import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { ensureDir, joinPath } from "../utils";
import { kimiHtmlToMarkdown } from "../html-to-md";

/**
 * Fetches the Kimi AI-generated review/summary from papers.cool
 * and writes it as `kimi.md`.
 *
 * Results are cached since they don't change once generated.
 * Sets `linkBack: true` so the file can be linked back to Zotero.
 */
export class KimiProvider extends BaseProvider {
  readonly id = "kimi";
  readonly displayName = "Kimi Review";
  readonly prefKey = "exportKimi";

  async export(ctx: ExportContext): Promise<ProviderResult> {
    const targetPath = joinPath(ctx.paperDir, "kimi.md");
    const cachePath = joinPath(ctx.cacheDir, "kimi.md");

    try {
      // Check cache first
      const cached = await this.readCache(cachePath);
      if (cached) {
        const content = new TextEncoder().encode(cached);
        await IOUtils.write(targetPath, content);
        return { success: true, files: [targetPath], linkBack: true };
      }

      // Fetch from papers.cool Kimi API
      const url = `https://papers.cool/arxiv/kimi?paper=${ctx.arxivId}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      if (!response.ok) {
        return {
          success: false,
          files: [],
          error: `Kimi fetch failed: HTTP ${response.status}`,
        };
      }

      const html = await response.text();

      // Empty response means Kimi hasn't generated a review for this paper
      if (!html || !html.trim()) {
        return {
          success: false,
          files: [],
          error: `Kimi review not available for ${ctx.arxivId}`,
        };
      }

      // Convert HTML to Markdown
      const mdBody = kimiHtmlToMarkdown(html);

      // Build final markdown with header and source links
      const title = String(ctx.item.getField("title") || ctx.arxivId);
      const markdown = [
        `# ${title}`,
        "",
        `> Kimi review for [${ctx.arxivId}](https://arxiv.org/abs/${ctx.arxivId})`,
        `> Source: [papers.cool](https://papers.cool/arxiv/paper/${ctx.arxivId})`,
        "",
        mdBody,
      ].join("\n");

      // Write to cache
      await ensureDir(ctx.cacheDir);
      const cacheContent = new TextEncoder().encode(markdown);
      await IOUtils.write(cachePath, cacheContent);

      // Write to target
      const content = new TextEncoder().encode(markdown);
      await IOUtils.write(targetPath, content);

      return { success: true, files: [targetPath], linkBack: true };
    } catch (e: any) {
      return {
        success: false,
        files: [],
        error: `Failed to export Kimi review: ${e.message}`,
      };
    }
  }

  async cleanup(paperDir: string): Promise<void> {
    const filePath = joinPath(paperDir, "kimi.md");
    try {
      await IOUtils.remove(filePath, { ignoreAbsent: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Read cached Kimi markdown if it exists.
   */
  private async readCache(cachePath: string): Promise<string | null> {
    try {
      const exists = await IOUtils.exists(cachePath);
      if (!exists) return null;
      const bytes = await IOUtils.read(cachePath);
      const text = new TextDecoder().decode(bytes);
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }
}
