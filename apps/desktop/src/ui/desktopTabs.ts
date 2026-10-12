/**
 * Browser-like tabs of the wide layout (Desktop / Web, docs/MOBILE_UI.md §19). Each tab is one screen of the centre
 * column: what it shows (a conversation, a centre view, a Docs page), its thread pane, its own back / forward history and
 * its scroll positions (the scroll memory, per place). Only the active tab is live in MainScreen's state and only its
 * conversation is the engine's open one (read marks, typing, viewing presence); the others are kept as snapshots.
 *
 * Pure: the list operations, the keys, and the per-device storage (localStorage, never trusted: every target is checked
 * against the store on restore). MainScreen holds the live state and the DOM.
 */
import type { SearchParams } from "./search";

/** What a tab shows, as stored on this device (ids only; never message bodies). */
export interface TabTarget {
  /** MainScreen's centre view ("channel", "threads", "docs" …). */
  view: string;
  /** The conversation (the one left behind a view too, as the single screen keeps it). */
  currentId: string | null;
  threadId: string | null;
  threadChannelId: string | null;
  /** "docs": the page on screen. */
  docsPageId: string | null;
  /** "files": the channel it is scoped to. */
  filesChannelId: string | null;
  /** The conversation's tab (メッセージ / キャンバス / 予定 / タスク). */
  tab: string;
  /** "search": its query. */
  search: SearchParams | null;
}

export interface Tab<S> {
  id: string;
  /** The tab's screen while it is in the background; null for the active tab (its screen is MainScreen's live state). */
  saved: S | null;
  /** What it shows, for its title, its badge and the storage (kept up to date for the active tab too). */
  target: TabTarget;
}

export const MAX_TABS = 20;

let counter = 0;
export function newTabId(): string {
  counter += 1;
  return `t${Date.now().toString(36)}${counter.toString(36)}`;
}

/** A tab opened from `fromId` goes right after it (a browser's link opened in a new tab), at the end past the cap's room. */
export function insertTab<S>(tabs: readonly Tab<S>[], fromId: string, tab: Tab<S>): Tab<S>[] {
  const at = tabs.findIndex((t) => t.id === fromId);
  const next = tabs.slice();
  next.splice(at < 0 ? next.length : at + 1, 0, tab);
  return next;
}

/** The tab that becomes active when `id` closes: the one right of it, else the one left of it (a browser). */
export function neighbourOf<S>(tabs: readonly Tab<S>[], id: string): string | null {
  const at = tabs.findIndex((t) => t.id === id);
  if (at < 0) return null;
  return tabs[at + 1]?.id ?? tabs[at - 1]?.id ?? null;
}

/** `id` moved to `to` (an index in the list without it, clamped). */
export function moveTab<S>(tabs: readonly Tab<S>[], id: string, to: number): Tab<S>[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return tabs.slice();
  const next = tabs.slice();
  const [tab] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, tab!);
  return next;
}

/** The tab `delta` steps from the active one, round the ends (Ctrl+Tab / Ctrl+Shift+Tab). */
export function stepTab<S>(tabs: readonly Tab<S>[], activeId: string, delta: number): string | null {
  if (tabs.length < 2) return null;
  const at = Math.max(0, tabs.findIndex((t) => t.id === activeId));
  return tabs[(((at + delta) % tabs.length) + tabs.length) % tabs.length]!.id;
}

/** ⌘1–⌘8 the n-th tab, ⌘9 the last (a browser). */
export function nthTab<S>(tabs: readonly Tab<S>[], digit: number): string | null {
  if (digit === 9) return tabs[tabs.length - 1]?.id ?? null;
  return tabs[digit - 1]?.id ?? null;
}

export type TabCommand = { kind: "new" } | { kind: "close" } | { kind: "step"; delta: 1 | -1 } | { kind: "nth"; digit: number };

type Keys = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">;

/**
 * The tab keys. The desktop app has a browser's: ⌘T / ⌘W, ⌘⇧[ / ⌘⇧], Ctrl+Tab / Ctrl+Shift+Tab, ⌘1–⌘9 (Ctrl on
 * Windows / Linux). A browser keeps those for its own tabs (they never reach the page), so the web build also takes
 * Alt (⌥) + T / W / 1–9 / Shift+[ / Shift+] (by the physical key: ⌥ on a Mac types other characters).
 */
