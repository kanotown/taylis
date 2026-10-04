/**
 * 管理 →「ユーザー」 (2026-10-04): the search, the filter chips and the sort of the users list, pure so the tests can
 * check them; the choice of filter and sort is remembered per device (localStorage, a convenience only).
 */
import type { AdminUserOut } from "../api/types";

export type UserFilter = "all" | "active" | "deactivated" | "admin" | "member" | "guest" | "bot" | "temporary";
export type UserSort = "name" | "username" | "newest" | "oldest" | "role";

export const USER_FILTERS: ReadonlyArray<[UserFilter, string]> = [
  ["all", "すべて"],
  ["active", "有効"],
  ["deactivated", "無効"],
  ["admin", "管理者"],
  ["member", "メンバー"],
  ["guest", "ゲスト"],
  ["bot", "ボット"],
  ["temporary", "仮パスワード"],
];

export const USER_SORTS: ReadonlyArray<[UserSort, string]> = [
  ["name", "名前"],
  ["username", "ユーザー名"],
  ["newest", "作成日 (新しい順)"],
  ["oldest", "作成日 (古い順)"],
  ["role", "役割"],
];

const ROLE_ORDER = ["admin", "member", "guest", "bot"];

function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** Whether `user` matches the search box: its display name, username or email contains every word (a leading @ is ignored). */
export function matchesUserSearch(user: AdminUserOut, query: string): boolean {
  const words = fold(query).split(/\s+/).map((word) => word.replace(/^@/, "")).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [user.display_name, user.username, user.email ?? ""].map(fold);
  return words.every((word) => haystack.some((text) => text.includes(word)));
}

export function matchesUserFilter(user: AdminUserOut, filter: UserFilter): boolean {
  const off = !!user.deactivated_at;
  switch (filter) {
    case "all": return true;
    case "active": return !off;
    case "deactivated": return off;
    case "temporary": return user.must_change_password && !off;
    default: return user.role === filter;
  }
}

/** How many of `users` each chip would show. */
export function userFilterCounts(users: readonly AdminUserOut[]): Record<UserFilter, number> {
  const counts = Object.fromEntries(USER_FILTERS.map(([value]) => [value, 0])) as Record<UserFilter, number>;
  for (const user of users) for (const [value] of USER_FILTERS) if (matchesUserFilter(user, value)) counts[value] += 1;
  return counts;
}

const byName = (a: AdminUserOut, b: AdminUserOut) => a.display_name.localeCompare(b.display_name, "ja") || a.username.localeCompare(b.username);

export function sortUsers(users: readonly AdminUserOut[], sort: UserSort): AdminUserOut[] {
  const list = [...users];
  const created = (user: AdminUserOut) => Date.parse(user.created_at) || 0;
  const role = (user: AdminUserOut) => { const index = ROLE_ORDER.indexOf(user.role); return index < 0 ? ROLE_ORDER.length : index; };
  switch (sort) {
    case "name": return list.sort(byName);
    case "username": return list.sort((a, b) => a.username.localeCompare(b.username));
    case "newest": return list.sort((a, b) => created(b) - created(a) || byName(a, b));
    case "oldest": return list.sort((a, b) => created(a) - created(b) || byName(a, b));
    case "role": return list.sort((a, b) => role(a) - role(b) || byName(a, b));
  }
}

/** The list as shown: searched, filtered, sorted. */
export function visibleUsers(users: readonly AdminUserOut[], query: string, filter: UserFilter, sort: UserSort): AdminUserOut[] {
  return sortUsers(users.filter((user) => matchesUserSearch(user, query) && matchesUserFilter(user, filter)), sort);
}

export const USERS_VIEW_KEY = "chikuwa.admin.users.view";
const DEFAULT_VIEW = { filter: "all" as UserFilter, sort: "name" as UserSort };

/** The remembered filter and sort (the defaults when nothing valid is stored or storage is unavailable). */
export function readUsersView(): { filter: UserFilter; sort: UserSort } {
  try {
    const parsed = JSON.parse(localStorage.getItem(USERS_VIEW_KEY) ?? "null") as { filter?: unknown; sort?: unknown } | null;
    const filter = USER_FILTERS.find(([value]) => value === parsed?.filter)?.[0] ?? DEFAULT_VIEW.filter;
    const sort = USER_SORTS.find(([value]) => value === parsed?.sort)?.[0] ?? DEFAULT_VIEW.sort;
    return { filter, sort };
  } catch {
    return { ...DEFAULT_VIEW };
  }
}

export function writeUsersView(view: { filter: UserFilter; sort: UserSort }): void {
  try {
    localStorage.setItem(USERS_VIEW_KEY, JSON.stringify(view));
  } catch {
    // A private window or blocked storage: the choice lasts until the dialog closes.
  }
}
