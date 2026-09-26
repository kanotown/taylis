import { Download, FileText, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";

export function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Images show their thumbnail (fetched with the bearer token); other files show a download row. */
export function AttachmentList({ attachments, controller }: { attachments: AttachmentOut[]; controller: AppController }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((attachment) =>
        attachment.has_thumbnail ? (
          <Thumbnail key={attachment.id} attachment={attachment} controller={controller} />
        ) : (
          <button
            key={attachment.id}
            type="button"
            className="group flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-left text-sm text-ink hover:border-accent/50 hover:bg-accent-soft/40"
            onClick={() => void controller.downloadAttachment(attachment)}
          >
            <FileText size={18} className="shrink-0 text-muted" />
            <span className="max-w-64 truncate">{attachment.filename}</span>
            <span className="text-xs text-muted">{formatSize(attachment.size_bytes)}</span>
            <Download size={14} className="text-muted opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ),
      )}
    </div>
  );
}

function Thumbnail({ attachment, controller }: { attachment: AttachmentOut; controller: AppController }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void controller.api
      ?.fetchBlob(`/api/v1/attachments/${attachment.id}/thumbnail`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, controller.api]);
  return (
    <button
      type="button"
      className="overflow-hidden rounded-xl border border-line bg-panel transition-shadow hover:shadow-md"
      title={`${attachment.filename} (${formatSize(attachment.size_bytes)})`}
      onClick={() => void controller.downloadAttachment(attachment)}
    >
      {url ? (
        <img src={url} alt={attachment.filename} className="block max-h-60 max-w-72 object-cover" />
      ) : (
        <span className="flex h-24 w-40 items-center justify-center text-muted">
          <Loader2 size={18} className="animate-spin" />
        </span>
      )}
    </button>
  );
}

/** Chips for uploads waiting in the composer. */
export function PendingAttachments({ items, onRemove }: { items: AttachmentOut[]; onRemove: (item: AttachmentOut) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-line bg-accent-soft px-2.5 py-0.5 text-xs text-ink hover:border-danger/50 hover:text-danger"
          onClick={() => onRemove(item)}
          title="取り消す"
        >
          <FileText size={12} />
          <span className="max-w-48 truncate">{item.filename}</span>
          <X size={12} />
        </button>
      ))}
    </div>
  );
}
