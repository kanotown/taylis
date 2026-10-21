import { ChevronLeft, ChevronRight, Download, FileText, Loader2, MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import { formatSize, keepOpenForToasts, ViewerFileButtons } from "./Attachments";
import { DOCUMENT_CARD_WIDTH, documentPreviewState, documentThumbBox, pageCountLabel } from "./attachmentLayout";
import type { PDFDocumentProxy } from "./pdfLoader";
import { cn, modKey } from "./primitives";
import { VIEWER_BUTTON, ViewerBody, ViewerCloseButton, ViewerFrame } from "./ViewerHeader";
import { claimZoomKeys, zoomKey } from "../platform/zoom";
import { t } from "../i18n";
import { FileName } from "./FileName";

/**
 * M108 (docs/PREVIEWS.md §5): the card of a PDF or Office file with a preview, as Slack shows one. Ready: the first
 * page in a box of its final size (from the server's width / height, so the row never jumps when it loads) over a line
 * with the name, size and page count; a click opens every page in the viewer. Pending: the plain card with
 * 「プレビューを作成中…」 (message.updated replaces it when the server is done). Download stays on the card.
 */
export function DocumentCard({ attachment, controller }: { attachment: AttachmentOut; controller: AppController }) {
  const state = documentPreviewState(attachment);
  const box = documentThumbBox(attachment);
  const [open, setOpen] = useState(false);
  const thumb = usePreviewThumbnail(controller, attachment, state === "ready");
  const pages = pageCountLabel(attachment.preview?.pages);
  const meta = [formatSize(attachment.size_bytes), pages].filter(Boolean).join(" · ");
  return (
    <div
      data-document-card={state ?? ""}
      className="group flex max-w-full flex-col overflow-hidden rounded-xl border border-line bg-panel text-sm text-ink"
      style={{ width: DOCUMENT_CARD_WIDTH }}
    >
      {state === "ready" && (
        <button
          type="button"
          className="block w-full overflow-hidden border-b border-line bg-white"
          style={box ? { height: box.height } : { aspectRatio: "4 / 3" }}
          data-document-box={box ? `${box.width}x${box.height}` : undefined}
          title={`${attachment.filename} — ${t("docPreview.clickToPreview")}`}
          aria-label={t("docPreview.open", { name: attachment.filename })}
          onClick={() => setOpen(true)}
        >
          {thumb ? (
            <img src={thumb} alt="" className="block h-full w-full object-cover object-top" />
          ) : (
            <span role="status" aria-label={t("docPreview.loading")} className="flex h-full w-full items-center justify-center text-muted">
              <Loader2 size={18} className="animate-spin" />
            </span>
          )}
        </button>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <FileText size={18} className="shrink-0 text-muted" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => (state === "ready" ? setOpen(true) : void controller.downloadAttachment(attachment))}
        >
          <FileName name={attachment.filename} />
          <span className="block text-xs text-muted">
            {state === "pending" ? <span role="status">{t("docPreview.creating")}</span> : meta}
          </span>
        </button>
        <button
          type="button"
          className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-accent-soft/60 hover:text-ink"
          title={t("attach.download")}
          aria-label={t("attach.downloadName", { name: attachment.filename })}
          onClick={() => void controller.downloadAttachment(attachment)}
        >
          <Download size={14} />
        </button>
      </div>
      {open && <PdfViewer attachment={attachment} controller={controller} onClose={() => setOpen(false)} />}
    </div>
  );
}

function usePreviewThumbnail(controller: AppController, attachment: AttachmentOut, enabled: boolean): string | null {
  const api = controller.api;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !api) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const blob = await api.fetchBlob(`/api/v1/attachments/${attachment.id}/preview/thumbnail`);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        // No picture: the box stays with its spinner-free name line below; the viewer still opens.
        if (!cancelled) setUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [api, attachment.id, enabled]);
  return url;
}

export const PDF_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const PAGE_MAX_WIDTH = 900;

