import { initLocale, getString } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { registerPrefsScripts } from "./modules/preferences";
import { registerNotifier, unregisterNotifier } from "./modules/notifier";
import { getPref } from "./utils/prefs";

async function onStartup() {
  // Register preference pane BEFORE awaiting initialization
  // (Zotero requires this to be called early)
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: "ZoFiles",
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`,
  });

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register Zotero.Notifier for item/collection events
  registerNotifier();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  // Insert FTL for localization
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // First-run: show welcome dialog if export root is not configured
  const exportRoot = getPref("exportRoot") as string;
  if (!exportRoot) {
    // Small delay to let the main window finish loading
    setTimeout(() => showWelcomeDialog(win), 1500);
  }
}

/**
 * Show a welcome/setup dialog on first install.
 * Guides the user to open Settings → ZoFiles to configure export root.
 */
function showWelcomeDialog(win: _ZoteroTypes.MainWindow): void {
  try {
    const dialogData: { [key: string]: any } = {};
    const dialogHelper = new ztoolkit.Dialog(2, 1);
    dialogHelper
      .setDialogData(dialogData)
      .addCell(0, 0, {
        tag: "div",
        namespace: "html",
        styles: {
          padding: "16px",
          maxWidth: "480px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        },
        children: [
          {
            tag: "h2",
            namespace: "html",
            properties: { textContent: "Welcome to ZoFiles! 🎉" },
            styles: { margin: "0 0 12px 0" },
          },
          {
            tag: "p",
            namespace: "html",
            properties: {
              textContent:
                "ZoFiles mirrors your Zotero collections as real folders on disk, with per-paper content: PDF, Markdown, BibTeX, notes, and more.",
            },
            styles: { margin: "0 0 12px 0", lineHeight: "1.5" },
          },
          {
            tag: "p",
            namespace: "html",
            properties: {
              textContent:
                "To get started, you need to set an Export Root Directory — the folder where ZoFiles will create your paper tree.",
            },
            styles: { margin: "0 0 12px 0", lineHeight: "1.5" },
          },
          {
            tag: "p",
            namespace: "html",
            properties: {
              textContent:
                'Click "Open Settings" below, or go to Zotero → Settings → ZoFiles at any time.',
            },
            styles: {
              margin: "0",
              lineHeight: "1.5",
              fontStyle: "italic",
              color: "#666",
            },
          },
        ],
      })
      .addButton("Open Settings", "open-settings")
      .addButton("Later", "later")
      .open("ZoFiles — First-Time Setup", {
        centerscreen: true,
        resizable: false,
        width: 520,
        height: 320,
      });

    // After dialog closes, check which button was pressed
    dialogHelper.window?.addEventListener("unload", () => {
      if (dialogData._lastButtonId === "open-settings") {
        // Open Zotero Settings and navigate to ZoFiles pane
        setTimeout(() => {
          Zotero.Utilities.Internal.openPreferences(addon.data.config.addonID);
        }, 300);
      }
    });
  } catch (e: any) {
    ztoolkit.log(`[ZoFiles] Welcome dialog error: ${e.message}`);
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  unregisterNotifier();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // This is dispatched from the notifier module
  // Keep empty — actual logic is in notifier.ts
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
