// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AttachmentList } from "../src/ui/Attachments";

const attachment: AttachmentOut = { id: "a", filename: "result.png", content_type: "image/png", size_bytes: 100, has_thumbnail: true, has_poster: false, duration_ms: null, status: "attached", created_at: "", width: 10, height: 10 };
const controller = (fetchBlob: (...args: unknown[]) => Promise<Blob>) => ({ api: { fetchBlob } }) as unknown as AppController;
beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = vi.fn(() => "blob:photo");
    static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("shows failed fetches and retries the authenticated thumbnail request", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Blob());
  render(<AttachmentList attachments={[attachment]} controller={controller(fetch)} />);
  fireEvent.click(await screen.findByRole("button", { name: "再試行" }));
  expect(await screen.findByRole("img", { name: "result.png" })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith("/api/v1/attachments/a/thumbnail");
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText("画像を読み込めませんでした")).toBeTruthy();
  cleanup();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo");
});

it("ignores late failures from an old session", async () => {
  let reject!: (error: Error) => void;
  const old = controller(() => new Promise<Blob>((_, fail) => { reject = fail; }));
  const view = render(<AttachmentList attachments={[attachment]} controller={old} />);
  view.rerender(<AttachmentList attachments={[attachment]} controller={controller(async () => new Blob())} />);
  await screen.findByRole("img");
  await act(async () => reject(new Error("old request")));
  expect(screen.queryByText("画像を読み込めませんでした")).toBeNull();
  expect(screen.getByRole("img")).toBeTruthy();
});

it("puts two or more photos in one wrapping row of equal squares, one photo and files as before (M28b, M38)", async () => {
  const second = { ...attachment, id: "b", filename: "second.png" };
  const third = { ...attachment, id: "c", filename: "third.png" };
  const file = { ...attachment, id: "f", filename: "notes.pdf", content_type: "application/pdf", has_thumbnail: false, width: null, height: null };
  const view = render(<AttachmentList attachments={[attachment, second, third, file]} controller={controller(async () => new Blob())} />);
  const grid = document.querySelector("[data-photo-grid]")!;
  // A row that wraps only when full: no two-column grid, which broke the line after the second photo (2026-09-30).
  expect(grid.className).toContain("flex-wrap");
  expect(grid.className).not.toContain("grid-cols-2");
  // Each tile is a wrapper (its download button over the corner) with the square photo button filling it.
  expect(grid.querySelectorAll("[data-media-tile]")).toHaveLength(3);
  for (const tile of grid.querySelectorAll("[data-media-tile]")) {
    expect(tile.className).toContain("photo-tile");
    expect(tile.querySelector("button:not([data-download-overlay])")!.className).toContain("aspect-square w-full");
  }
  expect(screen.getByTitle("notes.pdf").closest("[data-photo-grid]")).toBeNull(); // files stay in their own row
  view.rerender(<AttachmentList attachments={[attachment, file]} controller={controller(async () => new Blob())} />);
  expect(document.querySelector("[data-photo-grid]")).toBeNull();
  // One photo in its own shape: the box the server's size gives (10 x 10, never enlarged), the picture filling it.
  expect((await screen.findByRole("img", { name: "result.png" })).className).toContain("h-full w-full");
  expect(screen.getByRole("img", { name: "result.png" }).closest("button")!.dataset["photoBox"]).toBe("10x10");
  // One photo: the column does not stretch its button across the message (clicks beside it did open the photo).
  expect(document.querySelector("[data-attachments]")!.className).toContain("items-start");
  expect(screen.getByRole("img", { name: "result.png" }).closest("button")!.classList.contains("w-full")).toBe(false);
});

it("gives one photo its final box before the thumbnail arrives, so the rows around it never move (2026-10-01)", async () => {
  let deliver!: (blob: Blob) => void;
  const photo = { ...attachment, width: 4032, height: 3024 }; // a phone photo: 288 x 216 inside 288 x 240
  render(<AttachmentList attachments={[photo]} controller={controller(() => new Promise<Blob>((resolve) => { deliver = resolve; }))} />);
  const loading = screen.getByRole("status", { name: "画像を読み込み中" });
  const tile = loading.closest("button")!;
  expect(tile.style.width).toBe("288px");
  expect(tile.style.aspectRatio).toBe("288 / 216");
  expect(loading.className).toContain("h-full w-full"); // the spinner fills the box (it was a 96 px strip)
  await act(async () => deliver(new Blob()));
  const image = screen.getByRole("img", { name: "result.png" });
  expect(image.closest("button")).toBe(tile);
  expect(tile.style.aspectRatio).toBe("288 / 216"); // unchanged by the picture arriving
  expect(image.className).toContain("h-full w-full");
});

