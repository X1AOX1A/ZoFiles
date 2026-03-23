---
name: zotero-connector
description: |
  Import arXiv papers into Zotero with duplicate detection and batch support.
  TRIGGER when: user asks to import papers, add arxiv papers to zotero, batch import papers,
  check for duplicate papers in zotero, or mentions importing by arXiv ID.
  DO NOT TRIGGER when: user is working on ZoFiles plugin code, exporting papers, or general Zotero questions.
---

# Zotero Connector — arXiv Paper Importer

## What This Does

Imports arXiv papers into a running Zotero instance via the local connector API (localhost:23119).
Supports batch import, duplicate detection (via ZoFiles index or Zotero SQLite), progress display,
and optional collection targeting.

## Prerequisites

- Zotero 7/8 must be running locally
- **Zotero HTTP Server must be enabled** (connector API on `localhost:23119`):
  - Zotero 7/8: Edit → Settings → Advanced → Check **"Allow other applications on this computer to communicate with Zotero"**
  - This is enabled by default. If the script reports "Cannot connect to Zotero", verify this setting is on and Zotero is running.
- Python 3.8+ available in PATH
- Default python path:

  ```bash
  <FILL_IN: ASK USER FOR THE DEFAULT PYTHON PATH AND UPDATE THIS FILE>
  ```

## Usage

Always run the script with `--help` first to see full usage:

```bash
python .claude/skills/zotero-connector/scripts/import_arxiv.py --help
```

### Basic Import

```bash
# Single paper
python .claude/skills/zotero-connector/scripts/import_arxiv.py 2301.07041

# Multiple papers
python .claude/skills/zotero-connector/scripts/import_arxiv.py 2301.07041 2310.06825 1706.03762

# From a file (one ID per line)
cat arxiv_ids.txt | xargs python .claude/skills/zotero-connector/scripts/import_arxiv.py
```

### Options

```bash
# Target a specific collection (fuzzy name match or exact key)
python .claude/skills/zotero-connector/scripts/import_arxiv.py --collection "LLM Papers" 2301.07041

# Dry run — check duplicates without importing
python .claude/skills/zotero-connector/scripts/import_arxiv.py --dry-run 2301.07041 2310.06825

# Force import (skip duplicate check)
python .claude/skills/zotero-connector/scripts/import_arxiv.py --force 2301.07041

# Parallel import (up to 5 concurrent)
python .claude/skills/zotero-connector/scripts/import_arxiv.py --parallel 3 ID1 ID2 ID3 ID4 ID5

# Specify ZoFiles index path for duplicate detection
python .claude/skills/zotero-connector/scripts/import_arxiv.py --zofiles-index /path/to/.zofiles-index.json 2301.07041
```

### Supported Input Formats

The script accepts arXiv IDs in any of these formats:
- `2301.07041` — new-style ID
- `2301.07041v2` — with version (version stripped for dedup)
- `hep-th/0601001` — old-style ID
- `https://arxiv.org/abs/2301.07041` — full URL
- `arXiv:2301.07041` — prefixed form

### Output

- **Progress** is displayed on stderr (visible in terminal)
- **JSON result** is written to stdout (machine-parseable)
- Exit codes: 0 = success, 1 = fatal error, 2 = partial failure

## How It Works

1. **Ping Zotero** — confirms connector is listening on localhost:23119
2. **Normalize IDs** — strips URLs, prefixes, versions to get canonical arXiv IDs
3. **Duplicate detection** (multi-strategy fallback):
   - ZoFiles index (`.zofiles-index.json`) — fastest
   - Zotero SQLite database — comprehensive
   - No detection available — warns and continues
4. **Fetch metadata** — batch query to arXiv API (up to 20 IDs per request, 3s rate limit)
5. **Import** — POST each paper to Zotero connector with full metadata + PDF attachment
6. **Report** — summary of imported, skipped, and failed papers

## When to Use This Skill

Use when the user says things like:
- "Import this arXiv paper: 2301.07041"
- "Add these papers to Zotero"
- "Batch import arXiv papers"
- "Check if I already have paper 2301.07041"
- "Import 2301.07041 into my LLM collection"
