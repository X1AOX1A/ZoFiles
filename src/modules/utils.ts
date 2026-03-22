/**
 * ZoFiles utility functions.
 *
 * Provides filesystem helpers, filename sanitization, and paper folder formatting.
 */

import { getPref } from "../utils/prefs";

/**
 * Sanitize a string for use as a filename/directory name.
 * Removes/replaces characters problematic on macOS/Linux/Windows.
 * Truncates to maxLen to avoid filesystem limits.
 *
 * Ported from zotero_symlinks.py sanitize_filename()
 */
export function sanitizeFilename(name: string, maxLen = 200): string {
  // Replace path separators and other bad chars
  let result = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  // Collapse multiple underscores/spaces
  result = result.replace(/[_\s]+/g, " ").trim();
  // Remove trailing dots/spaces
  result = result.replace(/[. ]+$/, "");
  // Truncate by bytes (UTF-8)
  const encoder = new TextEncoder();
  while (encoder.encode(result).length > maxLen) {
    result = result.slice(0, -1);
  }
  result = result.trim();
  if (result.length === 0) result = "Untitled";
  return result;
}

/**
 * Format a paper folder name by applying a template with token substitution.
 * Supported tokens: {arxivId}, {title}, {firstAuthor}, {year}, {authors}
 */
export function formatPaperFolderFromVars(
  template: string,
  vars: {
    arxivId: string;
    title: string;
    firstAuthor: string;
    year: string;
    authors: string[];
  },
): string {
  let result = template;
  result = result.replace(/\{arxivId\}/g, vars.arxivId);
  result = result.replace(/\{title\}/g, vars.title);
  result = result.replace(/\{firstAuthor\}/g, vars.firstAuthor);
  result = result.replace(/\{year\}/g, vars.year);
  result = result.replace(/\{authors\}/g, vars.authors.join(", "));
  return sanitizeFilename(result);
}

/**
 * Build a paper folder name from a Zotero item.
 * Reads the `paperFolderFormat` preference for the template and extracts
 * metadata (title, authors, year) from the item. Requires an arXiv ID
 * to have already been resolved by the caller.
 */
export function formatPaperFolder(item: Zotero.Item, arxivId?: string): string {
  const template =
    (getPref("paperFolderFormat") as string) || "{arxivId} - {title}";

  const title = String(item.getField("title") || "Untitled");

  // Extract first author last name
  const creators = item.getCreators();
  const firstAuthor =
    creators.length > 0 ? creators[0].lastName || "Unknown" : "Unknown";
  const authors = creators.map(
    (c) => c.lastName || c.firstName || "Unknown",
  );

  // Extract year from date field
  const dateStr = String(item.getField("date") || "");
  const yearMatch = dateStr.match(/\d{4}/);
  const year = yearMatch ? yearMatch[0] : "";

  return formatPaperFolderFromVars(template, {
    arxivId: arxivId || "",
    title,
    firstAuthor,
    year,
    authors,
  });
}

/**
 * Ensure a directory exists, creating parent directories as needed.
 */
export async function ensureDir(path: string): Promise<void> {
  await IOUtils.makeDirectory(path, {
    ignoreExisting: true,
    createAncestors: true,
  });
}

/**
 * Recursively remove a directory and all its contents.
 * Safe: does not follow symlinks into directories.
 */
export async function removeDir(path: string): Promise<void> {
  if (!(await IOUtils.exists(path))) return;
  await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
}

/**
 * Join path segments using PathUtils.
 */
export function joinPath(...segments: string[]): string {
  return PathUtils.join(...segments);
}

/**
 * Get the cache directory path for ZoFiles.
 * When called with an arxivId, returns the per-paper subdirectory.
 * Creates the directory if needed.
 * Uses preference or defaults to ~/.cache/ZoFiles
 */
export function getCachePath(arxivId?: string): string {
  let basePath = getPref("cachePath") as string;
  if (!basePath) {
    basePath = PathUtils.join(
      // @ts-expect-error - XPCOM class not in zotero-types
      Components.classes["@mozilla.org/file/directory_service;1"]
        .getService(Components.interfaces.nsIProperties)
        .get("Home", Components.interfaces.nsIFile).path,
      ".cache",
      "ZoFiles",
    );
  }
  if (arxivId) {
    return PathUtils.join(basePath, sanitizeFilename(arxivId));
  }
  return basePath;
}

/**
 * Copy or symlink a file depending on the given mode or the pdfMode preference.
 * If mode is not provided, reads from the `pdfMode` preference.
 */
export async function copyOrSymlink(
  sourcePath: string,
  targetPath: string,
  mode?: string,
): Promise<void> {
  const resolvedMode = mode || (getPref("pdfMode") as string) || "symlink";
  // Remove existing target
  await IOUtils.remove(targetPath, { ignoreAbsent: true });
  if (resolvedMode === "copy") {
    await IOUtils.copy(sourcePath, targetPath);
  } else {
    // Symlink mode (default)
    // @ts-expect-error - createSymlink is not in zotero-types but exists at runtime
    Zotero.File.createSymlink(sourcePath, targetPath);
  }
}

/**
 * Clean a directory by removing all its contents but keeping the directory itself.
 * Handles symlinks safely (doesn't follow them).
 */
export async function cleanDirectory(dirPath: string): Promise<void> {
  if (!(await IOUtils.exists(dirPath))) return;
  const children = await IOUtils.getChildren(dirPath);
  for (const child of children) {
    await IOUtils.remove(child, { recursive: true, ignoreAbsent: true });
  }
}
