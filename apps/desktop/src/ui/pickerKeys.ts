import type { KeyboardEvent } from "react";

import { isImeKeyEvent } from "./ime";

/**
 * ↑↓ in a people / destination picker (the new-DM and add-member dialogs, ✏️ 新しいメッセージ): from the search field ↓
 * goes to the first row, then from row to row (`[data-pick]` buttons in `list`); ↑ on the first row goes back to the
 * field. A row toggles or opens with Enter / Space (it is a button). True when the key was handled.
 */
export function moveInPicker(event: KeyboardEvent, list: HTMLElement | null, input: HTMLInputElement | null): boolean {
  if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || event.altKey || event.metaKey || event.ctrlKey || isImeKeyEvent(event)) return false;
  const rows = list ? [...list.querySelectorAll<HTMLElement>("[data-pick]:not([disabled])")] : [];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  event.preventDefault();
  const next = event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : at - 1;
  if (next < 0) input?.focus();
  else rows[next]?.focus();
  return true;
}
