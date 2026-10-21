/**
 * The drive screen's plain rules (M161, docs/DRIVE.md §17): breadcrumbs, the pages of a folder, sorting, selection,
 * what opens in which viewer, and the drive file as the viewers' attachment.
 */
import type { AttachmentOut, DriveCrumb, DriveItemOut, DriveLocationOut } from "../api/types";
import { type MessageKey, t } from "../i18n";

export type DriveSort = "name" | "modified" | "size";
export type DriveOrder = "asc" | "desc";
export type DriveViewMode = "list" | "grid";

/** The name a location shows: 研究室ドライブ / マイドライブ in the UI language, a channel by its name. */
export function locationName(location: Pick<DriveLocationOut, "kind" | "name">): string {
  if (location.kind === "workspace") return t("drive.location.workspace");
  if (location.kind === "user") return t("drive.location.mine");
  return `#${location.name}`;
}

/** The locations column's order: 研究室ドライブ, マイドライブ, then the channels by name. */
export function orderLocations(locations: readonly DriveLocationOut[]): DriveLocationOut[] {
  const rank = (location: DriveLocationOut) => (location.kind === "workspace" ? 0 : location.kind === "user" ? 1 : 2);
  return [...locations].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "ja"));
}

/**
 * The breadcrumbs to draw: the location's name for the root, then the folders. More than `max` collapse the middle into
 * one "…" (its folders listed in a menu), keeping the root and the last `max - 2`.
 */
export function breadcrumbs(path: readonly DriveCrumb[], rootName: string, max = 5): { shown: DriveCrumb[]; hidden: DriveCrumb[] } {
  const named = path.map((crumb, index) => (index === 0 ? { ...crumb, name: rootName } : crumb));
  if (named.length <= max) return { shown: named, hidden: [] };
  const keep = Math.max(1, max - 2);
  return { shown: [named[0]!, ...named.slice(named.length - keep)], hidden: named.slice(1, named.length - keep) };
}

/** A path as one line (「研究室ドライブ › ゼミ資料 › 2026」). */
export function pathLine(path: readonly DriveCrumb[], rootName?: string): string {
  return path.map((crumb, index) => (index === 0 && rootName ? rootName : crumb.name)).join(" › ");
}

/** The next page appended to the rows held (an item already held, moved between pages by a change, counts once). */
export function appendPage(held: readonly DriveItemOut[], page: readonly DriveItemOut[]): DriveItemOut[] {
  const seen = new Set(held.map((item) => item.id));
  return [...held, ...page.filter((item) => !seen.has(item.id))];
}

/** The time a row shows: the file's own time when known, else the last change. */
export function itemTime(item: Pick<DriveItemOut, "content_modified_at" | "updated_at">): string {
  return item.content_modified_at ?? item.updated_at;
}

export type DriveIconKind = "folder" | "image" | "video" | "pdf" | "document" | "sheet" | "slides" | "archive" | "text" | "file";

