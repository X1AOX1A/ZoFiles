import { getPref } from "../../utils/prefs";

/**
 * Context passed to each content provider during export.
 */
export interface ExportContext {
  /** The Zotero item being exported */
  item: Zotero.Item;
  /** Extracted arXiv ID (e.g. "2301.12345") */
  arxivId: string;
  /** Target paper directory on the filesystem */
  paperDir: string;
  /** Cache directory for this paper (keyed by arXiv ID) */
  cacheDir: string;
}

/**
 * Result returned by a content provider after export.
 */
export interface ProviderResult {
  /** Whether the export succeeded */
  success: boolean;
  /** List of files created/copied in paperDir */
  files: string[];
  /** Error message if success is false */
  error?: string;
  /** If true, the generated file should be linked back to Zotero as an attachment */
  linkBack?: boolean;
}

/**
 * Interface that all content providers must implement.
 */
export interface ContentProvider {
  /** Unique identifier for this provider */
  readonly id: string;
  /** Human-readable name */
  readonly displayName: string;
  /** Preference key that controls whether this provider is enabled */
  readonly prefKey: string;

  /** Check whether this provider is enabled via user preferences */
  isEnabled(): boolean;

  /** Export content for the given item into paperDir */
  export(ctx: ExportContext): Promise<ProviderResult>;

  /** Clean up any provider-specific files from paperDir */
  cleanup(paperDir: string): Promise<void>;
}

/**
 * Base class with default implementations for content providers.
 */
export abstract class BaseProvider implements ContentProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly prefKey: string;

  isEnabled(): boolean {
    return getPref(this.prefKey as any) as boolean;
  }

  abstract export(ctx: ExportContext): Promise<ProviderResult>;

  async cleanup(_paperDir: string): Promise<void> {
    // Override in subclasses if cleanup is needed
  }
}
