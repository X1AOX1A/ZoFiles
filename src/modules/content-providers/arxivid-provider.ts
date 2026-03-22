import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { joinPath } from "../utils";

/**
 * Writes an `arxiv.id` file containing the paper's arXiv identifier.
 * This is a fast, local-only provider.
 */
export class ArxivIdProvider extends BaseProvider {
  readonly id = "arxivId";
  readonly displayName = "arXiv ID";
  readonly prefKey = "exportArxivId";

  async export(ctx: ExportContext): Promise<ProviderResult> {
    try {
      const filePath = joinPath(ctx.paperDir, "arxiv.id");
      const content = new TextEncoder().encode(ctx.arxivId + "\n");
      await IOUtils.write(filePath, content);
      return { success: true, files: [filePath] };
    } catch (e: any) {
      return {
        success: false,
        files: [],
        error: `Failed to write arxiv.id: ${e.message}`,
      };
    }
  }

  async cleanup(paperDir: string): Promise<void> {
    const filePath = joinPath(paperDir, "arxiv.id");
    try {
      await IOUtils.remove(filePath, { ignoreAbsent: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
