/**
 * The drive screen's plain rules (M161, docs/DRIVE.md §17): breadcrumbs, the pages of a folder, sorting, selection,
 * what opens in which viewer, and the drive file as the viewers' attachment.
 */
import type { AttachmentOut, DriveCrumb, DriveItemOut, DriveLocationOut } from "../api/types";
import { type MessageKey, t } from "../i18n";
import { isAudioType, mediaKind } from "../ui/attachmentLayout";
import { dateLabel, dayKey, timeLabel } from "../ui/format";

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

export type DriveIconKind = "folder" | "image" | "video" | "audio" | "pdf" | "document" | "sheet" | "slides" | "archive" | "text" | "file";

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
  if (isAudioType(type)) return "audio";
  if (isPdf(item)) return "pdf";
  return OFFICE[extensionOf(item.name)] ?? "file";
}

export type ViewerKind = "image" | "video" | "audio" | "document";

const OFFICE_EXTENSIONS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf"]);
const OFFICE_TYPE = /^application\/(msword|rtf|vnd\.ms-(excel|powerpoint)|vnd\.openxmlformats-officedocument\.|vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)$)/;
/** What the server's sniffer answers for a file it could not place (the server then goes by the extension). */
const UNPLACED = new Set(["", "application/octet-stream", "application/zip", "application/x-ole-storage"]);

type Viewable = Pick<DriveItemOut, "kind" | "name" | "content_type" | "file">;

/** A PDF: by its type, or by its name when the server could not tell (bytes before the header, §27). */
export function isPdf(item: Pick<DriveItemOut, "kind" | "name" | "content_type">): boolean {
  if (item.kind !== "file") return false;
  const type = (item.content_type ?? "").toLowerCase();
  return type === "application/pdf" || (extensionOf(item.name) === "pdf" && (type === "" || type === "application/octet-stream"));
}

/** An Office file the converter may turn into a PDF (the server's preview_kinds.source_kind). */
export function isOffice(item: Pick<DriveItemOut, "kind" | "name" | "content_type">): boolean {
  if (item.kind !== "file") return false;
  const type = (item.content_type ?? "").toLowerCase();
  return OFFICE_TYPE.test(type) || (UNPLACED.has(type) && OFFICE_EXTENSIONS.has(extensionOf(item.name)));
}

/**
 * Which of the app's viewers opens a file (§17.2, §27): photos with a thumbnail (the server could read them), videos,
 * sounds (2026-10-28, PREVIEWS.md §13: `audio/*`, and a video the server found no picture in), every PDF (its own bytes while its preview is not made), and Office files (the viewer waits for, or asks for, the
 * preview). Anything else has no viewer: opening it shows its details, and only 「ダウンロード」 downloads it.
 */
export function viewerKind(item: Viewable): ViewerKind | null {
  if (item.kind !== "file" || !item.file) return null;
  const type = (item.content_type ?? "").toLowerCase();
  if (type.startsWith("video/") || isAudioType(type)) {
    return mediaKind({ content_type: type, has_thumbnail: false, width: item.file.width, duration_ms: item.file.duration_ms, has_poster: item.file.has_poster }) === "audio" ? "audio" : "video";
  }
  if (type.startsWith("image/") && item.file.has_thumbnail) return "image";
  const status = item.file.preview?.status;
  if (status === "ready" || status === "pending" || isPdf(item) || isOffice(item)) return "document";
  return null;
}

/**
 * Where the document viewer reads a file's pages (§27):
 * - "preview": the made preview (/attachments/{id}/preview/pdf; for a PDF that is the file itself);
 * - "original": a PDF whose preview is not ready (not made yet, being made, failed, too large): its own bytes;
 * - "making": an Office file's preview is being made (「プレビューを作成中…」 until it is ready);
 * - "ask": an Office file without one (imported, §24): the viewer asks the server to make it;
 * - "failed": the Office file's preview could not be made (the download is offered).
 */
export type DocumentSource = "preview" | "original" | "making" | "ask" | "failed";

export function documentSource(item: Viewable): DocumentSource {
  const status = item.file?.preview?.status;
  if (status === "ready") return "preview";
  if (isPdf(item)) return "original";
  if (status === "pending") return "making";
  if (status === "failed") return "failed";
  return "ask";
}

/**
 * What a click on a row or a tile does (§27): with ⌘ / Ctrl or Shift it only selects; a plain click opens — a folder
 * (into it), a file with a viewer (the viewer), any other file (its details) — and selects it too. The second click of
 * a double click does nothing more (the first one opened already: a folder's next click would land in it).
 */
export function clickAction(item: Viewable, keys: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; detail?: number }): "select" | "folder" | "view" | "details" | "none" {
  if (keys.metaKey || keys.ctrlKey || keys.shiftKey) return "select";
  if ((keys.detail ?? 1) > 1) return "none";
  if (item.kind === "folder") return "folder";
  return viewerKind(item) ? "view" : "details";
}

/** The list's optional columns at a width of the listing (px): the least needed go first as it narrows (§27). */
export interface DriveColumns {
  modified: boolean;
  by: boolean;
  size: boolean;
}

export function driveColumns(width: number): DriveColumns {
  return { by: width >= 700, size: width >= 520, modified: width >= 420 };
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
    // AL1 (docs/ALBUMS.md §6.1): the display size for the full-screen viewers.
    has_display: file.has_display ?? false,
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

/**
 * §27: a row's time, readable at a glance: 「たった今」「3 分前」「5 時間前」 today, 「昨日 14:05」, then the day
 * (「10月3日 (金)」, another year with the year). The exact time is the cell's tooltip (exactTime).
 */
export function driveTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  const sameDay = dayKey(iso, now) === dayKey(now.toISOString(), now);
  if (minutes < 1 && minutes > -5) return t("drive.time.justNow");
  if (sameDay && minutes >= 0 && minutes < 60) return t("drive.time.minutesAgo", { count: minutes });
  if (sameDay && minutes >= 0) return t("drive.time.hoursAgo", { count: Math.floor(minutes / 60) });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(iso, now) === dayKey(yesterday.toISOString(), now)) return `${t("search.date.yesterday")} ${timeLabel(iso)}`;
  return dateLabel(iso, now);
}

/** 「2026年10月22日 (水) 14:05」: the tooltip of a relative time. */
export function exactTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const far = new Date(date.getFullYear() + 1, 0, 1); // always with the year
  return `${dateLabel(iso, far)} ${timeLabel(iso)}`;
}

/** 「3 分」「1 時間 5 分」 for the time left. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return t("drive.upload.secondsLeft", { n: Math.max(1, Math.round(seconds)) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("drive.upload.minutesLeft", { n: minutes });
  return t("drive.upload.hoursLeft", { h: Math.floor(minutes / 60), m: minutes % 60 });
}
