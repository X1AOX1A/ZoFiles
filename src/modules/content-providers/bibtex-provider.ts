import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { ensureDir, joinPath } from "../utils";

/**
 * Fetches BibTeX citation data from arXiv and writes `paper.bib`.
 * Results are cached in the cache directory to avoid repeated network requests.
 */
export class BibtexProvider extends BaseProvider {
  readonly id = "bibtex";
  readonly displayName = "BibTeX";
  readonly prefKey = "exportBibtex";

  async export(ctx: ExportContext): Promise<ProviderResult> {
    const targetPath = joinPath(ctx.paperDir, "paper.bib");
    const cachePath = joinPath(ctx.cacheDir, "paper.bib");

    try {
      // Check cache first
      const cached = await this.readCache(cachePath);
      if (cached) {
        const content = new TextEncoder().encode(cached);
        await IOUtils.write(targetPath, content);
        return { success: true, files: [targetPath] };
      }

      // Fetch from arXiv
      const url = `https://arxiv.org/bibtex/${ctx.arxivId}`;
      const response = await fetch(url);

      if (!response.ok) {
        return {
          success: false,
          files: [],
          error: `arXiv BibTeX fetch failed: HTTP ${response.status}`,
        };
      }

      const bibtex = await response.text();

      // Validate — BibTeX entries start with "@"
      if (!bibtex.trim().startsWith("@")) {
        return {
          success: false,
          files: [],
          error: "Invalid BibTeX response from arXiv",
        };
      }

      // Write to cache
      await ensureDir(ctx.cacheDir);
      const cacheContent = new TextEncoder().encode(bibtex);
      await IOUtils.write(cachePath, cacheContent);

      // Write to target
      const content = new TextEncoder().encode(bibtex);
      await IOUtils.write(targetPath, content);

      return { success: true, files: [targetPath] };
    } catch (e: any) {
      return {
        success: false,
        files: [],
        error: `Failed to export BibTeX: ${e.message}`,
      };
    }
  }

  async cleanup(paperDir: string): Promise<void> {
    const filePath = joinPath(paperDir, "paper.bib");
    try {
      await IOUtils.remove(filePath, { ignoreAbsent: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Read cached BibTeX if it exists and is valid.
   */
  private async readCache(cachePath: string): Promise<string | null> {
    try {
      const exists = await IOUtils.exists(cachePath);
      if (!exists) return null;
      const bytes = await IOUtils.read(cachePath);
      const text = new TextDecoder().decode(bytes);
      return text.trim().startsWith("@") ? text : null;
    } catch {
      return null;
    }
  }
}