it("leaves a photo without a recorded size to take the picture's own shape", async () => {
  render(<AttachmentList attachments={[{ ...attachment, width: null, height: null }]} controller={controller(async () => new Blob())} />);
  const image = await screen.findByRole("img", { name: "result.png" });
  expect(image.className).toContain("max-h-60 max-w-72");
  expect(image.closest("button")!.style.aspectRatio).toBe("");
});

it("keeps the full image viewer open while retrying a failed original", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("offline"));
  render(<AttachmentList attachments={[attachment]} controller={controller(fetch)} />);
  fireEvent.click(await screen.findByRole("button", { name: "元の画像を開く" }));
  await waitFor(() => expect(screen.getAllByText("画像を読み込めませんでした")).toHaveLength(2));
  fetch.mockResolvedValue(new Blob());
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "再試行" }));
  await within(screen.getByRole("dialog")).findByRole("img");
  expect(fetch).toHaveBeenLastCalledWith("/api/v1/attachments/a/content");
  expect(screen.getByRole("dialog")).toBeTruthy();
});

describe("the download button over a photo or video (2026-10-07)", () => {
  const video: AttachmentOut = { ...attachment, id: "v", filename: "clip.mp4", content_type: "video/mp4", size_bytes: 9_000_000, has_thumbnail: false, width: null, height: null };
  const file: AttachmentOut = { ...attachment, id: "f", filename: "notes.zip", content_type: "application/zip", has_thumbnail: false, width: null, height: null };
  const setup = (attachments: AttachmentOut[], downloadable?: boolean) => {
    const downloadAttachment = vi.fn(async () => {});
    const ctl = { api: { fetchBlob: async () => new Blob() }, downloadAttachment } as unknown as AppController;
    render(<AttachmentList attachments={attachments} controller={ctl} downloadable={downloadable} />);
    return downloadAttachment;
  };
  const overlay = (name: string) => screen.getByRole("button", { name: `${name} をダウンロード` });

  it("appears while a mouse is over a photo tile (also in a row of photos) and goes when it leaves; a touch never shows it", async () => {
    setup([attachment, { ...attachment, id: "b", filename: "second.png" }]);
    await screen.findAllByRole("img");
    const button = overlay("second.png");
    expect(button.dataset["shown"]).toBe("false");
    expect(button.className).toContain("pointer-events-none");
    const tile = button.closest("[data-media-tile]")!;
    fireEvent.pointerEnter(tile, { pointerType: "touch" });
    expect(button.dataset["shown"]).toBe("false");
    fireEvent.pointerEnter(tile, { pointerType: "mouse" });
    expect(button.dataset["shown"]).toBe("true");
    expect(button.className).not.toContain("pointer-events-none");
    expect(button.getAttribute("title")).toBe("ダウンロード");
    expect(overlay("result.png").dataset["shown"]).toBe("false"); // only the tile under the pointer
    fireEvent.pointerLeave(tile, { pointerType: "mouse" });
    expect(button.dataset["shown"]).toBe("false");
  });

  it("appears while the keyboard focus is on the tile or on the button, and not after it leaves", () => {
    setup([attachment]);
    const button = overlay("result.png");
    const tile = button.closest("[data-media-tile]")!;
    const photo = tile.querySelector<HTMLButtonElement>("button:not([data-download-overlay])")!;
    // The focus a click leaves (not :focus-visible) does not show it.
    act(() => photo.focus());
    expect(button.dataset["shown"]).toBe("false");
    act(() => photo.blur());
    // Keyboard focus: jsdom has no focus-visible heuristics, so the browser's answer is stubbed.
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":focus-visible" ? this === document.activeElement : matches.call(this, selector);
    });
    act(() => photo.focus());
    expect(button.dataset["shown"]).toBe("true");
    act(() => button.focus()); // tabbing from the photo to its button keeps it
    expect(button.dataset["shown"]).toBe("true");
    act(() => button.blur());
    expect(button.dataset["shown"]).toBe("false");
  });

  it("downloads like the viewer's button without opening the viewer", () => {
    const download = setup([attachment, video]);
    fireEvent.click(overlay("result.png"));
    expect(download).toHaveBeenCalledWith(attachment);
    fireEvent.click(overlay("clip.mp4"));
    expect(download).toHaveBeenCalledWith(video);
    expect(download).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The photo itself still opens the viewer.
    fireEvent.click(screen.getByTitle(/result\.png \(100 B\)/));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("is not there while the message is still being sent or failed to send", () => {
    setup([attachment, video, file], false);
    expect(document.querySelector("[data-download-overlay]")).toBeNull();
    expect(document.querySelector("[data-download-hint]")).toBeNull();
  });

  it("a file row downloads as a whole and names itself for screen readers; its icon shows on hover and keyboard focus", () => {
    const download = setup([file]);
    const row = overlay("notes.zip");
    expect(row.querySelector("[data-download-hint]")!.getAttribute("class")).toContain("group-focus-visible:opacity-100");
    fireEvent.click(row);
    expect(download).toHaveBeenCalledWith(file);
  });
});
