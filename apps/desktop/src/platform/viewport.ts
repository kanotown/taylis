/**
 * Phones and the keyboard (the apps do the same: KeyboardBehavior.swift / .kt).
 *
 * The app fits the part of the screen the keyboard leaves, the visual viewport. Chrome on Android resizes the page
 * itself (`interactive-widget=resizes-content` in index.html); iOS Safari does not: it pans the page up to show the
 * focused field, which pushed the header off the top and the newest messages behind the input. `--app-height`
 * (styles.css) follows the visual viewport and the pan is undone, so the conversation shrinks instead, and the
 * timeline, pinned to the bottom when it is resized (Timeline.tsx), keeps the newest message above the input.
 */
export function followVisualViewport(win: Window = window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const root = win.document.documentElement;
  const update = () => {
    if (Math.abs(viewport.scale - 1) > 0.01) return; // zoomed in by the reader: the page stays as it is
    root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
    if (win.scrollY !== 0 || viewport.offsetTop !== 0) win.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
  };
}

interface TouchLike {
  touches: ArrayLike<{ clientX: number; clientY: number }>;
}
interface TouchEndLike {
  target: EventTarget | null;
  preventDefault(): void;
}

/** What a tap may act on itself; the focus moves there, which closes the keyboard anyway. */
const ACTIONABLE = "a, button, input, textarea, select, label, [role='button'], [role='link'], [role='menuitem']";

/**
 * A tap on a conversation while the keyboard is up only closes the keyboard (touch screens, as in the apps). From the
 * touch events, not click: iOS Safari sends no click for the first tap on a message row (it shows the row's hover
 * state instead). The tap does not focus the message either, whose actions would pop up. A drag (a scroll) is not a
 * tap, and buttons and links still act. Spread the handlers on the scrolling list (one object per list).
 */
export function tapClosesKeyboard(win: Window = window) {
  let start: { x: number; y: number } | null = null;
  return {
    onTouchStartCapture: (event: TouchLike) => {
      const touch = event.touches[0];
      start = touch && keyboardUp(win) ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchMoveCapture: (event: TouchLike) => {
      const touch = event.touches[0];
      if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) start = null;
    },
    onTouchEndCapture: (event: TouchEndLike) => {
      if (!start) return;
      start = null;
      const target = event.target as Element | null;
      if (typeof target?.closest === "function" && target.closest(ACTIONABLE)) return;
      event.preventDefault(); // no mouse events after it: the message is not focused
      (win.document.activeElement as HTMLElement | null)?.blur();
    },
  };
}

/** A touch screen's keyboard is up: an input or a text area has the focus. */
export function keyboardUp(win: Window = window): boolean {
  if (!win.matchMedia?.("(hover: none)").matches) return false;
  const active = win.document.activeElement as HTMLElement | null;
  return !!active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
}

/**
 * How tall the message input may grow before it scrolls: 280 px, and on a touch screen at most a quarter of what the
 * keyboard leaves (at least four lines), so the conversation above it stays in view.
 */
export function composerMaxHeight(win: Window = window): number {
  if (!win.matchMedia?.("(hover: none)").matches) return 280;
  const visible = win.visualViewport?.height ?? win.innerHeight;
  return Math.min(280, Math.max(96, Math.round(visible * 0.25)));
}