const OFFICE: Readonly<Record<string, DriveIconKind>> = {
  doc: "document", docx: "document", odt: "document", rtf: "document",
  xls: "sheet", xlsx: "sheet", ods: "sheet", csv: "sheet",
  ppt: "slides", pptx: "slides", odp: "slides",
  zip: "archive", "7z": "archive", gz: "archive", tar: "archive", rar: "archive",
  txt: "text", md: "text", tex: "text", json: "text",
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function iconKind(item: Pick<DriveItemOut, "kind" | "name" | "content_type">): DriveIconKind {
  if (item.kind === "folder") return "folder";
  const type = (item.content_type ?? "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  return OFFICE[extensionOf(item.name)] ?? "file";
}

export type ViewerKind = "image" | "video" | "document";

/**
 * Which of the app's viewers opens a file (§17.2): photos with a thumbnail (the server could read them), videos, and
 * PDF / Office files whose preview is ready or being made; anything else downloads.
 */
export function viewerKind(item: Pick<DriveItemOut, "kind" | "content_type" | "file">): ViewerKind | null {
  if (item.kind !== "file" || !item.file) return null;
  const type = (item.content_type ?? "").toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/") && item.file.has_thumbnail) return "image";
  const status = item.file.preview?.status;
  if (status === "ready" || status === "pending") return "document";
  return null;
}

/** The thumbnail a row or a tile shows (null: an icon). */
export function thumbnailPath(item: Pick<DriveItemOut, "kind" | "file">): string | null {
  const file = item.file;
  if (item.kind !== "file" || !file) return null;
  if (file.has_thumbnail || file.has_poster) return `/api/v1/attachments/${file.attachment_id}/thumbnail`;
  if (file.preview?.status === "ready") return `/api/v1/attachments/${file.attachment_id}/preview/thumbnail`;
  return null;
}

/** Drive files handed to the attachment viewers: their downloads go the drive's way (controller.downloadAttachment). */
const driveFiles = new WeakMap<AttachmentOut, { id: string; name: string; size_bytes: number | null }>();

export function driveFileOf(attachment: AttachmentOut): { id: string; name: string; size_bytes: number | null } | null {
  return driveFiles.get(attachment) ?? null;
}

/** The current version of a drive file as an AttachmentOut (the viewers' shape), remembered as a drive file. */
export function asAttachment(item: DriveItemOut): AttachmentOut | null {
  const file = item.file;
  if (item.kind !== "file" || !file) return null;
  const attachment: AttachmentOut = {
    id: file.attachment_id,
    filename: item.name,
    content_type: item.content_type ?? "application/octet-stream",
    size_bytes: item.size_bytes ?? 0,
    created_at: item.updated_at,
    status: "attached",
    width: file.width,
    height: file.height,
    has_thumbnail: file.has_thumbnail,
    has_poster: file.has_poster,
    duration_ms: file.duration_ms,
    preview: file.preview ?? null,
  };
  driveFiles.set(attachment, { id: item.id, name: item.name, size_bytes: item.size_bytes });
  return attachment;
}

/** The files of a listing the viewer steps through with ← → (§17.2: the same folder's files). */
export function viewable(items: readonly DriveItemOut[]): DriveItemOut[] {
  return items.filter((item) => viewerKind(item) !== null);
}

/** The neighbour of `id` among `items` (−1 back, +1 on), or null at an end. */
export function stepItem(items: readonly DriveItemOut[], id: string, by: -1 | 1): DriveItemOut | null {
  const at = items.findIndex((item) => item.id === id);
  if (at < 0) return null;
  return items[at + by] ?? null;
}

/**
 * The selection after a click: alone; ⌘ / Ctrl toggles one; Shift takes the range from the anchor (the last plain or ⌘
 * click). Returns the new selection and anchor.
 */
export function clickSelection(order: readonly string[], selected: ReadonlySet<string>, anchor: string | null, id: string, keys: { toggle: boolean; range: boolean }): { selected: Set<string>; anchor: string } {
  if (keys.range && anchor && order.includes(anchor)) {
    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const range = new Set(keys.toggle ? selected : []);
    for (const key of order.slice(lo, hi + 1)) range.add(key);
    return { selected: range, anchor };
  }
  if (keys.toggle) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  return { selected: new Set([id]), anchor: id };
}

const SORT_LABELS: Readonly<Record<DriveSort, MessageKey>> = { name: "drive.sort.name", modified: "drive.sort.modified", size: "drive.sort.size" };

export function sortLabel(sort: DriveSort): string {
  return t(SORT_LABELS[sort]);
}

/** A column header pressed: the same one turns the order round, another starts ascending (newest first for time). */
export function nextSort(current: { sort: DriveSort; order: DriveOrder }, pressed: DriveSort): { sort: DriveSort; order: DriveOrder } {
  if (current.sort === pressed) return { sort: pressed, order: current.order === "asc" ? "desc" : "asc" };
  return { sort: pressed, order: pressed === "name" ? "asc" : "desc" };
}

const VIEW_KEY = "taylis.drive.view";

/** List or grid, remembered on this device (§17.2). */
export function readViewMode(): DriveViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function writeViewMode(mode: DriveViewMode): void {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* per-device convenience */
  }
}

/** 「1.2 GB」: the drive's sizes go past the attachments' MB. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 「3 分」「1 時間 5 分」 for the time left. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return t("drive.upload.secondsLeft", { n: Math.max(1, Math.round(seconds)) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("drive.upload.minutesLeft", { n: minutes });
  return t("drive.upload.hoursLeft", { h: Math.floor(minutes / 60), m: minutes % 60 });
}
