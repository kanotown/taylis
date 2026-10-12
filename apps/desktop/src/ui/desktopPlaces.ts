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
  return { ...stored, rail: railShown(stored), items };
}

/** `stored` with the rail shown or hidden. */
export function withRail(stored: DesktopPlaces | null | undefined, rail: boolean): DesktopPlaces {
  return { ...stored, rail, items: [...(stored?.items ?? [])] };
}

/**
 * 設定の「元に戻す」 for the places: the rail and every place back to their defaults (null), the Times section's position
 * kept (it is the sidebar's order, not a place's spot).
 */
export function withDefaultPlaces(stored: DesktopPlaces | null | undefined): DesktopPlaces | null {
  return stored?.times_before ? { rail: true, items: [], times_before: stored.times_before } : null;
}

/** Whether any place or the rail differs from the defaults (the Times section's position aside). */
export function placesChosen(stored: DesktopPlaces | null | undefined): boolean {
  return !!stored && (!railShown(stored) || (stored.items ?? []).length > 0);
}

// --- where the Times section stands (2026-10-12, TIMES_FEED.md §7) -------------------------------------------------

/** The Times section's key among the sidebar's sections ("favorites", my own sections' ids, "channels", "dms"). */
export const TIMES_SECTION = "times";
/** After every section. */
export const SECTIONS_END = "end";
/** Not chosen (or its section is gone): right above 「チャンネル」. */
export const DEFAULT_TIMES_BEFORE = "channels";

/** The section the Times section stands before (`SECTIONS_END`: after them all); a gone section's id reads as the default. */
export function timesAnchor(stored: DesktopPlaces | null | undefined, keys: readonly string[]): string {
  const chosen = stored?.times_before;
  return chosen && (chosen === SECTIONS_END || keys.includes(chosen)) ? chosen : DEFAULT_TIMES_BEFORE;
}

/**
 * `keys` (the sidebar's sections in order, without Times) with Times put in its place. Pass every section that could
 * show (お気に入り too while empty), so an anchor on one that is not drawn now still lands where it would be.
 */
export function withTimesPlaced(keys: readonly string[], anchor: string): string[] {
  const rest = keys.filter((key) => key !== TIMES_SECTION);
  const at = anchor === SECTIONS_END ? rest.length : rest.indexOf(anchor);
  rest.splice(at < 0 ? rest.length : at, 0, TIMES_SECTION);
  return rest;
}

/** The anchor that puts Times before (`after` false) or after `target` among the `shown` sections. */
export function timesAnchorAt(shown: readonly string[], target: string, after: boolean): string {
  const rest = shown.filter((key) => key !== TIMES_SECTION);
  if (!after) return target;
  return rest[rest.indexOf(target) + 1] ?? SECTIONS_END;
}

/** The anchor after 上へ (-1) / 下へ (+1) on the Times section among the `shown` sections; null at that end. */
export function timesAnchorMoved(shown: readonly string[], step: -1 | 1): string | null {
  const at = shown.indexOf(TIMES_SECTION);
  if (at < 0) return null;
  const neighbour = shown[at + step];
  if (neighbour === undefined) return null;
  return timesAnchorAt(shown, neighbour, step > 0);
}

/** `stored` with the Times section before `anchor` (the default anchor is stored as null). */
export function withTimesBefore(stored: DesktopPlaces | null | undefined, anchor: string): DesktopPlaces {
  return { ...stored, rail: railShown(stored), items: [...(stored?.items ?? [])], times_before: anchor === DEFAULT_TIMES_BEFORE ? null : anchor };
}
