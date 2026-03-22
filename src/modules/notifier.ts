/**
 * ZoFiles Notifier — listens to Zotero events and triggers export actions.
 *
 * Event mapping:
 * | Event                    | Action                                      |
 * |--------------------------|---------------------------------------------|
 * | item/add (regularItem)   | Incremental export                          |
 * | item/modify              | Re-export (cached providers skip)           |
 * | item/trash, item/delete  | Remove export folders via index              |
 * | collection/modify        | Full rebuild (name change affects paths)     |
 * | collection/delete        | Full rebuild                                |
 * | collection-item/add      | Export item to new collection path           |
 * | collection-item/remove   | Re-export + cleanup orphaned folders         |
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getExporter } from "./exporter";
import { extractArxivId, stripVersion } from "./arxiv-id";

const NOTIFIER_ID = `${config.addonRef}-notifier`;

let notifierCallbackId: string | null = null;
let rebuildDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildDebounceGeneration = 0;

/**
 * Register the Zotero.Notifier observer for item, collection,
 * and collection-item events.
 */
export function registerNotifier(): void {
  if (notifierCallbackId) {
    ztoolkit.log("[ZoFiles] Notifier already registered, skipping");
    return;
  }

  const observer = {
    notify: (
      event: string,
      type: string,
      ids: Array<string | number>,
      extraData: Record<string, any>,
    ) => {
      // Fire-and-forget — errors are caught inside
      onNotify(event, type, ids, extraData).catch((err) => {
        ztoolkit.log(`[ZoFiles] Notifier error: ${err.message || err}`);
      });
    },
  };

  notifierCallbackId = Zotero.Notifier.registerObserver(
    observer,
    ["item", "collection", "collection-item"],
    NOTIFIER_ID,
  );

  ztoolkit.log(
    `[ZoFiles] Notifier registered (id=${notifierCallbackId})`,
  );
}

/**
 * Unregister the Zotero.Notifier observer.
 * Safe to call multiple times.
 */
export function unregisterNotifier(): void {
  if (notifierCallbackId) {
    Zotero.Notifier.unregisterObserver(notifierCallbackId);
    ztoolkit.log(
      `[ZoFiles] Notifier unregistered (id=${notifierCallbackId})`,
    );
    notifierCallbackId = null;
  }
  // Invalidate any pending debounced rebuild by bumping generation
  rebuildDebounceGeneration++;
  rebuildDebounceTimer = null;
}

// ---------------------------------------------------------------------------
// Internal dispatch
// ---------------------------------------------------------------------------

/**
 * Main dispatch function called by the Zotero.Notifier observer.
 * Routes events to the appropriate exporter actions.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  _extraData: Record<string, any>,
): Promise<void> {
  // Skip if autoSync is disabled
  if (!getPref("autoSync")) return;

  // Skip if no export root configured
  const exportRoot = getPref("exportRoot");
  if (!exportRoot) return;

  // Skip events we don't handle (redraw, index, refresh, etc.)
  const handledItemEvents = ["add", "modify", "trash", "delete"];
  const handledCollectionEvents = ["modify", "delete"];
  const handledCollectionItemEvents = ["add", "remove"];

  if (type === "item" && !handledItemEvents.includes(event)) return;
  if (type === "collection" && !handledCollectionEvents.includes(event)) return;
  if (type === "collection-item" && !handledCollectionItemEvents.includes(event)) return;

  ztoolkit.log(`[ZoFiles] Notify: ${type}/${event} [${ids.join(", ")}]`);

  switch (type) {
    case "item":
      await handleItemEvent(event, ids);
      break;
    case "collection":
      await handleCollectionEvent(event);
      break;
    case "collection-item":
      await handleCollectionItemEvent(event, ids, _extraData);
      break;
  }
}

// ---------------------------------------------------------------------------
// Item events
// ---------------------------------------------------------------------------

/**
 * Handle item/add, item/modify, item/trash, item/delete events.
 *
 * Only processes regular items (not notes, attachments, annotations).
 * Shows a brief progress notification in the bottom-right corner.
 */
