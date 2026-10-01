// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AttachmentList } from "../src/ui/Attachments";

const attachment: AttachmentOut = { id: "a", filename: "result.png", content_type: "image/png", size_bytes: 100, has_thumbnail: true, status: "attached", created_at: "", width: 10, height: 10 };
const controller = (fetchBlob: (...args: unknown[]) => Promise<Blob>) => ({ api: { fetchBlob } }) as unknown as AppController;
beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = vi.fn(() => "blob:photo");
    static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
  expect(grid.querySelectorAll("button")).toHaveLength(3);
  for (const tile of grid.querySelectorAll("button")) expect(tile.className).toContain("photo-tile aspect-square");
  expect(screen.getByText("notes.pdf").closest("[data-photo-grid]")).toBeNull(); // files stay in their own row
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
