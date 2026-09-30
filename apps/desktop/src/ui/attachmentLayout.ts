import type { AttachmentOut } from "../api/types";

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

/** The bounds of an inline video tile, as a single photo's (max-w-72 × max-h-60). */
export const VIDEO_TILE_MAX: Box = { width: 288, height: 240 };
/** Before the video's shape is known: a neutral square, so neither a portrait nor a landscape clip jumps far. */
export const VIDEO_TILE_PLACEHOLDER: Box = { width: 180, height: 180 };

/**
 * The server makes no poster or size for videos, so the tile learns the shape from the video itself, which means
 * fetching its bytes. Up to this size that happens once the row nears the screen; a larger clip shows a plain tile and
 * is fetched only when opened in the viewer (after which its tile takes the real shape too).
 */
export const VIDEO_INLINE_MAX_BYTES = 30 * 1024 * 1024;

export function loadsInlineVideo(attachment: Pick<AttachmentOut, "size_bytes">): boolean {
  return attachment.size_bytes <= VIDEO_INLINE_MAX_BYTES;
}
