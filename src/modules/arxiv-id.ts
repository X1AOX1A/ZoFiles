/**
 * arXiv ID extraction from Zotero items.
 *
 * Checks fields in priority order: archiveID → DOI → url → extra
 * Supports new-style (YYMM.NNNNN) and old-style (subject/YYMMNNN) IDs.
 */

// New-style: YYMM.NNNNN where YY=07-29, MM=01-12
const NEW_STYLE_RE =
  /(?:arXiv[:\s]*)?((?:0[7-9]|[12]\d)(?:0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?)/i;

// Old-style: subject/YYMMNNN
const OLD_STYLE_RE =
  /(?:arXiv[:\s]*)?((?:astro-ph|cond-mat|gr-qc|hep-(?:ex|lat|ph|th)|math-ph|nlin|nucl-(?:ex|th)|physics|quant-ph|cs|math|q-bio|q-fin|stat|eess)(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;

/**
 * Parse a raw string for an arXiv ID.
 * Returns the bare ID (e.g. "2311.10702") or null.
 */
export function parseArxivId(value: string): string | null {
  if (!value) return null;
  let m = NEW_STYLE_RE.exec(value);
  if (m) return m[1];
  m = OLD_STYLE_RE.exec(value);
  if (m) return m[1];
  return null;
}

/**
 * Extract an arXiv ID from a Zotero item.
 * Checks fields in priority order:
 * 1. archiveID — most reliable
 * 2. DOI — e.g. "10.48550/arXiv.2311.10702"
 * 3. url — e.g. "https://arxiv.org/abs/2311.10702"
 * 4. extra — freeform text
 *
 * Returns null if no arXiv ID found (paper will be skipped for export).
 */
export function extractArxivId(item: Zotero.Item): string | null {
  const fields = ["archiveID", "DOI", "url", "extra"] as const;
  for (const field of fields) {
    try {
      const value = item.getField(field as string) as string;
      if (value) {
        const id = parseArxivId(value);
        if (id) return id;
      }
    } catch {
      // Field may not exist for this item type
      continue;
    }
  }
  return null;
}

/**
 * Strip version suffix from arXiv ID (e.g. "2311.10702v2" → "2311.10702")
 */
export function stripVersion(arxivId: string): string {
  return arxivId.replace(/v\d+$/, "");
}
