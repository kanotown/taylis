/**
 * The key that confirms an IME conversion (Japanese / Chinese input) must never submit, pick or navigate.
 *
 * Browsers mark it differently: Chromium sends the confirming Enter's keydown with `isComposing` before
 * `compositionend`; WebKit (Safari, and WKWebView in the macOS app) sends `compositionend` first and then a keydown whose
 * `isComposing` is already false (its keyCode is usually, but not always, 229). So besides `isComposing` and 229, a
 * keydown right after a `compositionend` counts as part of the composition: the flag is set on `compositionend` (seen on
 * the whole document, so no input needs its own handlers) and cleared on the next keyup, or after a short grace when no
 * keyup comes (the composition ended by a click or a blur).
 */

/** How long a keydown after `compositionend` still counts as the confirming key when no keyup clears the flag first. */
export const IME_CONFIRM_GRACE_MS = 100;

let justComposed = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function clear() {
  justComposed = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

if (typeof document !== "undefined") {
  document.addEventListener(
    "compositionend",
    () => {
      clear();
      justComposed = true;
      timer = setTimeout(clear, IME_CONFIRM_GRACE_MS);
    },
    true,
  );
  document.addEventListener("compositionstart", clear, true);
  document.addEventListener("keyup", clear, true);
}

type Keyish = { isComposing?: boolean; keyCode?: number };

/** True while a key belongs to an IME composition (or confirms one): ignore it for Enter / Tab / arrows. */
export function isImeKeyEvent(event: Keyish | { nativeEvent: Keyish }): boolean {
  const native: Keyish = "nativeEvent" in event ? event.nativeEvent : event;
  return Boolean(native.isComposing) || native.keyCode === 229 || justComposed;
}

/** An Enter that the user meant as Enter (not the one confirming a conversion). */
export function isPlainEnter(event: { key: string } & (Keyish | { nativeEvent: Keyish })): boolean {
  return event.key === "Enter" && !isImeKeyEvent(event);
}
