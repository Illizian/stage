import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  type CommitInfo,
  type FileDiff,
  type FileEntry,
  type RepoInfo,
  type Status,
} from "./api";
import { TopBar } from "./components/TopBar";
import { FileList } from "./components/FileList";
import { DiffView } from "./components/DiffView";
import { CommitBox } from "./components/CommitBox";
import { useWindowFocus } from "./focus";

const RECENTS_KEY = "stage.recents";
const LAST_KEY = "stage.last";

function loadRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** "3 of 11 changed lines staged" — the tabs used to carry this information. */
function StagedCount({ diff }: { diff: FileDiff }) {
  const changed = diff.rows.filter((r) => r.kind !== "context");
  if (changed.length === 0) return null;
  const staged = changed.filter((r) => r.staged).length;
  return (
    <span className="dh-count">
      {staged} of {changed.length} changed line{changed.length === 1 ? "" : "s"} staged
    </span>
  );
}

export default function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [status, setStatus] = useState<Status | null>(null);
  const [last, setLast] = useState<CommitInfo | null>(null);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after every index mutation so the open diff reloads.
  const [tick, setTick] = useState(0);

  const files = status?.files ?? [];
  const entry = useMemo(
    () => files.find((f) => f.path === selPath) ?? null,
    [files, selPath],
  );

  const remember = useCallback((root: string) => {
    setRecents((prev) => {
      const next = [root, ...prev.filter((p) => p !== root)].slice(0, 10);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
    localStorage.setItem(LAST_KEY, root);
  }, []);

  const refresh = useCallback(async (root: string) => {
    const [s, lc] = await Promise.all([api.status(root), api.lastCommit(root)]);
    setStatus(s);
    setLast(lc);
    return s;
  }, []);

  const load = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        const info = await api.openRepo(path);
        setRepo(info);
        remember(info.root);
        const s = await refresh(info.root);
        setSelPath(s.files[0]?.path ?? null);
        setSummary("");
        setDescription("");
        setTick((t) => t + 1);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh, remember],
  );

  // A repo named on the command line wins; otherwise reopen whatever was last
  // open, so launching lands you back where you were.
  useEffect(() => {
    api
      .initialRepo()
      .catch(() => null)
      .then((arg) => {
        const target = arg ?? localStorage.getItem(LAST_KEY);
        if (target) load(target).catch(() => {});
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep a valid selection as files come and go.
  useEffect(() => {
    if (!status) return;
    if (selPath && status.files.some((f) => f.path === selPath)) return;
    setSelPath(status.files[0]?.path ?? null);
  }, [status, selPath]);

  // Load the diff for whatever is selected.
  useEffect(() => {
    if (!repo || !entry) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    api
      .diff(repo.root, entry.path, entry.origPath, entry.untracked)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setDiff(null);
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, entry?.path, entry?.origPath, entry?.untracked, tick]);

  /** Run a mutation, then re-read git so the UI reflects the real index. */
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!repo) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(String(e));
      } finally {
        try {
          await refresh(repo.root);
        } catch (e) {
          setError(String(e));
        }
        setTick((t) => t + 1);
        setBusy(false);
      }
    },
    [repo, refresh],
  );

  /** Re-read git without changing anything, as ⌘R and the toolbar button do. */
  const refreshNow = useCallback(() => act(async () => {}), [act]);

  // Git moves under us while the window is in the background — a commit, a
  // rebase, a branch switch on the command line. Catch up on the way back in.
  useWindowFocus(
    useCallback(() => {
      if (!busy) refreshNow();
    }, [busy, refreshNow]),
  );

  const openFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") await load(picked);
  }, [load]);

  const toggleFile = useCallback(
    (f: FileEntry) =>
      act(() =>
        f.stagedState === "all"
          ? api.unstageFile(repo!.root, f.path, f.origPath)
          : api.stageFile(repo!.root, f.path),
      ),
    [act, repo],
  );

  const setLinesStaged = useCallback(
    (positions: number[], staged: boolean) => {
      if (!repo || !entry || !diff || busy) return;
      const hash = diff.hash;
      const want = new Set(positions);

      // Flip the rows straight away. Without this the view waits for git to
      // run and the diff to reload, which reads as a flicker on every click.
      // The refresh that follows replaces these with the truth from git.
      setDiff((d) =>
        d
          ? {
              ...d,
              rows: d.rows.map((r) =>
                r.selectable && r.staged !== staged && want.has(r.pos)
                  ? { ...r, staged }
                  : r,
              ),
            }
          : d,
      );

      act(() => api.setLinesStaged(repo.root, entry.path, positions, staged, hash));
    },
    [act, repo, entry, diff, busy],
  );

  const stagedCount = files.filter((f) => f.indexStatus !== ".").length;

  const doCommit = useCallback(
    () =>
      act(async () => {
        await api.commit(repo!.root, summary, description);
        setSummary("");
        setDescription("");
      }),
    [act, repo, summary, description],
  );

  // ⌘O open, ⌘R refresh.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "o") {
        e.preventDefault();
        openFolder();
      } else if (e.key === "r" && repo) {
        e.preventDefault();
        refreshNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFolder, refreshNow, repo]);

  return (
    <div className="app">
      <TopBar
        repo={repo}
        status={status}
        recents={recents}
        onOpen={openFolder}
        onPick={load}
        onForget={(p) =>
          setRecents((prev) => {
            const next = prev.filter((x) => x !== p);
            localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
            return next;
          })
        }
        onRefresh={refreshNow}
        busy={busy}
      />

      {!repo ? (
        <div className="welcome">
          <h1>Stage</h1>
          <p>
            A small git GUI. Every action runs your own <code>git</code> — staging
            a line here is the same as staging it on the command line.
          </p>
          <button className="commit wide" onClick={openFolder}>
            Open a repository…
          </button>
        </div>
      ) : (
        <div className="main">
          <div className="sidebar">
            <FileList
              files={files}
              selected={selPath}
              onSelect={setSelPath}
              onToggle={toggleFile}
              onToggleAll={(stageEverything) =>
                act(() =>
                  stageEverything ? api.stageAll(repo.root) : api.unstageAll(repo.root),
                )
              }
            />
            <CommitBox
              summary={summary}
              description={description}
              onSummary={setSummary}
              onDescription={setDescription}
              onCommit={doCommit}
              stagedCount={stagedCount}
              branch={status?.branch ?? null}
              busy={busy}
              last={last}
            />
          </div>

          <div className="diffpane">
            <div className="diffhead">
              {/* The inner span keeps the path LTR; the outer one is RTL only
                  so long paths ellipsize at the front rather than the end. */}
              <span className="dh-path">
                <span>{entry ? entry.path : "No file selected"}</span>
              </span>
              {entry && diff && <StagedCount diff={diff} />}
            </div>

            <DiffView
              diff={diff}
              loading={diffLoading || busy}
              onApply={setLinesStaged}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
