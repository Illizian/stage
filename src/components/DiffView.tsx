import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffRow, FileDiff } from "../api";
import { useSyntax, type Tok } from "../syntax";

interface Props {
  diff: FileDiff | null;
  loading: boolean;
  /** Move these lines into (or out of) the index. */
  onApply: (positions: number[], staged: boolean) => void;
}

interface Drag {
  from: number;
  to: number;
  /** The staged state every line in the range is being moved to. */
  target: boolean;
}

type Item =
  | { type: "row"; row: DiffRow }
  | { type: "fold"; gap: number; count: number };

export function DiffView({ diff, loading, onApply }: Props) {
  const { tokensFor } = useSyntax(diff);
  // Folded runs the user has chosen to reveal.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // An in-progress drag. `target` is the state every line in the range is
  // being moved to, taken from the line the drag started on — so one drag
  // only ever stages or only ever unstages, never both.
  const [drag, setDrag] = useState<Drag | null>(null);

  const rows = useMemo(() => diff?.rows ?? [], [diff]);

  // Folds reopen per file, but survive staging a line in the current one.
  useEffect(() => {
    setExpanded(new Set());
  }, [diff?.path]);

  const pending = useMemo(() => {
    if (!drag) return null;
    const [lo, hi] =
      drag.from <= drag.to ? [drag.from, drag.to] : [drag.to, drag.from];
    const s = new Set<number>();
    for (const r of rows) {
      if (r.idx >= lo && r.idx <= hi && r.selectable && r.staged !== drag.target) {
        s.add(r.idx);
      }
    }
    return s;
  }, [drag, rows]);

  // The drag is mirrored into a ref that is written synchronously by the
  // mouse handlers, so finishing it never depends on React having committed
  // the state update first. The listeners are attached once for the same
  // reason: anything conditional on `drag` can miss a release and leave the
  // drag stuck previewing a change it never applied.
  const dragRef = useRef<Drag | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const applyRef = useRef(onApply);
  applyRef.current = onApply;

  const setDragNow = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDrag(null);

      const [lo, hi] = d.from <= d.to ? [d.from, d.to] : [d.to, d.from];
      const positions = rowsRef.current
        .filter(
          (r) => r.idx >= lo && r.idx <= hi && r.selectable && r.staged !== d.target,
        )
        .map((r) => r.pos);
      if (positions.length) applyRef.current(positions, d.target);
    };
    // Losing focus mid-drag means no mouseup is ever delivered; cancel rather
    // than staging something the user did not finish asking for.
    const cancel = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDrag(null);
    };

    // A drag can end anywhere, including outside the window.
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  // Staged/total per contiguous run of changed lines, for the hunk checkbox.
  const groups = useMemo(() => {
    const m = new Map<number, { total: number; staged: number; first: number }>();
    for (const r of rows) {
      if (!r.group || !r.selectable) continue;
      const g = m.get(r.group) ?? { total: 0, staged: 0, first: r.idx };
      g.total += 1;
      if (r.staged) g.staged += 1;
      m.set(r.group, g);
    }
    return m;
  }, [rows]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (r.visible || expanded.has(r.gap)) {
        out.push({ type: "row", row: r });
        i += 1;
        continue;
      }
      const gap = r.gap;
      let j = i;
      while (j < rows.length && !rows[j].visible && rows[j].gap === gap) j += 1;
      out.push({ type: "fold", gap, count: j - i });
      i = j;
    }
    return out;
  }, [rows, expanded]);

  if (loading && !diff) return <div className="diff-empty">Loading diff…</div>;
  if (!diff) return <div className="diff-empty">Select a file to see its changes</div>;
  if (rows.length === 0) return <div className="diff-empty">No changes</div>;

  // Rendering must not depend on `loading`: unmounting the boxes during the
  // refresh after each click made every tick in the file blink.
  const interactive = diff.selectable;

  const toggleGroup = (group: number) => {
    const g = groups.get(group);
    if (!g) return;
    const target = g.staged < g.total; // partial or none → stage it all
    const positions = rows
      .filter((r) => r.group === group && r.selectable && r.staged !== target)
      .map((r) => r.pos);
    if (positions.length) onApply(positions, target);
  };

  return (
    <div className={`diffbody${interactive ? " interactive" : ""}`}>
      {diff.reason && <div className="diff-note">{diff.reason}</div>}

      {items.map((item) => {
        if (item.type === "fold") {
          return (
            <div
              className="dl fold"
              key={`fold-${item.gap}`}
              onClick={() => setExpanded((p) => new Set(p).add(item.gap))}
              title="Show the lines in between"
            >
              <span className="fold-label">
                ⋯ {item.count} unchanged line{item.count === 1 ? "" : "s"}
              </span>
            </div>
          );
        }

        const r = item.row;

        if (r.kind === "context") {
          return (
            <div className="dl context" key={r.idx}>
              <span className="hgut" />
              <span className="gut" />
              <span className="no">{r.oldLine ?? ""}</span>
              <span className="no">{r.newLine ?? ""}</span>
              <span className="sign" />
              <Code row={r} tokens={tokensFor(r)} />
            </div>
          );
        }

        const isPending = pending?.has(r.idx) ?? false;
        // While dragging, the row previews the state it is about to land in.
        const staged = isPending && drag ? drag.target : r.staged;
        const g = groups.get(r.group);
        const showGroupBox = interactive && g?.first === r.idx;
        const groupState =
          !g || g.staged === 0 ? "none" : g.staged === g.total ? "all" : "partial";

        return (
          <div
            className={`dl ${r.kind}${staged ? " staged" : ""}`}
            key={r.idx}
            onMouseDown={(e) => {
              // A toggle is still in flight; its row positions would be stale.
              if (loading) return;
              if (!interactive || !r.selectable || e.button !== 0) return;
              e.preventDefault();
              setDragNow({ from: r.idx, to: r.idx, target: !r.staged });
            }}
            onMouseEnter={() => {
              const d = dragRef.current;
              if (d) setDragNow({ ...d, to: r.idx });
            }}
          >
            <span className="hgut">
              {showGroupBox && (
                <span
                  className={`gbox g-${groupState}`}
                  title={
                    groupState === "all" ? "Unstage this hunk" : "Stage this hunk"
                  }
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!loading) toggleGroup(r.group);
                  }}
                >
                  {groupState === "all" ? <Tick /> : groupState === "partial" ? <Dash /> : null}
                </span>
              )}
            </span>

            <span className="gut">
              {interactive && (
                <span className={`lbox${staged ? " on" : ""}`}>
                  <Tick />
                </span>
              )}
            </span>

            <span className="no">{r.oldLine ?? ""}</span>
            <span className="no">{r.newLine ?? ""}</span>
            <span className="sign">{r.kind === "add" ? "+" : "-"}</span>
            <Code row={r} tokens={tokensFor(r)} />
          </div>
        );
      })}
    </div>
  );
}

/** One line of code, syntax-highlighted when a grammar was available. */
function Code({ row, tokens }: { row: DiffRow; tokens: Tok[] | null }) {
  return (
    <span className="tx">
      {tokens
        ? tokens.map((t, i) => (
            <span key={i} style={t.color ? { color: t.color } : undefined}>
              {t.content}
            </span>
          ))
        : row.text}
      {row.nonl && <span className="nonl"> ↵ no newline at end of file</span>}
    </span>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M10 3 4.6 8.4 2 5.8" fill="none" strokeWidth="2" />
    </svg>
  );
}

function Dash() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 6h6" fill="none" strokeWidth="2" />
    </svg>
  );
}
