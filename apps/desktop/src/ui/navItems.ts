/**
 * M111: the sidebar's menu items, mine on every device (UserMe.nav_items). The catalogue, the default order and the rule are
 * apps/shared/nav-items.json (the same in the three clients; tests/navItems.test.ts checks this copy against it).
 */

export interface NavItem {
  key: string;
  visible: boolean;
}

export type NavPlatform = "desktop" | "mobile";

interface CatalogueItem {
  key: string;
  label: string;
  visible: boolean;
  platforms: readonly NavPlatform[];
}

export const NAV_CATALOGUE: readonly CatalogueItem[] = [
  { key: "threads", label: "スレッド", visible: true, platforms: ["desktop", "mobile"] },
  { key: "activity", label: "アクティビティ", visible: true, platforms: ["desktop"] },
  { key: "times-feed", label: "Times", visible: true, platforms: ["mobile"] },
  { key: "drafts", label: "下書き", visible: true, platforms: ["desktop", "mobile"] },
  { key: "saved", label: "保存済み", visible: true, platforms: ["desktop", "mobile"] },
  { key: "reminders", label: "リマインダー", visible: true, platforms: ["desktop", "mobile"] },
  { key: "files", label: "ファイル", visible: true, platforms: ["desktop", "mobile"] },
  { key: "canvases", label: "キャンバス", visible: true, platforms: ["desktop", "mobile"] },
  { key: "calendar", label: "カレンダー", visible: true, platforms: ["desktop", "mobile"] },
  { key: "tasks", label: "タスク", visible: true, platforms: ["desktop", "mobile"] },
  { key: "deadlines", label: "締切", visible: true, platforms: ["desktop", "mobile"] },
  { key: "reservations", label: "予約", visible: true, platforms: ["desktop", "mobile"] },
];

export const NAV_ORDER: Readonly<Record<NavPlatform, readonly string[]>> = {
  desktop: ["threads", "activity", "drafts", "reminders", "files", "canvases", "calendar", "tasks", "deadlines", "reservations", "saved", "times-feed"],
  mobile: ["threads", "times-feed", "drafts", "saved", "reminders", "calendar", "tasks", "deadlines", "reservations", "files", "canvases", "activity"],
};

/** The items this client draws in its sidebar (M112: 「予約」 with its page). */
export const DESKTOP_NAV_KEYS: readonly string[] = ["threads", "activity", "drafts", "reminders", "files", "canvases", "calendar", "tasks", "deadlines", "reservations", "saved"];

const byKey = new Map(NAV_CATALOGUE.map((item) => [item.key, item]));

export function navLabel(key: string): string {
  return byKey.get(key)?.label ?? key;
}

/**
 * Everything I have, in my order: not customised (null), the platform's default order and visibility; else my items in
 * their order (a repeated key counts once, unknown keys kept), then each catalogue item I never saved, in the default order,
 * with its default visibility. This is what a change saves, so other platforms' and newer clients' items survive.
 */
export function fullNavItems(stored: readonly NavItem[] | null | undefined, platform: NavPlatform = "desktop"): NavItem[] {
  const defaults = (keys: readonly string[]) => keys.map((key) => ({ key, visible: byKey.get(key)!.visible }));
  if (!stored) return defaults(NAV_ORDER[platform]);
  const seen = new Set<string>();
  const out: NavItem[] = [];
  for (const item of stored) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push({ key: item.key, visible: item.visible });
  }
  return [...out, ...defaults(NAV_ORDER[platform].filter((key) => !seen.has(key)))];
}

/** The items of `full` this client lists (in the catalogue, on the platform, implemented here), with their switch. */
export function shownNavItems(full: readonly NavItem[], platform: NavPlatform = "desktop", implemented: readonly string[] = DESKTOP_NAV_KEYS): NavItem[] {
  return full.filter((item) => byKey.get(item.key)?.platforms.includes(platform) && implemented.includes(item.key));
}

/** The settings' new order of the shown items: they take the slots of `full` they had, in that order; the rest stay. */
export function reorderNavItems(full: readonly NavItem[], order: readonly string[], platform: NavPlatform = "desktop", implemented: readonly string[] = DESKTOP_NAV_KEYS): NavItem[] {
  const editable = new Set(shownNavItems(full, platform, implemented).map((item) => item.key));
  const items = new Map(full.map((item) => [item.key, item]));
  const queue = order.filter((key) => editable.has(key));
  let next = 0;
  return full.map((item) => (editable.has(item.key) && next < queue.length ? items.get(queue[next++]!)! : item));
}

export function setNavItemVisible(full: readonly NavItem[], key: string, visible: boolean): NavItem[] {
  return full.map((item) => (item.key === key ? { ...item, visible } : item));
}

/** Moves one shown item `by` places (−1 up, +1 down) among the shown ones. */
export function moveNavItem(full: readonly NavItem[], key: string, by: number, platform: NavPlatform = "desktop", implemented: readonly string[] = DESKTOP_NAV_KEYS): NavItem[] {
  const keys = shownNavItems(full, platform, implemented).map((item) => item.key);
  const from = keys.indexOf(key);
  const to = from + by;
  if (from < 0 || to < 0 || to >= keys.length) return [...full];
  keys.splice(from, 1);
  keys.splice(to, 0, key);
  return reorderNavItems(full, keys, platform, implemented);
}

/** The sidebar's items to draw, in my order (the visible ones this client implements). */
export function sidebarNavKeys(stored: readonly NavItem[] | null | undefined): string[] {
  return shownNavItems(fullNavItems(stored)).filter((item) => item.visible).map((item) => item.key);
}
