/** M16c: the workspaces (servers) this device knows (WORKSPACES.md §4). Secrets live in the credential store. */

export interface WorkspaceEntry {
  /** The list key: a normalized URL (older installs keep the string they logged in with). */
  serverUrl: string;
  /** GET /server; null until the server has been asked (routing notifications, duplicate check). */
  workspaceId: string | null;
  /** GET /server; the host until known. */
  name: string;
  /** The name signed in with: it names the saved credential and the local database (`server|username`), so it stays. */
  username: string;
  /** M96: the account's username now, when it changed after signing in (`signInName`); missing = `username`. */
  loginName?: string;
  userId: string | null;
  /** The session ended (signed out elsewhere, revoked): the entry stays so signing back in is one step. */
  signedOut?: boolean;
  /** M93: GET /server's `icon_version` (the admin's icon, public); null / missing = the letter tile. */
  iconVersion?: string | null;
}

export const LIST_KEY = "chikuwa.workspaces";
export const ACTIVE_KEY = "chikuwa.workspace.active";
const LEGACY_SERVER_KEY = "chikuwa.server";
const LEGACY_USERNAME_KEY = "chikuwa.username";

/** "chat.example.com" → "https://chat.example.com"; scheme + host (+ port) + path, no trailing slash. */
export function normalizeServerUrl(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Two spellings of one server ("HTTPS://Chat.example.com/" and "https://chat.example.com"). */
export function sameServer(a: string, b: string): boolean {
  return (normalizeServerUrl(a) ?? a) === (normalizeServerUrl(b) ?? b);
}

export function hostLabel(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/** The letters on the rail: 「テス」 → "テ", "ChikuwaChat" → "C", "dev team" → "DT". */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2 && /^[a-z0-9]/i.test(words[0]!) && /^[a-z0-9]/i.test(words[1]!)) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  const first = [...name.trim()][0] ?? "?";
  return first.toUpperCase();
}

const PALETTE = ["#5b5bd6", "#0f9d8a", "#d9480f", "#c2255c", "#1c7ed6", "#7048e8", "#2b8a3e", "#e67700"];

/** A stable colour per workspace for its tile. */
export function workspaceColor(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function valid(entry: unknown): entry is WorkspaceEntry {
  const e = entry as WorkspaceEntry;
  return typeof e === "object" && e !== null && typeof e.serverUrl === "string" && typeof e.username === "string" && typeof e.name === "string";
}

/** M96: the name to show and to sign in with (the account's username now; `username` may be the old one). */
export function signInName(entry: Pick<WorkspaceEntry, "username" | "loginName">): string {
  return entry.loginName ?? entry.username;
}

/**
 * M93: the rail's order after dragging `serverUrl` to `toIndex` (its index in the list as it will be). The list is
 * saved in this order, so the rail, ⌘1 … ⌘9 and the next start follow it. Unknown URLs and no-op moves return the
 * same array.
 */
export function moveWorkspace(entries: WorkspaceEntry[], serverUrl: string, toIndex: number): WorkspaceEntry[] {
  const from = entries.findIndex((e) => e.serverUrl === serverUrl);
  if (from < 0) return entries;
  const to = Math.max(0, Math.min(entries.length - 1, Math.trunc(toIndex)));
  if (to === from) return entries;
  const next = entries.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * M93: where a drop between tiles lands. `gap` is the slot the indicator shows: 0 = before the first tile,
 * n = after the last. Dropping into the slot right before or after the dragged tile keeps the order.
 */
export function dropIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** M93: the gap under the pointer while dragging: how many tiles' middles lie above `y` (0 … n). */
export function gapForPointer(y: number, midpoints: number[]): number {
  let gap = 0;
  for (const mid of midpoints) if (y > mid) gap += 1;
  return gap;
}

/** The last active workspace's list key as saved (no migration, no list read): main.tsx's colours before the first paint. */
export function savedActiveWorkspace(): string | null {
  const active = read<unknown>(ACTIVE_KEY, null);
  return typeof active === "string" ? active : null;
}

/** The saved list, in the order added (or as the user arranged it, M93); the one install that predates workspaces becomes its first entry. */
export function loadWorkspaces(): { entries: WorkspaceEntry[]; active: string | null } {
  let entries = read<unknown[]>(LIST_KEY, []);
  if (!Array.isArray(entries)) entries = [];
  let list = entries.filter(valid).map((e) => ({ ...e, workspaceId: e.workspaceId ?? null, userId: e.userId ?? null }));
  let active = read<string | null>(ACTIVE_KEY, null);
  if (list.length === 0) {
    const server = localStorage.getItem(LEGACY_SERVER_KEY);
    const username = localStorage.getItem(LEGACY_USERNAME_KEY);
    if (server && username) {
      // Keep the exact string: it names the saved credential and the local database (`server|username`).
      list = [{ serverUrl: server, workspaceId: null, name: hostLabel(server), username, userId: null }];
      active = server;
      saveWorkspaces(list, active);
    }
  }
  if (active && !list.some((e) => e.serverUrl === active)) active = list[0]?.serverUrl ?? null;
  return { entries: list, active };
}

export function saveWorkspaces(entries: WorkspaceEntry[], active: string | null): void {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(entries));
    if (active) localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
    else localStorage.removeItem(ACTIVE_KEY);
    // The pre-workspace keys follow the active one, so an older build still opens it.
    const current = entries.find((e) => e.serverUrl === active);
    if (current) {
      localStorage.setItem(LEGACY_SERVER_KEY, current.serverUrl);
      localStorage.setItem(LEGACY_USERNAME_KEY, current.username);
    } else {
      localStorage.removeItem(LEGACY_SERVER_KEY);
      localStorage.removeItem(LEGACY_USERNAME_KEY);
    }
  } catch {
    /* storage refused: the list lives for this run */
  }
}

/** What GET /server answered; anything else is not a ChikuwaChat server. */
export interface ServerInfo {
  product: "chikuwachat";
  workspace_id: string;
  name: string;
  api_version: string;
  /** M93: the workspace icon's version (null: none; missing: a server before M93). */
  icon_version?: string | null;
}

export function isServerInfo(value: unknown): value is ServerInfo {
  const v = value as ServerInfo;
  return typeof v === "object" && v !== null && v.product === "chikuwachat" && typeof v.workspace_id === "string" && typeof v.name === "string";
}
