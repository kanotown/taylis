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
    <div className="attachments">
      {attachments.map((attachment) =>
        attachment.has_thumbnail ? (
          <Thumbnail key={attachment.id} attachment={attachment} controller={controller} />
        ) : (
          <button key={attachment.id} className="file" onClick={() => void controller.downloadAttachment(attachment)}>
            📄 {attachment.filename} <span className="muted">{formatSize(attachment.size_bytes)}</span>
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
    <button className="thumbnail" title={attachment.filename} onClick={() => void controller.downloadAttachment(attachment)}>
      {url ? <img src={url} alt={attachment.filename} /> : <span className="muted">{attachment.filename}</span>}
    </button>
  );
}

/** Chips for uploads waiting in the composer. */
export function PendingAttachments({ items, onRemove }: { items: AttachmentOut[]; onRemove: (item: AttachmentOut) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="pending-attachments">
      {items.map((item) => (
        <button key={item.id} className="chip" onClick={() => onRemove(item)} title="取り消す">
          {item.filename} ✕
        </button>
      ))}
    </div>
  );
}
