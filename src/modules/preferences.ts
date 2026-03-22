/**
 * ZoFiles Preferences — wires up the preferences pane UI.
 *
 * Called when the preferences XHTML is loaded via the `onload` handler.
 * Manages: export root picker, collection tree checkboxes, folder format,
 * content provider toggles, PDF mode, cache path, link-back, auto sync,
 * and the manual rebuild button.
 */

import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { getExporter } from "./exporter";

const PREF_ID = (suffix: string) =>
  `zotero-prefpane-${config.addonRef}-${suffix}`;

/**
 * Initialize the preferences pane.
 * Called from hooks.onPrefsEvent("load", { window }).
 */
export async function registerPrefsScripts(_window: Window): Promise<void> {
  // Store the window reference for later use
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
    } as any;
  } else {
    addon.data.prefs.window = _window;
  }

  const doc = _window.document;

  // Initialize UI state from preferences
  initExportRoot(doc);
  initFolderFormat(doc);
  initContentToggles(doc);
  initPdfMode(doc);
  initAdvancedSettings(doc);
  await initCollectionTree(doc);

  // Bind interactive events
  bindBrowseButton(doc);
  bindFolderFormatEvents(doc);
  bindContentToggleEvents(doc);
  bindPdfModeEvents(doc);
  bindAdvancedEvents(doc);
  bindRebuildButton(doc);
  bindForceRebuildButton(doc);
}

// ---------------------------------------------------------------------------
// Export Root
// ---------------------------------------------------------------------------

/**
 * Display the current export root path in the text field.
 */
function initExportRoot(doc: Document): void {
  const input = doc.getElementById(
    PREF_ID("export-root"),
  ) as HTMLInputElement | null;
  if (input) {
    input.value = (getPref("exportRoot") as string) || "";
  }
}

/**
 * Bind the Browse button to open a directory picker,
 * and the text input to save manually typed paths.
 */
