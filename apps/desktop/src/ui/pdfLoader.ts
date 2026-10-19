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
 * The Adobe CMaps and the standard fonts are bundled (hashed assets, fetched one by one when a PDF asks for them): a
 * PDF whose Japanese font is not embedded (Word on Windows, many scanners' and forms' PDFs) names its characters
 * through a CMap such as UniJIS-UCS2-H, and without it every Japanese glyph came out blank (user report 2026-10-19).
 * Never inlined as data: URLs, which the CSPs' `connect-src` refuse. Not loaded: the wasm image decoders, so JPEG 2000
 * images may still show blank (download opens the PDF in the system's viewer).
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

// Only the URLs are in this module (eager: no chunk per file); a file is fetched when a PDF asks for it.
const binaryData: Record<string, Record<string, string>> = {
  cMapUrl: import.meta.glob<string>("../../node_modules/pdfjs-dist/cmaps/*.bcmap", { query: "?url&no-inline", import: "default", eager: true }),
  standardFontDataUrl: import.meta.glob<string>("../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", { query: "?url&no-inline", import: "default", eager: true }),
};

/** PDF.js asks for `<cMapUrl><name>.bcmap` and `<standardFontDataUrl><file>`; the base URLs below are only names. */
export class BundledBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const entry = Object.entries(binaryData[kind] ?? {}).find(([path]) => path.endsWith(`/${filename}`));
    if (!entry) throw new Error(`PDF.js data not bundled: ${kind} ${filename}`);
    const response = await fetch(entry[1]);
    if (!response.ok) throw new Error(`PDF.js data ${filename}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export type { PDFDocumentProxy };

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({
    data: new Uint8Array(data),
    useWasm: false,
    useWorkerFetch: false,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    BinaryDataFactory: BundledBinaryDataFactory,
    stopAtErrors: false,
  }).promise;
}
