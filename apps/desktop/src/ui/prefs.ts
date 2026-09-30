/** Per-device UI preferences (browser storage; not synced). */
/** "mod-enter": ⌘+Enter on a Mac, Ctrl+Enter elsewhere (the default since 2026-09-30, as the tester asked). */
export type SendKey = "mod-enter" | "shift-enter" | "enter";

const SEND_KEY = "chikuwa.prefs.sendKey";
const SIDEBAR_WIDTH = "chikuwa.prefs.sidebarWidth";
const PANE_WIDTH = "chikuwa.prefs.paneWidth";
const GROUP_POSTS = "chikuwa.prefs.groupPosts";
const CANVAS_SPLIT = "chikuwa.prefs.canvasSplit";
const FORMAT_BAR = "chikuwa.prefs.formatBar";
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

/** Default: Enter inserts a newline, ⌘+Enter (Ctrl+Enter) sends. A choice made before keeps. */
export function readSendKey(): SendKey {
  const value = read(SEND_KEY);
  return value === "enter" || value === "shift-enter" ? value : "mod-enter";
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

/** The composer's formatting bar, shown or hidden with 「Aa」 (tester, 2026-09-30, as in Slack). Default shown. */
export function readFormatBar(): boolean {
  return read(FORMAT_BAR) !== "0";
}

export function writeFormatBar(value: boolean): void {
  write(FORMAT_BAR, value ? null : "0");
}

/** The canvas editor's share of the width beside its preview (tester, 2026-09-30: the preview's width adjustable). */
export const CANVAS_SPLIT_MIN = 0.25;
export const CANVAS_SPLIT_MAX = 0.75;
export const CANVAS_SPLIT_DEFAULT = 0.5;

export function clampCanvasSplit(value: number): number {
  return Math.min(CANVAS_SPLIT_MAX, Math.max(CANVAS_SPLIT_MIN, value));
}

export function readCanvasSplit(): number {
  const value = Number(read(CANVAS_SPLIT));
  return Number.isFinite(value) && value >= CANVAS_SPLIT_MIN && value <= CANVAS_SPLIT_MAX ? value : CANVAS_SPLIT_DEFAULT;
}

export function writeCanvasSplit(value: number): void {
  write(CANVAS_SPLIT, value === CANVAS_SPLIT_DEFAULT ? null : value.toFixed(3));
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
export function isSendKey(event: { key: string; shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean }, sendKey: SendKey): boolean {
  if (event.key !== "Enter") return false;
  const mod = Boolean(event.metaKey || event.ctrlKey);
  if (sendKey === "mod-enter") return mod;
  if (mod) return false;
  return sendKey === "enter" ? !event.shiftKey : event.shiftKey;
}

/** ⌘ on a Mac, Ctrl elsewhere. */
export function modKeyName(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}

export function sendKeyLabel(sendKey: SendKey): { send: string; newline: string } {
  if (sendKey === "mod-enter") return { send: `${modKeyName()}+Enter`, newline: "Enter" };
  return sendKey === "enter" ? { send: "Enter", newline: "Shift+Enter" } : { send: "Shift+Enter", newline: "Enter" };
}
