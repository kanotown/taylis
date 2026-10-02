import { PANE_MAX, PANE_MIN, SIDEBAR_MAX, SIDEBAR_MIN } from "./prefs";

export const CONVERSATION_MIN = 360;

/** Use the actual workspace width (excluding its rail), without overwriting the user's saved widths. */
export function paneLayout(width: number, sidebar: number, pane: number, hasPane: boolean) {
  const sidebarWidth = Math.min(sidebar, SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width - CONVERSATION_MIN));
  const room = width - sidebarWidth - CONVERSATION_MIN;
  const replaceCentre = hasPane && room < PANE_MIN;
  const paneWidth = hasPane && !replaceCentre ? Math.min(pane, PANE_MAX, room) : 0;
  return { sidebarWidth, paneWidth, replaceCentre };
}

/**
 * How much of the wide conversation header fits its width (the centre column narrows to CONVERSATION_MIN with the
 * thread pane open): "full" shows the tab strip and every button; "tabMenu" folds 「メッセージ | キャンバス | 予定 |
 * タスク」 into one menu button; "tight" also moves pins, files, members and the shortcuts button into ⋯ (the star,
 * the bell and ⋯ stay). 0 (not laid out yet, or a test's DOM) counts as wide.
 */
export type HeaderFit = "full" | "tabMenu" | "tight";
export const HEADER_FULL_MIN = 660;
export const HEADER_TAB_MENU_MIN = 500;

export function headerFit(width: number): HeaderFit {
  if (!(width > 0) || width >= HEADER_FULL_MIN) return "full";
  return width >= HEADER_TAB_MENU_MIN ? "tabMenu" : "tight";
}