async function handleItemEvent(
  event: string,
  ids: Array<string | number>,
): Promise<void> {
  // Filter to regular items only
  const regularItemIds = filterRegularItems(ids);
  if (regularItemIds.length === 0) return;

  const exporter = getExporter();

  switch (event) {
    case "add":
    case "modify": {
      const actionLabel = event === "add" ? "Exporting" : "Updating";
      ztoolkit.log(
        `[ZoFiles] item/${event}: exporting ${regularItemIds.length} items`,
      );

      for (const id of regularItemIds) {
        // Get item info for the notification
        const itemInfo = getItemInfo(id);

        const progressWin = new ztoolkit.ProgressWindow(
          `ZoFiles — ${actionLabel}`,
        )
          .createLine({
            text: itemInfo.display,
            type: "default",
            progress: 0,
          })
          .show(-1);

        try {
          await exporter.exportItem(id);
          progressWin.changeLine({
            idx: 0,
            text: `${itemInfo.display}`,
            progress: 100,
            type: "success",
          });
        } catch (err: any) {
          ztoolkit.log(
            `[ZoFiles] Export failed for item ${id}: ${err.message || err}`,
          );
          progressWin.changeLine({
            idx: 0,
            text: `Failed: ${itemInfo.display}`,
            progress: 100,
            type: "fail",
          });
        }
        progressWin.startCloseTimer(3000);
      }
      break;
    }

    case "trash":
    case "delete": {
      // Item trashed/deleted — remove exported folders via index
      ztoolkit.log(
        `[ZoFiles] item/${event}: removing ${regularItemIds.length} items`,
      );

      const progressWin = new ztoolkit.ProgressWindow("ZoFiles — Removing")
        .createLine({
          text: `Removing ${regularItemIds.length} item(s)...`,
          type: "default",
          progress: 0,
        })
        .show(-1);

      try {
        await exporter.removeItemExport(regularItemIds);
        progressWin.changeLine({
          idx: 0,
          text: `Removed ${regularItemIds.length} item(s)`,
          progress: 100,
          type: "success",
        });
      } catch (err: any) {
        ztoolkit.log(
          `[ZoFiles] Removal failed: ${err.message || err}`,
        );
        progressWin.changeLine({
          idx: 0,
          text: `Removal failed`,
          progress: 100,
          type: "fail",
        });
      }
      progressWin.startCloseTimer(3000);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Collection events
// ---------------------------------------------------------------------------

/**
 * Handle collection/modify and collection/delete events.
 *
 * Collection name or hierarchy changes affect filesystem paths,
 * so a full rebuild is the safest approach.
 */
async function handleCollectionEvent(event: string): Promise<void> {
  if (event === "modify" || event === "delete") {
    ztoolkit.log(
      `[ZoFiles] collection/${event}: scheduling full rebuild`,
    );
    debouncedRebuild();
  }
}

// ---------------------------------------------------------------------------
// Collection-item events
// ---------------------------------------------------------------------------

/**
 * Handle collection-item/add and collection-item/remove events.
 *
 * The `ids` array for collection-item events contains strings like
 * "collectionID-itemID". We parse out the item IDs.
 *
 * - add: export the item to its (possibly new) collection path
 * - remove: re-export the item (to update paths) and clean up orphans
 */
async function handleCollectionItemEvent(
  event: string,
  ids: Array<string | number>,
  _extraData: Record<string, any>,
): Promise<void> {
  // Parse item IDs from "collectionID-itemID" format
  const itemIds = parseCollectionItemIds(ids);
  const regularItemIds = filterRegularItems(itemIds);
  if (regularItemIds.length === 0) return;

  const exporter = getExporter();

  switch (event) {
    case "add":
      // Item added to a collection — export to new path
      ztoolkit.log(
        `[ZoFiles] collection-item/add: exporting ${regularItemIds.length} items`,
      );
      for (const id of regularItemIds) {
        const itemInfo = getItemInfo(id);

        const progressWin = new ztoolkit.ProgressWindow("ZoFiles — Exporting")
          .createLine({
            text: itemInfo.display,
            type: "default",
            progress: 0,
          })
          .show(-1);

        try {
          await exporter.exportItem(id);
          progressWin.changeLine({
            idx: 0,
            text: `${itemInfo.display}`,
            progress: 100,
            type: "success",
          });
        } catch (err: any) {
          ztoolkit.log(
            `[ZoFiles] Export failed for item ${id}: ${err.message || err}`,
          );
          progressWin.changeLine({
            idx: 0,
            text: `Failed: ${itemInfo.display}`,
            progress: 100,
            type: "fail",
          });
        }
        progressWin.startCloseTimer(3000);
      }
      break;

    case "remove":
      // Item removed from a collection — re-export to clean up stale paths
      // A full rebuild is more reliable here since we need to remove folders
      // from the old collection path and the item may still be in other collections
      ztoolkit.log(
        `[ZoFiles] collection-item/remove: scheduling full rebuild`,
      );
      debouncedRebuild();
      break;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Filter an array of IDs to only those that correspond to regular items
 * (not notes, attachments, or annotations).
 */
function filterRegularItems(ids: Array<string | number>): number[] {
  const result: number[] = [];
  for (const id of ids) {
    const numId = typeof id === "string" ? parseInt(id, 10) : id;
    if (isNaN(numId)) continue;

    try {
      const item = Zotero.Items.get(numId);
      if (item && item.isRegularItem()) {
        result.push(numId);
      }
    } catch {
      // Item may have been deleted already (trash/delete event)
      // For delete events, include the ID so removeItemExport can clean the index
      result.push(numId);
    }
  }
  return result;
}

/**
 * Parse item IDs from collection-item event IDs.
 *
 * Zotero's collection-item events use IDs in the format "collectionID-itemID".
 * We extract just the item IDs.
 */
function parseCollectionItemIds(ids: Array<string | number>): number[] {
  const itemIds: number[] = [];
  for (const id of ids) {
    const str = String(id);
    const parts = str.split("-");
    if (parts.length >= 2) {
      const itemId = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(itemId)) {
        itemIds.push(itemId);
      }
    }
  }
  // Deduplicate
  return [...new Set(itemIds)];
}

/**
 * Get display info for an item (arXiv ID + truncated title) for notifications.
 */
function getItemInfo(itemId: number): { arxivId: string; title: string; display: string } {
  try {
    const item = Zotero.Items.get(itemId);
    if (item) {
      const rawId = extractArxivId(item);
      const arxivId = rawId ? stripVersion(rawId) : "";
      const title = String(item.getField("title") || "");
      const truncTitle = title.length > 40 ? title.slice(0, 37) + "..." : title;

      if (arxivId && truncTitle) {
        return { arxivId, title, display: `${arxivId} — ${truncTitle}` };
      } else if (arxivId) {
        return { arxivId, title, display: arxivId };
      } else if (truncTitle) {
        return { arxivId: "", title, display: truncTitle };
      }
    }
  } catch {
    // Ignore
  }
  return { arxivId: "", title: "", display: `Item ${itemId}` };
}

/**
 * Schedule a debounced incremental rebuild.
 *
 * Multiple events (e.g. batch collection renames) within 1500ms
 * are coalesced into a single rebuild. Uses incrementalRebuild
 * for speed — only processes differences.
 */
function debouncedRebuild(): void {
  // Use generation counter to invalidate stale timers
  const gen = ++rebuildDebounceGeneration;
  rebuildDebounceTimer = setTimeout(async () => {
    // Only run if this is still the latest generation
    if (gen !== rebuildDebounceGeneration) return;
    rebuildDebounceTimer = null;

    const progressWin = new ztoolkit.ProgressWindow("ZoFiles — Syncing")
      .createLine({
        text: "Syncing collections...",
        type: "default",
        progress: 0,
      })
      .show(-1);

    try {
      ztoolkit.log("[ZoFiles] Executing debounced incremental rebuild");
      const exporter = getExporter();
      const result = await exporter.incrementalRebuild((info) => {
        const pct = info.total > 0
          ? Math.round((info.current / info.total) * 100)
          : 0;
        const truncTitle = info.title.length > 40
          ? info.title.slice(0, 37) + "..."
          : info.title;
        progressWin.changeLine({
          idx: 0,
          text: `[${info.current}/${info.total}] ${info.arxivId} — ${truncTitle}`,
          progress: pct,
        });
      });

      const summary = result.exported > 0 || result.removed > 0
        ? `Done: ${result.exported} exported, ${result.removed} removed`
        : `Up to date (${result.skipped} items)`;

      progressWin.changeLine({
        idx: 0,
        text: summary,
        progress: 100,
        type: result.errors.length > 0 ? "fail" : "success",
      });
      progressWin.startCloseTimer(3000);

      ztoolkit.log(
        `[ZoFiles] Rebuild complete: ${result.exported} exported, ${result.skipped} skipped, ${result.removed} removed, ${result.errors.length} errors`,
      );
    } catch (err: any) {
      progressWin.changeLine({
        idx: 0,
        text: `Sync failed: ${err.message || err}`,
        progress: 100,
        type: "fail",
      });
      progressWin.startCloseTimer(5000);

      ztoolkit.log(
        `[ZoFiles] Incremental rebuild failed: ${err.message || err}`,
      );
    }
  }, 1500);
}
