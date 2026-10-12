/**
 * 2026-10-12 (docs/MOBILE_UI.md §18.2): where Desktop / Web puts each place — an icon in the places rail, a row near the
 * sidebar's top, or only under 「その他」 — and whether the rail shows at all. Mine on every device (UserMe.desktop_places),
 * apart from UserMe.nav_items: the phones' tiles no longer follow the desktop's placement (nav_items keeps the shared
 * order and the phones' visibility).
 */
import type { UserMe } from "../api/types";

export type PlaceSpot = "rail" | "sidebar" | "hidden";
export type DesktopPlaces = NonNullable<UserMe["desktop_places"]>;

/** The desktop's own places after the nav items: the Times feed and my own Times (MOBILE_UI.md §18.5). */
export const TIMES_PLACE_KEYS: readonly string[] = ["times-feed", "my-times"];

/** Not chosen: スレッド and 下書き are sidebar rows (under ⌘K / 未読), everything else stands in the rail. */
const DEFAULT_SPOTS: Readonly<Record<string, PlaceSpot>> = { threads: "sidebar", drafts: "sidebar" };

export function defaultSpot(key: string): PlaceSpot {
  return DEFAULT_SPOTS[key] ?? "rail";
}

/** Whether the rail shows (null / a server without the setting: yes). */
export function railShown(stored: DesktopPlaces | null | undefined): boolean {
  return stored?.rail ?? true;
}

/** Where I put `key` (else its default). */
export function chosenSpot(stored: DesktopPlaces | null | undefined, key: string): PlaceSpot {
  const item = stored?.items?.find((entry) => entry.key === key);
  return item ? item.place : defaultSpot(key);
}

/** Where `key` is drawn now: with the rail hidden, its places are sidebar rows. */
export function shownSpot(stored: DesktopPlaces | null | undefined, key: string): PlaceSpot {
  const spot = chosenSpot(stored, key);
  return spot === "rail" && !railShown(stored) ? "sidebar" : spot;
}

/** `stored` with `key` put at `spot` (the other items, unknown keys too, kept in their order). */
export function withSpot(stored: DesktopPlaces | null | undefined, key: string, spot: PlaceSpot): DesktopPlaces {
  const items = [...(stored?.items ?? [])];
  const at = items.findIndex((entry) => entry.key === key);
  if (at >= 0) items[at] = { key, place: spot };
  else items.push({ key, place: spot });
  return { rail: railShown(stored), items };
}

/** `stored` with the rail shown or hidden. */
export function withRail(stored: DesktopPlaces | null | undefined, rail: boolean): DesktopPlaces {
  return { rail, items: [...(stored?.items ?? [])] };
}
