// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AttachmentList, VideoViewer } from "../src/ui/Attachments";
import { expectsPicture, PICTURE_JUDGE_SECONDS, PictureCheck, playbackProblem, showsNoPicture, STREAM_STALL_MS, STREAM_TICKET_STALE_MS, type WatchedVideo } from "../src/ui/videoPlayback";
import { fitBox, formatDuration, groupAttachments, loadsInlineVideo, mediaKind, photoLayout, VIDEO_INLINE_MAX_BYTES, VIDEO_TILE_MAX } from "../src/ui/attachmentLayout";
import { acquireVideo, resetVideoCache, VIDEO_RELEASE_DELAY_MS } from "../src/ui/videoSource";

const base: AttachmentOut = { id: "a", filename: "photo.png", content_type: "image/png", size_bytes: 100, has_thumbnail: true, has_poster: false, has_display: false, duration_ms: null, status: "attached", created_at: "", width: 10, height: 10 };
const video: AttachmentOut = { ...base, id: "v", filename: "clip.mp4", content_type: "video/mp4", size_bytes: 2_000_000, has_thumbnail: false, width: null, height: null };
const file: AttachmentOut = { ...base, id: "f", filename: "notes.pdf", content_type: "application/pdf", has_thumbnail: false, width: null, height: null };