export function tabCommand(event: Keys, mac: boolean, web: boolean): TabCommand | null {
  if (event.isComposing) return null;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const digit = /^Digit([1-9])$/.exec(event.code ?? "")?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : null);
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") return { kind: "step", delta: event.shiftKey ? -1 : 1 };
  if (mod && !event.altKey) {
    const key = event.key.toLowerCase();
    if (!event.shiftKey && key === "t") return { kind: "new" };
    if (!event.shiftKey && key === "w") return { kind: "close" };
    if (event.shiftKey && (event.code === "BracketLeft" || event.key === "{")) return { kind: "step", delta: -1 };
    if (event.shiftKey && (event.code === "BracketRight" || event.key === "}")) return { kind: "step", delta: 1 };
    if (!event.shiftKey && digit) return { kind: "nth", digit: Number(digit) };
    return null;
  }
  if (web && event.altKey && !event.metaKey && !event.ctrlKey) {
    if (!event.shiftKey && event.code === "KeyT") return { kind: "new" };
    if (!event.shiftKey && event.code === "KeyW") return { kind: "close" };
    if (event.shiftKey && event.code === "BracketLeft") return { kind: "step", delta: -1 };
    if (event.shiftKey && event.code === "BracketRight") return { kind: "step", delta: 1 };
    if (!event.shiftKey && /^Digit[1-9]$/.test(event.code ?? "")) return { kind: "nth", digit: Number(event.code!.slice(5)) };
  }
  return null;
}

/** The keys shown in the shortcut list and the tooltips. */
export function tabKeyLabels(mac: boolean, web: boolean): { newTab: string; close: string; step: string; nth: string } {
  const m = mac ? "⌘" : "Ctrl+";
  const a = mac ? "⌥" : "Alt+";
  const both = (app: string, browser: string) => (web ? `${app} / ${browser}` : app);
  return {
    newTab: both(`${m}T`, `${a}T`),
    close: both(`${m}W`, `${a}W`),
    step: both(`${m}${mac ? "⇧" : "Shift+"}[ / ]・Ctrl+Tab`, `${a}${mac ? "⇧" : "Shift+"}[ / ]`),
    nth: both(`${m}1〜9`, `${a}1〜9`),
  };
}

// --- storage (per device, per account) -------------------------------------------------------------------------------

const PREFIX = "chikuwa.tabs.";
const USE_TABS = "chikuwa.prefs.useTabs";

export interface StoredTabs {
  tabs: Array<{ id: string; target: TabTarget }>;
  active: string;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null);

/** A stored target as far as its shape goes (what it points at is checked by the caller against the store). */
export function parseTarget(value: unknown): TabTarget | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const view = str(raw["view"]);
  if (!view) return null;
  const search = raw["search"];
  return {
    view,
    currentId: str(raw["currentId"]),
    threadId: str(raw["threadId"]),
    threadChannelId: str(raw["threadChannelId"]),
    docsPageId: str(raw["docsPageId"]),
    filesChannelId: str(raw["filesChannelId"]),
    tab: str(raw["tab"]) ?? "messages",
    search: search && typeof search === "object" && typeof (search as SearchParams).q === "string" ? (search as SearchParams) : null,
  };
}

export function readStoredTabs(accountKey: string): StoredTabs | null {
  try {
    const raw = localStorage.getItem(PREFIX + accountKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabs?: unknown; active?: unknown };
    if (!Array.isArray(parsed.tabs)) return null;
    const tabs: StoredTabs["tabs"] = [];
    const ids = new Set<string>();
    for (const entry of parsed.tabs.slice(0, MAX_TABS)) {
      const id = str((entry as { id?: unknown })?.id);
      const target = parseTarget((entry as { target?: unknown })?.target);
      if (!id || !target || ids.has(id)) continue;
      ids.add(id);
      tabs.push({ id, target });
    }
    if (tabs.length === 0) return null;
    const active = str(parsed.active);
    return { tabs, active: active && ids.has(active) ? active : tabs[0]!.id };
  } catch {
    return null;
  }
}

export function writeStoredTabs(accountKey: string, stored: StoredTabs | null): void {
  try {
    if (!stored || stored.tabs.length <= 1) localStorage.removeItem(PREFIX + accountKey);
    else localStorage.setItem(PREFIX + accountKey, JSON.stringify(stored));
  } catch {
    /* a per-device convenience only */
  }
}

/**
 * The stored tabs whose targets still exist (`check` fixes a target up or says it is gone: a conversation left or
 * deleted, a page in the trash). The active one falls to its neighbour when it is gone. Null when none is left.
 */
export function restoreTabs(stored: StoredTabs | null, check: (target: TabTarget) => TabTarget | null): StoredTabs | null {
  if (!stored) return null;
  const activeAt = stored.tabs.findIndex((t) => t.id === stored.active);
  const kept: Array<{ id: string; target: TabTarget; at: number }> = [];
  stored.tabs.forEach((entry, at) => {
    const target = check(entry.target);
    if (target) kept.push({ id: entry.id, target, at });
  });
  if (kept.length === 0) return null;
  const active = kept.find((t) => t.at === activeAt) ?? kept.find((t) => t.at > activeAt) ?? kept[kept.length - 1]!;
  return { tabs: kept.map(({ id, target }) => ({ id, target })), active: active.id };
}

/** 「タブを使う」 (settings → 表示, this device; on by default). */
export function readUseTabs(): boolean {
  try {
    return localStorage.getItem(USE_TABS) !== "0";
  } catch {
    return true;
  }
}

export function writeUseTabs(on: boolean): void {
  try {
    if (on) localStorage.removeItem(USE_TABS);
    else localStorage.setItem(USE_TABS, "0");
  } catch {
    /* a per-device convenience only */
  }
}
