import { Download, FileText, Loader2, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import { Button, cn } from "./primitives";

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

/** Fetches an attachment image with the bearer token and hands back an object URL (revoked on unmount). */
export function useAttachmentUrl(controller: AppController, attachment: AttachmentOut, kind: "thumbnail" | "content", enabled = true): string | null {
  return useAttachmentImage(controller, attachment, kind, enabled).url;
}

/** Keep failures separate from loading, and ignore responses from a previous image or attempt. */
export function useAttachmentImage(controller: AppController, attachment: AttachmentOut, kind: "thumbnail" | "content", enabled = true) {
  const api = controller.api;
  const [attempt, setAttempt] = useState(0);
  const key = `${attachment.id}/${kind}/${attempt}`;
  const [state, setState] = useState({ key, api, url: null as string | null, failed: false });
  useEffect(() => {
    if (!enabled) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setState({ key, api, url: null, failed: false });
    void (async () => {
      try {
        if (!api) throw new Error("No session");
        const blob = await api.fetchBlob(`/api/v1/attachments/${attachment.id}/${kind}`);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ key, api, url: objectUrl, failed: false });
      } catch {
        if (!cancelled) setState({ key, api, url: null, failed: true });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, api, kind, enabled, key]);
  const current = enabled && state.key === key && state.api === api;
  return {
    url: current ? state.url : null,
    failed: current && state.failed,
    retry: () => setAttempt((value) => value + 1),
    onError: () => setState((value) => value.key === key && value.api === api ? { ...value, url: null, failed: true } : value),
  };
}

function Thumbnail({ attachment, controller }: { attachment: AttachmentOut; controller: AppController }) {
  const { url, failed, retry, onError } = useAttachmentImage(controller, attachment, "thumbnail");
  const [open, setOpen] = useState(false);
  return (
    <>
      {failed ? (
        <div className="flex w-64 flex-col gap-2 rounded-xl border border-line bg-panel p-3 text-sm">
          <span className="truncate" title={attachment.filename}>{attachment.filename}</span>
          <span role="status" className="text-muted">画像を読み込めませんでした</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={retry}>再試行</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>元の画像を開く</Button>
          </div>
        </div>
      ) : <button
        type="button"
        className="overflow-hidden rounded-xl border border-line bg-panel transition-shadow hover:shadow-md"
        title={`${attachment.filename} (${formatSize(attachment.size_bytes)}) — クリックで拡大`}
        onClick={() => setOpen(true)}
      >
        {url ? (
          <img src={url} alt={attachment.filename} onError={onError} className="block max-h-60 max-w-72 object-cover" />
        ) : (
          <span role="status" aria-label="画像を読み込み中" className="flex h-24 w-40 items-center justify-center text-muted">
            <Loader2 size={18} className="animate-spin" />
          </span>
        )}
      </button>}
      {open && <Lightbox attachment={attachment} controller={controller} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Slack-style photo preview: the full image on a dark backdrop, with download and close. */
function Lightbox({ attachment, controller, onClose }: { attachment: AttachmentOut; controller: AppController; onClose: () => void }) {
  const { url, failed, retry, onError } = useAttachmentImage(controller, attachment, "content");
  const [fit, setFit] = useState(true);
  return (
    <Dialog.Root open onOpenChange={(value) => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay fixed inset-0 z-40 bg-black/85" />
        <Dialog.Content className="fixed inset-0 z-50 flex flex-col focus:outline-none" onClick={onClose}>
          <Dialog.Title className="sr-only">{attachment.filename}</Dialog.Title>
          <Dialog.Description className="sr-only">写真のプレビュー</Dialog.Description>
          <div className="flex items-center gap-3 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{attachment.filename}</div>
              <div className="text-xs text-white/70">
                {formatSize(attachment.size_bytes)}
                {attachment.width && attachment.height ? ` · ${attachment.width}×${attachment.height}` : ""}
              </div>
            </div>
            <button type="button" className="rounded-lg p-2 hover:bg-white/15" title="ダウンロード" onClick={() => void controller.downloadAttachment(attachment)}>
              <Download size={18} />
            </button>
            <Dialog.Close asChild>
              <button type="button" className="rounded-lg p-2 hover:bg-white/15" title="閉じる (Esc)">
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>
          <div className={cn("flex min-h-0 flex-1 items-center justify-center overflow-auto p-4", !fit && "block")}>
            {url ? (
              <img
                src={url}
                alt={attachment.filename}
                onError={onError}
                onClick={(e) => { e.stopPropagation(); setFit((v) => !v); }}
                className={cn("select-none", fit ? "max-h-full max-w-full cursor-zoom-in object-contain" : "mx-auto cursor-zoom-out")}
              />
            ) : failed ? (
              <div className="flex flex-col items-center gap-3 text-white" onClick={(e) => e.stopPropagation()}>
                <p role="status">画像を読み込めませんでした</p>
                <button type="button" className="rounded-lg border border-white/50 px-4 py-2 hover:bg-white/15" onClick={retry}>再試行</button>
              </div>
            ) : (
              <Loader2 size={28} className="animate-spin text-white/70" />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
