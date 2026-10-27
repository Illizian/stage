import { invoke } from "@tauri-apps/api/core";

export type StagedState = "none" | "partial" | "all";

export interface FileEntry {
  path: string;
  origPath: string | null;
  /** Porcelain v2 index-side letter; "." means unchanged. */
  indexStatus: string;
  /** Porcelain v2 worktree-side letter; "." means unchanged. */
  workStatus: string;
  untracked: boolean;
  unmerged: boolean;
  stagedState: StagedState;
}

export interface Status {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  files: FileEntry[];
}

export type RowKind = "context" | "add" | "del";

export interface DiffRow {
  idx: number;
  kind: RowKind;
  text: string;
  /** Line number in HEAD. */
  oldLine: number | null;
  /** Line number in the worktree. */
  newLine: number | null;
  /** Whether this change is currently in the index. */
  staged: boolean;
  selectable: boolean;
  /** Handle used to toggle this line; meaningful only to the backend. */
  pos: number;
  /** Contiguous run of changed lines, for toggling a whole hunk. */
  group: number;
  /** False for unchanged lines far from any change. */
  visible: boolean;
  /** Identifies the folded run, so one gap can be expanded at a time. */
  gap: number;
  nonl: boolean;
}

export interface FileDiff {
  path: string;
  binary: boolean;
  truncated: boolean;
  selectable: boolean;
  reason: string | null;
  rows: DiffRow[];
  hash: string;
}

export interface RepoInfo {
  root: string;
  name: string;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  relative: string;
}

export const api = {
  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),

  status: (root: string) => invoke<Status>("repo_status", { root }),

  diff: (root: string, path: string, origPath: string | null, untracked: boolean) =>
    invoke<FileDiff>("file_diff", { root, path, origPath, untracked }),

  stageFile: (root: string, path: string) =>
    invoke<void>("stage_file", { root, path }),

  unstageFile: (root: string, path: string, origPath: string | null) =>
    invoke<void>("unstage_file", { root, path, origPath }),

  stageAll: (root: string) => invoke<void>("stage_all", { root }),

  unstageAll: (root: string) => invoke<void>("unstage_all", { root }),

  /**
   * Stage or unstage the given lines. `positions` are `DiffRow.pos` handles
   * for rows that are not already in the requested state, so one call only
   * ever moves lines one way.
   */
  setLinesStaged: (
    root: string,
    path: string,
    positions: number[],
    staged: boolean,
    hash: string,
  ) => invoke<void>("set_lines_staged", { root, path, positions, staged, hash }),

  commit: (root: string, summary: string, description: string) =>
    invoke<string>("commit", { root, summary, description }),

  lastCommit: (root: string) => invoke<CommitInfo | null>("last_commit", { root }),

  gitInfo: () => invoke<string>("git_info"),

  initialRepo: () => invoke<string | null>("initial_repo"),
};

/** Single letter shown in the file list badge. */
export function statusLetter(f: FileEntry): string {
  if (f.unmerged) return "U";
  if (f.untracked) return "A";
  const c = f.workStatus !== "." ? f.workStatus : f.indexStatus;
  switch (c) {
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
    case "C":
      return "R";
    case "U":
      return "U";
    default:
      return "M";
  }
}

export function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return i === -1 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}
