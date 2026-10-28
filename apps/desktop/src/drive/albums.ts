/**
 * AL2 (docs/ALBUMS.md §10, §18.4): the plain rules of the photo albums on Desktop / Web, kept apart from the screens so
 * the tests read them without a DOM:
 *
 * - what is a photo or a video of an album, the time it is sorted by (capture time, else the file's, else made) and the
 *   day headings of the grid (only in the capture-date order, the server's own order);
 * - the album's dates (its own days, else the photos' range) and count for the header, the list and the `/d/` card;
 * - the grid's rows for a given width (3–8 columns, day headings) and the rows in view (only those are drawn: a
 *   tile's thumbnail is read when its row is drawn);
 * - the viewer's sources (the display size, the original on 「元の画像」 or a zoom past it, an icon for HEIC) and the
 *   neighbours read ahead;
 * - the slideshow's order (in order or shuffled, from the photo it started at), how long a slide stays (videos muted to
 *   their end, 60 s at most; 「動画を飛ばす」 leaves them out);
 * - 「チャンネルに知らせる」's draft, a new album's default name from a message, the share link's `originals` default.
 */
import type { AlbumOut, AttachmentOut, DriveItemOut, SharedAlbumOut, SharedItemOut } from "../api/types";
import { t, weekdayName } from "../i18n";

export type AlbumSort = "taken" | "name" | "added";
export type AlbumOrder = "asc" | "desc";

/** The longest a video stays on in a slideshow (§8, §17 Q6). */
export const SLIDESHOW_VIDEO_MAX_MS = 60_000;
export const SLIDESHOW_INTERVALS = [3, 5, 10] as const;
export type SlideshowInterval = (typeof SLIDESHOW_INTERVALS)[number];

/** Raster images the server hands back as they are when it has no display size yet (its INLINE_TYPES). */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type MediaLike = Pick<DriveItemOut, "kind" | "content_type">;

/** A photo or a video (what an album shows in its grid; other files are listed apart). */
export function isAlbumMedia(item: MediaLike): boolean {
  if (item.kind !== "file") return false;
  const type = (item.content_type ?? "").toLowerCase();
  return type.startsWith("image/") || type.startsWith("video/");
}

export function isVideo(item: Pick<DriveItemOut, "content_type">): boolean {
  return (item.content_type ?? "").toLowerCase().startsWith("video/");
}

/** The time a photo is sorted and grouped by (the server's order): capture time, else the file's own, else made. */
export function mediaTime(item: Pick<DriveItemOut, "file" | "content_modified_at" | "created_at">): string {
  return item.file?.taken_at ?? item.content_modified_at ?? item.created_at;
}

function localKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 「9月16日（火）」 (another year: with the year) in the UI language. */
export function dayHeading(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const params = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), weekday: weekdayName((date.getDay() + 6) % 7) };
  return date.getFullYear() === now.getFullYear() ? t("albums.day", params) : t("albums.dayYear", params);
}

export interface DayGroup<T> {
  key: string;
  /** The heading (null: no headings in this order). */
  label: string | null;
  items: T[];
}

/**
 * The grid's groups: one per local day in the capture-date order (consecutive photos of the same day; the server
 * sorted them), else one group without a heading (by name, by when they were added).
 */
export function dayGroups(items: readonly DriveItemOut[], sort: AlbumSort, now: Date = new Date()): DayGroup<DriveItemOut>[] {
  if (items.length === 0) return [];
  if (sort !== "taken") return [{ key: "all", label: null, items: [...items] }];
  const groups: DayGroup<DriveItemOut>[] = [];
  for (const item of items) {
    const iso = mediaTime(item);
    const date = new Date(iso);
    const key = Number.isNaN(date.getTime()) ? "unknown" : localKey(date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key: groups.some((group) => group.key === key) ? `${key}#${groups.length}` : key, label: key === "unknown" ? t("albums.noDate") : dayHeading(iso, now), items: [item] });
  }
  return groups;
}

/** "YYYY-MM-DD" (a date) or an ISO time, as the local day; null when unreadable. */
function asDay(value: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!value) return null;
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) return { y: Number(plain[1]), m: Number(plain[2]), d: Number(plain[3]) };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

type Dated = Pick<AlbumOut, "starts_on" | "ends_on" | "taken_from" | "taken_to"> | Pick<SharedAlbumOut, "starts_on" | "ends_on" | "taken_from" | "taken_to">;