function bindBrowseButton(doc: Document): void {
  const btn = doc.getElementById(PREF_ID("browse"));
  const input = doc.getElementById(
    PREF_ID("export-root"),
  ) as HTMLInputElement | null;

  // Helper: handle export root change with index rebase prompt
  const handleExportRootChange = async (newPath: string) => {
    const oldPath = (getPref("exportRoot") as string) || ""
    if (!newPath || newPath === oldPath) {
      setPref("exportRoot", newPath)
      return
    }
    setPref("exportRoot", newPath)

    // If there was a previous export root, offer to rebase the index
    if (oldPath) {
      const win = doc.ownerGlobal as Window
      const msg = getString("pref-rebase-confirm")
        .replace("{old}", oldPath)
        .replace("{new}", newPath)
      const doRebase = win.confirm(msg)

      if (doRebase) {
        try {
          const exporter = getExporter()
          const updated = await exporter.rebaseIndex(oldPath, newPath)
          if (updated > 0) {
            win.alert(
              getString("pref-rebase-success").replace("{count}", String(updated)),
            )
          } else if (updated === 0) {
            win.alert(getString("pref-rebase-no-change"))
          } else {
            win.alert(getString("pref-rebase-no-index"))
          }
        } catch (err: any) {
          ztoolkit.log(`[ZoFiles] rebaseIndex failed: ${err.message}`)
          win.alert(
            getString("pref-rebase-error").replace("{error}", err.message || String(err)),
          )
        }
      }
    }
  }

  // Save manually typed path on change/blur
  if (input) {
    const saveInput = () => {
      const val = input.value.trim();
      handleExportRootChange(val)
    };
    input.addEventListener("change", saveInput);
    input.addEventListener("blur", saveInput);
  }

  if (!btn) return;

  btn.addEventListener("command", async () => {
    try {
      // Use Zotero's built-in file picker utility
      const path = await new Promise<string | null>((resolve) => {
        const win = doc.ownerGlobal;
        // @ts-expect-error - nsIFilePicker not fully typed
        const fp = Components.classes[
          "@mozilla.org/filepicker;1"
        ].createInstance(Components.interfaces.nsIFilePicker);

        fp.init(
          win,
          "Choose Export Root Directory",
          Components.interfaces.nsIFilePicker.modeGetFolder,
        );

        // Set initial directory if current export root exists
        const currentRoot = getPref("exportRoot") as string;
        if (currentRoot) {
          try {
            // @ts-expect-error - nsIFile not fully typed
            const dir = Components.classes[
              "@mozilla.org/file/local;1"
            ].createInstance(Components.interfaces.nsIFile);
            dir.initWithPath(currentRoot);
            if (dir.exists()) {
              fp.displayDirectory = dir;
            }
          } catch {
            // Ignore
          }
        }

        fp.open((result: number) => {
          if (
            result === Components.interfaces.nsIFilePicker.returnOK &&
            fp.file
          ) {
            resolve(fp.file.path);
          } else {
            resolve(null);
          }
        });
      });

      if (path) {
        if (input) {
          input.value = path;
        }
        await handleExportRootChange(path)
      }
    } catch (err: any) {
      // Fallback: prompt for manual input
      ztoolkit.log(
        `[ZoFiles] FilePicker failed: ${err.message}, falling back to prompt`,
      );
      const win = doc.ownerGlobal as Window;
      const result = win.prompt(
        "Enter export root directory path:",
        (getPref("exportRoot") as string) || "",
      );
      if (result !== null && result.trim()) {
        if (input) {
          input.value = result.trim();
        }
        await handleExportRootChange(result.trim())
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Collection Tree
// ---------------------------------------------------------------------------

/**
 * Load Zotero collections and render them as a checkbox tree.
 * Checked state is read from the enabledCollections preference.
 */
async function initCollectionTree(doc: Document): Promise<void> {
  const container = doc.getElementById(PREF_ID("collection-tree"));
  if (!container) return;

  // Clear existing content
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  // Parse enabled collection IDs
  const enabledJson = getPref("enabledCollections") as string;
  let enabledIds: number[];
  try {
    enabledIds = enabledJson ? JSON.parse(enabledJson) : [];
  } catch {
    enabledIds = [];
  }
  const enableAll = enabledIds.length === 0;

  // Get all collections from user library
  const libraryID = Zotero.Libraries.userLibraryID;
  const allCollections = Zotero.Collections.getByLibrary(libraryID);
  const roots = allCollections.filter((c: any) => !c.parentID);

  // Sort roots alphabetically
  roots.sort((a: any, b: any) => a.name.localeCompare(b.name));

  // Render each root collection and its descendants
  for (const col of roots) {
    renderCollectionNode(doc, container, col, enabledIds, enableAll, 0);
  }

  // Remove old controls (if refreshing)
  const oldControls = (container.parentNode as Element)?.querySelector(
    ".zofiles-collection-controls",
  );
  if (oldControls) oldControls.remove();

  // Add "select all / deselect all / refresh" controls
  const controls = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "html:div",
  ) as HTMLElement;
  controls.className = "zofiles-collection-controls";

  const selectAllBtn = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "html:button",
  ) as HTMLButtonElement;
  selectAllBtn.textContent = getString("pref-select-all");
  selectAllBtn.addEventListener("click", () => {
    toggleAllCollections(doc, true);
  });

  const deselectAllBtn = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "html:button",
  ) as HTMLButtonElement;
  deselectAllBtn.textContent = getString("pref-deselect-all");
  deselectAllBtn.style.marginLeft = "8px";
  deselectAllBtn.addEventListener("click", () => {
    toggleAllCollections(doc, false);
  });

  const refreshBtn = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "html:button",
  ) as HTMLButtonElement;
  refreshBtn.textContent = getString("pref-refresh-tree");
  refreshBtn.style.marginLeft = "8px";
  refreshBtn.addEventListener("click", () => {
    initCollectionTree(doc);
  });

  controls.appendChild(selectAllBtn);
  controls.appendChild(deselectAllBtn);
  controls.appendChild(refreshBtn);

  // Insert controls before the tree
  container.parentNode?.insertBefore(controls, container);
}

/**
 * Recursively render a collection node with a checkbox.
 */
function renderCollectionNode(
  doc: Document,
  parent: Element,
  collection: any, // Zotero.Collection
  enabledIds: number[],
  enableAll: boolean,
  depth: number,
): void {
  const row = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "html:div",
  ) as HTMLElement;
  row.className = "zofiles-collection-row";
  row.style.paddingLeft = `${depth * 20}px`;

  const checkbox = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "html:input",
  ) as HTMLInputElement;
  checkbox.type = "checkbox";
  checkbox.dataset.collectionId = String(collection.id);
  checkbox.className = "zofiles-collection-checkbox";
  checkbox.checked = enableAll || enabledIds.includes(collection.id);

  checkbox.addEventListener("change", () => {
    saveCollectionSelections(doc);
  });

  const label = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "html:label",
  ) as HTMLLabelElement;
  label.textContent = collection.name;
  label.style.marginLeft = "4px";
  label.style.cursor = "pointer";
  label.addEventListener("click", () => {
    checkbox.checked = !checkbox.checked;
    saveCollectionSelections(doc);
  });

  // Show item count
  const count = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "html:span",
  ) as HTMLSpanElement;
  const itemCount = (collection.getChildItems(true) as number[]).length;
  count.textContent = ` (${itemCount})`;
  count.style.color = "#888";
  count.style.fontSize = "0.9em";

  row.appendChild(checkbox);
  row.appendChild(label);
  row.appendChild(count);
  parent.appendChild(row);

  // Render children
  const children = collection.getChildCollections();
  children.sort((a: any, b: any) => a.name.localeCompare(b.name));
  for (const child of children) {
    renderCollectionNode(doc, parent, child, enabledIds, enableAll, depth + 1);
  }
}