/** The next zoom step up (1) or down (-1) from `zoom`, staying at the ends; 0 is back to the width fit (100 %). */
export function stepPdfZoom(zoom: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return 1;
  if (direction === 1) return PDF_ZOOMS.find((step) => step > zoom + 1e-9) ?? PDF_ZOOMS[PDF_ZOOMS.length - 1]!;
  return [...PDF_ZOOMS].reverse().find((step) => step < zoom - 1e-9) ?? PDF_ZOOMS[0]!;
}

/**
 * The page being read: the last page whose top has passed a line a little below the top of the view (60 px, or 40 %
 * of a short view), as a PDF viewer counts it; the last page once the view is at the end (a short last page never
 * reaches the top). `tops` are the pages' offsets in the scroller, in order.
 */
export function currentPage(tops: readonly number[], scrollTop: number, viewHeight: number, scrollHeight = Infinity): number {
  if (tops.length > 0 && scrollTop > 0 && scrollTop + viewHeight >= scrollHeight - 2) return tops.length;
  const line = scrollTop + Math.min(60, viewHeight * 0.4);
  let page = 1;
  for (let index = 0; index < tops.length; index++) if (tops[index]! <= line) page = index + 1;
  return page;
}

const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The document viewer (M108, docs/PREVIEWS.md §5 and §11): every page of the preview PDF, drawn with PDF.js as they
 * come near (a 300-page file draws only what is seen), centred in the viewer's card (ViewerFrame) while they are
 * shorter than it. Fits the width at first (100 %, at most
 * 900 px wide); 50–300 % with the buttons, ⌘ / Ctrl + 「+」 「-」 「0」 (the window's text size keys are lent to the
 * viewer while it is open). 「n / N」 follows the scroll; ← / → (also PageUp / PageDown when the pages are not focused,
 * Home / End) go a page back / on, smoothly; Esc, the × and a click on the dark space around the pages close. The
 * strip above the card and the header move the window in the desktop app.
 *
 * M163: the public page of a share link (src/share) shows a shared PDF with the same viewer, without a session: it
 * passes how to read the bytes (`load`), its own buttons and its download instead of the controller.
 */
export type PdfSource = Pick<AttachmentOut, "id" | "filename" | "size_bytes" | "preview">;
type PdfViewerProps =
  | { attachment: AttachmentOut; controller: AppController; onClose: () => void }
  | { attachment: PdfSource; load: () => Promise<ArrayBuffer>; buttons: ReactNode; onDownload: () => void; onClose: () => void };

