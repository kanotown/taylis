/** Per-device UI preferences (browser storage; not synced). */
export type SendKey = "enter" | "shift-enter";

const SEND_KEY = "chikuwa.prefs.sendKey";
const SIDEBAR_WIDTH = "chikuwa.prefs.sidebarWidth";
const PANE_WIDTH = "chikuwa.prefs.paneWidth";
const GROUP_POSTS = "chikuwa.prefs.groupPosts";
/** The right-hand pane (thread, pins): dragged by its left edge. */
export const PANE_MIN = 320;
export const PANE_MAX = 760;
export const PANE_DEFAULT = 400;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 440;
export const SIDEBAR_DEFAULT = 260;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* per-device convenience only */
  }
}

/** Default: Enter inserts a newline, Shift+Enter sends. */
export function readSendKey(): SendKey {
  return read(SEND_KEY) === "enter" ? "enter" : "shift-enter";
}

export function writeSendKey(value: SendKey): void {
  write(SEND_KEY, value);
}

/** M47 「連続した投稿をまとめる」. Default off: a picture and name on every post (channels, DMs and threads). */
export function readGroupPosts(): boolean {
  return read(GROUP_POSTS) === "1";
}

export function writeGroupPosts(value: boolean): void {
  write(GROUP_POSTS, value ? "1" : null);
}

export function readSidebarWidth(): number {
  const value = Number(read(SIDEBAR_WIDTH));
  return Number.isFinite(value) && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX ? value : SIDEBAR_DEFAULT;
}

export function writeSidebarWidth(value: number): void {
  write(SIDEBAR_WIDTH, String(Math.round(value)));
}

export function readPaneWidth(): number {
  const value = Number(read(PANE_WIDTH));
  return Number.isFinite(value) && value >= PANE_MIN && value <= PANE_MAX ? value : PANE_DEFAULT;
}

export function writePaneWidth(value: number): void {
  write(PANE_WIDTH, String(Math.round(value)));
}

/** True when this keyboard event should send, given the preference. */
export function isSendKey(event: { key: string; shiftKey: boolean }, sendKey: SendKey): boolean {
  if (event.key !== "Enter") return false;
  return sendKey === "enter" ? !event.shiftKey : event.shiftKey;
}

export function sendKeyLabel(sendKey: SendKey): { send: string; newline: string } {
  return sendKey === "enter" ? { send: "Enter", newline: "Shift+Enter" } : { send: "Shift+Enter", newline: "Enter" };
}
