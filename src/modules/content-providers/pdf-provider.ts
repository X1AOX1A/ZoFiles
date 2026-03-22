import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { joinPath, copyOrSymlink } from "../utils";

/**
 * Copies or symlinks the paper's PDF attachment into the export directory.
 * Respects the `pdfMode` preference ("copy" or "symlink").
 */
export class PdfProvider extends BaseProvider {
  readonly id = "pdf";
  readonly displayName = "PDF";
  readonly prefKey = "exportPdf";

  async export(ctx: ExportContext): Promise<ProviderResult> {
    try {
      const attachmentIds = ctx.item.getAttachments();
      if (!attachmentIds || attachmentIds.length === 0) {
        return {
          success: false,
          files: [],
          error: "No attachments found",
        };
      }

      // Find the first PDF attachment
      let pdfPath: string | null = null;
      for (const attId of attachmentIds) {
        const att = Zotero.Items.get(attId);
        if (!att || !att.isAttachment()) continue;
        const contentType = att.attachmentContentType;
        if (contentType === "application/pdf") {
          const result = await att.getFilePathAsync();
          if (result && typeof result === "string") {
            pdfPath = result;
            break;
          }
        }
      }

      if (!pdfPath) {
        return {
          success: false,
          files: [],
          error: "No PDF attachment found",
        };
      }

      // Verify the source PDF exists
      const exists = await IOUtils.exists(pdfPath);
      if (!exists) {
        return {
          success: false,
          files: [],
          error: `PDF file not found on disk: ${pdfPath}`,
        };
      }

      const targetPath = joinPath(ctx.paperDir, "paper.pdf");
      // copyOrSymlink reads pdfMode preference internally
      await copyOrSymlink(pdfPath, targetPath);

      return { success: true, files: [targetPath] };
    } catch (e: any) {
      return {
        success: false,
        files: [],
        error: `Failed to export PDF: ${e.message}`,
      };
    }
  }

  async cleanup(paperDir: string): Promise<void> {
    const filePath = joinPath(paperDir, "paper.pdf");
    try {
      await IOUtils.remove(filePath, { ignoreAbsent: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