export function PdfViewer(props: PdfViewerProps) {
  const { attachment, onClose } = props;
  const controller = "controller" in props ? props.controller : null;
  const load = "load" in props ? props.load : null;
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState(Math.SQRT2);
  const [fitWidth, setFitWidth] = useState(PAGE_MAX_WIDTH);
  const [page, setPage] = useState(1);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Where the view was (as a share of the pages' height) before a zoom: the same place is shown after it.
  const keepAt = useRef<number | null>(null);

  const api = controller?.api ?? null;
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setFailed(false);
    void (async () => {
      try {
        const read = load ?? (api ? async () => (await api.fetchBlob(`/api/v1/attachments/${attachment.id}/preview/pdf`)).arrayBuffer() : null);
        if (!read) throw new Error("No session");
        const [bytes, { openPdf }] = await Promise.all([read(), import("./pdfLoader")]);
        const opened = await openPdf(bytes);
        if (cancelled) {
          void opened.loadingTask.destroy();
          return;
        }
        loaded = opened;
        const first = await opened.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        if (!cancelled) {
          setAspect(viewport.height / viewport.width);
          setDoc(opened);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) void loaded.loadingTask.destroy();
    };
  }, [attachment.id, api, load, attempt]);

  // The scroller mounts with the dialog's content (a portal): follow it by callback, not by a one-time effect.
  const observer = useRef<ResizeObserver | null>(null);
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element;
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const measure = () => setFitWidth(Math.max(200, Math.min(PAGE_MAX_WIDTH, element.clientWidth - 32)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
  }, []);

  // ⌘ / Ctrl + 「+」 「-」 「0」 zoom the pages while the viewer is open, not the window's text (platform/zoom.ts).
  useEffect(() => claimZoomKeys(), []);

  const pages = doc?.numPages ?? attachment.preview?.pages ?? 0;
  const width = Math.round(fitWidth * zoom);

  const pageTops = () => {
    const element = scroller.current;
    if (!element) return [];
    return [...element.querySelectorAll<HTMLElement>("[data-pdf-page]")].map((node) => node.offsetTop);
  };
  const onScroll = () => {
    const element = scroller.current;
    if (!element || !doc) return;
    setPage(currentPage(pageTops(), element.scrollTop, element.clientHeight, element.scrollHeight));
  };
  const goTo = (target: number) => {
    const element = scroller.current;
    if (!element || !doc) return;
    const number = Math.min(Math.max(1, target), doc.numPages);
    const node = element.querySelector<HTMLElement>(`[data-pdf-page='${number}']`);
    if (!node) return;
    setPage(number);
    const top = Math.max(0, node.offsetTop - 12);
    if (typeof element.scrollTo === "function") element.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    else element.scrollTop = top;
  };
  // The zoom as of the last change (keys pressed faster than React renders step from it, not from a stale render).
  const zoomNow = useRef(zoom);
  const changeZoom = (next: number) => {
    const element = scroller.current;
    if (next === zoomNow.current) return;
    zoomNow.current = next;
    if (element && element.scrollHeight > 0 && keepAt.current === null) keepAt.current = element.scrollTop / element.scrollHeight;
    setZoom(next);
  };
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || keepAt.current === null) return;
    element.scrollTop = keepAt.current * element.scrollHeight;
    keepAt.current = null;
  }, [width]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const direction = zoomKey(event);
    if (direction !== null) {
      event.preventDefault();
      changeZoom(stepPdfZoom(zoomNow.current, direction));
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || !doc) return;
    const inPages = event.target instanceof Node && !!scroller.current?.contains(event.target);
    const step = event.key === "ArrowLeft" || (event.key === "PageUp" && !inPages) ? -1 : event.key === "ArrowRight" || (event.key === "PageDown" && !inPages) ? 1 : 0;
    if (step !== 0) {
      event.preventDefault();
      goTo(page + step);
    } else if ((event.key === "Home" || event.key === "End") && !inPages) {
      event.preventDefault();
      goTo(event.key === "Home" ? 1 : doc.numPages);
    }
  };

  const zoomIndex = PDF_ZOOMS.indexOf(zoom);
  return (
    <ViewerFrame
      title={attachment.filename}
      description={t("docPreview.description")}
      onClose={onClose}
      onKeyDown={onKeyDown}
      onPointerDownOutside={keepOpenForToasts}
      header={
        <>
          <div className="min-w-0 flex-1 max-sm:basis-full">
            <FileName name={attachment.filename} className="text-sm font-medium" />
            <div className="text-xs text-white/70">{[formatSize(attachment.size_bytes), pageCountLabel(pages)].filter(Boolean).join(" · ")}</div>
          </div>
          {doc && doc.numPages > 1 && (
            <div className="flex items-center" role="group" aria-label={t("docPreview.pages")}>
              <button type="button" className={VIEWER_BUTTON} title={t("docPreview.prevPage")} aria-label={t("docPreview.prevPage")} disabled={page <= 1} onClick={() => goTo(page - 1)}>
                <ChevronLeft size={18} />
              </button>
              <span data-page-counter="" aria-live="polite" className="min-w-14 text-center text-xs tabular-nums text-white/90">
                {t("docPreview.pageOf", { n: page, total: doc.numPages })}
              </span>
              <button type="button" className={VIEWER_BUTTON} title={t("docPreview.nextPage")} aria-label={t("docPreview.nextPage")} disabled={page >= doc.numPages} onClick={() => goTo(page + 1)}>
                <ChevronRight size={18} />
              </button>
            </div>
          )}
          <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
          <button type="button" className={VIEWER_BUTTON} title={`${t("docPreview.zoomOut")} (${modKey()} −)`} aria-label={t("docPreview.zoomOut")} disabled={zoomIndex <= 0} onClick={() => changeZoom(stepPdfZoom(zoom, -1))}>
            <ZoomOut size={18} />
          </button>
          <button type="button" data-zoom-level="" className="min-w-12 rounded-lg px-1 py-2 text-xs tabular-nums text-white hover:bg-white/15" title={`${t("docPreview.fitWidth")} (${modKey()} 0)`} onClick={() => changeZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" className={VIEWER_BUTTON} title={`${t("docPreview.zoomIn")} (${modKey()} +)`} aria-label={t("docPreview.zoomIn")} disabled={zoomIndex >= PDF_ZOOMS.length - 1} onClick={() => changeZoom(stepPdfZoom(zoom, 1))}>
            <ZoomIn size={18} />
          </button>
          <button type="button" className={VIEWER_BUTTON} title={t("docPreview.fitWidth")} aria-label={t("docPreview.fitWidth")} aria-pressed={zoom === 1} onClick={() => changeZoom(1)}>
            <MoveHorizontal size={18} />
          </button>
          <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
          {"controller" in props ? <ViewerFileButtons attachment={props.attachment} controller={props.controller} /> : props.buttons}
          <ViewerCloseButton />
        </>
      }
    >
      <ViewerBody onClose={onClose} scrollerRef={attachScroller} onScroll={onScroll}>
        {doc ? (
          <div data-pdf-pages="" data-viewer-content="" className="m-auto flex w-max flex-col items-center gap-4">
            {Array.from({ length: doc.numPages }, (_, index) => (
              <PdfPage key={index} doc={doc} number={index + 1} width={width} aspect={aspect} root={scroller.current} />
            ))}
          </div>
        ) : failed ? (
          <div className="m-auto flex flex-col items-center gap-3 text-white">
            <p role="status">{t("docPreview.failed")}</p>
            <div className="flex gap-2">
              <button type="button" className="rounded-lg border border-white/50 px-4 py-2 hover:bg-white/15" onClick={() => setAttempt((n) => n + 1)}>{t("common.retry")}</button>
              <button type="button" className="rounded-lg border border-white/50 px-4 py-2 hover:bg-white/15" onClick={() => ("controller" in props ? void props.controller.downloadAttachment(props.attachment) : props.onDownload())}>{t("attach.download")}</button>
            </div>
          </div>
        ) : (
          <Loader2 size={28} role="status" aria-label={t("docPreview.loading")} className="m-auto animate-spin text-white/70" />
        )}
      </ViewerBody>
    </ViewerFrame>
  );
}

