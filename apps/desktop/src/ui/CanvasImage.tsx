/**
 * M44 (CANVAS.md §4.10): an image of a canvas, `![説明](attachment:<id>)`. Its metadata and bytes are fetched with the
 * bearer token like a message's photos (the server lets the conversation's members read it, and the uploader while it is
 * still pending); its thumbnail shows in the document, a click opens the full image. A reference that cannot be read —
 * someone else's pending upload, another canvas's file, one erased — shows as 「表示できない画像」. External URLs are
 * never drawn (the dialect only parses `attachment:` images).
 */
import { FileText, ImageOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import { formatSize, Lightbox, useAttachmentImage } from "./Attachments";
import { t } from "../i18n";

export function CanvasImage({ controller, attachmentId, alt }: { controller: AppController; attachmentId: string; alt: string }) {
  const [meta, setMeta] = useState<AttachmentOut | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setMeta(undefined);
    void controller.attachmentMeta(attachmentId).then((row) => {
      if (live) setMeta(row);
    });
    return () => {
      live = false;
    };
  }, [controller, attachmentId]);

  if (meta === undefined) {
    return (
      <span role="status" aria-label={t("attach.loadingImage")} data-attachment-id={attachmentId} className="my-2 flex h-24 w-40 items-center justify-center rounded-lg border border-line bg-panel text-muted">
        <Loader2 size={18} className="animate-spin" />
      </span>
    );
  }
  if (meta === null) return <Unavailable attachmentId={attachmentId} alt={alt} />;
  if (!meta.content_type.startsWith("image/")) {
    // A file named by a link-style reference (another client may write one): a download row, never drawn.
    return (
      <button type="button" data-attachment-id={attachmentId} className="my-2 inline-flex max-w-full items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-left text-sm hover:bg-accent-soft/40" onClick={() => void controller.downloadAttachment(meta)}>
        <FileText size={16} className="shrink-0 text-muted" />
        <span className="truncate">{meta.filename}</span>
        <span className="shrink-0 text-xs text-muted">{formatSize(meta.size_bytes)}</span>
      </button>
    );
  }
  return <Picture controller={controller} attachment={meta} alt={alt} />;
}

function Picture({ controller, attachment, alt }: { controller: AppController; attachment: AttachmentOut; alt: string }) {
  const { url, failed, onError } = useAttachmentImage(controller, attachment, attachment.has_thumbnail ? "thumbnail" : "content");
  const [open, setOpen] = useState(false);
  if (failed) return <Unavailable attachmentId={attachment.id} alt={alt} />;
  const box = attachment.width && attachment.height ? { aspectRatio: `${attachment.width} / ${attachment.height}` } : undefined;
  return (
    <>
      <button
        type="button"
        data-attachment-id={attachment.id}
        className="my-2 block max-w-full overflow-hidden rounded-lg border border-line bg-panel transition-shadow hover:shadow-md"
        title={`${alt || attachment.filename} — ${t("attach.clickToZoom")}`}
        onClick={() => setOpen(true)}
      >
        {url ? (
          <img src={url} alt={alt || attachment.filename} onError={onError} className="block max-h-[480px] max-w-full object-contain" style={box} />
        ) : (
          <span role="status" aria-label={t("attach.loadingImage")} className="flex h-32 w-48 items-center justify-center text-muted">
            <Loader2 size={18} className="animate-spin" />
          </span>
        )}
      </button>
      {alt && <span className="-mt-1 mb-2 block text-xs text-muted">{alt}</span>}
      {open && <Lightbox attachment={attachment} controller={controller} onClose={() => setOpen(false)} />}
    </>
  );
}

function Unavailable({ attachmentId, alt }: { attachmentId: string; alt: string }) {
  return (
    <span data-attachment-id={attachmentId} className="my-2 inline-flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted">
      <ImageOff size={16} /> {t("canvasImage.unavailable")}{alt ? `: ${alt}` : ""}
    </span>
  );
}
