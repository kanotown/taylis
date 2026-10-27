/**
 * A drive file in the app's own viewers (M161, docs/DRIVE.md §17.2): photos (Lightbox), videos (VideoViewer; on the
 * Web it plays from a download ticket, with Range, instead of fetching the whole clip first), sounds (AudioViewer, the
 * same way; PREVIEWS.md §13) and PDF / Office files
 * (PdfViewer). The viewers' download buttons go the drive's way (controller.downloadAttachment knows a drive file).
 * ← → step to the folder's previous and next viewable file (photos, videos and sounds; in a PDF the keys scroll).
 *
 * §27 (2026-10-22): a document never turns into a download. A PDF opens from its preview when that is made, else from
 * its own bytes (an imported PDF has none until it is asked for). An Office file without a preview asks the server to
 * make it (POST /drive/items/{id}/preview) and shows 「プレビューを作成中…」 until drive.changed (or the next look,
 * every few seconds) says it is ready; one that gets none, or whose preview failed, says so and offers the download.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DriveItemOut, DrivePreviewOut } from "../api/types";
import type { AppController } from "../state/app";
import { ticketUrl } from "../drive/download";
import { asAttachment, documentSource, stepItem, viewerKind } from "../drive/listing";
import { isWeb } from "../platform/env";
import { AudioViewer, Lightbox, VideoViewer } from "./Attachments";
import { type PdfHold, PdfViewer } from "./DocumentPreview";

/** How often a preview being made is looked at again (drive.changed usually says it first). */
export const PREVIEW_POLL_MS = 4000;

export function DriveViewer({ controller, item, siblings, onStep, onClose, page }: {
  controller: AppController;
  item: DriveItemOut;
  /** §29: a document opens at this page (a search's match inside it). */
  page?: number | null;
  /** The viewable files of the folder, in the listing's order. */
  siblings: readonly DriveItemOut[];
  onStep: (item: DriveItemOut) => void;
  onClose: () => void;
}) {
  const kind = viewerKind(item);
  const attachment = useMemo(() => asAttachment(item), [item]);
  useEffect(() => {
    if (kind === "document") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, video")) return;
      const next = stepItem(siblings, item.id, event.key === "ArrowLeft" ? -1 : 1);
      if (next) {
        event.preventDefault();
        onStep(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind, siblings, item.id, onStep]);
  if (!attachment || !kind) return null;
  if (kind === "image") return <Lightbox key={item.id} attachment={attachment} controller={controller} onClose={onClose} />;
  if (kind === "video" || kind === "audio") {
    const api = controller.api;
    const stream = isWeb() && api ? async () => ticketUrl(api.baseUrl, (await api.driveDownloadTicket(item.id)).url) : undefined;
    // 2026-10-28 (PREVIEWS.md §13): a sound plays in the viewer too (it used to show the details, then download).
    if (kind === "audio") return <AudioViewer key={item.id} attachment={attachment} controller={controller} onClose={onClose} stream={stream} />;
    return <VideoViewer key={item.id} attachment={attachment} controller={controller} onClose={onClose} stream={stream} />;
  }
  return <DriveDocument key={item.id} controller={controller} item={item} onClose={onClose} page={page ?? null} />;
}

function withPreview(item: DriveItemOut, preview: DrivePreviewOut["preview"]): DriveItemOut {
  return item.file ? { ...item, file: { ...item.file, preview } } : item;
}

/** A PDF or an Office file (§27): the pages from the preview or the PDF itself, or why they are not there yet. */
function DriveDocument({ controller, item, onClose, page }: { controller: AppController; item: DriveItemOut; onClose: () => void; page: number | null }) {
  const api = controller.api;
  const engine = controller.engine;
  const [live, setLive] = useState(item);
  /** The server's answer to 「make its preview」: null while not asked or waiting, "none" when it gets none. */
  const [answer, setAnswer] = useState<"none" | null>(null);
  // A PDF opened from its own bytes stays on them (its preview becoming ready meanwhile would reload the pages).
  const original = useRef(documentSource(item) === "original");
  const source = original.current ? "original" : documentSource(live);

  // Never made (imported, §24): ask for it. A PDF asks too (its thumbnail), but reads its own bytes meanwhile.
  useEffect(() => {
    if (!api || item.file?.preview) return;
    let cancelled = false;
    api.requestDrivePreview(item.id).then(
      (out) => {
        if (cancelled) return;
        setLive((current) => withPreview(current, out.preview ?? null));
        if (!out.preview) setAnswer("none");
      },
      (error) => {
        if (cancelled) return;
        setAnswer("none");
        controller.setError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, controller, item.id, item.file?.preview]);

  // Being made: look again when the folder changes (the preview loop's drive.changed), on a reconnect, and every few seconds.
  const making = source === "making";
  useEffect(() => {
    if (!making || !api) return;
    let cancelled = false;
    const look = () => {
      void api.driveItem(item.id).then(
        (out) => {
          if (!cancelled) setLive(out.item);
        },
        () => undefined,
      );
    };
    const timer = setInterval(look, PREVIEW_POLL_MS);
    const unsubscribe = engine?.drive.subscribe((signal) => {
      if (signal.kind === "resync" || (signal.kind === "changed" && signal.locationId === item.location_id)) look();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [making, api, engine, item.id, item.location_id]);

  const load = useCallback(async () => {
    if (!api) throw new Error("No session");
    return (await api.fetchBlob(`/api/v1/drive/items/${item.id}/content`)).arrayBuffer();
  }, [api, item.id]);
  const attachment = useMemo(() => asAttachment(live), [live]);
  if (!attachment) return null;
  const hold: PdfHold | null =
    source === "making" ? "making"
    : source === "failed" ? "failed"
    : source === "ask" ? (answer === "none" ? "unavailable" : "making")
    : null;
  return <PdfViewer attachment={attachment} controller={controller} onClose={onClose} load={source === "original" ? load : undefined} hold={hold} initialPage={page} />;
}
