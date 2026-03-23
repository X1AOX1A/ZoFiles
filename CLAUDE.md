# CLAUDE.md — Development Guide for ZoFiles

## Quick Start

```bash
npm install
npm run build        # → .scaffold/build/zo-files.xpi
npm start            # dev mode with hot reload
```

## What Is This

**ZoFiles** is a Zotero 7/8 plugin (TypeScript, esbuild) that mirrors Zotero's collection hierarchy as real filesystem directories, with per-paper folders containing PDF, Markdown, BibTeX, Kimi review, notes, and arXiv ID files.

Built on [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) by windingwind.

## Architecture Overview

```
Zotero.Notifier events
    ↓
notifier.ts (dispatch + filter)
    ↓
exporter.ts (ExportQueue / incrementalRebuild / fullRebuild)
    ↓
tree-builder.ts (collection → directory mapping)
    ↓
content-providers/*.ts (pluggable per-file generators)
    ↓
filesystem (IOUtils / PathUtils)
```

### Data Flow

1. **Notifier** (`notifier.ts`) listens to `item`, `collection`, `collection-item` events
2. **Exporter** (`exporter.ts`) orchestrates: resolves paths via tree-builder, runs providers, manages index
3. **Tree Builder** (`tree-builder.ts`) maps Zotero collection hierarchy → filesystem directory tree
   - Each `CollectionNode` has `itemIds` (direct items) and `allItemIds` (direct + all descendant items)
   - **`Allin/` directory**: created when a collection has subcollections and `allItemIds.length > 0`. Contains **every paper from the collection and all its descendants** — a flat view of the entire subtree. This means even if the parent collection has no direct items, `Allin/` is still created as long as subcollections have papers.
4. **Content Providers** (`content-providers/*.ts`) generate individual files (PDF, Markdown, etc.)
5. **Index** (`.zofiles-index.json`) tracks exported items, paths, and files for incremental operations

## Key Files

| File                                         | Purpose                                                                   | When to touch                             |
| -------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| `src/modules/exporter.ts`                    | Core export logic, queue, rebuild, index management                       | Export behavior, path resolution, cleanup |
| `src/modules/notifier.ts`                    | Event dispatch, progress notifications                                    | Adding new event handlers                 |
| `src/modules/tree-builder.ts`                | Collection → directory mapping, `Allin/` logic                            | Changing how collections map to folders   |
| `src/modules/preferences.ts`                 | Settings panel wiring, rebuild buttons                                    | Adding new preferences                    |
| `src/modules/content-providers/`             | Pluggable content generators                                              | Adding new export file types              |
| `src/modules/arxiv-id.ts`                    | arXiv ID extraction from multiple fields                                  | Changing paper identification             |
| `src/modules/utils.ts`                       | `ensureDir`, `joinPath`, `removeDir`, `formatPaperFolder`, `getCachePath` | Filesystem operations                     |
| `src/hooks.ts`                               | Plugin lifecycle (startup, shutdown, window load)                         | Init/cleanup logic                        |
| `addon/prefs.js`                             | Default preference values                                                 | Adding new settings                       |
| `addon/content/preferences.xhtml`            | Settings panel UI (XUL/XHTML)                                             | Settings UI changes                       |
| `addon/locale/{en-US,zh-CN}/preferences.ftl` | Localization strings                                                      | Any user-facing text                      |

## Preference Keys (addon/prefs.js)

| Key                  | Type          | Default                 | Description                                        |
| -------------------- | ------------- | ----------------------- | -------------------------------------------------- |
| `exportRoot`         | string        | `""`                    | Root directory for export tree                     |
| `cachePath`          | string        | `""`                    | Cache dir (falls back to `~/.cache/ZoFiles`)       |
| `paperFolderFormat`  | string        | `"{arxivId} - {title}"` | Paper folder naming template                       |
| `enabledCollections` | string (JSON) | `"[]"`                  | JSON array of enabled collection IDs (empty = all) |
| `exportPdf`          | bool          | `true`                  | Export PDF                                         |
| `exportMarkdown`     | bool          | `true`                  | Export full-text Markdown                          |
| `exportKimi`         | bool          | `true`                  | Export Kimi AI review                              |
| `exportBibtex`       | bool          | `true`                  | Export BibTeX                                      |
| `exportNotes`        | bool          | `true`                  | Export Zotero notes                                |
| `exportArxivId`      | bool          | `true`                  | Export arXiv ID file                               |
| `pdfMode`            | string        | `"symlink"`             | `"symlink"` or `"copy"`                            |
| `linkBackToZotero`   | bool          | `false`                 | Create linked attachments in Zotero                |
| `autoSync`           | bool          | `true`                  | Auto-export on changes                             |

## Content Providers

Execution order (fast → slow): ArxivId → PDF → BibTeX → Notes → Kimi → Markdown

Each provider extends `BaseProvider` and implements:

