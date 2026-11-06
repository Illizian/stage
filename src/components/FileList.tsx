import { useState } from "react";
import { splitPath, statusLetter, type FileEntry } from "../api";
import { buildTree, dirCount, stagedStateOf, type TreeNode } from "../tree";
import { Check } from "./Check";

// The tree turns on once the list is long and spread across folders, and only
// turns off again once it is well short of that. One threshold would flip the
// sidebar's shape back and forth as files are staged and committed.
const TREE_FILES = 15;
const TREE_DIRS = 4;
const LIST_FILES = 8;
const LIST_DIRS = 2;

/** Pixels each level of the tree is pushed in. */
const INDENT = 14;
/** A folder's chevron and the gap after it, so files line up with its checkbox. */
const CHEV = 12 + 9;

export function FileList({
  files,
  selected,
  onSelect,
  onToggle,
  onToggleFiles,
  onToggleAll,
}: {
  files: FileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
  onToggle: (f: FileEntry) => void;
  onToggleFiles: (files: FileEntry[], stage: boolean) => void;
  onToggleAll: (stageEverything: boolean) => void;
}) {
  const allState = stagedStateOf(files) ?? "none";

  const dirs = dirCount(files);
  const [autoTree, setAutoTree] = useState(false);
  const wantTree = autoTree
    ? files.length >= LIST_FILES && dirs >= LIST_DIRS
    : files.length >= TREE_FILES && dirs >= TREE_DIRS;
  if (wantTree !== autoTree) setAutoTree(wantTree);

  // Set from the header button; lasts until the app is closed.
  const [override, setOverride] = useState<boolean | null>(null);
  const tree = override ?? wantTree;

  // Kept by path, so a refresh doesn't open everything back up.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const flip = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const fileRow = (f: FileEntry, depth: number | null) => {
    const [dir, name] = splitPath(f.path);
    const letter = statusLetter(f);
    return (
      <div
        key={f.path}
        role="option"
        aria-selected={f.path === selected}
        className={`frow${f.path === selected ? " sel" : ""}${f.whyOnly ? " why-only" : ""}`}
        style={depth === null ? undefined : { paddingLeft: 12 + depth * INDENT + CHEV }}
        onClick={() => onSelect(f.path)}
      >
        <Check
          state={f.stagedState}
          disabled={f.whyOnly}
          title={
            f.whyOnly
              ? "Only WHY comments are left, and they are never staged"
              : f.stagedState === "all"
                ? "Unstage this file"
                : "Stage this whole file"
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggle(f);
          }}
        />
        <span className="fpath" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
          {depth === null && <span className="fdir">{dir}</span>}
          <span className="fname">{name}</span>
        </span>
        <span className={`badge b-${letter}`} title={describe(f)}>
          {letter}
        </span>
      </div>
    );
  };

  const treeRows = (nodes: TreeNode[], depth: number): React.ReactNode[] =>
    nodes.flatMap((n) => {
      if (n.kind === "file") return [fileRow(n.entry, depth)];
      const open = !collapsed.has(n.path);
      const state = stagedStateOf(n.files);
      return [
        <div
          key={n.path}
          className="frow dirrow"
          style={{ paddingLeft: 12 + depth * INDENT }}
          aria-expanded={open}
          onClick={() => flip(n.path)}
        >
          <svg viewBox="0 0 12 12" className={`dchev${open ? " open" : ""}`} aria-hidden="true">
            <path d="M4.5 3 7.5 6 4.5 9" fill="none" strokeWidth="1.4" />
          </svg>
          <Check
            state={state ?? "none"}
            disabled={state === null}
            title={
              state === null
                ? "Only WHY comments are left in here, and they are never staged"
                : state === "all"
                  ? "Unstage this folder"
                  : "Stage this whole folder"
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleFiles(n.files, state !== "all");
            }}
          />
          <span className="fpath" title={n.path}>
            <span className="fname">{n.name}</span>
          </span>
          <span className="dcount">{n.files.length}</span>
        </div>,
        ...(open ? treeRows(n.children, depth + 1) : []),
      ];
    });

  return (
    <div className="filelist">
      <div className="list-head">
        <Check
          state={allState}
          title={allState === "all" ? "Unstage everything" : "Stage everything"}
          onClick={() => onToggleAll(allState !== "all")}
        />
        <span>
          {files.length} changed file{files.length === 1 ? "" : "s"}
        </span>
        {files.length > 0 && (
          <button
            className="icon-btn view-btn"
            title={tree ? "Show as a list" : "Show as a tree"}
            onClick={() => setOverride(!tree)}
          >
            {tree ? <ListIcon /> : <TreeIcon />}
          </button>
        )}
      </div>

      <div className="rows" role="listbox" aria-label="Changed files">
        {tree ? treeRows(buildTree(files), 0) : files.map((f) => fileRow(f, null))}

        {files.length === 0 && <div className="empty-list">No local changes</div>}
      </div>
    </div>
  );
}

function describe(f: FileEntry): string {
  if (f.unmerged) return "Conflicted";
  if (f.untracked) return "New file (untracked)";
  const parts: string[] = [];
  if (f.indexStatus !== ".") parts.push(`staged: ${f.indexStatus}`);
  if (f.workStatus !== ".") parts.push(`unstaged: ${f.workStatus}`);
  return parts.join(", ");
}

function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" className="bicon" aria-hidden="true">
      <path d="M3 4h10M3 8h10M3 12h10" fill="none" strokeWidth="1.4" />
    </svg>
  );
}

function TreeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="bicon" aria-hidden="true">
      <path d="M3 3.5h6M5 3.5v8.5h6M5 8h6" fill="none" strokeWidth="1.4" />
    </svg>
  );
}
