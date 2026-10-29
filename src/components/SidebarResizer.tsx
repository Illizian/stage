import { useEffect, useLayoutEffect, useRef, useState } from "react";

const WIDTH_KEY = "stage.sidebarWidth";
const DEFAULT_W = 330;
const MIN_W = 240;
const KEY_STEP = 16;

function loadWidth(): number {
  const v = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_W;
}

/**
 * Drag handle on the sidebar's right edge. Its width lives here rather than in
 * App so a drag re-renders only the handle, not the file list and diff; it
 * reaches the layout through the `--sidebar-w` variable on `.main`, where CSS
 * clamps it between the minimum and half the window.
 */
export function SidebarResizer({ main }: { main: React.RefObject<HTMLDivElement | null> }) {
  const [width, setWidth] = useState(loadWidth);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    main.current?.style.setProperty("--sidebar-w", `${width}px`);
  }, [main, width]);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  const clamp = (w: number) =>
    Math.round(Math.min(Math.max(w, MIN_W), Math.max(MIN_W, (main.current?.clientWidth ?? 0) / 2)));

  // Measured rather than taken from state: after the window shrinks, CSS may
  // be showing a narrower sidebar than the stored width, and moving from the
  // stored one would make the edge jump.
  const shown = () => handle.current?.parentElement?.getBoundingClientRect().width ?? width;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: shown() };
    document.body.classList.add("resizing");
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) setWidth(clamp(drag.current.w + e.clientX - drag.current.x));
  };

  const onPointerUp = () => {
    drag.current = null;
    document.body.classList.remove("resizing");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowLeft" ? -KEY_STEP : e.key === "ArrowRight" ? KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    setWidth(clamp(shown() + step));
  };

  return (
    <div
      ref={handle}
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_W}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setWidth(DEFAULT_W)}
      onKeyDown={onKeyDown}
    />
  );
}
