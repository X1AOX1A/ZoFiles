import { sanitizeFilename, joinPath } from "./utils";
import { getPref } from "../utils/prefs";

/**
 * Represents a node in the Zotero collection tree,
 * mapped to a filesystem directory.
 */
export interface CollectionNode {
  /** Zotero collection ID */
  id: number;
  /** Original collection name */
  name: string;
  /** Sanitized name safe for filesystem use */
  fsName: string;
  /** Child collection nodes */
  children: CollectionNode[];
  /** IDs of items directly in this collection (non-recursive) */
  itemIds: number[];
  /**
   * True when this collection has both direct items AND subcollections.
   * Items should be placed in an "Allin" subdirectory to separate them
   * from subcollection directories.
   */
  needsAllin: boolean;
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

/**
 * Build the full collection tree for the current user library.
 *
 * If the `enabledCollections` preference contains a non-empty JSON array of
 * collection IDs, only those collections (and their ancestors/descendants)
 * are included. An empty array means all collections are exported.
 */
export async function buildCollectionTree(): Promise<CollectionNode[]> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const collections = Zotero.Collections.getByLibrary(libraryID);

  // Find root collections (no parent)
  const roots = collections.filter((c: any) => !c.parentID);

  // Parse enabled collection IDs from preferences
  const enabledJson = getPref("enabledCollections") as string;
  let enabledIds: number[] = [];
  try {
    enabledIds = enabledJson ? JSON.parse(enabledJson) : [];
  } catch {
    // Malformed JSON — treat as "all enabled"
    enabledIds = [];
  }

  const tree: CollectionNode[] = [];
  for (const col of roots) {
    const node = await buildNode(col, enabledIds);
    if (node) tree.push(node);
  }

  // Sort alphabetically at root level
  tree.sort((a, b) => a.name.localeCompare(b.name));
  return tree;
}

/**
 * Recursively build a CollectionNode from a Zotero collection object.
 * Returns null if the collection (and all its descendants) are filtered out
 * by the enabled list.
 */
async function buildNode(
  collection: any, // Zotero.Collection
  enabledIds: number[],
): Promise<CollectionNode | null> {
  // If enabledIds is non-empty, check if this collection or any descendant
  // is in the enabled set. If not, prune the entire subtree.
  const isEnabled =
    enabledIds.length === 0 ||
    enabledIds.includes(collection.id) ||
    hasEnabledDescendant(collection, enabledIds);

  if (!isEnabled) return null;

  // Recursively build children
  const childCollections = collection.getChildCollections();
  const children: CollectionNode[] = [];
  for (const child of childCollections) {
    const childNode = await buildNode(child, enabledIds);
    if (childNode) children.push(childNode);
  }
  children.sort((a, b) => a.name.localeCompare(b.name));

  // Get direct child item IDs (non-recursive — passing true returns IDs only)
  const itemIds = collection.getChildItems(true) as number[];

  return {
    id: collection.id,
    name: collection.name,
    fsName: sanitizeFilename(collection.name),
    children,
    itemIds,
    // Needs "Allin" subdir when there are both items and subcollections
    needsAllin: children.length > 0 && itemIds.length > 0,
  };
}

/**
 * Check if any descendant of the given collection is in the enabled list.
 */
function hasEnabledDescendant(
  collection: any,
  enabledIds: number[],
): boolean {
  for (const child of collection.getChildCollections()) {
    if (enabledIds.includes(child.id)) return true;
    if (hasEnabledDescendant(child, enabledIds)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Item path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve all filesystem paths where a given item should appear
 * based on its collection memberships in the tree.
 *
 * An item in a collection that has both subcollections and direct items
 * gets placed in the "Allin/" subdirectory to avoid mixing paper folders
 * with subcollection directories.
 *
 * @param itemId   - The Zotero item ID to look up
 * @param tree     - The pre-built collection tree
 * @param basePath - The export root directory
 * @returns Filesystem directory paths (not including the paper folder itself)
 */
export function resolveItemPaths(
  itemId: number,
  tree: CollectionNode[],
  basePath: string,
): string[] {
  const paths: string[] = [];
  walkTree(tree, basePath, itemId, paths);
  return paths;
}

/**
 * Recursively walk the tree to find all directories where itemId should appear.
 */
function walkTree(
  nodes: CollectionNode[],
  basePath: string,
  itemId: number,
  paths: string[],
): void {
  for (const node of nodes) {
    const nodePath = joinPath(basePath, node.fsName);

    if (node.itemIds.includes(itemId)) {
      // If this collection has both subcollections and direct items,
      // place items in an "Allin" subdirectory
      const targetDir = node.needsAllin
        ? joinPath(nodePath, "Allin")
        : nodePath;
      paths.push(targetDir);
    }

    // Continue walking into children
    walkTree(node.children, nodePath, itemId, paths);
  }
}

// ---------------------------------------------------------------------------
// Tree utilities
// ---------------------------------------------------------------------------

/**
 * Flatten the collection tree into a single array of all nodes.
 * Useful for iterating over all collections regardless of nesting depth.
 */
export function flattenTree(nodes: CollectionNode[]): CollectionNode[] {
  const result: CollectionNode[] = [];
  for (const node of nodes) {
    result.push(node);
    result.push(...flattenTree(node.children));
  }
  return result;
}

/**
 * Get the configured export root directory from preferences.
 * Returns an empty string if not configured.
 */
export function getExportRoot(): string {
  return (getPref("exportRoot") as string) || "";
}
