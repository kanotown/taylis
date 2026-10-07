// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AttachmentList } from "../src/ui/Attachments";
import { fitBox, formatDuration, groupAttachments, loadsInlineVideo, mediaKind, photoLayout, VIDEO_INLINE_MAX_BYTES, VIDEO_TILE_MAX } from "../src/ui/attachmentLayout";
import { acquireVideo, resetVideoCache, VIDEO_RELEASE_DELAY_MS } from "../src/ui/videoSource";

const base: AttachmentOut = { id: "a", filename: "photo.png", content_type: "image/png", size_bytes: 100, has_thumbnail: true, has_poster: false, duration_ms: null, status: "attached", created_at: "", width: 10, height: 10 };
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
    expect(within(dialog).getByText("この動画はアプリ内で再生できません")).toBeTruthy();
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
    expect(document.querySelectorAll("[data-photo-grid] button")).toHaveLength(2);
    expect(document.querySelectorAll("[data-video-row] [data-video-tile]")).toHaveLength(1);
    expect(screen.getByTitle("notes.pdf").closest("[data-photo-grid], [data-video-row]")).toBeNull();
  });
});