/**
 * Toggle all collection checkboxes on or off.
 */
function toggleAllCollections(doc: Document, checked: boolean): void {
  const checkboxes = doc.querySelectorAll<HTMLInputElement>(
    ".zofiles-collection-checkbox",
  );
  for (const cb of checkboxes) {
    cb.checked = checked;
  }
  saveCollectionSelections(doc);
}

/**
 * Read all checkbox states and save to the enabledCollections preference.
 * When all checkboxes are checked, saves "[]" (meaning export all).
 */
function saveCollectionSelections(doc: Document): void {
  const checkboxes = doc.querySelectorAll<HTMLInputElement>(
    ".zofiles-collection-checkbox",
  );

  const checkedIds: number[] = [];
  let allChecked = true;

  for (const cb of checkboxes) {
    const id = parseInt(cb.dataset.collectionId || "0", 10);
    if (cb.checked) {
      checkedIds.push(id);
    } else {
      allChecked = false;
    }
  }

  // If all are checked, store "[]" to mean "all collections"
  const value = allChecked ? "[]" : JSON.stringify(checkedIds);
  setPref("enabledCollections", value);
}

// ---------------------------------------------------------------------------
// Folder Format
// ---------------------------------------------------------------------------

/**
 * Initialize the folder format menulist (dropdown).
 */
function initFolderFormat(doc: Document): void {
  const menulist = doc.getElementById(
    PREF_ID("folder-format"),
  ) as XUL.MenuList | null;
  const customInput = doc.getElementById(
    PREF_ID("folder-format-custom"),
  ) as HTMLInputElement | null;

  if (!menulist) return;

  const currentFormat = getPref("paperFolderFormat") as string;

  // Check if the current format matches one of the presets
  const presets = [
    "{arxivId} - {title}",
    "{arxivId}",
    "{title}",
    "{firstAuthor} - {title}",
    "{year} - {title}",
  ];

  const matchIndex = presets.indexOf(currentFormat);
  if (matchIndex >= 0) {
    menulist.selectedIndex = matchIndex;
    if (customInput) customInput.style.display = "none";
  } else {
    // Custom format — select the "Custom" option (last item)
    menulist.selectedIndex = presets.length;
    if (customInput) {
      customInput.style.display = "";
      customInput.value = currentFormat;
    }
  }
}

