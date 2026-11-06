import type { FileEntry, StagedState } from "./api";

export interface DirNode {
  kind: "dir";
  /** Shown on the row; several segments when a chain of folders is compacted. */
  name: string;
  /** Full path with a trailing slash, used to remember what is collapsed. */
  path: string;
  children: TreeNode[];
  /** Every file anywhere under this folder. */
  files: FileEntry[];
}

export interface FileNode {
  kind: "file";
  name: string;
  entry: FileEntry;
}

export type TreeNode = DirNode | FileNode;

/**
 * Turn the flat status list into folders and files. Folders come before files
 * at each level, and a folder whose only child is another folder is merged
 * into it, so `src-tauri/src` is one row, not two.
 */
export function buildTree(files: FileEntry[]): TreeNode[] {
  const root: DirNode = { kind: "dir", name: "", path: "", children: [], files: [] };

  for (const f of files) {
    const parts = f.path.split("/");
    let dir = root;
    dir.files.push(f);
    for (const seg of parts.slice(0, -1)) {
      const path = `${dir.path}${seg}/`;
      let next = dir.children.find(
        (c): c is DirNode => c.kind === "dir" && c.path === path,
      );
      if (!next) {
        next = { kind: "dir", name: seg, path, children: [], files: [] };
        dir.children.push(next);
      }
      next.files.push(f);
      dir = next;
    }
    dir.children.push({ kind: "file", name: parts[parts.length - 1], entry: f });
  }

  return root.children.map(compact).sort(dirsFirst);
}

function compact(node: TreeNode): TreeNode {
  if (node.kind === "file") return node;
  let d = node;
  while (d.children.length === 1 && d.children[0].kind === "dir") {
    const only = d.children[0];
    d = { ...only, name: `${d.name}/${only.name}` };
  }
  return { ...d, children: d.children.map(compact).sort(dirsFirst) };
}

function dirsFirst(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** How many folders hold changes directly, which is what makes a list hard to scan. */
export function dirCount(files: FileEntry[]): number {
  return new Set(files.map((f) => f.path.slice(0, f.path.lastIndexOf("/") + 1))).size;
}

/**
 * The checkbox for a set of files. WHY-only files can't be staged, so they
 * are left out; `null` means nothing in the set can be staged at all.
 */
export function stagedStateOf(files: FileEntry[]): StagedState | null {
  const stageable = files.filter((f) => !f.whyOnly);
  if (stageable.length === 0) return null;
  const staged = stageable.filter((f) => f.stagedState !== "none").length;
  if (staged === 0) return "none";
  return staged === stageable.length && stageable.every((f) => f.stagedState === "all")
    ? "all"
    : "partial";
}
