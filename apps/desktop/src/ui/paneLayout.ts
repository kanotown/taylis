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
