import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { ensureDir, joinPath } from "../utils";

/**
 * Simple rate limiter to avoid exceeding API limits.
 * Tracks request timestamps and enforces a maximum rate.
 */
class RateLimiter {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Wait until a request can be made within the rate limit.
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    // Remove timestamps outside the window
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      // Wait until the oldest request in the window expires
      const oldest = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldest) + 100; // +100ms buffer
      await new Promise((resolve) => Zotero.setTimeout(resolve, waitMs));
      return this.acquire(); // Re-check after waiting
    }

    this.timestamps.push(Date.now());
  }
}

// Global rate limiter: 30 requests per minute for arxiv2md.org
const rateLimiter = new RateLimiter(30, 60_000);

/**
 * Fetches the full-text Markdown conversion of the paper from arxiv2md.org
 * and writes it as `paper.md`.
 *
 * Respects a 30 requests/minute rate limit.
 * Results are cached since the paper content doesn't change.
 * Sets `linkBack: true` so the file can be linked back to Zotero.
 */
export class MarkdownProvider extends BaseProvider {
  readonly id = "markdown";
  readonly displayName = "Markdown";
  readonly prefKey = "exportMarkdown";

  async export(ctx: ExportContext): Promise<ProviderResult> {
    const targetPath = joinPath(ctx.paperDir, "paper.md");
    const cachePath = joinPath(ctx.cacheDir, "paper.md");

    try {
      // Check cache first
      const cached = await this.readCache(cachePath);
      if (cached) {
        const content = new TextEncoder().encode(cached);
        await IOUtils.write(targetPath, content);
        return { success: true, files: [targetPath], linkBack: true };
      }

      // Respect rate limit before making request
      await rateLimiter.acquire();

      // Fetch from arxiv2md.org
      const params = new URLSearchParams({
        url: ctx.arxivId,
        remove_refs: "false",
        remove_toc: "false",
        remove_citations: "false",
        frontmatter: "true",
      });
      const url = `https://arxiv2md.org/api/markdown?${params.toString()}`;

      const response = await fetch(url);

      if (!response.ok) {
        return {
          success: false,
          files: [],
          error: `arxiv2md fetch failed: HTTP ${response.status}`,
        };
      }

      const markdown = await response.text();

      if (!markdown || !markdown.trim()) {
        return {
          success: false,
          files: [],
          error: `Empty markdown response for ${ctx.arxivId}`,
        };
      }

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
        error: `Failed to export Markdown: ${e.message}`,
      };
    }
  }

  async cleanup(paperDir: string): Promise<void> {
    const filePath = joinPath(paperDir, "paper.md");
    try {
      await IOUtils.remove(filePath, { ignoreAbsent: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Read cached markdown if it exists.
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
