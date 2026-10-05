/**
 * PDF.js (pdfjs-dist, Apache-2.0) for the document viewer (M108, docs/PREVIEWS.md §5). Loaded only when a viewer
 * opens (a dynamic import of this module), so the timeline's bundle does not carry it. The worker is a hashed asset of
 * our own origin, which the CSPs already allow (`default-src 'self'` in Tauri, `script-src 'self'` in Caddy).
 *
 * Why not the browser's own viewer in an <iframe>: Tauri's WKWebView on macOS has no dependable PDF viewer for a
 * frame, WebKitGTK none at all, and both CSPs would have to let `blob:` frames in; PDF.js draws to a canvas the same
 * way in Tauri (macOS, Windows) and every browser. The legacy build: the modern one needs Safari 17.4+ APIs, and a Mac
 * app on an older macOS runs the system's older WebKit.
 *
 * Not loaded: the Adobe CMaps, the standard fonts and the wasm image decoders (PDF.js would fetch them from URLs we do
 * not serve). The converter's PDFs embed their fonts and use JPEG / Flate images, so they never need them; an uploaded
 * PDF with unembedded CJK fonts or JPEG 2000 images may show those parts blank in this viewer (download opens it in
 * the system's viewer).
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({
    data: new Uint8Array(data),
    useWasm: false,
    useWorkerFetch: false,
    stopAtErrors: false,
  }).promise;
}
