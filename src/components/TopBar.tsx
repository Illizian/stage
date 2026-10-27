import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { RepoInfo, Status } from "../api";

/// The window has no native title bar to grab (the traffic lights are overlaid
/// on the web view), so the top bar has to start the drag itself. Relying on
/// `data-tauri-drag-region` alone left the window immovable.
function isDragSurface(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && !el.closest("button, input, textarea, a, select, .menu");
}

async function beginDrag(e: React.MouseEvent) {
  if (e.button !== 0 || !isDragSurface(e.target)) return;
  try {
    await getCurrentWindow().startDragging();
  } catch {
    // Not running inside Tauri (e.g. the browser preview).
  }
}

async function toggleMaximize(e: React.MouseEvent) {
  if (!isDragSurface(e.target)) return;
  try {
    await getCurrentWindow().toggleMaximize();
  } catch {
    // Not running inside Tauri.
  }
}

export function TopBar({
  repo,
  status,
  recents,
  onOpen,
  onPick,
  onForget,
  onRefresh,
  busy,
}: {
  repo: RepoInfo | null;
  status: Status | null;
  recents: string[];
  onOpen: () => void;
  onPick: (path: string) => void;
  onForget: (path: string) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const branch = status?.detached
    ? "detached HEAD"
    : (status?.branch ?? "—");

  return (
    <div
      className="topbar"
      data-tauri-drag-region
      onMouseDown={beginDrag}
      onDoubleClick={toggleMaximize}
    >
      <div className="repo-wrap" ref={wrap}>
        <button
          className="repo-btn"
          onClick={() => setOpen((v) => !v)}
          title={repo?.root}
        >
          <span className="rb-label">Repository</span>
          <span className="rb-name">{repo ? repo.name : "Open a folder…"}</span>
          <Chevron />
        </button>

        {open && (
          <div className="menu">
            <button
              className="menu-item primary"
              onClick={() => {
                setOpen(false);
                onOpen();
              }}
            >
              Open folder…
            </button>
            {recents.length > 0 && <div className="menu-sep">Recent</div>}
            {recents.map((p) => (
              <div key={p} className="menu-row">
                <button
                  className="menu-item"
                  onClick={() => {
                    setOpen(false);
                    onPick(p);
                  }}
                  title={p}
                >
                  <span className="mi-name">{p.split("/").pop()}</span>
                  <span className="mi-path">{tilde(p)}</span>
                </button>
                <button
                  className="menu-x"
                  title="Remove from recents"
                  onClick={(e) => {
                    e.stopPropagation();
                    onForget(p);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="branch-chip" title={status?.upstream ?? undefined}>
        <BranchIcon />
        <span className="b-name">{branch}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="ab">
            {status.ahead > 0 && <span>↑{status.ahead}</span>}
            {status.behind > 0 && <span>↓{status.behind}</span>}
          </span>
        )}
      </div>

      <div className="spacer" data-tauri-drag-region />

      <button
        className="icon-btn"
        onClick={onRefresh}
        disabled={!repo || busy}
        title="Refresh (⌘R)"
      >
        <RefreshIcon />
      </button>
    </div>
  );
}

function tilde(p: string) {
  const home = "/Users/";
  if (!p.startsWith(home)) return p;
  const rest = p.slice(home.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? "~" : "~" + rest.slice(slash);
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" className="chev" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" strokeWidth="1.4" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="bicon" aria-hidden="true">
      <path
        d="M4 3.5v9M4 3.5a1.5 1.5 0 1 0 0-.001M4 12.5a1.5 1.5 0 1 0 0-.001M12 5.5a1.5 1.5 0 1 0 0-.001M12 7v.5A3.5 3.5 0 0 1 8.5 11H4"
        fill="none"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" className="bicon" aria-hidden="true">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 2v3.2h-3.2"
        fill="none"
        strokeWidth="1.4"
      />
    </svg>
  );
}
