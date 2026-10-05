// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AttachmentList } from "../src/ui/Attachments";
import { documentPreviewState, documentThumbBox, pageCountLabel } from "../src/ui/attachmentLayout";

// PDF.js does not run in jsdom: the viewer's loader hands back a document of three pages that draw nothing.
const openPdf = vi.fn();
vi.mock("../src/ui/pdfLoader", () => ({ openPdf: (data: ArrayBuffer) => openPdf(data) }));

const base: AttachmentOut = {
  id: "d",
  filename: "議事録.docx",
  content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size_bytes: 2048,
  has_thumbnail: false,
  has_poster: false,
  duration_ms: null,
  status: "attached",
  created_at: "",
  width: null,
  height: null,
};
const ready: AttachmentOut = { ...base, preview: { status: "ready", pages: 3, width: 800, height: 1132 } };
const controller = (fetchBlob: (path: string) => Promise<Blob>, downloadAttachment = vi.fn()) =>
  ({ api: { fetchBlob }, downloadAttachment }) as unknown as AppController;

beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = vi.fn(() => "blob:preview");
    static override revokeObjectURL = vi.fn();
  });
  openPdf.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reads the preview state and sizes the card's box from the server's numbers", () => {
  expect(documentPreviewState(base)).toBeNull(); // an older server: no field
  expect(documentPreviewState({ ...base, preview: null })).toBeNull();
  expect(documentPreviewState({ ...base, preview: { status: "failed", pages: null, width: null, height: null } })).toBeNull();
  expect(documentPreviewState({ ...base, preview: { status: "pending", pages: null, width: null, height: null } })).toBe("pending");
  expect(documentPreviewState(ready)).toBe("ready");
  // A portrait page shows its top (capped); a slide shows whole.
  expect(documentThumbBox(ready)).toEqual({ width: 256, height: 200 });
  expect(documentThumbBox({ ...base, preview: { status: "ready", pages: 1, width: 800, height: 450 } })).toEqual({ width: 256, height: 144 });
  expect(documentThumbBox({ ...base, preview: { status: "pending", pages: null, width: null, height: null } })).toBeNull();
  expect(pageCountLabel(12)).toBe("12 ページ");
  expect(pageCountLabel(null)).toBe("");
});

it("shows a plain download row when there is no preview, and 「プレビューを作成中…」 while it is made", () => {
  const download = vi.fn();
  const fetch = vi.fn(async () => new Blob());
  const view = render(<AttachmentList attachments={[{ ...base, preview: { status: "failed", pages: null, width: null, height: null } }]} controller={controller(fetch, download)} />);
  expect(document.querySelector("[data-document-card]")).toBeNull();
  fireEvent.click(screen.getByText("議事録.docx"));
  expect(download).toHaveBeenCalledTimes(1);

  view.rerender(<AttachmentList attachments={[{ ...base, preview: { status: "pending", pages: null, width: null, height: null } }]} controller={controller(fetch, download)} />);
  const card = document.querySelector("[data-document-card]") as HTMLElement;
  expect(card.dataset["documentCard"]).toBe("pending");
  expect(screen.getByRole("status").textContent).toBe("プレビューを作成中…");
  expect(card.querySelector("[data-document-box]")).toBeNull();
  expect(fetch).not.toHaveBeenCalled(); // nothing to fetch yet
});

it("shows the first page in its final box with the name, size and page count, and downloads from the card", async () => {
  const download = vi.fn();
  let deliver!: (blob: Blob) => void;
  const fetch = vi.fn(() => new Promise<Blob>((resolve) => { deliver = resolve; }));
  render(<AttachmentList attachments={[ready]} controller={controller(fetch, download)} />);
  const box = document.querySelector("[data-document-box]") as HTMLElement;
  expect(box.dataset["documentBox"]).toBe("256x200");
  expect(box.style.height).toBe("200px"); // reserved before the picture arrives
  expect(screen.getByText("2 KB · 3 ページ")).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith("/api/v1/attachments/d/preview/thumbnail");
  deliver(new Blob());
  await waitFor(() => expect(box.querySelector("img")?.getAttribute("src")).toBe("blob:preview"));
  expect(box.style.height).toBe("200px");
  fireEvent.click(screen.getByRole("button", { name: "ダウンロード" }));
  expect(download).toHaveBeenCalledWith(ready);
});

it("opens every page in the viewer, with zoom, download and a retry after a failure", async () => {
  const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) };
  const destroy = vi.fn();
  openPdf.mockRejectedValueOnce(new Error("broken")).mockResolvedValue({ numPages: 3, getPage: async () => page, loadingTask: { destroy } });
  const fetch = vi.fn(async () => new Blob(["%PDF"]));
  const download = vi.fn();
  render(<AttachmentList attachments={[ready]} controller={controller(fetch, download)} />);
  fireEvent.click(screen.getByRole("button", { name: "議事録.docx のプレビューを開く" }));
  expect(fetch).toHaveBeenCalledWith("/api/v1/attachments/d/preview/pdf");
  expect(await screen.findByText("プレビューを読み込めませんでした")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "再試行" }));
  await waitFor(() => expect(document.querySelectorAll("[data-pdf-page]")).toHaveLength(3));
  const first = document.querySelector("[data-pdf-page='1']") as HTMLElement;
  const before = parseInt(first.style.width, 10);
  fireEvent.click(screen.getByRole("button", { name: "拡大" }));
  expect(parseInt(first.style.width, 10)).toBeGreaterThan(before);
  expect(screen.getByText("125%")).toBeTruthy();
  // The page keeps the PDF's own shape (A4 here).
  expect(Math.abs(parseInt(first.style.height, 10) / parseInt(first.style.width, 10) - 842 / 595)).toBeLessThan(0.01);
  const dialog = screen.getByRole("dialog");
  fireEvent.click(dialog.querySelector("[aria-label='ダウンロード']")!);
  expect(download).toHaveBeenCalledWith(ready);
  fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(destroy).toHaveBeenCalled();
});
