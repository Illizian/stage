import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Calls `onFocus` each time the window regains focus.
 *
 * Tauri's own event is used rather than the DOM's: activating the app from the
 * dock or with ⌘-tab focuses the native window, which the web view does not
 * reliably see as a `focus` event of its own. The DOM listener is the fallback
 * for running the front end in a plain browser, where there is no Tauri.
 */
export function useWindowFocus(onFocus: () => void) {
  // Held in a ref so a changing handler never re-registers the listener —
  // re-registering is asynchronous, and a focus arriving in the gap is lost.
  const handler = useRef(onFocus);
  handler.current = onFocus;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let stopped = false;

    (async () => {
      try {
        return await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) handler.current();
        });
      } catch {
        // Not running inside Tauri (e.g. the browser preview).
        const onWindowFocus = () => handler.current();
        window.addEventListener("focus", onWindowFocus);
        return () => window.removeEventListener("focus", onWindowFocus);
      }
    })().then((off) => {
      // The listener may only be in place after the effect has been torn down.
      if (stopped) off();
      else unlisten = off;
    });

    return () => {
      stopped = true;
      unlisten?.();
    };
  }, []);
}
