import type { AttachmentOut } from "../api/types";

/**
 * Why a clip does not play in the in-app player (2026-10-27, docs/PREVIEWS.md §12):
 * - "unsupported": this engine cannot decode it (HEVC on Windows WebView2 without its decoder, HEVC tagged `hev1`
 *   in WebKit, Matroska / AVI in WebKit, ...). The answer is the download, never a retry.
 * - "network": the bytes stopped coming (a broken connection, an expired drive ticket). A retry can help.
 */
export type PlaybackProblem = "unsupported" | "network";

/**
 * A `MediaError` as a problem. `played`: the clip had loaded its metadata before (so its format is readable here and
 * a later error is the transport's: Chrome reports an expired ticket's 404 mid-play as 2, but at the start as 4).
 */
export function playbackProblem(code: number | undefined, played: boolean): PlaybackProblem {
  if (played) return "network";
  // 1 aborted, 2 network; 3 decode, 4 source not supported (also: no track this engine can play).
  return code === 1 || code === 2 ? "network" : "unsupported";
}

/**
 * Whether the server says the clip has a picture: it measured one (`width`), made a poster from it, or could not look
 * (nothing recorded: an older upload, so assume a picture). A file it read with no picture (audio only) plays as sound.
 */
export function expectsPicture(attachment: Pick<AttachmentOut, "width" | "duration_ms"> & Partial<Pick<AttachmentOut, "has_poster">>): boolean {
  if ((attachment.width ?? 0) > 0 || attachment.has_poster === true) return true;
  return attachment.width == null && attachment.duration_ms == null;
}

/**
 * The "black box": Chromium (WebView2, Chrome) drops a video track it cannot decode and plays the sound alone, with
 * no error, so the size stays 0×0 (and no frame is ever painted). Measured on Chrome with an MPEG-4 Part 2 clip, the
 * same path as HEVC on a Windows PC without the HEVC decoder.
 */
export function showsNoPicture(
  video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight" | "currentTime"> & { getVideoPlaybackQuality?: () => { totalVideoFrames: number } },
  attachment: Parameters<typeof expectsPicture>[0],
): boolean {
  if (!expectsPicture(attachment)) return false;
  if (video.videoWidth === 0 && video.videoHeight === 0) return true;
  // Playing for a while without a single frame decoded.
  if (video.currentTime >= 1.5 && typeof video.getVideoPlaybackQuality === "function") {
    return video.getVideoPlaybackQuality().totalVideoFrames === 0;
  }
  return false;
}

/**
 * A streamed drive video (the Web: a download ticket's URL, docs/DRIVE.md §7.3) whose ticket may have lapsed: the
 * server forgets a ticket unused for 5 minutes. WebKit then stalls for good with no error (measured: the 404 of the
 * next Range request leaves it "stalled"), so a stall this long after the URL was issued fetches a new ticket and
 * resumes there.
 */
export const STREAM_TICKET_STALE_MS = 4 * 60_000;
/** How long playback may wait for data before a stale ticket is renewed. */
export const STREAM_STALL_MS = 8_000;
/** Renewals in a row without the clip playing in between, before the error is shown. */
export const STREAM_RENEWALS_MAX = 2;
