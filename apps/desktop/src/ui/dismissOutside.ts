/**
 * Closing the top bar's menus (the workspace menu, 在室状況's quick switch) from anywhere, as a native menu closes
 * (2026-10-08: the quick switch stayed open after a click elsewhere in the top bar).
 *
 * Radix closes a popover on the document's `pointerdown` outside it. The top bar is the window's title bar in the
 * desktop app (data-tauri-drag-region): Tauri's script answers its `mousedown` with preventDefault +
 * stopImmediatePropagation and hands the press to the system's window drag (macOS performWindowDrag, Windows'
 * WM_NCLBUTTONDOWN move loop), which keeps the press's mouseup from the WebView. A WebView that missed the mouseup
 * may still count the button as down and send the next press as a `mousedown` without its `pointerdown`, which Radix
 * never hears of (the press that Tauri's script itself sees is always a `mousedown`). A press is therefore taken from
 * both events, on the window in the capture phase (before any page script can stop it), and
 * the menu also closes on the things that move focus or the window without a press in the page: the window losing
 * focus (another app, Windows' move loop), Esc, and the window being moved (Tauri's `moved`).
 */
import { type RefObject, useEffect, useRef } from "react";

import { isTauri } from "../platform/env";

/** Subscribes to the window being moved; the result unsubscribes. A fake in tests. */
export type WindowMoves = (handler: () => void) => Promise<() => void>;

async function tauriMoves(handler: () => void): Promise<() => void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onMoved(() => handler());
}

/**
 * Calls `dismiss` on a press outside `inside` (pointerdown or mousedown, on any element, a drag region's included),
 * on the window's blur, on Esc and on `moves`. The result removes the listeners.
 */
export function watchOutside(win: Window, inside: (node: Node) => boolean, dismiss: () => void, moves?: WindowMoves): () => void {
  const onPress = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && inside(target)) return;
    dismiss();
  };
  // Not in the capture phase: an element's blur does not bubble, so only the window's own reaches here.
  const onBlur = () => dismiss();
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.isComposing) dismiss();
  };
  win.addEventListener("pointerdown", onPress, true);
  win.addEventListener("mousedown", onPress, true);
  win.addEventListener("blur", onBlur);
  win.addEventListener("keydown", onKey, true);
  let alive = true;
  let unlisten: (() => void) | null = null;
  moves?.(() => {
    if (alive) dismiss();
  }).then(
    (stop) => {
      if (alive) unlisten = stop;
      else stop();
    },
    (err) => console.warn("could not follow the window's moves", err),
  );
  return () => {
    alive = false;
    win.removeEventListener("pointerdown", onPress, true);
    win.removeEventListener("mousedown", onPress, true);
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("keydown", onKey, true);
    unlisten?.();
  };
}

/**
 * While `open`, closes the menu (`onDismiss`) as watchOutside says. `refs`: what counts as inside, the menu's content
 * and its trigger (the trigger toggles the menu itself).
 */
export function useDismissOutside(open: boolean, onDismiss: () => void, refs: ReadonlyArray<RefObject<HTMLElement | null>>, moves: WindowMoves | undefined = isTauri() ? tauriMoves : undefined) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const inside = useRef(refs);
  inside.current = refs;
  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;
    return watchOutside(
      window,
      (node) => inside.current.some((ref) => ref.current?.contains(node)),
      () => dismiss.current(),
      moves,
    );
  }, [open, moves]);
}