/**
 * The album's days (§10.2): its own (`starts_on`〜`ends_on`), else the range of its photos' capture times:
 * 「2026/9/16〜9/19」, one day 「2026/9/16」, across a new year 「2026/12/30〜2027/1/2」. "" when there are none.
 */
export function albumDates(album: Dated): string {
  const own = asDay(album.starts_on) ?? asDay(album.ends_on);
  const from = own ? asDay(album.starts_on) ?? own : asDay(album.taken_from);
  const to = own ? asDay(album.ends_on) ?? from : asDay(album.taken_to) ?? from;
  if (!from) return "";
  const first = `${from.y}/${from.m}/${from.d}`;
  if (!to || (to.y === from.y && to.m === from.m && to.d === from.d)) return first;
  const last = to.y === from.y ? `${to.m}/${to.d}` : `${to.y}/${to.m}/${to.d}`;
  return t("albums.range", { from: first, to: last });
}

/** 「312 枚」, with videos 「312 枚 · 動画 8 本」, empty 「写真はまだありません」. */
export function albumCount(album: Pick<AlbumOut, "photo_count" | "video_count">): string {
  if (album.photo_count === 0 && album.video_count === 0) return t("albums.empty");
  const parts = [];
  if (album.photo_count > 0) parts.push(t("albums.photos", { count: album.photo_count }));
  if (album.video_count > 0) parts.push(t("albums.videos", { count: album.video_count }));
  return parts.join(" · ");
}

/** The card's and the list's line: 「312 枚 · 2026/9/16〜9/19」. */
export function albumLine(album: Pick<AlbumOut, "photo_count" | "video_count"> & Dated): string {
  return [albumCount(album), albumDates(album)].filter(Boolean).join(" · ");
}

// --- the grid --------------------------------------------------------------------------------------------------------

export const GRID_GAP = 4;
export const GRID_PADDING = 16;
export const GRID_HEADING = 40;
const MIN_TILE = 132;

/** 3 to 8 square tiles across, as wide as the grid allows (§10.2). */
export function gridColumns(width: number): number {
  if (!(width > 0)) return 4;
  const inner = width - GRID_PADDING * 2;
  return Math.max(3, Math.min(8, Math.floor((inner + GRID_GAP) / (MIN_TILE + GRID_GAP))));
}

export type GridRow<T> =
  | { kind: "heading"; key: string; label: string; top: number; height: number }
  | { kind: "tiles"; key: string; items: T[]; top: number; height: number };

export interface GridLayout<T> {
  rows: GridRow<T>[];
  columns: number;
  tile: number;
  height: number;
}

/** The grid's rows (headings and rows of tiles) and their places, for a width. */
export function layoutGrid<T>(groups: readonly DayGroup<T>[], width: number): GridLayout<T> {
  const columns = gridColumns(width);
  const inner = Math.max(0, (width > 0 ? width : 4 * (MIN_TILE + GRID_GAP)) - GRID_PADDING * 2);
  const tile = Math.max(40, Math.floor((inner - GRID_GAP * (columns - 1)) / columns));
  const rows: GridRow<T>[] = [];
  let top = GRID_PADDING / 2;
  for (const group of groups) {
    if (group.label !== null) {
      rows.push({ kind: "heading", key: `h:${group.key}`, label: group.label, top, height: GRID_HEADING });
      top += GRID_HEADING;
    }
    for (let at = 0; at < group.items.length; at += columns) {
      rows.push({ kind: "tiles", key: `r:${group.key}:${at}`, items: group.items.slice(at, at + columns), top, height: tile + GRID_GAP });
      top += tile + GRID_GAP;
    }
  }
  return { rows, columns, tile, height: top + GRID_PADDING / 2 };
}

/** The rows drawn for a scroll position: those in view and `overscan` px around (a binary search; rows are in order). */
export function visibleRows<T>(rows: readonly GridRow<T>[], scrollTop: number, viewport: number, overscan = 600): { from: number; to: number } {
  if (rows.length === 0) return { from: 0, to: 0 };
  const start = Math.max(0, scrollTop - overscan);
  const end = scrollTop + Math.max(viewport, 1) + overscan;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid]!;
    if (row.top + row.height <= start) lo = mid + 1;
    else hi = mid;
  }
  let to = lo;
  while (to < rows.length && rows[to]!.top < end) to += 1;
  return { from: lo, to };
}

