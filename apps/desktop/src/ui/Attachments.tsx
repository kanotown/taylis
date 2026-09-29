import { Download, FileText, Film, Loader2, X } from "lucide-react";
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

/**
 * Images show their thumbnail (fetched with the bearer token); other files show a download row. Two or more photos
 * sit in a two-column grid of squares, as on the phones (M16o); a single one keeps its own shape.
 */
export function AttachmentList({ attachments, controller }: { attachments: AttachmentOut[]; controller: AppController }) {
  if (attachments.length === 0) return null;
  const photos = attachments.filter((a) => a.has_thumbnail);
  const files = attachments.filter((a) => !a.has_thumbnail);
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {photos.length > 1 ? (
        <div data-photo-grid="" className="grid max-w-96 grid-cols-2 gap-1.5">
          {photos.map((attachment) => <Thumbnail key={attachment.id} attachment={attachment} controller={controller} square />)}
        </div>
      ) : (
        photos.map((attachment) => <Thumbnail key={attachment.id} attachment={attachment} controller={controller} />)
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              className="group flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-left text-sm text-ink hover:border-accent/50 hover:bg-accent-soft/40"
              onClick={() => void controller.downloadAttachment(attachment)}
            >
              {attachment.content_type.startsWith("video/") ? <Film size={18} className="shrink-0 text-muted" /> : <FileText size={18} className="shrink-0 text-muted" />}
              <span className="max-w-64 truncate">{attachment.filename}</span>
              <span className="text-xs text-muted">{formatSize(attachment.size_bytes)}</span>
              <Download size={14} className="text-muted opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
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

/** `square`: a cell of the photo grid (filled, cropped to a square); otherwise the image's own shape up to a cap. */
function Thumbnail({ attachment, controller, square = false }: { attachment: AttachmentOut; controller: AppController; square?: boolean }) {
  const { url, failed, retry, onError } = useAttachmentImage(controller, attachment, "thumbnail");
  const [open, setOpen] = useState(false);
  return (
    <>
      {failed ? (
        <div className={cn("flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 text-sm", square ? "w-full" : "w-64")}>
          <span className="truncate" title={attachment.filename}>{attachment.filename}</span>
          <span role="status" className="text-muted">画像を読み込めませんでした</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={retry}>再試行</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>元の画像を開く</Button>
          </div>
        </div>
      ) : <button
        type="button"
        className={cn("overflow-hidden rounded-xl border border-line bg-panel transition-shadow hover:shadow-md", square && "aspect-square w-full")}
        title={`${attachment.filename} (${formatSize(attachment.size_bytes)}) — クリックで拡大`}
        onClick={() => setOpen(true)}
      >
        {url ? (
          <img src={url} alt={attachment.filename} onError={onError} className={cn("block object-cover", square ? "h-full w-full" : "max-h-60 max-w-72")} />
        ) : (
          <span role="status" aria-label="画像を読み込み中" className={cn("flex items-center justify-center text-muted", square ? "h-full w-full" : "h-24 w-40")}>
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

/**
 * Uploads waiting in the composer, as Slack and Mattermost show them (testers, 2026-09-29): small square thumbnails
 * with a × to take one out; a click previews a photo (the same lightbox as in the conversation) or downloads a file.
 * They were chips with the file name, and a click took the file out. `uploading` adds a tile with a spinner for each
 * file still on its way.
 */
export function PendingAttachments({ items, uploading = 0, controller, onRemove }: {
  items: AttachmentOut[];
  uploading?: number;
  controller: AppController;
  onRemove: (item: AttachmentOut) => void;
}) {
  if (items.length === 0 && uploading === 0) return null;
  return (
    <div className="flex flex-wrap gap-2.5 px-1 pb-2 pt-1.5">
      {items.map((item) => <PendingTile key={item.id} item={item} controller={controller} onRemove={() => onRemove(item)} />)}
      {Array.from({ length: uploading }, (_, index) => (
        <span key={`uploading-${index}`} role="status" aria-label="アップロード中" className="flex h-16 w-16 items-center justify-center rounded-lg border border-line bg-panel text-muted">
          <Loader2 size={18} className="animate-spin" />
        </span>
      ))}
    </div>
  );
}

function PendingTile({ item, controller, onRemove }: { item: AttachmentOut; controller: AppController; onRemove: () => void }) {
  const image = item.has_thumbnail;
  const { url } = useAttachmentImage(controller, item, "thumbnail", image);
  const [open, setOpen] = useState(false);
  const video = item.content_type.startsWith("video/");
  return (
    <div className="relative">
      <button
        type="button"
        title={`${item.filename} (${formatSize(item.size_bytes)})${image ? " — クリックで拡大" : ""}`}
        aria-label={`${item.filename} を${image ? "プレビュー" : "ダウンロード"}`}
        className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border border-line bg-panel text-muted hover:border-accent/50"
        onClick={() => (image ? setOpen(true) : void controller.downloadAttachment(item))}
      >
        {image && url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : image ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <>
            {video ? <Film size={18} /> : <FileText size={18} />}
            <span className="line-clamp-2 w-full break-all px-1 text-center text-[9px] leading-tight">{item.filename}</span>
          </>
        )}
      </button>
      <button
        type="button"
        aria-label={`${item.filename} を取り消す`}
        title="取り消す"
        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink/80 text-canvas shadow hover:bg-danger"
        onClick={onRemove}
      >
        <X size={12} />
      </button>
      {open && <Lightbox attachment={item} controller={controller} onClose={() => setOpen(false)} />}
    </div>
  );
}
