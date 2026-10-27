// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentOut, DriveItemOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AttachmentList, AudioViewer } from "../src/ui/Attachments";
import { groupAttachments, isAudioType, mediaKind } from "../src/ui/attachmentLayout";
import { iconKind, viewerKind } from "../src/drive/listing";
import { resetVideoCache } from "../src/ui/videoSource";

const base: AttachmentOut = { id: "s", filename: "interview.wav", content_type: "audio/x-wav", size_bytes: 2_400_000, has_thumbnail: false, has_poster: false, duration_ms: null, status: "attached", created_at: "", width: null, height: null };
const second: AttachmentOut = { ...base, id: "t", filename: "memo.mp3", content_type: "audio/mpeg" };

/** jsdom has no media playback: play / pause flip `paused` and fire the events a browser fires. */
const playing = new WeakSet<HTMLMediaElement>();
beforeEach(() => {
  let urls = 0;
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = vi.fn(() => `blob:media-${++urls}`);
    static override revokeObjectURL = vi.fn();
  });
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
    return !playing.has(this);
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    playing.add(this);
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    if (!playing.delete(this)) return;
    this.dispatchEvent(new Event("pause"));
  });
});
afterEach(() => {
  cleanup();
  resetVideoCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const controllerWith = (fetchBlob: (path: string) => Promise<Blob> = vi.fn(async () => new Blob())) => {
  const downloadAttachment = vi.fn(async () => {});
  return { controller: { api: { fetchBlob }, downloadAttachment } as unknown as AppController, downloadAttachment, fetchBlob };
};

const audioOf = (root: HTMLElement) => {
  const element = root.querySelector("audio");
  if (!element) throw new Error("no audio element");
  return element;
};

describe("which files are sounds", () => {
  it("plays audio types in place, keeps MIDI a file, and treats a video without a picture as sound", () => {
    for (const type of ["audio/x-wav", "audio/wav", "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/opus", "audio/x-flac", "audio/flac", "audio/webm", "audio/x-aiff"]) {
      expect(mediaKind({ ...base, content_type: type })).toBe("audio");
    }
    expect(isAudioType("audio/midi")).toBe(false);
    expect(mediaKind({ ...base, content_type: "audio/midi" })).toBe("file");
    // The server read it and found no picture (an audio-only mp4 / webm): a sound, not a black video tile.
    expect(mediaKind({ ...base, content_type: "video/mp4", duration_ms: 3000 })).toBe("audio");
    // Not read (older upload, no probe): still a video.
    expect(mediaKind({ ...base, content_type: "video/mp4" })).toBe("video");
    expect(mediaKind({ ...base, content_type: "video/mp4", duration_ms: 3000, width: 640 })).toBe("video");
    const groups = groupAttachments([base, { ...base, id: "p", content_type: "image/png", has_thumbnail: true }]);
    expect(groups.audios.map((a) => a.id)).toEqual(["s"]);
    expect(groups.files).toEqual([]);
  });

  it("opens a drive sound in the viewer, with its own icon", () => {
    const file = { attachment_id: "s", has_thumbnail: false, has_poster: false, width: null, height: null, duration_ms: null, preview: null };
    const item = { kind: "file", name: "take1.wav", content_type: "audio/x-wav", file } as unknown as DriveItemOut;
    expect(viewerKind(item)).toBe("audio");
    expect(iconKind(item)).toBe("audio");
    expect(viewerKind({ ...item, content_type: "video/webm", file: { ...file, duration_ms: 1000 } } as DriveItemOut)).toBe("audio");
    expect(viewerKind({ ...item, content_type: "video/mp4" } as DriveItemOut)).toBe("video");
    expect(viewerKind({ ...item, content_type: "audio/midi" } as DriveItemOut)).toBeNull();
  });
});

describe("in a message", () => {
  it("shows a player row; the bytes are fetched only when it is played, and the name does not download", async () => {
    const { controller, downloadAttachment, fetchBlob } = controllerWith();
    render(<AttachmentList attachments={[base]} controller={controller} />);
    const row = screen.getByRole("group", { name: "音声：interview.wav" });
    expect(within(row).getByText("2.3 MB")).toBeTruthy();
    fireEvent.click(within(row).getByTitle("interview.wav"));
    expect(downloadAttachment).not.toHaveBeenCalled();
    await act(async () => {});
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(audioOf(row).getAttribute("src")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "再生" }));
    await vi.waitFor(() => expect(audioOf(row).getAttribute("src")).toBe("blob:media-1"));
    expect(fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/s/content");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(row.dataset.state).toBe("playing");
    // The length and the position, once known.
    const audio = audioOf(row);
    Object.defineProperty(audio, "duration", { value: 65, configurable: true });
    fireEvent.loadedMetadata(audio);
    Object.defineProperty(audio, "currentTime", { value: 12, writable: true, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(within(row).getByText("0:12 / 1:05")).toBeTruthy();
    const seek = within(row).getByRole("slider", { name: "再生位置" });
    fireEvent.change(seek, { target: { value: "30" } });
    expect(audio.currentTime).toBe(30);

    fireEvent.click(within(row).getByRole("button", { name: "一時停止" }));
    expect(row.dataset.state).toBe("paused");
    fireEvent.click(within(row).getByRole("button", { name: "interview.wav をダウンロード" }));
    expect(downloadAttachment).toHaveBeenCalledWith(base);
  });

  it("toggles with Space while the row has the focus", async () => {
    const { controller } = controllerWith();
    render(<AttachmentList attachments={[base]} controller={controller} />);
    const row = screen.getByRole("group", { name: "音声：interview.wav" });
    row.focus();
    fireEvent.keyDown(row, { key: " ", code: "Space" });
    await vi.waitFor(() => expect(row.dataset.state).toBe("playing"));
    fireEvent.keyDown(row, { key: " ", code: "Space" });
    expect(row.dataset.state).toBe("paused");
  });

  it("plays one thing at a time", async () => {
    const { controller } = controllerWith();
    render(<AttachmentList attachments={[base, second]} controller={controller} />);
    const first = screen.getByRole("group", { name: "音声：interview.wav" });
    const next = screen.getByRole("group", { name: "音声：memo.mp3" });
    fireEvent.click(within(first).getByRole("button", { name: "再生" }));
    await vi.waitFor(() => expect(first.dataset.state).toBe("playing"));
    fireEvent.click(within(next).getByRole("button", { name: "再生" }));
    await vi.waitFor(() => expect(next.dataset.state).toBe("playing"));
    expect(first.dataset.state).toBe("paused");
  });

  it("says when this device cannot play it (download kept), and retries when it could not load", async () => {
    const fetchBlob = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Blob());
    const { controller, downloadAttachment } = controllerWith(fetchBlob);
    render(<AttachmentList attachments={[{ ...base, filename: "voice.opus", content_type: "audio/ogg" }]} controller={controller} />);
    const row = screen.getByRole("group", { name: "音声：voice.opus" });
    fireEvent.click(within(row).getByRole("button", { name: "再生" }));
    await within(row).findByText("音声を読み込めませんでした");
    fireEvent.click(within(row).getByRole("button", { name: "再試行" }));
    await vi.waitFor(() => expect(audioOf(row).getAttribute("src")).toBe("blob:media-1"));
    const audio = audioOf(row);
    Object.defineProperty(audio, "error", { value: { code: 4 }, configurable: true });
    fireEvent.error(audio);
    expect(within(row).getByText("この音声はこの端末では再生できません。ダウンロードして開いてください")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "再試行" })).toBeNull();
    expect((within(row).getByRole("button", { name: "再生" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(row).getByRole("button", { name: "voice.opus をダウンロード" }));
    expect(downloadAttachment).toHaveBeenCalled();
  });
});

describe("in the viewer (a drive file, a file waiting in the composer)", () => {
  it("starts at once, and Space plays / pauses wherever the focus is", async () => {
    const { controller, fetchBlob } = controllerWith();
    render(<AudioViewer attachment={base} controller={controller} onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    const player = within(dialog).getByRole("group", { name: "音声：interview.wav" });
    await vi.waitFor(() => expect(player.dataset.state).toBe("playing"));
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: " ", code: "Space" });
    expect(player.dataset.state).toBe("paused");
    fireEvent.keyDown(dialog, { key: " ", code: "Space" });
    expect(player.dataset.state).toBe("playing");
    // The header's download is the viewer's; the player has none of its own here.
    expect(within(player).queryByRole("button", { name: "interview.wav をダウンロード" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "ダウンロード" })).toBeTruthy();
  });

  it("plays a Web drive file from its ticket's URL and takes a new ticket when it lapsed mid-play", async () => {
    const { controller, fetchBlob } = controllerWith();
    const stream = vi.fn().mockResolvedValueOnce("https://lab.example/api/v1/drive/download/one").mockResolvedValue("https://lab.example/api/v1/drive/download/two");
    render(<AudioViewer attachment={base} controller={controller} onClose={() => undefined} stream={stream} />);
    const player = screen.getByRole("group", { name: "音声：interview.wav" });
    await vi.waitFor(() => expect(audioOf(player).getAttribute("src")).toBe("https://lab.example/api/v1/drive/download/one"));
    const first = audioOf(player);
    fireEvent.loadedMetadata(first);
    Object.defineProperty(first, "error", { value: { code: 2 }, configurable: true });
    fireEvent.error(first);
    await vi.waitFor(() => expect(audioOf(player).getAttribute("src")).toBe("https://lab.example/api/v1/drive/download/two"));
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(within(player).queryByText("音声を読み込めませんでした")).toBeNull();
  });
});
