// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AttachmentList } from "../src/ui/Attachments";
import { documentPreviewState, documentThumbBox, pageCountLabel } from "../src/ui/attachmentLayout";
import { currentPage, stepPdfZoom } from "../src/ui/DocumentPreview";
import { ViewerHeader } from "../src/ui/ViewerHeader";
import { setUpZoom } from "../src/platform/zoom";

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
  fireEvent.click(screen.getByTitle("議事録.docx"));
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
  fireEvent.click(screen.getByRole("button", { name: "議事録.docx をダウンロード" }));
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

it("counts pages by the scroll and steps the zoom within its range", () => {
  const tops = [0, 1000, 2000];
  expect(currentPage(tops, 0, 800, 3000)).toBe(1);
  expect(currentPage(tops, 950, 800, 3000)).toBe(2); // page 2's top is just under the top of the view
  expect(currentPage(tops, 800, 800, 3000)).toBe(1);
  expect(currentPage(tops, 2200, 800, 3000)).toBe(3); // at the end: the last page, however short
  expect(stepPdfZoom(1, 1)).toBe(1.25);
  expect(stepPdfZoom(3, 1)).toBe(3);
  expect(stepPdfZoom(0.5, -1)).toBe(0.5);
  expect(stepPdfZoom(2, 0)).toBe(1);
});

it("moves page by page with ← / → and zooms with Ctrl (⌘) + 「+」 「-」 「0」, not the window", async () => {
  const stopZoom = setUpZoom(true);
  const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) };
  openPdf.mockResolvedValue({ numPages: 3, getPage: async () => page, loadingTask: { destroy: vi.fn() } });
  render(<AttachmentList attachments={[ready]} controller={controller(vi.fn(async () => new Blob(["%PDF"])))} />);
  fireEvent.click(screen.getByRole("button", { name: "議事録.docx のプレビューを開く" }));
  await waitFor(() => expect(document.querySelectorAll("[data-pdf-page]")).toHaveLength(3));
  const counter = () => document.querySelector("[data-page-counter]")!.textContent;
  const dialog = screen.getByRole("dialog");
  expect(counter()).toBe("1 / 3");
  expect((screen.getByRole("button", { name: "前のページ（←）" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  expect(counter()).toBe("2 / 3");
  fireEvent.keyDown(dialog, { key: "End" });
  expect(counter()).toBe("3 / 3");
  fireEvent.keyDown(dialog, { key: "ArrowRight" }); // stays on the last
  expect(counter()).toBe("3 / 3");
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  expect(counter()).toBe("2 / 3");
  fireEvent.click(screen.getByRole("button", { name: "前のページ（←）" }));
  expect(counter()).toBe("1 / 3");

  const level = () => document.querySelector("[data-zoom-level]")!.textContent;
  fireEvent.keyDown(dialog, { key: "=", ctrlKey: true });
  fireEvent.keyDown(dialog, { key: "=", ctrlKey: true });
  expect(level()).toBe("150%");
  expect(document.documentElement.style.getPropertyValue("--ui-zoom")).toBe(""); // the window's text size kept still
  fireEvent.keyDown(dialog, { key: "-", ctrlKey: true });
  expect(level()).toBe("125%");
  fireEvent.keyDown(dialog, { key: "0", ctrlKey: true });
  expect(level()).toBe("100%");
  expect(screen.getByRole("button", { name: "幅に合わせる" }).getAttribute("aria-pressed")).toBe("true");

  // The top row moves the window, its buttons do not (Tauri's "deep" drag region skips clickable elements).
  const header = dialog.querySelector("[data-viewer-header]") as HTMLElement;
  expect(header.getAttribute("data-tauri-drag-region")).toBe("deep");
  expect(header.contains(screen.getByRole("button", { name: "ダウンロード" }))).toBe(true);

  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Closed: the zoom keys are the window's again.
  fireEvent.keyDown(window, { key: "=", ctrlKey: true });
  expect(document.documentElement.style.getPropertyValue("--ui-zoom")).toBe("1.1");
  stopZoom();
  localStorage.clear();
  document.documentElement.style.removeProperty("--ui-zoom");
});

it("keeps the macOS window buttons' room, and draws our own on Windows", () => {
  const { rerender } = render(<ViewerHeader kind="overlay"><span>名前</span></ViewerHeader>);
  const header = document.querySelector("[data-viewer-header]") as HTMLElement;
  expect(header.style.paddingLeft).toContain("84px");
  expect(screen.queryByRole("group", { name: "ウィンドウ" })).toBeNull();
  rerender(<ViewerHeader kind="custom"><span>名前</span></ViewerHeader>);
  expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
  rerender(<ViewerHeader kind="native"><span>名前</span></ViewerHeader>);
  expect(screen.queryByRole("button", { name: "最小化" })).toBeNull();
});