- `export(ctx: ExportContext) → ProviderResult` — generate the file
- `cleanup(paperDir) → void` — remove the file
- `isEnabled() → bool` — checks user pref

To add a new provider:

1. Create `src/modules/content-providers/my-provider.ts` extending `BaseProvider`
2. Add pref key to `addon/prefs.js` and UI toggle to `preferences.xhtml`
3. Register in `registry.ts` (order matters — fast/local first)
4. Add localization strings to both `en-US` and `zh-CN` `.ftl` files

## Exporter Internals

### ExportQueue

- Debounced (500ms), max concurrency 3
- Deduplicates: multiple enqueues for same itemId share one task
- Uses generation counter pattern for debounce invalidation

### incrementalRebuild

Compares `.zofiles-index.json` with current Zotero state. Categorizes items into:

- `toExport` — new items not in index
- `toCleanAndReExport` — paths changed (moved between collections)
- `toCleanOnly` — removed from all exported collections
- `toRemove` — deleted from Zotero entirely
- `upToDate` — no changes needed

### doExportItem

Single-item export flow:

1. Validate item + extract arXiv ID
2. Build/reuse collection tree
3. Resolve target directories
4. Export to primary directory via providers
5. Copy to additional directories
6. **Clean stale paths** (compares old vs new `exportedPaths` in index)
7. Optionally link back to Zotero
8. Update index

### Stale Path Cleanup

`doExportItem` compares the previous index entry's `exportedPaths` with the new paths. Paths no longer needed are deleted. This handles the race condition where `item/modify` fires before the debounced `incrementalRebuild`.

## Known Issues / Pitfalls

### `Zotero.setTimeout` Does NOT Exist in Zotero 8

Use standard `setTimeout` everywhere. The markdown-provider's `RateLimiter` (line 33) still has `Zotero.setTimeout` — **this is a known bug**. It doesn't crash because most requests hit cache, but will fail on uncached rate-limited requests.

### Event Ordering Race Condition

When removing an item from a collection, Zotero fires both `item/modify` and `collection-item/remove`. The `item/modify` handler (immediate) runs before the debounced `incrementalRebuild` (1.5s delay). The fix is in `doExportItem` which now cleans stale paths before updating the index.

### `item/redraw` Event Flooding

Zotero fires hundreds of `item/redraw` events per second. The notifier filters these out early with:

```typescript
const handledItemEvents = ["add", "modify", "trash", "delete"];
if (type === "item" && !handledItemEvents.includes(event)) return;
```

### Link-Back Deduplication

Link-back uses attachment **title** (`[ZoFiles] filename`) for dedup, not file path. Path-based dedup fails when items move between collections. Stale link-back attachments (pointing to deleted files) are automatically cleaned up.

### Rebuild is Sequential

Both `fullRebuild` and `incrementalRebuild` process items sequentially. Could be parallelized with a concurrency pool, but need to fix the rate limiter bug first (`Zotero.setTimeout`).

### IOUtils / PathUtils

These are Mozilla platform APIs available in Zotero's privileged context. No `import` needed — they're globals. Use `IOUtils.write()`, `IOUtils.read()`, `IOUtils.exists()`, `IOUtils.remove()`, `PathUtils.filename()`, etc.

## Zotero Plugin Patterns

- **Preferences**: read with `getPref(key)`, set with `setPref(key, value)`. Keys are auto-prefixed with `extensions.zotero.zofiles.`.
- **Localization**: Fluent `.ftl` files in `addon/locale/`. Referenced via `data-l10n-id` in XHTML.
- **ztoolkit.ProgressWindow**: Zotero's native bottom-right notification popup. Use `.createLine()`, `.changeLine()`, `.show(-1)`, `.startCloseTimer()`.
- **Global types**: `Zotero`, `ztoolkit`, `addon`, `IOUtils`, `PathUtils` are all globals in the plugin context.

## Build & Deploy

```bash
npm run build          # production build → .scaffold/build/zo-files.xpi
npm start              # dev mode with hot reload in Zotero
```

### Release via CI

Do **not** use `gh release create` manually — it conflicts with the Release workflow.

```bash
git tag v0.X.Y
git push --tags        # CI builds, creates GitHub Release, uploads .xpi
```

## Code Style

- TypeScript with strict mode
- No semicolons — match existing code style
- Async/await for all IO operations
- Try/catch with graceful failure in providers (never crash the whole export)
- Log with `ztoolkit.log("[ZoFiles] ...")`
- Both `en-US` and `zh-CN` localization for all user-facing strings

## Before Committing

1. **Run `npx prettier --write .`** — CI enforces Prettier; commits with formatting issues will fail. This includes **all** files in the repo — `.claude/skills/` Markdown/Python files are also checked.
2. **Check if docs need updating** — if you changed preferences, added features, or modified the public API, update `README.md` and/or this `CLAUDE.md` accordingly.
3. **Run `npm run build`** — ensure the build and type-check pass (`tsc --noEmit`).
