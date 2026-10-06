import type { KeyboardEvent } from "react";

/** Row navigation only: scrolling uses the existing visibility/read handling of the owning list. */
export function messageRowKey(event: KeyboardEvent<HTMLElement>, openThread?: () => void): void {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
  const row = event.currentTarget;
  const rows = [...(row.closest("[data-message-list]")?.querySelectorAll<HTMLElement>("article.message") ?? [])];
  const index = rows.indexOf(row);
  let next: HTMLElement | undefined;
  if (!event.shiftKey) {
    if (event.key === "ArrowUp") next = rows[Math.max(0, index - 1)];
    if (event.key === "ArrowDown") next = rows[Math.min(rows.length - 1, index + 1)];
    if (event.key === "Home") next = rows[0];
    if (event.key === "End") next = rows.at(-1);
  }
  if (next) {
    event.preventDefault();
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
  } else if ((!event.shiftKey && event.key === "Enter") || (event.shiftKey && event.key === "F10")) {
    const action = row.querySelector<HTMLButtonElement>(".row-actions button:not(:disabled)");
    if (action) { event.preventDefault(); action.focus(); }
  } else if (!event.shiftKey && (event.key === "ArrowRight" || event.key.toLowerCase() === "t") && openThread) {
    event.preventDefault();
    openThread();
  }
}

/** Cycle visible regions in DOM order; leave modal focus traps and normal text editing intact. */
export function focusChatRegion(backwards: boolean): boolean {
  if (document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')) return false;
  const regions = [...document.querySelectorAll<HTMLElement>("[data-chat-focus], .composer [data-composer-input]")].filter((element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
  });
  if (!regions.length) return false;
  const index = regions.findIndex((element) => element === document.activeElement || element.contains(document.activeElement));
  const next = regions[index < 0 ? (backwards ? regions.length - 1 : 0) : (index + (backwards ? -1 : 1) + regions.length) % regions.length]!;
  const target = next.querySelector<HTMLElement>("article.message, button:not(:disabled), a[href]") ?? next;
  target.focus();
  return true;
}