/**
 * Bind folder format dropdown and custom input events.
 */
function bindFolderFormatEvents(doc: Document): void {
  const menulist = doc.getElementById(
    PREF_ID("folder-format"),
  ) as XUL.MenuList | null;
  const customInput = doc.getElementById(
    PREF_ID("folder-format-custom"),
  ) as HTMLInputElement | null;

  if (!menulist) return;

  menulist.addEventListener("command", () => {
    const selected = menulist.selectedItem;
    if (!selected) return;

    const value = selected.getAttribute("value") || "";

    if (value === "custom") {
      // Show custom input
      if (customInput) {
        customInput.style.display = "";
        customInput.focus();
      }
    } else {
      // Hide custom input, save the preset value
      if (customInput) customInput.style.display = "none";
      setPref("paperFolderFormat", value);
    }
  });

  if (customInput) {
    customInput.addEventListener("change", () => {
      const value = customInput.value.trim();
      if (value) {
        setPref("paperFolderFormat", value);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Content Toggles
// ---------------------------------------------------------------------------

/**
 * Provider toggle definitions: pref key → checkbox element ID suffix.
 */
const CONTENT_TOGGLES = [
  { prefKey: "exportPdf", id: "export-pdf" },
  { prefKey: "exportMarkdown", id: "export-markdown" },
  { prefKey: "exportKimi", id: "export-kimi" },
  { prefKey: "exportBibtex", id: "export-bibtex" },
  { prefKey: "exportNotes", id: "export-notes" },
  { prefKey: "exportArxivId", id: "export-arxivid" },
] as const;

/**
 * Initialize content provider toggle checkboxes from preferences.
 */
function initContentToggles(doc: Document): void {
  for (const toggle of CONTENT_TOGGLES) {
    const checkbox = doc.getElementById(
      PREF_ID(toggle.id),
    ) as XUL.Checkbox | null;
    if (checkbox) {
      checkbox.checked = getPref(toggle.prefKey as any) as boolean;
    }
  }
}

/**
 * Bind change events for content provider toggle checkboxes.
 */
function bindContentToggleEvents(doc: Document): void {
  for (const toggle of CONTENT_TOGGLES) {
    const checkbox = doc.getElementById(PREF_ID(toggle.id));
    if (!checkbox) continue;

    checkbox.addEventListener("command", (e: Event) => {
      const target = e.target as XUL.Checkbox;
      setPref(toggle.prefKey as any, target.checked);
    });
  }
}

// ---------------------------------------------------------------------------
// PDF Mode
// ---------------------------------------------------------------------------

/**
 * Initialize the PDF mode radiogroup.
 */
function initPdfMode(doc: Document): void {
  const radiogroup = doc.getElementById(
    PREF_ID("pdf-mode"),
  ) as XUL.RadioGroup | null;
  if (!radiogroup) return;

  const currentMode = getPref("pdfMode") as string;
  // Select the matching radio button
  const radios = radiogroup.querySelectorAll("radio");
  for (const radio of radios) {
    if (radio.getAttribute("value") === currentMode) {
      radiogroup.selectedItem = radio;
      break;
    }
  }
}

/**
 * Bind the PDF mode radiogroup change event.
 */
function bindPdfModeEvents(doc: Document): void {
  const radiogroup = doc.getElementById(
    PREF_ID("pdf-mode"),
  ) as XUL.RadioGroup | null;
  if (!radiogroup) return;

  radiogroup.addEventListener("command", () => {
    const selected = radiogroup.selectedItem;
    if (selected) {
      const value = selected.getAttribute("value") || "symlink";
      setPref("pdfMode", value);
    }
  });
}

// ---------------------------------------------------------------------------
// Advanced Settings
// ---------------------------------------------------------------------------

/**
 * Initialize cache path, link-back, and auto sync controls.
 */
function initAdvancedSettings(doc: Document): void {
  // Cache path
  const cacheInput = doc.getElementById(
    PREF_ID("cache-path"),
  ) as HTMLInputElement | null;
  if (cacheInput) {
    cacheInput.value = (getPref("cachePath") as string) || "";
    cacheInput.placeholder = "~/.cache/ZoFiles";
  }

  // Link back to Zotero
  const linkBackCheckbox = doc.getElementById(
    PREF_ID("link-back"),
  ) as XUL.Checkbox | null;
  if (linkBackCheckbox) {
    linkBackCheckbox.checked = getPref("linkBackToZotero") as boolean;
  }

  // Auto sync
  const autoSyncCheckbox = doc.getElementById(
    PREF_ID("auto-sync"),
  ) as XUL.Checkbox | null;
  if (autoSyncCheckbox) {
    autoSyncCheckbox.checked = getPref("autoSync") as boolean;
  }
}

/**
 * Bind events for advanced settings controls.
 */
function bindAdvancedEvents(doc: Document): void {
  // Cache path — save on change
  const cacheInput = doc.getElementById(
    PREF_ID("cache-path"),
  ) as HTMLInputElement | null;
  if (cacheInput) {
    cacheInput.addEventListener("change", () => {
      setPref("cachePath", cacheInput.value.trim());
    });
  }

  // Link back checkbox
  const linkBackCheckbox = doc.getElementById(PREF_ID("link-back"));
  if (linkBackCheckbox) {
    linkBackCheckbox.addEventListener("command", (e: Event) => {
      const target = e.target as XUL.Checkbox;
      setPref("linkBackToZotero", target.checked);
    });
  }

  // Auto sync checkbox
  const autoSyncCheckbox = doc.getElementById(PREF_ID("auto-sync"));
  if (autoSyncCheckbox) {
    autoSyncCheckbox.addEventListener("command", (e: Event) => {
      const target = e.target as XUL.Checkbox;
      setPref("autoSync", target.checked);
    });
  }
}

// ---------------------------------------------------------------------------
// Rebuild Buttons
// ---------------------------------------------------------------------------

/**
 * Bind the Rebuild button to trigger an incremental rebuild.
 * Only exports new/changed items and removes stale ones — fast.
 */
function bindRebuildButton(doc: Document): void {
  const btn = doc.getElementById(PREF_ID("rebuild"));
  if (!btn) return;

  const statusLabel = doc.getElementById(
    PREF_ID("rebuild-status"),
  ) as HTMLElement | null;
  const forceBtn = doc.getElementById(PREF_ID("force-rebuild"));

  btn.addEventListener("command", async () => {
    const exportRoot = getPref("exportRoot") as string;
    if (!exportRoot) {
      if (statusLabel) {
        statusLabel.textContent = getString("pref-rebuild-no-root");
        statusLabel.style.color = "#c00";
      }
      return;
    }

    // Disable both buttons during rebuild
    btn.setAttribute("disabled", "true");
    if (forceBtn) forceBtn.setAttribute("disabled", "true");
    if (statusLabel) {
      statusLabel.textContent = getString("pref-rebuild-running");
      statusLabel.style.color = "";
    }

    const progressWin = new ztoolkit.ProgressWindow("ZoFiles — Rebuilding")
      .createLine({
        text: "Scanning for changes...",
        type: "default",
        progress: 0,
      })
      .show(-1);

    try {
      const exporter = getExporter();
      const result = await exporter.incrementalRebuild((info) => {
        const pct =
          info.total > 0 ? Math.round((info.current / info.total) * 100) : 0;
        const truncTitle =
          info.title.length > 40 ? info.title.slice(0, 37) + "..." : info.title;
        const statusText =
          info.status === "error"
            ? `[${info.current}/${info.total}] ERROR: ${info.arxivId}`
            : `[${info.current}/${info.total}] ${info.arxivId} — ${truncTitle}`;

        progressWin.changeLine({
          idx: 0,
          text: statusText,
          progress: pct,
        });
      });

      const summary =
        result.exported > 0 || result.removed > 0
          ? `Done: ${result.exported} exported, ${result.skipped} skipped, ${result.removed} removed`
          : `Already up to date (${result.skipped} items)`;

      progressWin.changeLine({
        idx: 0,
        text: summary,
        progress: 100,
        type: result.errors.length > 0 ? "fail" : "success",
      });
      progressWin.startCloseTimer(5000);

      if (statusLabel) {
        statusLabel.textContent =
          summary +
          (result.errors.length > 0 ? `, ${result.errors.length} errors` : "");
        statusLabel.style.color = result.errors.length > 0 ? "#c80" : "#080";
      }
    } catch (err: any) {
      progressWin.changeLine({
        idx: 0,
        text: `Error: ${err.message || err}`,
        progress: 100,
        type: "fail",
      });
      progressWin.startCloseTimer(5000);

      if (statusLabel) {
        statusLabel.textContent = `${getString("pref-rebuild-error")}: ${err.message || err}`;
        statusLabel.style.color = "#c00";
      }
    } finally {
      btn.removeAttribute("disabled");
      if (forceBtn) forceBtn.removeAttribute("disabled");
    }
  });
}

/**
 * Bind the Force Rebuild button to trigger a full clean rebuild.
 * Deletes everything in the export root and re-exports from scratch.
 */
function bindForceRebuildButton(doc: Document): void {
  const btn = doc.getElementById(PREF_ID("force-rebuild"));
  if (!btn) return;

  const statusLabel = doc.getElementById(
    PREF_ID("rebuild-status"),
  ) as HTMLElement | null;
  const rebuildBtn = doc.getElementById(PREF_ID("rebuild"));

  btn.addEventListener("command", async () => {
    const exportRoot = getPref("exportRoot") as string;
    if (!exportRoot) {
      if (statusLabel) {
        statusLabel.textContent = getString("pref-rebuild-no-root");
        statusLabel.style.color = "#c00";
      }
      return;
    }

    // Disable both buttons during rebuild
    btn.setAttribute("disabled", "true");
    if (rebuildBtn) rebuildBtn.setAttribute("disabled", "true");
    if (statusLabel) {
      statusLabel.textContent = getString("pref-rebuild-running");
      statusLabel.style.color = "";
    }

    const progressWin = new ztoolkit.ProgressWindow(
      "ZoFiles — Force Rebuilding",
    )
      .createLine({
        text: "Cleaning export directory...",
        type: "default",
        progress: 0,
      })
      .show(-1);

    try {
      const exporter = getExporter();
      const result = await exporter.fullRebuild((info) => {
        const pct =
          info.total > 0 ? Math.round((info.current / info.total) * 100) : 0;
        const truncTitle =
          info.title.length > 40 ? info.title.slice(0, 37) + "..." : info.title;
        const statusText =
          info.status === "error"
            ? `[${info.current}/${info.total}] ERROR: ${info.arxivId}`
            : `[${info.current}/${info.total}] ${info.arxivId} — ${truncTitle}`;

        progressWin.changeLine({
          idx: 0,
          text: statusText,
          progress: pct,
        });
      });

      progressWin.changeLine({
        idx: 0,
        text: `Done: ${result.exported} exported, ${result.errors.length} errors`,
        progress: 100,
        type: result.errors.length > 0 ? "fail" : "success",
      });
      progressWin.startCloseTimer(5000);

      if (statusLabel) {
        const msg = getString("pref-rebuild-complete")
          .replace("{exported}", String(result.exported))
          .replace("{errors}", String(result.errors.length));
        statusLabel.textContent = msg;
        statusLabel.style.color = result.errors.length > 0 ? "#c80" : "#080";
      }
    } catch (err: any) {
      progressWin.changeLine({
        idx: 0,
        text: `Error: ${err.message || err}`,
        progress: 100,
        type: "fail",
      });
      progressWin.startCloseTimer(5000);

      if (statusLabel) {
        statusLabel.textContent = `${getString("pref-rebuild-error")}: ${err.message || err}`;
        statusLabel.style.color = "#c00";
      }
    } finally {
      btn.removeAttribute("disabled");
      if (rebuildBtn) rebuildBtn.removeAttribute("disabled");
    }
  });
}
