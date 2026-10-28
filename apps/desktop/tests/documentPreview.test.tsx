// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AttachmentList } from "../src/ui/Attachments";
import { documentPreviewState, documentThumbBox, pageCountLabel } from "../src/ui/attachmentLayout";
import { currentPage, stepPdfZoom } from "../src/ui/DocumentPreview";
import { ViewerBody, ViewerFrame } from "../src/ui/ViewerHeader";
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
  has_display: false,
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

const frame = (kind: "overlay" | "custom" | "native", onClose = vi.fn()) => (
  <ViewerFrame title="名前" description="説明" kind={kind} onClose={onClose} header={<span>名前</span>}>
    <ViewerBody onClose={onClose}><div data-testid="page" style={{ width: 100, height: 100 }} /></ViewerBody>
  </ViewerFrame>
);

it("keeps a strip above the card to drag the window by (the macOS buttons sit in it, ours on Windows), none in the browser", () => {
  const { rerender } = render(frame("overlay"));
  const strip = () => document.querySelector("[data-viewer-drag-strip]") as HTMLElement | null;
  expect(strip()?.getAttribute("data-tauri-drag-region")).toBe("deep");
  expect(strip()?.style.height).toContain("40px");
  expect(screen.queryByRole("group", { name: "ウィンドウ" })).toBeNull();
  // The card's header moves the window too.
  expect(document.querySelector("[data-viewer-header]")!.getAttribute("data-tauri-drag-region")).toBe("deep");
  rerender(frame("custom"));
  expect(strip()!.contains(screen.getByRole("button", { name: "最小化" }))).toBe(true);
  rerender(frame("native"));
  expect(strip()).toBeNull();
  expect(screen.queryByRole("button", { name: "最小化" })).toBeNull();
});

const press = (element: Element, up: Element = element) => {
  fireEvent.pointerDown(element, { button: 0 });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(up, { button: 0 });
  fireEvent.mouseUp(up, { button: 0 });
  // A click goes to the nearest element holding both ends of the press.
  const common = element.contains(up) ? element : up.contains(element) ? up : element.parentElement!;
  fireEvent.click(common, { button: 0 });
};

it("closes on a press on the dark space around the card or the page, not on the page, the header or the drag strip", () => {
  const onClose = vi.fn();
  render(frame("overlay", onClose));
  const outside = document.querySelector("[data-viewer-frame]")!;
  const around = document.querySelector("[data-viewer-backdrop]")!;
  const page = screen.getByTestId("page");
  press(page);
  press(document.querySelector("[data-viewer-header]")!);
  press(document.querySelector("[data-viewer-drag-strip]")!);
  press(document.querySelector("[data-viewer-card]")!);
  press(document.querySelector("[data-viewer-scroller]")!); // its scroll bars
  expect(onClose).not.toHaveBeenCalled();
  // A drag (a text selection) from the page that ends outside it, and one from outside that ends on the page.
  press(page, around);
  press(around, page);
  expect(onClose).not.toHaveBeenCalled();
  // A right click does not close.
  fireEvent.pointerDown(around, { button: 2 });
  fireEvent.pointerUp(around, { button: 2 });
  fireEvent.click(around, { button: 2 });
  expect(onClose).not.toHaveBeenCalled();
  press(around);
  expect(onClose).toHaveBeenCalledTimes(1);
  press(outside);
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("centres what is shorter than the view and scrolls what is taller from its top", () => {
  render(frame("native"));
  const around = document.querySelector("[data-viewer-backdrop]") as HTMLElement;
  // At least the view's size, growing with its content: the content's auto margins centre it without cutting its top.
  expect(around.className).toContain("min-h-full");
  expect(around.className).toContain("min-w-full");
  expect(around.className).toContain("flex");
  expect(around.className).not.toContain("justify-center");
  expect((document.querySelector("[data-viewer-scroller]") as HTMLElement).className).toContain("overflow-auto");
});

it("closes the document viewer on a press beside the pages and keeps it on the pages", async () => {
  const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) };
  openPdf.mockResolvedValue({ numPages: 2, getPage: async () => page, loadingTask: { destroy: vi.fn() } });
  render(<AttachmentList attachments={[ready]} controller={controller(vi.fn(async () => new Blob(["%PDF"])))} />);
  fireEvent.click(screen.getByRole("button", { name: "議事録.docx のプレビューを開く" }));
  await waitFor(() => expect(document.querySelectorAll("[data-pdf-page]")).toHaveLength(2));
  expect((document.querySelector("[data-pdf-pages]") as HTMLElement).className).toContain("m-auto");
  const close = screen.getByRole("button", { name: "閉じる" });
  expect(close.getAttribute("title")).toBe("閉じる（Esc）");
  press(document.querySelector("[data-pdf-page='1']")!);
  press(document.querySelector("[data-pdf-pages]")!); // the gap between pages
  press(document.querySelector("[data-pdf-page='1']")!, document.querySelector("[data-viewer-backdrop]")!);
  expect(screen.getByRole("dialog")).toBeTruthy();
  press(document.querySelector("[data-viewer-backdrop]")!);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("closes the photo viewer on a press beside the photo; a press on the photo zooms it", async () => {
  const photo: AttachmentOut = { ...base, id: "p", filename: "写真.png", content_type: "image/png", has_thumbnail: true, width: 400, height: 300 };
  render(<AttachmentList attachments={[photo]} controller={controller(vi.fn(async () => new Blob(["png"])))} />);
  fireEvent.click(document.querySelector("[data-photo-box]")!);
  const img = await waitFor(() => within(screen.getByRole("dialog")).getByRole("img", { name: "写真.png" }));
  expect(img.className).toContain("m-auto");
  expect(img.className).toContain("cursor-zoom-in");
  press(img);
  expect(img.className).toContain("cursor-zoom-out");
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(document.querySelector("[data-photo-box]")!);
  await waitFor(() => within(screen.getByRole("dialog")).getByRole("img", { name: "写真.png" }));
  press(document.querySelector("[data-viewer-backdrop]")!);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
