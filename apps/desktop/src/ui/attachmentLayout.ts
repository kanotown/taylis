import type { AttachmentOut } from "../api/types";
import { t } from "../i18n";

/**
 * How a message shows its attachments (M38). The layout decisions live here, apart from the React tree, so they can
 * be tested without a browser.
 *
 * - photo: the server made a thumbnail (images).
 * - video: `video/*`, shown as a tile in its own shape and played in the in-app viewer (it used to download).
 * - file: everything else, a download row.
 */
export type MediaKind = "photo" | "video" | "file";

export function mediaKind(attachment: Pick<AttachmentOut, "content_type" | "has_thumbnail">): MediaKind {
  if (attachment.content_type.toLowerCase().startsWith("video/")) return "video";
  if (attachment.has_thumbnail) return "photo";
  return "file";
}

export function groupAttachments<T extends Pick<AttachmentOut, "content_type" | "has_thumbnail">>(attachments: T[]) {
  const groups = { photos: [] as T[], videos: [] as T[], files: [] as T[] };
  for (const attachment of attachments) {
    const kind = mediaKind(attachment);
    (kind === "photo" ? groups.photos : kind === "video" ? groups.videos : groups.files).push(attachment);
  }
  return groups;
}

/**
 * One photo keeps its own shape; two or more are equal square thumbnails in a row that wraps only when it is full
 * (Slack), at most 9rem each and three to a row on a phone (the `photo-tile` class in styles.css). The row used to be a
 * two-column grid, so a third photo always started a new line (testers, 2026-09-30).
 */
export function photoLayout(count: number): "single" | "row" {
  return count > 1 ? "row" : "single";
}

export interface Box {
  width: number;
  height: number;
}

/** The largest box of the media's own shape inside `max` (never scaled up); `null` when the shape is not known yet. */
export function fitBox(width: number | null | undefined, height: number | null | undefined, max: Box): Box | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, max.width / width, max.height / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The bounds of a single photo in a message. */
export const PHOTO_MAX: Box = { width: 288, height: 240 };
/** The bounds of an inline video tile, as a single photo's. */
export const VIDEO_TILE_MAX: Box = PHOTO_MAX;

/**
 * A single photo's box, from the size the server recorded (of the upright original): the tile has its final size
 * before the thumbnail arrives, so nothing below or above it moves when the picture loads (it was a 96 px spinner, then
 * nothing while the image decoded, then the picture: rows jumped by up to 240 px each). The thumbnail (512 px) is
 * never smaller than this box, so the picture fills it. `null` without a recorded size (the tile then takes the
 * picture's own, and the timeline's anchoring keeps the view still).
 */
export function photoBox(attachment: Pick<AttachmentOut, "width" | "height">): Box | null {
  return fitBox(attachment.width, attachment.height, PHOTO_MAX);
}
/** Before the video's shape is known: a neutral square, so neither a portrait nor a landscape clip jumps far. */
export const VIDEO_TILE_PLACEHOLDER: Box = { width: 180, height: 180 };

/**
 * A video tile needs the clip's shape and a frame to show. Since M79 the server records both at upload (`width` /
 * `height` upright, `has_poster`: a JPEG frame at `/thumbnail`), so the tile has its final size at once and shows the
 * poster without downloading the clip, which is fetched only when opened. A video without them (uploaded before M79
 * and not backfilled yet, a file the server could not read, or an older server) learns its shape from the video
 * itself, which means fetching its bytes: up to this size that happens once the row nears the screen; a larger clip
 * shows a plain tile and is fetched only when opened in the viewer (after which its tile takes the real shape too).
 */
export const VIDEO_INLINE_MAX_BYTES = 30 * 1024 * 1024;

/** M79: the server made a poster frame for this video (absent from servers before M79: false). */
export function hasPoster(attachment: Partial<Pick<AttachmentOut, "has_poster">>): boolean {
  return attachment.has_poster === true;
}

/** Whether the tile fetches the clip itself: not while the server's poster stands in (`posterFailed`: it did not load). */
export function loadsInlineVideo(
  attachment: Pick<AttachmentOut, "size_bytes"> & Partial<Pick<AttachmentOut, "has_poster">>,
  posterFailed = false,
): boolean {
  if (hasPoster(attachment) && !posterFailed) return false;
  return attachment.size_bytes <= VIDEO_INLINE_MAX_BYTES;
}

/** A video's length as its tile shows it ("0:07", "12:34", "1:02:03"); `null` when the server does not know it. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const total = ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * M108 (docs/PREVIEWS.md): a PDF's or Office file's preview. `pending` shows 「プレビューを作成中…」 on the file card,
 * `ready` the first page (and every page in the viewer), anything else (failed, none, an older server without the
 * field) the plain download row.
 */
export type DocumentPreviewState = "pending" | "ready" | null;

export function documentPreviewState(attachment: Partial<Pick<AttachmentOut, "preview">>): DocumentPreviewState {
  const status = attachment.preview?.status;
  return status === "pending" || status === "ready" ? status : null;
}

/** The card's width; the first page is shown this wide, its top up to DOCUMENT_THUMB_MAX_HEIGHT (as Slack). */
export const DOCUMENT_CARD_WIDTH = 256;
export const DOCUMENT_THUMB_MAX_HEIGHT = 200;

/**
 * The thumbnail's box on the card, from the size the server recorded: final before the picture arrives (no jump).
 * A landscape slide shows whole, a portrait page its top part. `null` when the size is unknown.
 */
export function documentThumbBox(attachment: Partial<Pick<AttachmentOut, "preview">>): Box | null {
  const preview = attachment.preview;
  if (!preview || preview.status !== "ready" || !preview.width || !preview.height) return null;
  const height = Math.round((DOCUMENT_CARD_WIDTH * preview.height) / preview.width);
  return { width: DOCUMENT_CARD_WIDTH, height: Math.max(1, Math.min(DOCUMENT_THUMB_MAX_HEIGHT, height)) };
}

/** 「12 ページ」, or "" when the count is unknown. */
export function pageCountLabel(pages: number | null | undefined): string {
  return pages && pages > 0 ? t("attach.pages", { count: pages }) : "";
}
