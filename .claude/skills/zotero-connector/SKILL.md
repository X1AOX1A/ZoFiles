---
name: zotero-connector
description: |
  Import arXiv papers into Zotero with duplicate detection and batch support.
  TRIGGER when: user asks to import papers, add arxiv papers to zotero, batch import papers,
  check for duplicate papers in zotero, mentions importing by arXiv ID, or wants to list Zotero collections.
  DO NOT TRIGGER when: user is working on ZoFiles plugin code, exporting papers, or general Zotero questions.
---

# Zotero Connector — arXiv Paper Importer

Import arXiv papers into Zotero via the local connector API (`localhost:23119`).
The script handles everything: ID normalization, duplicate detection, metadata fetch,
PDF download, and optional collection targeting.

## Script Location

```
.claude/skills/zotero-connector/scripts/import_arxiv.py
```

Python 3.8+ required, stdlib only (no pip install needed).

## Quick Reference

```bash
SCRIPT=".claude/skills/zotero-connector/scripts/import_arxiv.py"

# Single paper
python $SCRIPT 2301.07041

# Multiple papers
python $SCRIPT 2301.07041 2310.06825 1706.03762

# Into a specific collection (by path or ID)
python $SCRIPT --collection "By Topic/Agent" 2301.07041
python $SCRIPT --collection C148 2301.07041

# Dry run — check duplicates without importing
python $SCRIPT --dry-run 2301.07041 2310.06825

# Force import (skip duplicate check)
python $SCRIPT --force 2301.07041

# Silently skip duplicates (don't show them at all)
python $SCRIPT --ignore-duplicates 2301.07041 2310.06825

# Parallel import (up to 5 concurrent)
python $SCRIPT --parallel 3 ID1 ID2 ID3 ID4 ID5

# List all collections
python $SCRIPT --list-collections
```

## Input Formats

The script accepts arXiv IDs in any form — it normalizes them automatically:

| Format       | Example                            |
| ------------ | ---------------------------------- |
| New-style ID | `2301.07041`                       |
| With version | `2301.07041v2` (version stripped)  |
| Old-style ID | `hep-th/0601001`                   |
| Full URL     | `https://arxiv.org/abs/2301.07041` |
| Prefixed     | `arXiv:2301.07041`                 |
| DOI form     | `10.48550/arXiv.2301.07041`        |

## Collection Targeting

When importing, use `--collection` to place papers in a specific Zotero collection.
The argument can be a connector ID (`C148`) or a path suffix (`Agent/Agent`, `By Topic/Agent`).
Path matching is case-insensitive and matches from the end, so `"Agent"` matches any
collection named "Agent" (ambiguous matches produce an error with suggestions).

### Collection Cache

A cache of the collection tree lives at `.claude/skills/zotero-connector/scripts/collections`.
**Always read the cache first** to resolve collection names — avoid calling `--list-collections`
on every import:

```bash
# Read existing cache
cat .claude/skills/zotero-connector/scripts/collections

# Refresh if missing or stale (--collection failed with "not found")
python $SCRIPT --list-collections > .claude/skills/zotero-connector/scripts/collections
```

## Duplicate Detection

The script auto-detects duplicates using a multi-strategy fallback (no configuration needed):

1. **ZoFiles index** (`.zofiles-index.json`) — fastest, auto-detected from Zotero prefs
2. **Zotero SQLite** — comprehensive, reads the database in immutable mode (safe while Zotero runs)
3. **None available** — warns and continues without dedup

Override the index path with `--zofiles-index /path/to/.zofiles-index.json` if auto-detection fails.

## Output

- **Progress** → stderr (colored, human-readable)
- **JSON result** → stdout (machine-parseable)
- **Exit codes**: 0 = success, 1 = fatal error, 2 = partial failure

## Prerequisites

- Zotero 7/8 running locally with the HTTP server enabled (Edit → Settings → Advanced →
  "Allow other applications on this computer to communicate with Zotero" — on by default)
- Python 3.8+

## How It Works (internals)

1. Ping Zotero connector at `localhost:23119`
2. Normalize all input IDs to canonical form
3. Check duplicates (ZoFiles index → Zotero SQLite → skip)
4. Batch-fetch metadata from arXiv API (20 IDs/request, 3s rate limit)
5. POST each paper to `/connector/saveItems` (metadata + authors + tags)
6. If `--collection` specified, call `/connector/updateSession` to move the item
   (the connector's `saveItems` always saves to the UI-selected collection, so
   `updateSession` is the only way to target a specific collection)
7. Download PDF from arXiv and push via `/connector/saveAttachment`
8. Report summary as JSON on stdout
