/**
 * M67: the keys and mouse buttons of back / forward (placeHistory.ts), as Slack's desktop app has them.
 *
 * - macOS: ⌘[ / ⌘] everywhere (no text field uses them, so they work in the composer too, as in Slack); ⌘← / ⌘→ only
 *   outside text fields (inside one they move to the start / end of the line).
 * - Windows / Linux: Alt+← / Alt+→ (not editing keys there), also in the composer.
 * - Mouse buttons 4 / 5 (MainScreen listens in the desktop app only: a browser already turns them into its own Back /
 *   Forward, which the web build's history entries follow).
 * Never during IME composition.
 */

export const isMacPlatform = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** A field the keys would edit text in. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select");
}

type Keys = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "target">;

/** -1 back, 1 forward, null: not a history key (or one that belongs to the text field it was pressed in). */
export function historyStep(event: Keys, mac = isMacPlatform()): -1 | 1 | null {
  if (event.isComposing || event.shiftKey || event.ctrlKey) return null;
  const arrow = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
  if (mac) {
    if (!event.metaKey || event.altKey) return null;
    if (event.key === "[") return -1;
    if (event.key === "]") return 1;
    return arrow !== null && !isTextEntry(event.target) ? arrow : null;
  }
  if (!event.altKey || event.metaKey) return null;
  return arrow;
}

/** The mouse's back (4th) and forward (5th) buttons: `MouseEvent.button` 3 and 4. */
export function mouseHistoryStep(button: number): -1 | 1 | null {
  return button === 3 ? -1 : button === 4 ? 1 : null;
}

/** The buttons' tooltips. */
export function historyShortcutLabels(mac = isMacPlatform()): { back: string; forward: string } {
  return mac ? { back: "戻る (⌘[)", forward: "進む (⌘])" } : { back: "戻る (Alt + ←)", forward: "進む (Alt + →)" };
}
