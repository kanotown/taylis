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
export function expectsPicture(attachment: Partial<Pick<AttachmentOut, "width" | "duration_ms" | "has_poster">>): boolean {
  if ((attachment.width ?? 0) > 0 || attachment.has_poster === true) return true;
  return attachment.width == null && attachment.duration_ms == null;
}

/**
 * The tile's quick look (a clip loaded for its first frame, never played): 0×0 at `loadeddata` while the server says
 * there is a picture. Only puts the poster back on the tile; whether the clip plays is the viewer's `PictureCheck`.
 */
export function showsNoPicture(
  video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight">,
  attachment: Parameters<typeof expectsPicture>[0],
): boolean {
  return expectsPicture(attachment) && video.videoWidth === 0 && video.videoHeight === 0;
}

/** Seconds the clip must have actually played (time advancing while shown) with no picture before the viewer says so. */
export const PICTURE_JUDGE_SECONDS = 2;
/** A `currentTime` step longer than this between two looks is a seek (or a jump after a stall), not playback. */
const PLAYBACK_STEP_MAX = 1;

/** What the viewer's check reads off the `<video>` element. */
export type WatchedVideo = Pick<HTMLVideoElement, "videoWidth" | "videoHeight" | "currentTime" | "paused" | "readyState"> &
  Partial<Pick<HTMLVideoElement, "seeking" | "duration" | "ended">> & {
    getVideoPlaybackQuality?: () => { totalVideoFrames: number };
  };

/**
 * The viewer's "black box" check (2026-10-27, made robust 2026-10-31; docs/PREVIEWS.md §12, §12.1): Chromium (WebView2,
 * Chrome) drops a video track it cannot decode and plays the sound alone, with no error: the size stays 0×0 and no frame
 * is painted. The first rule ("0×0 at `loadeddata`, or 0 frames once `currentTime` passed 1.5 s") misfired on clips
 * that play: WebKit (the macOS app) counts `totalVideoFrames` only while playing, so a clip sought or resumed past
 * 1.5 s while paused had 0 frames and was called unplayable. Now:
 * - a picture is proven by any of: a size (`videoWidth` / `videoHeight`), a decoded frame, or a frame callback
 *   (`requestVideoFrameCallback`, fed through `frame()`); then the verdict is `"picture"`, which also clears an earlier
 *   `"none"` (frames that start late);
 * - `"none"` only after the clip has really played `PICTURE_JUDGE_SECONDS` (or most of a shorter clip) with none of
 *   those: time counted only between looks where it advanced by a small step while playing, not seeking, with data,
 *   on a visible page (paused, autoplay blocked, buffering, a hidden tab or a seek never count);
 * - `null` while it cannot tell yet; and always `"picture"` when the server found no picture (a sound-only file).
 */
export class PictureCheck {
  private played = 0;
  private last: number | null = null;
  private sawFrame = false;

  constructor(private readonly expects: boolean) {}

  /** A frame was presented (a `requestVideoFrameCallback` call). */
  frame(): void {
    this.sawFrame = true;
  }

  /** A new source (a renewed ticket, a retry): judge it afresh. */
  reset(): void {
    this.played = 0;
    this.last = null;
    this.sawFrame = false;
  }

  observe(video: WatchedVideo, visible = pageVisible()): "picture" | "none" | null {
    if (!this.expects || this.sawFrame || video.videoWidth > 0 || video.videoHeight > 0) return "picture";
    if (typeof video.getVideoPlaybackQuality === "function" && video.getVideoPlaybackQuality().totalVideoFrames > 0) return "picture";
    const at = video.currentTime;
    const step = this.last === null ? 0 : at - this.last;
    this.last = at;
    // HAVE_FUTURE_DATA (3): not stalled waiting for bytes.
    if (!video.paused && !video.seeking && visible && video.readyState >= 3 && step > 0 && step <= PLAYBACK_STEP_MAX) this.played += step;
    const duration = video.duration && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
    const needed = Math.min(PICTURE_JUDGE_SECONDS, duration * 0.75);
    return this.played >= needed ? "none" : null;
  }
}

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
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
