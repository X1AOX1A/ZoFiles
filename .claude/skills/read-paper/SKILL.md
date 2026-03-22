---
name: read-paper
description: |
  How to read and work with academic paper folders exported by ZoFiles.
  Each paper folder (named like `{arxivId} - {title}`) contains structured files: paper.md (full text), paper.bib (citation), kimi.md (AI review), arxiv.id, notes/, and paper.pdf.
  Use this skill whenever the user asks you to read a paper, summarize a paper, cite a paper, review a paper, compare papers, or work with any folder that contains paper.md/paper.bib/kimi.md files — even if they don't mention "ZoFiles" explicitly.
---

# Reading Paper Folders

Paper folders are exported by ZoFiles from Zotero. Each folder is named `{arxivId} - {title}` and contains a set of structured files about one academic paper.

## Paper Library Location

The paper library is at:

```
<FILL_IN: ask the user for their ZoFiles export root path, then update this file>
```

If the path above is not filled in or doesn't exist, ask the user: "What's the path to your ZoFiles paper library?" Then update this section with the actual path, and update the directory structure example below accordingly.

## Directory Structure

The library mirrors the user's Zotero collection hierarchy. Collections become directories, sub-collections become subdirectories, and paper folders sit at the leaves:

```
<library_root>/
├── <Collection>/                        ← top-level collection
│   ├── <Sub-collection>/                ← sub-collection
│   │   ├── <Sub-sub-collection>/        ← deeper nesting
│   │   │   ├── 2512.18832 - From Word to World .../   ← paper folder
│   │   │   │   ├── paper.md
│   │   │   │   ├── paper.bib
│   │   │   │   ├── kimi.md
│   │   │   │   ├── arxiv.id
│   │   │   │   ├── paper.pdf
│   │   │   │   └── notes/
│   │   │   └── 2510.09577 - Dyna-Mind .../
│   │   └── Allin/                       ← papers directly in parent (not in any sub-collection)
│   └── Allin/                           ← papers directly in top-level collection
└── Allin/                               ← papers directly at root level
```

**Key patterns:**

- **`Allin/` directories** appear when a collection has both sub-collections and direct papers. The direct papers go into `Allin/` to avoid mixing folders and paper directories.
- **Paper folders** are always named `{arxivId} - {title}` (e.g. `2512.18832 - From Word to World Can Large Language Models be Implicit Text-based World Models`).
- To **find a paper by arXiv ID**, use glob: `**/2512.18832*` from the library root.
- To **browse a topic**, list the corresponding collection directory.
- To **see all papers**, recursively glob for `**/paper.md` or `**/arxiv.id`.

## Files in a Paper Folder

| File        | What it is                                               | When to read it                                                                                                                         |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `paper.md`  | Full-text Markdown of the paper                          | **Primary source.** Read this for any paper-related task.                                                                               |
| `paper.bib` | BibTeX citation entry                                    | When citing. **Always copy verbatim — never generate BibTeX yourself.**                                                                 |
| `kimi.md`   | AI-generated review in Chinese (Q&A format)              | Optional. Useful as a quick overview or to answer high-level questions without reading the full paper. Primarily for human consumption. |
| `arxiv.id`  | Plain text arXiv ID (e.g. `2505.17746`)                  | When you need the paper's identifier or arXiv URL.                                                                                      |
| `notes/`    | Directory of the user's personal notes as Markdown files | When the user asks about their notes or annotations on a paper.                                                                         |
| `paper.pdf` | Original PDF (or symlink to it)                          | Only read if specifically asked — prefer `paper.md` which is the same content in a more parseable format.                               |

## How to Read paper.md Efficiently

`paper.md` starts with a YAML frontmatter header containing metadata, followed by a table of contents, then the full paper text:

```yaml
---
title: "Paper Title"
authors: ["Author 1", "Author 2"]
url: "https://arxiv.org/abs/XXXX.XXXXX"
sections: 27
estimated_tokens: "12.9k"
---
## Contents
- 1 Introduction
- 2 Related Works
  - 2.1 ...
...
```

**Reading strategy:**

1. **Start with the frontmatter + table of contents** — this tells you the paper's structure, size (`estimated_tokens`), and lets you decide what to read
2. **Read selectively by section** — use the ToC to jump to relevant sections. No need to read the entire paper for most tasks.
3. **For a quick overview**: read Introduction + Conclusion (usually sections 1 and the last numbered section)
4. **For methodology details**: read the Methods/Approach section
5. **For results**: read Experiments/Results/Evaluation sections

When the paper is large (>15k tokens), avoid reading the entire file at once. Use offset/limit on the Read tool, or ask yourself which sections are actually needed for the user's question.

## Citation Rules

When the user needs to cite a paper:

1. Read `paper.bib` from the paper folder
2. **Copy the BibTeX entry exactly as-is** — do not modify, reformat, or regenerate it
3. The BibTeX is sourced from arXiv and is authoritative

This matters because hand-generated BibTeX often contains errors (wrong year, misspelled names, wrong venue). The file contains the correct citation.

## Working with kimi.md

`kimi.md` is a structured AI review in Chinese, organized as Q&A:

- Q1: 这篇论文试图解决什么问题？(What problem does this paper solve?)
- Q2: 有哪些相关研究？(Related work)
- Q3: 论文如何解决这个问题？(Methodology)
- Q4: 这是否是一个新的开发方法？(Novelty)
- ...and more

It's useful for getting a quick Chinese-language summary, but **always verify claims against paper.md** if accuracy matters — the review is AI-generated and may contain inaccuracies.

## Common Tasks

**"Summarize this paper"** → Read paper.md (Introduction + Conclusion), optionally skim kimi.md for a second perspective.

**"What's the main contribution?"** → Read Introduction section of paper.md.

**"Give me the BibTeX"** → Read and copy paper.bib verbatim.

**"Compare these two papers"** → Read paper.md from both folders (focus on Introduction + Methods + Results).

**"What did I note about this paper?"** → Read files in the notes/ directory.

**"What's the arXiv ID?"** → Read arxiv.id.
