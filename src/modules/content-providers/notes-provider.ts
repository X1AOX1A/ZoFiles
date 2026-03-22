import { BaseProvider, ExportContext, ProviderResult } from "./provider";
import { ensureDir, joinPath, sanitizeFilename } from "../utils";
import { htmlToMarkdown } from "../html-to-md";

/**
 * Exports Zotero notes attached to the item as individual Markdown files
 * in a `notes/` subdirectory.
 */
export class NotesProvider extends BaseProvider {
  readonly id = "notes";
  readonly displayName = "Notes";
  readonly prefKey = "exportNotes";

  async export(ctx: ExportContext): Promise<ProviderResult> {
    try {
      const noteIds = ctx.item.getNotes();
      if (!noteIds || noteIds.length === 0) {
        // No notes is not an error — just nothing to export
        return { success: true, files: [] };
      }

      const notesDir = joinPath(ctx.paperDir, "notes");
      await ensureDir(notesDir);

      const files: string[] = [];
      const errors: string[] = [];

      for (const noteId of noteIds) {
        try {
          const note = Zotero.Items.get(noteId);
          if (!note) continue;

          // Get HTML content and title
          const html = note.getNote();
          if (!html) continue;

          const title = note.getNoteTitle() || `note-${noteId}`;
          const safeName = sanitizeFilename(title);
          const fileName = `${safeName}.md`;

          // Convert HTML to Markdown
          const markdown = htmlToMarkdown(html);

          // Write the note
          const filePath = joinPath(notesDir, fileName);
          const content = new TextEncoder().encode(markdown);
          await IOUtils.write(filePath, content);
          files.push(filePath);
        } catch (e: any) {
          errors.push(`Note ${noteId}: ${e.message}`);
        }
      }

      if (files.length === 0 && errors.length > 0) {
        return {
          success: false,
          files: [],
          error: `All notes failed: ${errors.join("; ")}`,
        };
      }

      return {
        success: true,
        files,
        error:
          errors.length > 0
            ? `Some notes failed: ${errors.join("; ")}`
            : undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        files: [],
        error: `Failed to export notes: ${e.message}`,
      };
    }
  }

  async cleanup(paperDir: string): Promise<void> {
    const notesDir = joinPath(paperDir, "notes");
    try {
      await IOUtils.remove(notesDir, { recursive: true, ignoreAbsent: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
