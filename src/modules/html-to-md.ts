/**
 * HTML to Markdown converter.
 * Used for Zotero notes and Kimi review HTML content.
 *
 * Pure regex-based converter — no DOM dependency.
 */

/**
 * Convert HTML string to Markdown.
 */
export function htmlToMarkdown(html: string): string {
  let text = html;

  // Remove <head>, <style>, <script> blocks
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");

  // Strip Zotero note wrapper div
  text = text.replace(/^<div class="zotero-note[^"]*">\s*/i, "");
  text = text.replace(/\s*<\/div>\s*$/i, "");

  // Headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Bold and italic (before link processing)
  text = text.replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  text = text.replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

  // Links
  text = text.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    "[$2]($1)",
  );

  // Images
  text = text.replace(
    /<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi,
    "![$1]($2)",
  );
  text = text.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");

  // Code blocks
  text = text.replace(
    /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    "\n```\n$1\n```\n",
  );
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");

  // Blockquotes
  text = text.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_: string, content: string) => {
      return (
        "\n" +
        content
          .trim()
          .split("\n")
          .map((line: string) => "> " + line)
          .join("\n") +
        "\n"
      );
    },
  );

  // Horizontal rules
  text = text.replace(/<hr[^>]*\/?>/gi, "\n---\n");

  // Unordered lists
  text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_: string, content: string) => {
    return (
      "\n" + content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n") + "\n"
    );
  });

  // Ordered lists
  text = text.replace(
    /<ol[^>]*>([\s\S]*?)<\/ol>/gi,
    (_: string, content: string) => {
      let counter = 0;
      const result = content.replace(
        /<li[^>]*>([\s\S]*?)<\/li>/gi,
        (_m: string, liContent: string) => {
          counter++;
          return `${counter}. ${liContent.trim()}\n`;
        },
      );
      return "\n" + result + "\n";
    },
  );

  // Remaining list items (nested)
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  // Line breaks and paragraphs
  text = text.replace(/<br\s*\/?>/gi, "  \n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<p[^>]*>/gi, "");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<div[^>]*>/gi, "");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = decodeEntities(text);

  // Clean up excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Convert Kimi HTML output (from papers.cool) to Markdown.
 * Handles the specific Q&A format of papers.cool responses.
 */
export function kimiHtmlToMarkdown(html: string): string {
  let text = html;

  // Convert Q&A headings
  text = text.replace(
    /<p class="faq-q"><strong>(Q\d+)<\/strong>:\s*(.+?)<\/p>/gi,
    "## $1: $2\n",
  );

  // Remove faq-a div tags
  text = text.replace(/<div class="faq-a">\s*/g, "");
  text = text.replace(/\s*<\/div>/g, "");

  // Use general converter for the rest
  return htmlToMarkdown(text);
}

/**
 * Strip all HTML tags, returning plain text.
 */
export function stripHtml(html: string): string {
  let text = html.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return text.trim();
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
