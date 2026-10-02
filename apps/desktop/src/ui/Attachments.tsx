import { Download, FileText, Film, Loader2, Play, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import { fitBox, formatDuration, groupAttachments, hasPoster, loadsInlineVideo, mediaKind, photoBox, photoLayout, VIDEO_TILE_MAX, VIDEO_TILE_PLACEHOLDER } from "./attachmentLayout";
import { scrollParent } from "./LinkPreviewCard";
import { Button, cn } from "./primitives";
import { acquireVideo, knownVideoSize, rememberVideoSize, subscribeVideoSizes } from "./videoSource";

export function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Images show their thumbnail (fetched with the bearer token), videos a tile in their own shape that plays in the
 * viewer (M38), other files a download row. One photo keeps its own shape; two or more are equal squares in a row
 * that wraps only when it is full (M38, as Slack; it was a two-column grid, so a third photo always broke the line).
 * The column is `items-start`: a tile is only as wide as its picture, so a click beside it does nothing (a stretched
 * button made the whole message width open the photo).
 */
export function AttachmentList({ attachments, controller }: { attachments: AttachmentOut[]; controller: AppController }) {
  if (attachments.length === 0) return null;
  const { photos, videos, files } = groupAttachments(attachments);
  return (
    <div data-attachments="" className="mt-1.5 flex flex-col items-start gap-2">
      {photoLayout(photos.length) === "row" ? (
        <div data-photo-grid="" className="flex flex-wrap gap-1.5 self-stretch">
          {photos.map((attachment) => <Thumbnail key={attachment.id} attachment={attachment} controller={controller} square />)}
        </div>
      ) : (
        photos.map((attachment) => <Thumbnail key={attachment.id} attachment={attachment} controller={controller} />)
      )}
      {videos.length > 0 && (
        <div data-video-row="" className="flex max-w-full flex-wrap items-start gap-1.5">
          {videos.map((attachment) => <VideoTile key={attachment.id} attachment={attachment} controller={controller} />)}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex max-w-full flex-wrap gap-2">
          {files.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              className="group flex max-w-full items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-left text-sm text-ink hover:border-accent/50 hover:bg-accent-soft/40"
              onClick={() => void controller.downloadAttachment(attachment)}
            >
              <FileText size={18} className="shrink-0 text-muted" />
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

/**
 * `square`: a tile of the photo row (`photo-tile`: filled, cropped to a square); otherwise the image's own shape up to
 * a cap, and the button is only as large as the image.
 */
function Thumbnail({ attachment, controller, square = false }: { attachment: AttachmentOut; controller: AppController; square?: boolean }) {
  const { url, failed, retry, onError } = useAttachmentImage(controller, attachment, "thumbnail");
  const [open, setOpen] = useState(false);
  // Its final size from the start when the server knows the photo's (attachmentLayout.photoBox).
  const box = square ? null : photoBox(attachment);
  return (
    <>
      {failed ? (
        <div className={cn("flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 text-sm", square ? "photo-tile overflow-hidden" : "w-64 max-w-full")}>
          <span className="truncate" title={attachment.filename}>{attachment.filename}</span>
          <span role="status" className="text-muted">画像を読み込めませんでした</span>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={retry}>再試行</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>元の画像を開く</Button>
          </div>
        </div>
      ) : <button
        type="button"
        className={cn("block max-w-full overflow-hidden rounded-xl border border-line bg-panel transition-shadow hover:shadow-md", square && "photo-tile aspect-square")}
        style={box ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : undefined}
        data-photo-box={box ? `${box.width}x${box.height}` : undefined}
        title={`${attachment.filename} (${formatSize(attachment.size_bytes)}) — クリックで拡大`}
        onClick={() => setOpen(true)}
      >
        {url ? (
          <img src={url} alt={attachment.filename} onError={onError} className={cn("block object-cover", square || box ? "h-full w-full" : "max-h-60 max-w-72")} />
        ) : (
          <span role="status" aria-label="画像を読み込み中" className={cn("flex items-center justify-center text-muted", square || box ? "h-full w-full" : "h-24 w-40")}>
            <Loader2 size={18} className="animate-spin" />
          </span>
        )}
      </button>}
      {open && <Lightbox attachment={attachment} controller={controller} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The dark full-window viewer shared by photos and videos: name, size and shape on top with download and close; a
 * click on the backdrop closes it, Esc too.
 */
function ViewerShell({ attachment, description, shape, controller, onClose, bodyClassName, children }: {
  attachment: AttachmentOut;
  description: string;
  shape?: { width: number; height: number } | null;
  controller: AppController;
  onClose: () => void;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(value) => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay fixed inset-0 z-40 bg-black/85" />
        <Dialog.Content className="fixed inset-0 z-50 flex flex-col focus:outline-none" onClick={onClose}>
          <Dialog.Title className="sr-only">{attachment.filename}</Dialog.Title>
          <Dialog.Description className="sr-only">{description}</Dialog.Description>
          <div className="flex items-center gap-3 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{attachment.filename}</div>
              <div className="text-xs text-white/70">
                {formatSize(attachment.size_bytes)}
                {shape ? ` · ${shape.width}×${shape.height}` : ""}
              </div>
            </div>
            <button type="button" className="rounded-lg p-2 hover:bg-white/15" title="ダウンロード" aria-label="ダウンロード" onClick={() => void controller.downloadAttachment(attachment)}>
              <Download size={18} />
            </button>
            <Dialog.Close asChild>
              <button type="button" className="rounded-lg p-2 hover:bg-white/15" title="閉じる (Esc)" aria-label="閉じる">
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>
          <div className={cn("flex min-h-0 flex-1 items-center justify-center overflow-auto p-4", bodyClassName)}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Slack-style photo preview: the full image on a dark backdrop, with download and close. */
export function Lightbox({ attachment, controller, onClose }: { attachment: AttachmentOut; controller: AppController; onClose: () => void }) {
  const { url, failed, retry, onError } = useAttachmentImage(controller, attachment, "content");
  const [fit, setFit] = useState(true);
  const shape = attachment.width && attachment.height ? { width: attachment.width, height: attachment.height } : null;
  return (
    <ViewerShell attachment={attachment} description="写真のプレビュー" shape={shape} controller={controller} onClose={onClose} bodyClassName={fit ? undefined : "block"}>
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
    </ViewerShell>
  );
}

/**
 * A video's bytes as an object URL, through the same authenticated `fetchBlob` as the photos, shared by its tile and
 * the viewer (videoSource.ts). `enabled` false: nothing is fetched.
 */
export function useVideoSource(controller: AppController, attachment: AttachmentOut, enabled = true) {
  const api = controller.api;
  const [attempt, setAttempt] = useState(0);
  const key = `${attachment.id}/${attempt}`;
  const [state, setState] = useState({ key, api, url: null as string | null, failed: false });
  useEffect(() => {
    if (!enabled) return;
    if (!api) {
      setState({ key, api, url: null, failed: true });
      return;
    }
    setState({ key, api, url: null, failed: false });
    let cancelled = false;
    const handle = acquireVideo(api, attachment.id);
    handle.promise.then(
      (url) => { if (!cancelled) setState({ key, api, url, failed: false }); },
      () => { if (!cancelled) setState({ key, api, url: null, failed: true }); },
    );
    return () => {
      cancelled = true;
      handle.release();
    };
  }, [attachment.id, api, enabled, key]);
  const current = enabled && state.key === key && state.api === api;
  return {
    url: current ? state.url : null,
    failed: current && state.failed,
    retry: () => setAttempt((value) => value + 1),
  };
}

/** The video's shape: what its own file said when it loaded (remembered per attachment), else the server's, if any. */
export function useVideoShape(attachment: AttachmentOut) {
  const subscribe = useCallback((listener: () => void) => subscribeVideoSizes(listener), []);
  const known = useSyncExternalStore(subscribe, () => knownVideoSize(attachment.id));
  if (known) return known;
  return attachment.width && attachment.height ? { width: attachment.width, height: attachment.height } : null;
}

/**
 * A video in a message (M38): a tile in the clip's own shape (a portrait clip stands upright) showing a frame, with a
 * play mark and its length; a click opens the viewer. M79: with the server's size and poster the tile has its final
 * size at once and shows the poster, and the clip is fetched only when opened. Without them, clips up to
 * VIDEO_INLINE_MAX_BYTES are fetched once the row nears the screen (the timeline renders every row it holds) for
 * their first frame; a larger one shows a plain tile until it is opened.
 */
function VideoTile({ attachment, controller }: { attachment: AttachmentOut; controller: AppController }) {
  const probe = useRef<HTMLButtonElement>(null);
  const poster = useAttachmentImage(controller, attachment, "thumbnail", hasPoster(attachment));
  const inline = loadsInlineVideo(attachment, poster.failed);
  const [near, setNear] = useState(false);
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const element = probe.current;
    if (!inline || near || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setNear(true);
    }, { root: scrollParent(element), rootMargin: "100% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [inline, near]);
  const { url, failed } = useVideoSource(controller, attachment, inline && near);
  const shape = useVideoShape(attachment);
  const box = fitBox(shape?.width, shape?.height, VIDEO_TILE_MAX) ?? VIDEO_TILE_PLACEHOLDER;
  const loading = inline && near && !url && !failed;
  return (
    <>
      <button
        ref={probe}
        type="button"
        data-video-tile=""
        data-shape={shape ? (shape.height > shape.width ? "portrait" : "landscape") : "unknown"}
        style={{ width: box.width, aspectRatio: `${box.width} / ${box.height}` }}
        className="group relative block max-w-full overflow-hidden rounded-xl border border-line bg-neutral-900 transition-shadow hover:shadow-md"
        title={`${attachment.filename} (${formatSize(attachment.size_bytes)}) — クリックで再生`}
        aria-label={`${attachment.filename} を再生`}
        onClick={() => setOpen(true)}
      >
        {url && !broken ? (
          <video
            // #t: WebKit paints no first frame for preload="metadata" without it.
            src={`${url}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
            aria-hidden
            onLoadedMetadata={(e) => rememberVideoSize(attachment.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
            onError={() => setBroken(true)}
            className="pointer-events-none block h-full w-full object-cover"
          />
        ) : poster.url ? (
          <img data-video-poster="" src={poster.url} alt="" onError={poster.onError} className="pointer-events-none block h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 pb-8 text-white/80">
            {loading ? <Loader2 size={18} className="animate-spin" aria-label="動画を読み込み中" /> : <Film size={22} />}
            <span className="line-clamp-2 w-full break-all text-center text-xs">{attachment.filename}</span>
          </span>
        )}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white transition-transform group-hover:scale-110">
            <Play size={22} fill="currentColor" className="translate-x-px" />
          </span>
        </span>
        <span data-video-badge="" className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {[formatDuration(attachment.duration_ms), formatSize(attachment.size_bytes)].filter(Boolean).join(" · ")}
        </span>
      </button>
      {open && <VideoViewer attachment={attachment} controller={controller} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The video player (M38): the clip with the platform's controls, in the same viewer as photos, download kept. */
export function VideoViewer({ attachment, controller, onClose }: { attachment: AttachmentOut; controller: AppController; onClose: () => void }) {
  const { url, failed, retry } = useVideoSource(controller, attachment);
  const [unplayable, setUnplayable] = useState(false);
  const shape = useVideoShape(attachment);
  // M79: the server's poster while the clip downloads and until it plays.
  const poster = useAttachmentImage(controller, attachment, "thumbnail", hasPoster(attachment)).url;
  return (
    <ViewerShell attachment={attachment} description="動画のプレビュー" shape={shape} controller={controller} onClose={onClose}>
      {url && !unplayable ? (
        <video
          data-video-player=""
          src={url}
          poster={poster ?? undefined}
          controls
          autoPlay
          playsInline
          onClick={(e) => e.stopPropagation()}
          onLoadedMetadata={(e) => rememberVideoSize(attachment.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
          onError={() => setUnplayable(true)}
          className="max-h-full max-w-full bg-black object-contain"
        />
      ) : unplayable || failed ? (
        <div className="flex flex-col items-center gap-3 text-center text-white" onClick={(e) => e.stopPropagation()}>
          <p role="status">{unplayable ? "この動画はアプリ内で再生できません" : "動画を読み込めませんでした"}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {!unplayable && <button type="button" className="rounded-lg border border-white/50 px-4 py-2 hover:bg-white/15" onClick={retry}>再試行</button>}
            <button type="button" className="rounded-lg border border-white/50 px-4 py-2 hover:bg-white/15" onClick={() => void controller.downloadAttachment(attachment)}>ダウンロード</button>
          </div>
        </div>
      ) : (
        <div role="status" className="flex min-h-0 max-h-full flex-col items-center gap-2 text-sm text-white/70">
          {poster && <img data-video-poster="" src={poster} alt="" className="min-h-0 max-w-full flex-1 object-contain opacity-60" />}
          <Loader2 size={28} className="animate-spin" />
          動画を読み込み中… ({formatSize(attachment.size_bytes)})
        </div>
      )}
    </ViewerShell>
  );
}

/**
 * Uploads waiting in the composer, as Slack and Mattermost show them (testers, 2026-09-29): small square thumbnails
 * with a × to take one out; a click previews a photo or plays a video (the same viewers as in the conversation) or
 * downloads a file. They were chips with the file name, and a click took the file out. `uploading` adds a tile with a
 * spinner for each file still on its way.
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
  const kind = mediaKind(item);
  const image = kind === "photo";
  const video = kind === "video";
  const { url } = useAttachmentImage(controller, item, "thumbnail", image || (video && hasPoster(item)));
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        title={`${item.filename} (${formatSize(item.size_bytes)})${image ? " — クリックで拡大" : video ? " — クリックで再生" : ""}`}
        aria-label={`${item.filename} を${image ? "プレビュー" : video ? "再生" : "ダウンロード"}`}
        className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border border-line bg-panel text-muted hover:border-accent/50"
        onClick={() => (image || video ? setOpen(true) : void controller.downloadAttachment(item))}
      >
        {image && url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : video && url ? (
          <span className="relative block h-full w-full">
            <img data-video-poster="" src={url} alt="" className="h-full w-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center text-white"><Play size={16} fill="currentColor" /></span>
          </span>
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
      {open && (video
        ? <VideoViewer attachment={item} controller={controller} onClose={() => setOpen(false)} />
        : <Lightbox attachment={item} controller={controller} onClose={() => setOpen(false)} />)}
    </div>
  );
}