/** 「0:42」「1:05:10」: a video's length on its tile. */
export function durationLabel(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// --- the viewer ------------------------------------------------------------------------------------------------------

/** Whether a photo can be drawn at all (HEIC from a Mac has neither a thumbnail nor a display size: an icon, §6.3). */
export function hasPicture(item: Pick<DriveItemOut, "content_type" | "file">): boolean {
  const file = item.file;
  if (!file) return false;
  return file.has_display || file.has_thumbnail || RASTER.has((item.content_type ?? "").toLowerCase());
}

export interface ViewerSources {
  /** The display size (2048 px WebP); the server answers the original raster image while it has none. */
  display: string;
  /** The original (「元の画像」, a zoom past the display size). */
  original: string;
}

/** Where the viewer reads a photo (§18.4); null for a video or a photo that cannot be drawn. */
export function viewerSources(item: DriveItemOut): ViewerSources | null {
  if (item.kind !== "file" || !item.file || isVideo(item) || !hasPicture(item)) return null;
  return {
    display: `/api/v1/attachments/${item.file.attachment_id}/display`,
    original: `/api/v1/drive/items/${item.id}/content?inline=1`,
  };
}

/** The neighbours to read ahead (§6.1: the next and previous `n`), nearest first, never the shown one. */
export function neighbours<T>(items: readonly T[], index: number, n = 2): T[] {
  const out: T[] = [];
  for (let step = 1; step <= n; step++) {
    const next = items[index + step];
    const back = items[index - step];
    if (next !== undefined) out.push(next);
    if (back !== undefined) out.push(back);
  }
  return out;
}

/** A horizontal swipe's direction (−1 back, +1 on), or 0 when it was a tap or mostly vertical. */
export function swipeStep(dx: number, dy: number, threshold = 50): -1 | 0 | 1 {
  if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

/** 「位置情報あり」 is told in the details only (never on the grid, §10.2). */
export function hasLocation(item: Pick<DriveItemOut, "file">): boolean {
  return item.file?.has_location === true;
}

// --- the slideshow ---------------------------------------------------------------------------------------------------

/** What a slideshow shows: photos that can be drawn, and videos unless 「動画を飛ばす」. */
export function slideshowItems(items: readonly DriveItemOut[], skipVideos: boolean): DriveItemOut[] {
  return items.filter((item) => item.kind === "file" && (isVideo(item) ? !skipVideos : hasPicture(item)));
}

/**
 * The slides' order: the album's from the start, or shuffled (Fisher–Yates) with the start first. A start not among
 * them begins at the first.
 */
export function slideshowOrder<T extends { id: string }>(items: readonly T[], mode: "order" | "random", startId: string | null, random: () => number = Math.random): T[] {
  const at = Math.max(0, items.findIndex((item) => item.id === startId));
  if (mode === "order") return [...items.slice(at), ...items.slice(0, at)];
  const rest = items.filter((_, index) => index !== at);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return items[at] ? [items[at], ...rest] : rest;
}

/** A video's `ended` normally moves on; the timer only stops one that never ends (its loading counted in). */
export const SLIDESHOW_VIDEO_GRACE_MS = 5_000;

/**
 * The longest a slide stays: a photo the interval; a video plays muted to its end (its `ended` moves on), and the timer
 * stops it at its length and a little more for its loading, 60 s at most (unknown length: 60 s).
 */
export function slideDuration(item: Pick<DriveItemOut, "content_type" | "file">, intervalSeconds: number): number {
  if (!isVideo(item)) return intervalSeconds * 1000;
  const length = item.file?.duration_ms;
  return length && length > 0 ? Math.min(length + SLIDESHOW_VIDEO_GRACE_MS, SLIDESHOW_VIDEO_MAX_MS) : SLIDESHOW_VIDEO_MAX_MS;
}

const SLIDESHOW_KEY = "taylis.albums.slideshow";

export interface SlideshowSettings {
  interval: SlideshowInterval;
  random: boolean;
  skipVideos: boolean;
}

export const DEFAULT_SLIDESHOW: SlideshowSettings = { interval: 5, random: false, skipVideos: false };

/** The slideshow's choices, remembered on this device. */
export function readSlideshowSettings(): SlideshowSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SLIDESHOW_KEY) ?? "null") as Partial<SlideshowSettings> | null;
    if (!raw) return DEFAULT_SLIDESHOW;
    return {
      interval: (SLIDESHOW_INTERVALS as readonly number[]).includes(raw.interval as number) ? (raw.interval as SlideshowInterval) : DEFAULT_SLIDESHOW.interval,
      random: raw.random === true,
      skipVideos: raw.skipVideos === true,
    };
  } catch {
    return DEFAULT_SLIDESHOW;
  }
}

