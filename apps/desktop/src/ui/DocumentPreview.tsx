import { Download, FileText, Loader2, X, ZoomIn, ZoomOut } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import { formatSize } from "./Attachments";
import { DOCUMENT_CARD_WIDTH, documentPreviewState, documentThumbBox, pageCountLabel } from "./attachmentLayout";
import type { PDFDocumentProxy } from "./pdfLoader";
import { cn } from "./primitives";
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

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const PAGE_MAX_WIDTH = 900;

/** Every page of the preview PDF, rendered with PDF.js as they come near (a 300-page file draws only what is seen). */
export function PdfViewer({ attachment, controller, onClose }: { attachment: AttachmentOut; controller: AppController; onClose: () => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState(Math.SQRT2);
  const [fitWidth, setFitWidth] = useState(PAGE_MAX_WIDTH);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const api = controller.api;
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setFailed(false);
    void (async () => {
      try {
        if (!api) throw new Error("No session");
        const [blob, { openPdf }] = await Promise.all([
          api.fetchBlob(`/api/v1/attachments/${attachment.id}/preview/pdf`),
          import("./pdfLoader"),
        ]);
        const opened = await openPdf(await blob.arrayBuffer());
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
  }, [attachment.id, controller.api, attempt]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setFitWidth(Math.max(200, Math.min(PAGE_MAX_WIDTH, element.clientWidth - 32)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const width = Math.round(fitWidth * zoom);
  const pages = doc?.numPages ?? attachment.preview?.pages ?? 0;
  const zoomIndex = ZOOMS.indexOf(zoom);
  return (
    <Dialog.Root open onOpenChange={(value) => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay fixed inset-0 z-40 bg-black/85" />
        <Dialog.Content className="fixed inset-0 z-50 flex flex-col focus:outline-none">
          <Dialog.Title className="sr-only">{attachment.filename}</Dialog.Title>
          <Dialog.Description className="sr-only">{t("docPreview.description")}</Dialog.Description>
          <div className="flex items-center gap-2 px-4 py-3 text-white">
            <div className="min-w-0 flex-1">
              <FileName name={attachment.filename} className="text-sm font-medium" />
              <div className="text-xs text-white/70">{[formatSize(attachment.size_bytes), pageCountLabel(pages)].filter(Boolean).join(" · ")}</div>
            </div>
            <button type="button" className="rounded-lg p-2 hover:bg-white/15 disabled:opacity-40" title={t("docPreview.zoomOut")} aria-label={t("docPreview.zoomOut")} disabled={zoomIndex <= 0} onClick={() => setZoom(ZOOMS[Math.max(0, zoomIndex - 1)] ?? 1)}>
              <ZoomOut size={18} />
            </button>
            <button type="button" className="min-w-12 rounded-lg px-1 py-2 text-xs tabular-nums hover:bg-white/15" title={t("docPreview.fitWidth")} onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="rounded-lg p-2 hover:bg-white/15 disabled:opacity-40" title={t("docPreview.zoomIn")} aria-label={t("docPreview.zoomIn")} disabled={zoomIndex >= ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zoomIndex + 1)] ?? 1)}>
              <ZoomIn size={18} />
            </button>
            <button type="button" className="rounded-lg p-2 hover:bg-white/15" title={t("attach.download")} aria-label={t("attach.download")} onClick={() => void controller.downloadAttachment(attachment)}>
              <Download size={18} />
            </button>
            <Dialog.Close asChild>
              <button type="button" className="rounded-lg p-2 hover:bg-white/15" title={t("attach.closeEsc")} aria-label={t("common.close")}>
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>
          <div ref={scroller} data-pdf-pages="" className="min-h-0 flex-1 overflow-auto px-4 pb-6">
            {doc ? (
              <div className="mx-auto flex w-max flex-col items-center gap-3">
                {Array.from({ length: doc.numPages }, (_, index) => (
                  <PdfPage key={index} doc={doc} number={index + 1} width={width} aspect={aspect} root={scroller.current} />
                ))}
              </div>
            ) : failed ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-white">
                <p role="status">{t("docPreview.failed")}</p>
                <div className="flex gap-2">
                  <button type="button" className="rounded-lg border border-white/50 px-4 py-2 hover:bg-white/15" onClick={() => setAttempt((n) => n + 1)}>{t("common.retry")}</button>
                  <button type="button" className="rounded-lg border border-white/50 px-4 py-2 hover:bg-white/15" onClick={() => void controller.downloadAttachment(attachment)}>{t("attach.download")}</button>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center">
                <Loader2 size={28} role="status" aria-label={t("docPreview.loading")} className="animate-spin text-white/70" />
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
    <div ref={holder} data-pdf-page={number} className="relative bg-white shadow-lg" style={{ width, height }}>
      <canvas ref={canvas} className="block" style={{ width, height }} aria-label={t("docPreview.page", { n: number })} />
      {failed && <span className={cn("absolute inset-0 flex items-center justify-center text-sm text-muted")}>{t("docPreview.pageFailed")}</span>}
    </div>
  );
}
