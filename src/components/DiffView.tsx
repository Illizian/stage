import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
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

/** Row heights, fixed by `.dl` and `.dl.fold` in styles.css. */
const ROW_H = 20;
// A fold's rules above and below sit inside its 22px, under `border-box`.
const FOLD_H = 22;

/** Rows rendered past each edge of the pane, so a fast flick stays covered. */
const OVERSCAN = 12;

/**
 * Everything in a row that is not the line's text: the two checkbox gutters,
 * the two line-number columns, the +/- sign, and the padding after the text.
 */
const GUTTERS = 18 + 22 + 46 + 46 + 14 + 28;

// Memoised because the pane re-renders for anything that changes in App —
// typing a commit message, most of all — and none of that touches the diff.
export const DiffView = memo(function DiffView({ diff, loading, onApply }: Props) {
  if (loading && !diff) return <div className="diff-empty">Loading diff…</div>;
  if (!diff) return <div className="diff-empty">Select a file to see its changes</div>;
  if (diff.rows.length === 0) return <div className="diff-empty">No changes</div>;

  // Keyed on the path so a different file starts at the top with its folds
  // closed, rather than inheriting the last one's scroll position.
  return <Diff diff={diff} loading={loading} onApply={onApply} key={diff.path} />;
});

function Diff({ diff, loading, onApply }: Props & { diff: FileDiff }) {
  const { tokensFor } = useSyntax(diff);
  // Folded runs the user has chosen to reveal.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // An in-progress drag. `target` is the state every line in the range is
  // being moved to, taken from the line the drag started on — so one drag
  // only ever stages or only ever unstages, never both.
  const [drag, setDrag] = useState<Drag | null>(null);

  const rows = diff.rows;

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

  // The rows to show, with each folded run of unchanged lines standing in for
  // the lines it hides. `offsets[i]` is where item `i` starts down the pane,
  // which is what makes the window below computable without measuring rows.
  const { items, offsets, height } = useMemo(() => {
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

    const offs = new Float64Array(out.length + 1);
    for (let k = 0; k < out.length; k++) {
      offs[k + 1] = offs[k] + (out[k].type === "fold" ? FOLD_H : ROW_H);
    }
    return { items: out, offsets: offs, height: offs[out.length] };
  }, [rows, expanded]);

  // How wide the longest line in the file is, in character cells. Only part of
  // the file is in the DOM at any moment, so the pane's horizontal extent has
  // to come from the text rather than from whatever happens to be rendered —
  // otherwise it would shift under the sideways scrollbar as you scroll down.
  const width = useMemo(() => {
    let max = 0;
    for (const r of rows) {
      let cols = 0;
      for (const ch of r.text) {
        // Tabs run to the next stop; `tab-size: 4` sets where those are.
        if (ch === "\t") cols += 4 - (cols % 4);
        // Anything past the CJK block is wide enough to count as two cells.
        else cols += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
      }
      // The "no newline at end of file" note rides along after the text.
      if (r.nonl) cols += 30;
      if (cols > max) max = cols;
    }
    return `calc(${GUTTERS}px + ${max}ch)`;
  }, [rows]);

  // Which items are on screen. Scrolling only ever changes this, so a scroll
  // re-renders the dozens of rows in view rather than the whole file.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);
  const [port, setPort] = useState({ top: 0, height: 0 });

  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const read = () => {
      // A note for a rename or a cut-off diff scrolls along above the rows, so
      // it has to come off the scroll position before it indexes into them.
      const top = el.scrollTop - (noteRef.current?.offsetHeight ?? 0);
      setPort((p) =>
        p.top === top && p.height === el.clientHeight
          ? p
          : { top, height: el.clientHeight },
      );
    };
    // flushSync, so the rows for the new scroll position are in the DOM before
    // the browser paints it. Left to its own schedule React can commit a frame
    // late, which shows as a band of empty pane at the edge of a fast scroll.
    // Not on the first read, which runs while React is still committing.
    const readNow = () => flushSync(read);

    read();
    el.addEventListener("scroll", readNow, { passive: true });
    const ro = new ResizeObserver(readNow);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", readNow);
      ro.disconnect();
    };
  }, []);

  const [first, last] = useMemo(() => {
    // Before the pane has been measured, enough to fill a tall window.
    if (port.height === 0) return [0, Math.min(items.length, 120)];
    const lo = itemAt(offsets, Math.max(0, port.top)) - OVERSCAN;
    const hi = itemAt(offsets, port.top + port.height) + OVERSCAN;
    return [Math.max(0, lo), Math.min(items.length, hi + 1)];
  }, [port, offsets, items.length]);

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
    <div className={`diffbody${interactive ? " interactive" : ""}`} ref={paneRef}>
      {diff.reason && (
        <div className="diff-note" ref={noteRef}>
          {diff.reason}
        </div>
      )}

      {/* The rows that are off screen, as height. Both pads also carry the
          full line width, so the pane is as wide as the longest line in the
          file and not merely as wide as the longest one on screen. */}
      <div className="diff-pad" style={{ height: offsets[first], minWidth: width }} />

      {items.slice(first, last).map((item) => {
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

      <div
        className="diff-pad"
        style={{ height: height - offsets[last], minWidth: width }}
      />
    </div>
  );
}

/** Index of the item that `y` pixels down the pane falls in. */
function itemAt(offsets: Float64Array, y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** One line of code, syntax-highlighted when a grammar was available. */
const Code = memo(function Code({ row, tokens }: { row: DiffRow; tokens: Tok[] | null }) {
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
});

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