let urls = 0;
beforeEach(() => {
  urls = 0;
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = vi.fn(() => `blob:media-${++urls}`);
    static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => {
  cleanup();
  resetVideoCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const controllerWith = (fetchBlob: (path: string) => Promise<Blob>) => {
  const downloadAttachment = vi.fn(async () => {});
  return { controller: { api: { fetchBlob }, downloadAttachment } as unknown as AppController, downloadAttachment };
};

describe("layout decisions", () => {
  it("tells photos, videos and files apart (a video is never a download row)", () => {
    expect(mediaKind(base)).toBe("photo");
    expect(mediaKind(video)).toBe("video");
    expect(mediaKind({ ...video, content_type: "video/quicktime" })).toBe("video");
    expect(mediaKind({ ...video, has_thumbnail: true })).toBe("video"); // a future server poster keeps it a video
    expect(mediaKind(file)).toBe("file");
    const groups = groupAttachments([file, video, base]);
    expect(groups.photos).toEqual([base]);
    expect(groups.videos).toEqual([video]);
    expect(groups.files).toEqual([file]);
  });

  it("keeps one photo in its own shape and puts 2, 3 or 4 in one wrapping row", () => {
    expect(photoLayout(1)).toBe("single");
    for (const count of [2, 3, 4, 9]) expect(photoLayout(count)).toBe("row");
  });

  it("fits a video tile to its own shape: portrait stands upright, never enlarged", () => {
    expect(fitBox(1080, 1920, VIDEO_TILE_MAX)).toEqual({ width: 135, height: 240 });
    expect(fitBox(1920, 1080, VIDEO_TILE_MAX)).toEqual({ width: 288, height: 162 });
    expect(fitBox(160, 120, VIDEO_TILE_MAX)).toEqual({ width: 160, height: 120 });
    expect(fitBox(null, 100, VIDEO_TILE_MAX)).toBeNull();
    expect(fitBox(0, 0, VIDEO_TILE_MAX)).toBeNull();
  });

  it("fetches a clip for its tile only up to the inline cap", () => {
    expect(loadsInlineVideo({ size_bytes: VIDEO_INLINE_MAX_BYTES })).toBe(true);
    expect(loadsInlineVideo({ size_bytes: VIDEO_INLINE_MAX_BYTES + 1 })).toBe(false);
    // M79: the server's poster stands in, unless it failed to load.
    expect(loadsInlineVideo({ size_bytes: 10, has_poster: true })).toBe(false);
    expect(loadsInlineVideo({ size_bytes: 10, has_poster: true }, true)).toBe(true);
    expect(loadsInlineVideo({ size_bytes: VIDEO_INLINE_MAX_BYTES + 1, has_poster: true }, true)).toBe(false);
  });

  it("formats a video's length", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(300)).toBe("0:01");
    expect(formatDuration(7_400)).toBe("0:07");
    expect(formatDuration(754_000)).toBe("12:34");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });
});

describe("video source cache", () => {
  it("shares one authenticated fetch between holders and revokes the URL after the last lets go", async () => {
    vi.useFakeTimers();
    const fetchBlob = vi.fn(async () => new Blob());
    const api = { fetchBlob };
    const tile = acquireVideo(api, "v");
    const viewer = acquireVideo(api, "v");
    expect(await tile.promise).toBe("blob:media-1");
    expect(await viewer.promise).toBe("blob:media-1");
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    expect(fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/v/content");
    tile.release();
    tile.release(); // idempotent
    vi.advanceTimersByTime(VIDEO_RELEASE_DELAY_MS);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    viewer.release();
    const again = acquireVideo(api, "v"); // back within the delay: the same bytes
    expect(await again.promise).toBe("blob:media-1");
    again.release();
    vi.advanceTimersByTime(VIDEO_RELEASE_DELAY_MS);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:media-1");
    expect(fetchBlob).toHaveBeenCalledTimes(1);
  });

  it("fetches again after a failure, and never reuses another session's bytes", async () => {
    const fetchBlob = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Blob());
    const api = { fetchBlob };
    const first = acquireVideo(api, "v");
    await expect(first.promise).rejects.toThrow("offline");
    const retry = acquireVideo(api, "v");
    expect(await retry.promise).toBe("blob:media-1");
    first.release(); // the failed holder letting go does not touch the new entry
    const other = { fetchBlob: vi.fn(async () => new Blob()) };
    expect(await acquireVideo(other, "v").promise).toBe("blob:media-2");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:media-1");
  });
});

describe("in a message", () => {
  it("shows a video as a tile that opens a player in the app, with the bytes fetched once and download kept", async () => {
    const fetchBlob = vi.fn(async () => new Blob());
    const { controller, downloadAttachment } = controllerWith(fetchBlob);
    render(<AttachmentList attachments={[video]} controller={controller} />);
    const tile = screen.getByRole("button", { name: "clip.mp4 を再生" });
    expect(tile.dataset.shape).toBe("unknown");
    const preview = await vi.waitFor(() => {
      const element = tile.querySelector("video");
      if (!element) throw new Error("no frame yet");
      return element;
    });
    expect(preview.getAttribute("src")).toBe("blob:media-1#t=0.1");
    // The clip's own shape, once its metadata is in: a portrait clip stands upright.
    Object.defineProperty(preview, "videoWidth", { value: 1080 });
    Object.defineProperty(preview, "videoHeight", { value: 1920 });
    fireEvent.loadedMetadata(preview);
    expect(tile.dataset.shape).toBe("portrait");
    expect(tile.style.width).toBe("135px");
    expect(tile.style.aspectRatio).toBe("135 / 240");

    fireEvent.click(tile);
    const dialog = screen.getByRole("dialog");
    const player = await vi.waitFor(() => {
      const element = dialog.querySelector<HTMLVideoElement>("video[data-video-player]");
      if (!element) throw new Error("no player yet");
      return element;
    });
    expect(player.getAttribute("src")).toBe("blob:media-1");
    expect(player.controls).toBe(false); // §12.2: only under the mouse or the keyboard focus
    fireEvent.pointerEnter(player, { pointerType: "mouse" });
    expect(player.controls).toBe(true);
    expect(within(dialog).getByText(/1080×1920/)).toBeTruthy();
    expect(fetchBlob).toHaveBeenCalledTimes(1); // the tile's bytes, not a second download
    expect(downloadAttachment).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "ダウンロード" }));
    expect(downloadAttachment).toHaveBeenCalledWith(video);
  });

  it("does not fetch a large clip for its tile, only when it is opened", async () => {
    const fetchBlob = vi.fn(async () => new Blob());
    const { controller } = controllerWith(fetchBlob);
    const big = { ...video, size_bytes: VIDEO_INLINE_MAX_BYTES + 1 };
    render(<AttachmentList attachments={[big]} controller={controller} />);
    const tile = screen.getByRole("button", { name: "clip.mp4 を再生" });
    await act(async () => {});
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(tile.querySelector("video")).toBeNull();
    fireEvent.click(tile);
    await vi.waitFor(() => expect(screen.getByRole("dialog").querySelector("video[data-video-player]")).toBeTruthy());
    expect(fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/v/content");
  });

  it("offers the download when the app cannot play the clip or fetch it", async () => {
    const fetchBlob = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Blob());
    const { controller, downloadAttachment } = controllerWith(fetchBlob);
    render(<AttachmentList attachments={[{ ...video, size_bytes: VIDEO_INLINE_MAX_BYTES + 1 }]} controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "clip.mp4 を再生" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("動画を読み込めませんでした");
    fireEvent.click(within(dialog).getByRole("button", { name: "再試行" }));
    const player = await vi.waitFor(() => {
      const element = dialog.querySelector("video[data-video-player]");
      if (!element) throw new Error("no player yet");
      return element;
    });
    fireEvent.error(player);
    expect(within(dialog).getByText("この動画はこの端末では再生できません。ダウンロードして開いてください")).toBeTruthy();
    const buttons = within(dialog).getAllByRole("button", { name: "ダウンロード" });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(downloadAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: "v" }));
  });

  it("M79: sizes the tile from the server and shows its poster without downloading the clip", async () => {
    const fetchBlob = vi.fn(async () => new Blob());
    const { controller } = controllerWith(fetchBlob);
    const served = { ...video, width: 1080, height: 1920, has_poster: true, duration_ms: 42_400 };
    render(<AttachmentList attachments={[served]} controller={controller} />);
    const tile = screen.getByRole("button", { name: "clip.mp4 を再生" });
    // Its final shape before anything loads: nothing below it moves.
    expect(tile.dataset.shape).toBe("portrait");
    expect(tile.style.width).toBe("135px");
    expect(tile.style.aspectRatio).toBe("135 / 240");
    const poster = await vi.waitFor(() => {
      const element = tile.querySelector("img[data-video-poster]");
      if (!element) throw new Error("no poster yet");
      return element;
    });
    expect(poster.getAttribute("src")).toMatch(/^blob:media-/);
    expect(tile.querySelector("video")).toBeNull();
    expect(fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/v/thumbnail");
    expect(fetchBlob).not.toHaveBeenCalledWith("/api/v1/attachments/v/content");
    expect(tile.querySelector("[data-video-badge]")?.textContent).toBe("0:42 · 1.9 MB");

    // Opened: now the clip is fetched, with the poster on the player until it plays.
    fireEvent.click(tile);
    const dialog = screen.getByRole("dialog");
    const player = await vi.waitFor(() => {
      const element = dialog.querySelector<HTMLVideoElement>("video[data-video-player]");
      if (!element) throw new Error("no player yet");
      return element;
    });
    expect(fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/v/content");
    await vi.waitFor(() => expect(player.getAttribute("poster")).toMatch(/^blob:media-/));
    expect(within(dialog).getByText(/1080×1920/)).toBeTruthy();
  });

  it("M79: falls back to the clip's own first frame when the poster does not load", async () => {
    const fetchBlob = vi.fn(async (path: string) => {
      if (path.endsWith("/thumbnail")) throw new Error("gone");
      return new Blob();
    });
    const { controller } = controllerWith(fetchBlob);
    render(<AttachmentList attachments={[{ ...video, has_poster: true }]} controller={controller} />);
    const tile = screen.getByRole("button", { name: "clip.mp4 を再生" });
    await vi.waitFor(() => {
      if (!tile.querySelector("video")) throw new Error("no frame yet");
    });
    expect(fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/v/content");
  });

  it("keeps photos, videos and files in their own rows", () => {
    const { controller } = controllerWith(async () => new Blob());
    render(<AttachmentList attachments={[base, { ...base, id: "b" }, video, file]} controller={controller} />);
    expect(document.querySelectorAll("[data-photo-grid] [data-media-tile]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-video-row] [data-video-tile]")).toHaveLength(1);
    expect(screen.getByTitle("notes.pdf").closest("[data-photo-grid], [data-video-row]")).toBeNull();
  });
});

describe("when a clip does not play (2026-10-27)", () => {
  const sized = (element: HTMLVideoElement, width: number, height: number) => {
    Object.defineProperty(element, "videoWidth", { value: width, configurable: true });
    Object.defineProperty(element, "videoHeight", { value: height, configurable: true });
  };
  const errored = (element: HTMLVideoElement, code: number) => {
    Object.defineProperty(element, "error", { value: { code }, configurable: true });
    fireEvent.error(element);
  };
  const playerIn = (dialog: HTMLElement, src?: string) =>
    vi.waitFor(() => {
      const element = dialog.querySelector<HTMLVideoElement>("video[data-video-player]");
      if (!element || (src && element.getAttribute("src") !== src)) throw new Error("no player yet");
      return element;
    });
  const openPlayer = async (attachment: AttachmentOut, controller: AppController, stream?: () => Promise<string>) => {
    render(<VideoViewer attachment={attachment} controller={controller} onClose={() => {}} stream={stream} />);
    const dialog = screen.getByRole("dialog");
    return { dialog, player: await playerIn(dialog) };
  };
  const served: AttachmentOut = { ...video, width: 1920, height: 1080, duration_ms: 4000, size_bytes: VIDEO_INLINE_MAX_BYTES + 1 };
  const ticket = (n: number) => `https://chat.example/api/v1/drive/download/t${n}`;

  it("tells a codec problem from a transport one", () => {
    expect(playbackProblem(4, false)).toBe("unsupported");
    expect(playbackProblem(3, false)).toBe("unsupported");
    expect(playbackProblem(undefined, false)).toBe("unsupported");
    expect(playbackProblem(2, false)).toBe("network");
    // Once the clip loaded here, a later error is the transport's (Chrome: an expired ticket mid-play).
    expect(playbackProblem(4, true)).toBe("network");
  });

  it("expects a picture unless the server read the file and found none", () => {
    expect(expectsPicture({ width: 1920, duration_ms: 4000 })).toBe(true);
    expect(expectsPicture({ width: null, duration_ms: null })).toBe(true); // never looked at
    expect(expectsPicture({ width: null, duration_ms: 4000, has_poster: false })).toBe(false); // sound only
    // The tile's quick look: 0×0 once loaded puts the poster back; a size, or a sound-only file, never.
    expect(showsNoPicture({ videoWidth: 0, videoHeight: 0 }, served)).toBe(true);
    expect(showsNoPicture({ videoWidth: 1920, videoHeight: 1080 }, served)).toBe(false);
    expect(showsNoPicture({ videoWidth: 0, videoHeight: 0 }, { width: null, duration_ms: 4000 })).toBe(false);
  });

  describe("the viewer's picture check (2026-10-31: no more misfires on clips that play)", () => {
    type Fake = { -readonly [K in keyof WatchedVideo]: WatchedVideo[K] };
    const fake = (over: Partial<Fake> = {}): Fake => ({ videoWidth: 0, videoHeight: 0, currentTime: 0, paused: false, seeking: false, readyState: 4, duration: 60, ...over });
    const frames = (totalVideoFrames: number) => () => ({ totalVideoFrames });
    /** Plays `seconds` in steps of 0.25 s, looking at each step (as `timeupdate` does). */
    const play = (check: PictureCheck, video: Fake, seconds: number, visible = true) => {
      let verdict = check.observe(video, visible);
      for (let i = 0; i < seconds * 4; i++) {
        video.currentTime += 0.25;
        verdict = check.observe(video, visible);
      }
      return verdict;
    };

    it("never calls a clip with a size unplayable, even with 0 frames counted (WebKit while paused)", () => {
      // Measured in Playwright WebKit: a clip sought to 2 s / 4 s while paused, or resumed paused at 3 s, reports
      // totalVideoFrames 0 with its size known: the old rule said "cannot be played".
      const check = new PictureCheck(true);
      const paused = fake({ videoWidth: 1280, videoHeight: 720, currentTime: 4, paused: true, getVideoPlaybackQuality: frames(0) });
      expect(check.observe(paused)).toBe("picture");
      expect(play(check, fake({ videoWidth: 1280, videoHeight: 720, getVideoPlaybackQuality: frames(0) }), 5)).toBe("picture");
    });

    it("waits while the size is not known yet (0×0 at loadeddata), and a size arriving later answers it", () => {
      const check = new PictureCheck(true);
      const video = fake({ readyState: 2, paused: true });
      expect(check.observe(video)).toBeNull(); // loadeddata: 0×0, not playing
      video.videoWidth = 1920;
      video.videoHeight = 1080;
      expect(check.observe(video)).toBe("picture"); // resize
    });

    it("does not count paused, sought, buffering or hidden time", () => {
      const check = new PictureCheck(true);
      const video = fake();
      expect(play(check, { ...video, paused: true } as Fake, 10)).toBeNull(); // autoplay blocked / paused
      const seeking = fake({ seeking: true });
      expect(play(check, seeking, 10)).toBeNull();
      const buffering = fake({ readyState: 2 });
      expect(play(check, buffering, 10)).toBeNull();
      expect(play(check, fake(), 10, false)).toBeNull(); // a hidden tab / minimised window
      // Jumps (a seek forward while paused, then play): only the small steps count.
      const jumpy = fake();
      check.observe(jumpy);
      jumpy.currentTime = 30;
      expect(check.observe(jumpy)).toBeNull();
      jumpy.currentTime = 45;
      expect(check.observe(jumpy)).toBeNull();
    });

    it("says there is no picture only after real playback without one (Chromium's dropped track)", () => {
      const check = new PictureCheck(true);
      const video = fake({ getVideoPlaybackQuality: frames(0) });
      expect(play(check, video, PICTURE_JUDGE_SECONDS - 0.5)).toBeNull();
      expect(play(check, video, 0.5)).toBe("none");
      // Frames starting later clear it.
      video.getVideoPlaybackQuality = frames(3);
      expect(check.observe(video)).toBe("picture");
    });

    it("takes a frame callback as proof, judges a short clip on most of it, and leaves sound-only files alone", () => {
      const called = new PictureCheck(true);
      called.frame();
      expect(called.observe(fake())).toBe("picture");
      expect(play(new PictureCheck(true), fake({ duration: 1 }), 0.75)).toBe("none");
      expect(play(new PictureCheck(false), fake(), 10)).toBe("picture");
      const again = new PictureCheck(true);
      expect(play(again, fake(), 3)).toBe("none");
      again.reset(); // a renewed ticket / a retry: judged afresh
      expect(again.observe(fake())).toBeNull();
    });
  });

  it("says a clip shows no picture here only once it played without one, keeps the sound, and takes it back when frames come", async () => {
    const { controller, downloadAttachment } = controllerWith(vi.fn(async () => new Blob()));
    const { dialog, player } = await openPlayer(served, controller);
    sized(player, 0, 0); // the video track dropped, the sound playing
    Object.defineProperty(player, "paused", { value: false, configurable: true });
    Object.defineProperty(player, "readyState", { value: 4, configurable: true });
    fireEvent.loadedMetadata(player);
    fireEvent.loadedData(player);
    // Not at loadeddata any more: nothing has played yet.
    expect(dialog.querySelector("[data-video-no-picture]")).toBeNull();
    for (let at = 0.25; at <= PICTURE_JUDGE_SECONDS + 0.25; at += 0.25) {
      player.currentTime = at;
      fireEvent.timeUpdate(player);
    }
    expect(within(dialog).getByText("この端末では映像を表示できません（音だけが流れます）。ダウンロードして開いてください")).toBeTruthy();
    expect(dialog.querySelector("video[data-video-player]")).toBe(player); // the sound goes on
    expect(within(dialog).queryByRole("button", { name: "再試行" })).toBeNull();
    const buttons = within(dialog).getAllByRole("button", { name: "ダウンロード" });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(downloadAttachment).toHaveBeenCalledWith(served);
    // The picture arrives after all (a late size): the notice goes.
    sized(player, 1920, 1080);
    fireEvent(player, new Event("resize"));
    expect(dialog.querySelector("[data-video-no-picture]")).toBeNull();
  });

  it("does not call a paused clip sought past 1.5 s unplayable (the WebKit misfire)", async () => {
    const { controller } = controllerWith(vi.fn(async () => new Blob()));
    const { dialog, player } = await openPlayer(served, controller);
    sized(player, 1920, 1080);
    Object.defineProperty(player, "getVideoPlaybackQuality", { value: () => ({ totalVideoFrames: 0 }), configurable: true });
    fireEvent.loadedMetadata(player);
    fireEvent.loadedData(player);
    player.currentTime = 4;
    fireEvent.timeUpdate(player);
    player.currentTime = 30;
    fireEvent.timeUpdate(player);
    expect(dialog.querySelector("[data-video-no-picture], [data-video-problem]")).toBeNull();
    expect(dialog.querySelector("video[data-video-player]")).toBe(player);
  });

  it("shows the controls (and their dim) only under the mouse or the keyboard focus, paused or playing", async () => {
    const { controller } = controllerWith(vi.fn(async () => new Blob()));
    const { player } = await openPlayer(served, controller);
    expect(player.hasAttribute("controls")).toBe(false);
    fireEvent.pointerEnter(player, { pointerType: "mouse" });
    expect(player.hasAttribute("controls")).toBe(true);
    // A click focuses it: that alone does not hold the controls once the mouse leaves.
    fireEvent.pointerDown(player, { pointerType: "mouse" });
    fireEvent.focus(player);
    fireEvent.pointerLeave(player, { pointerType: "mouse" });
    expect(player.hasAttribute("controls")).toBe(false);
    // Tab (or a key on it) keeps them.
    fireEvent.blur(player);
    fireEvent.focus(player);
    expect(player.hasAttribute("controls")).toBe(true);
    fireEvent.blur(player);
    expect(player.hasAttribute("controls")).toBe(false);
    // Dragging the time bar out of the video: hidden on release, not on leaving.
    fireEvent.pointerEnter(player, { pointerType: "mouse" });
    fireEvent.pointerLeave(player, { pointerType: "mouse", buttons: 1 });
    expect(player.hasAttribute("controls")).toBe(true);
    act(() => { window.dispatchEvent(new Event("pointerup")); });
    expect(player.hasAttribute("controls")).toBe(false);
    expect(player.tabIndex).toBe(0);
  });

  it("offers a retry, not 'cannot be played', when the bytes stop after the clip loaded", async () => {
    const { controller } = controllerWith(vi.fn(async () => new Blob()));
    const { dialog, player } = await openPlayer(served, controller);
    sized(player, 1920, 1080);
    fireEvent.loadedMetadata(player);
    errored(player, 2);
    expect(within(dialog).getByText("動画を読み込めませんでした")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "再試行" }));
    await playerIn(dialog);
  });

  it("streams a drive video on a new ticket from where it was when the old one lapsed", async () => {
    const { controller } = controllerWith(vi.fn(async () => new Blob()));
    let tickets = 0;
    const stream = vi.fn(async () => ticket(++tickets));
    const { dialog, player } = await openPlayer(served, controller, stream);
    expect(player.getAttribute("src")).toBe(ticket(1));
    sized(player, 1920, 1080);
    fireEvent.loadedMetadata(player);
    player.currentTime = 42;
    fireEvent.timeUpdate(player);
    fireEvent.pause(player);
    // Minutes later the next Range request answers 404: an error after the clip had loaded.
    errored(player, 4);
    const next = await playerIn(dialog, ticket(2));
    const pause = vi.spyOn(next, "pause").mockImplementation(() => {});
    fireEvent.loadedMetadata(next);
    expect(next.currentTime).toBe(42);
    expect(pause).toHaveBeenCalled(); // it was paused: it stays paused
    // A few renewals in a row at most: then the error, with a retry.
    errored(next, 2);
    const third = await playerIn(dialog, ticket(3));
    fireEvent.loadedMetadata(third);
    errored(third, 2);
    expect(within(dialog).getByText("動画を読み込めませんでした")).toBeTruthy();
    expect(stream).toHaveBeenCalledTimes(3);
  });

  it("renews a stale ticket when WebKit only stalls (no error)", async () => {
    const { controller } = controllerWith(vi.fn(async () => new Blob()));
    let tickets = 0;
    const stream = vi.fn(async () => ticket(++tickets));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { dialog, player } = await openPlayer(served, controller, stream);
    sized(player, 1920, 1080);
    fireEvent.loadedMetadata(player);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // A stall soon after the ticket came: a slow network, left to the browser.
    fireEvent.waiting(player);
    act(() => { vi.advanceTimersByTime(STREAM_STALL_MS + 100); });
    expect(stream).toHaveBeenCalledTimes(1);
    // The same past the ticket's idle time: a new ticket.
    now.mockReturnValue(1_000_000 + STREAM_TICKET_STALE_MS + 1);
    fireEvent.stalled(player);
    act(() => { vi.advanceTimersByTime(STREAM_STALL_MS + 100); });
    vi.useRealTimers();
    await playerIn(dialog, ticket(2));
    now.mockRestore();
  });

  it("puts the poster back on a tile whose clip shows no picture", async () => {
    const fetchBlob = vi.fn(async (path: string) => {
      if (path.endsWith("/thumbnail")) throw new Error("gone");
      return new Blob();
    });
    const { controller } = controllerWith(fetchBlob);
    render(<AttachmentList attachments={[{ ...video, width: 640, height: 480, duration_ms: 3000, has_poster: true }]} controller={controller} />);
    const tile = screen.getByRole("button", { name: "clip.mp4 を再生" });
    const frame = await vi.waitFor(() => {
      const element = tile.querySelector("video");
      if (!element) throw new Error("no frame yet");
      return element;
    });
    sized(frame, 0, 0);
    fireEvent.loadedData(frame);
    expect(tile.querySelector("video")).toBeNull();
  });
});