/**
 * One page: a white box of the page's shape (the first page's until this one is drawn), drawn when it comes within
 * a screen of the view and redrawn at a new width; the device pixel ratio keeps the text sharp.
 */
function PdfPage({ doc, number, width, aspect, root }: { doc: PDFDocumentProxy; number: number; width: number; aspect: number; root: HTMLElement | null }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const [ownAspect, setOwnAspect] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = holder.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { root, rootMargin: "100% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(number);
        if (cancelled || !canvas.current) return;
        const base = page.getViewport({ scale: 1 });
        setOwnAspect(base.height / base.width);
        const ratio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const target = canvas.current;
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        const render = page.render({ canvas: target, viewport });
        task = render;
        await render.promise;
      } catch (error) {
        if (!cancelled && (error as { name?: string })?.name !== "RenderingCancelledException") setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, width, near]);

  const height = Math.round(width * (ownAspect ?? aspect));
  return (
    <div ref={holder} data-pdf-page={number} className="relative rounded-sm bg-white shadow-2xl" style={{ width, height }}>
      <canvas ref={canvas} className="block" style={{ width, height }} aria-label={t("docPreview.page", { n: number })} />
      {failed && <span className={cn("absolute inset-0 flex items-center justify-center text-sm text-muted")}>{t("docPreview.pageFailed")}</span>}
    </div>
  );
}