export function writeSlideshowSettings(settings: SlideshowSettings): void {
  try {
    localStorage.setItem(SLIDESHOW_KEY, JSON.stringify(settings));
  } catch {
    /* per-device convenience */
  }
}

// --- the album as a folder -------------------------------------------------------------------------------------------

const AS_FILES_KEY = "taylis.albums.asFiles";

/** §10.1: an album folder opens as the album unless 「ファイルの一覧で見る」 was chosen on this device. */
export function readAlbumAsFiles(): boolean {
  try {
    return localStorage.getItem(AS_FILES_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAlbumAsFiles(asFiles: boolean): void {
  try {
    localStorage.setItem(AS_FILES_KEY, asFiles ? "1" : "0");
  } catch {
    /* per-device convenience */
  }
}

/** Whether a folder can be made an album here (not the top folder, not 「投稿のファイル」; the server checks too). */
export function canBecomeAlbum(item: Pick<DriveItemOut, "kind" | "parent_id" | "album"> & { system_role?: DriveItemOut["system_role"] }): boolean {
  return item.kind === "folder" && !!item.parent_id && !item.system_role && !item.album;
}

/** 「チャンネルに知らせる」's draft (§10.4): 「写真を追加しました（12 枚）」 when photos were added on this screen, and the link. */
export function notifyDraft(current: string, url: string, added: number): string {
  const line = added > 0 ? `${t("albums.notify.added", { count: added })}\n${url} ` : `${url} `;
  return current.trim() ? `${current.replace(/\s+$/, "")}\n${line}` : line;
}

/** 「この投稿の写真でアルバムを作る」's default name (§9): 「#学会 2026-09-16」 (a DM: the date only). */
export function albumNameFor(channelName: string | null | undefined, at: string): string {
  const date = new Date(at);
  const day = Number.isNaN(date.getTime()) ? "" : localKey(date);
  return [channelName ? `#${channelName}` : "", day].filter(Boolean).join(" ") || t("albums.untitled");
}

/** The photos and videos of a message that can go into an album (stored, not being sent). */
export function albumAttachments(attachments: readonly AttachmentOut[]): AttachmentOut[] {
  return attachments.filter((attachment) => attachment.status === "attached" && /^(image|video)\//i.test(attachment.content_type ?? ""));
}

/** §7: a new link to an album folder hands out the display sizes only, unless 「元の写真のダウンロードを許す」. */
export function originalsDefault(item: Pick<DriveItemOut, "kind" | "album">): boolean {
  return !(item.kind === "folder" && item.album);
}

/** The display size saved from the public page: the name with `.webp` (「IMG_1234.webp」). */
export function webpName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.webp`;
}

/** What the public page offers to save a file as (§7): the file, the display size, or nothing (403 otherwise). */
export function publicSave(item: Pick<SharedItemOut, "kind" | "content_type" | "has_display">, originals: boolean): "original" | "display" | null {
  if (item.kind !== "file") return null;
  if (originals) return "original";
  if ((item.content_type ?? "").toLowerCase().startsWith("video/")) return "original";
  if ((item.content_type ?? "").toLowerCase() === "image/gif") return "original";
  return item.has_display ? "display" : null;
}

/** The results of an add (§9): how many went in, how many failed (the first error). */
export function addSummary(results: readonly { ok: boolean; error?: string | null }[]): { done: number; failed: number; error: string | null } {
  const failed = results.filter((result) => !result.ok);
  return { done: results.length - failed.length, failed: failed.length, error: failed[0]?.error ?? null };
}

/** An "YYYY-MM-DD" date shown in the settings' date inputs (the server's dates are the same form). */
export function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The settings form's dates: both empty, one, or the end not before the start. */
export function datesProblem(starts: string, ends: string): string | null {
  if (starts && !isDay(starts)) return t("albums.settings.badDate");
  if (ends && !isDay(ends)) return t("albums.settings.badDate");
  if (starts && ends && ends < starts) return t("albums.settings.endsBeforeStarts");
  return null;
}

