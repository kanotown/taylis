/**
 * A drive file in the app's own viewers (M161, docs/DRIVE.md §17.2): photos (Lightbox), videos (VideoViewer; on the
 * Web it plays from a download ticket, with Range, instead of fetching the whole clip first) and PDF / Office files
 * (PdfViewer on /attachments/{id}/preview/pdf). The viewers' download buttons go the drive's way
 * (controller.downloadAttachment knows a drive file). ← → step to the folder's previous and next viewable file
 * (photos and videos; in a PDF the keys scroll).
 */
import { useEffect, useMemo } from "react";

import type { DriveItemOut } from "../api/types";
import type { AppController } from "../state/app";
import { ticketUrl } from "../drive/download";
import { asAttachment, stepItem, viewerKind } from "../drive/listing";
import { isWeb } from "../platform/env";
import { Lightbox, VideoViewer } from "./Attachments";
import { PdfViewer } from "./DocumentPreview";

export function DriveViewer({ controller, item, siblings, onStep, onClose }: {
  controller: AppController;
  item: DriveItemOut;
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
  if (kind === "video") {
    const api = controller.api;
    const stream = isWeb() && api ? async () => ticketUrl(api.baseUrl, (await api.driveDownloadTicket(item.id)).url) : undefined;
    return <VideoViewer key={item.id} attachment={attachment} controller={controller} onClose={onClose} stream={stream} />;
  }
  return <PdfViewer key={item.id} attachment={attachment} controller={controller} onClose={onClose} />;
}
