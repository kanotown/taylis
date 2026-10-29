/**
 * AL2 (docs/ALBUMS.md §10.3): an album's photos full screen, and its slideshow.
 *
 * The viewer (the app's ViewerFrame): the display size (2048 px WebP; the server answers the original raster image
 * while it has none, and an older server's 404 falls back to the original here), ← → and a swipe to the previous and
 * next photo or video, the two on each side read ahead, a click to zoom (past the display size it reads the original),
 * 「元の画像を開く」, the download, 「表紙にする」 for who may write, and the details (size, type, dimensions, the
 * capture time, 「位置情報あり」, where it is). A HEIC the server cannot read shows its icon and the download.
 *
 * The slideshow: the whole window (the browser's Fullscreen API, the desktop app's window full screen), 3 / 5 / 10
 * seconds a photo, in order or shuffled, Space pauses, ← → step, Esc ends. Videos play muted to their end, 60 seconds
 * at most, unless 「動画を飛ばす」. The next two are read ahead.
 */
import { ChevronLeft, ChevronRight, Download, Image as ImageIcon, ImageUp, Info, MapPin, Pause, Play, Presentation, X } from "lucide-react";
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DriveItemOut } from "../api/types";
import type { AppController } from "../state/app";
import { hasLocation, isVideo, mediaTime, neighbours, type SlideshowSettings, slideDuration, slideshowItems, slideshowOrder, swipeStep, viewerSources } from "../drive/albums";
import { BlobCache } from "../drive/blobCache";
import { ticketUrl } from "../drive/download";
import { asAttachment, exactTime, formatBytes } from "../drive/listing";
import { isTauri, isWeb } from "../platform/env";
import { DriveIcon } from "./DriveBrowser";
import { FileName } from "./FileName";
import { cn } from "./primitives";
import { useTransparentBackdrop } from "./transparency";
import { useMediaSource } from "./useMediaSource";
import { VIEWER_BUTTON, ViewerBody, ViewerCloseButton, ViewerFrame } from "./ViewerHeader";
import { t } from "../i18n";

/** A picture of the viewer: the display size (or the original when asked), from the shared cache. */
function usePicture(cache: BlobCache, item: DriveItemOut, original: boolean): { url: string | null; failed: boolean } {
  const sources = viewerSources(item);
  const [state, setState] = useState<{ key: string; url: string | null; failed: boolean }>({ key: "", url: null, failed: false });
  const wantsOriginal = original && !!sources?.original;
  const key = sources ? `${wantsOriginal ? sources.original : sources.display}` : "";
  useEffect(() => {
    if (!sources) return;
    let cancelled = false;
    setState({ key, url: null, failed: false });
    const fallback = sources.fallback;
    const first = wantsOriginal && sources.original ? sources.original : sources.display;
    cache.get(first).then(
      (url) => { if (!cancelled) setState({ key, url, failed: false }); },
      () => {
        if (cancelled || wantsOriginal) {
          if (!cancelled) setState({ key, url: null, failed: true });
          return;
        }
        // An older server has no /display: the original (a HEIC's thumbnail, §23).
        cache.get(fallback).then(
          (url) => { if (!cancelled) setState({ key, url, failed: false }); },
          () => { if (!cancelled) setState({ key, url: null, failed: true }); },
        );
      },
    );
    return () => {
      cancelled = true;
    };
    // `sources` follows `key` and the item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key, wantsOriginal]);
  return state.key === key ? { url: state.url, failed: state.failed } : { url: null, failed: false };
}

/** Reads the neighbours' display sizes ahead (§6.1). */
function useReadAhead(cache: BlobCache, items: readonly DriveItemOut[], index: number, n = 2): void {
  const ids = neighbours(items, index, n).map((item) => item.id).join(",");
  useEffect(() => {
    for (const item of neighbours(items, index, n)) {
      const sources = viewerSources(item);
      if (sources) cache.warm(sources.display);
    }
    // `ids` names the neighbours.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, ids]);
}

function useCache(controller: AppController): BlobCache | null {
  const api = controller.api;
  const cache = useMemo(() => (api ? new BlobCache(api, 8) : null), [api]);
  useEffect(() => () => cache?.clear(), [cache]);
  return cache;
}

/** A video of the album: streamed on the Web (a download ticket, with Range), its bytes in the desktop app. */
function AlbumVideo({ controller, item, slideshow = false, onEnded }: { controller: AppController; item: DriveItemOut; slideshow?: boolean; onEnded?: () => void }) {
  const attachment = useMemo(() => asAttachment(item), [item]);
  const api = controller.api;
  const stream = useMemo(() => (isWeb() && api ? async () => ticketUrl(api.baseUrl, (await api.driveDownloadTicket(item.id)).url) : undefined), [api, item.id]);
  const { url, failed } = useMediaSource(controller, attachment!, !!attachment, stream);
  if (failed) return <p role="status" className="m-auto text-sm text-white/80">{t("attach.videoFailed")}</p>;
  if (!url) return <span role="status" aria-label={t("common.loading")} className="m-auto h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />;
  return (
    <video
      data-album-video={item.id}
      src={url}
      controls={!slideshow}
      autoPlay
      muted={slideshow}
      playsInline
      onEnded={onEnded}
      className="m-auto min-h-0 min-w-0 max-h-full max-w-full rounded-md bg-black object-contain"
    />
  );
}

/** What cannot be drawn (a HEIC the server could not read, §6.3): its icon, and why. */
function NoPicture({ item, onDownload }: { item: DriveItemOut; onDownload: () => void }) {
  return (
    <div data-album-no-picture="" className="m-auto flex max-w-sm flex-col items-center gap-3 text-center text-white">
      <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-white/10"><DriveIcon item={item} size={40} /></span>
      <p className="text-sm text-white/80">{t("albums.viewer.noPicture")}</p>
      <button type="button" className="rounded-lg border border-white/40 px-4 py-1.5 text-sm hover:bg-white/15" onClick={onDownload}>{t("drive.download")}</button>
    </div>
  );
}

export function AlbumViewer({ controller, items, startId, path, canWrite, coverItemId, onClose, onNeedMore, onSlideshow, onMakeCover }: {
  controller: AppController;
  /** The album's photos and videos as listed (its order). */
  items: readonly DriveItemOut[];
  startId: string;
  /** Where the album is (the details' 「場所」). */
  path: string;
  canWrite: boolean;
  coverItemId: string | null;
  onClose: () => void;
  /** Near the end of what is listed: the next page. */
  onNeedMore?: () => void;
  /** 「スライドショー」 from the photo shown. */
  onSlideshow?: (fromId: string) => void;
  onMakeCover?: (item: DriveItemOut) => void;
}) {
  const cache = useCache(controller);
  const [id, setId] = useState(startId);
  const index = Math.max(0, items.findIndex((item) => item.id === id));
  const item = items[index] ?? items[0];
  const [original, setOriginal] = useState(false);
  const [fit, setFit] = useState(true);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    setOriginal(false);
    setFit(true);
  }, [id]);
  useEffect(() => {
    if (onNeedMore && index >= items.length - 3) onNeedMore();
  }, [index, items.length, onNeedMore]);
  const step = useCallback((by: -1 | 1) => {
    const next = items[index + by];
    if (next) setId(next.id);
  }, [items, index]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, video")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);
  if (!cache || !item) return null;
  // A zoom past the display size reads the original (§10.3).
  const showOriginal = original || !fit;
  const download = () => void controller.downloadDriveFile(item);
  const users = controller.store.users;
  const by = item.created_by ? users.get(item.created_by)?.display_name ?? null : null;
  const line = [exactTime(mediaTime(item)), by].filter(Boolean).join(" · ");
  return (
    <ViewerFrame
      title={item.name}
      description={t("albums.viewer.description")}
      onClose={onClose}
      header={
        <>
          <div className="min-w-0 flex-1 max-sm:basis-full">
            <FileName name={item.name} className="text-sm font-medium" />
            <div className="flex items-center gap-2 text-xs text-white/70">
              <span className="truncate">{line}</span>
              <span className="shrink-0 tabular-nums">{t("albums.viewer.position", { at: index + 1, count: items.length })}</span>
              {hasLocation(item) && <span data-album-location="" className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-white/10 px-1.5 py-px text-[11px]"><MapPin size={11} /> {t("albums.viewer.hasLocation")}</span>}
            </div>
          </div>
          {viewerSources(item)?.original && (
            <button type="button" data-album-original="" aria-pressed={original} className={cn(VIEWER_BUTTON, original && "bg-white/15")} title={t("albums.viewer.original")} aria-label={t("albums.viewer.original")} onClick={() => setOriginal((value) => !value)}>
              <ImageIcon size={18} />
            </button>
          )}
          {onSlideshow && (
            <button type="button" className={VIEWER_BUTTON} title={t("albums.slideshow.start")} aria-label={t("albums.slideshow.start")} onClick={() => onSlideshow(item.id)}>
              <Presentation size={18} />
            </button>
          )}
          {canWrite && onMakeCover && !isVideo(item) && (
            <button type="button" data-album-make-cover="" disabled={coverItemId === item.id} className={VIEWER_BUTTON} title={t("albums.makeCover")} aria-label={t("albums.makeCover")} onClick={() => onMakeCover(item)}>
              <ImageUp size={18} />
            </button>
          )}
          <button type="button" aria-pressed={details} className={cn(VIEWER_BUTTON, details && "bg-white/15")} title={t("drive.details")} aria-label={t("drive.details")} onClick={() => setDetails((value) => !value)}>
            <Info size={18} />
          </button>
          <button type="button" className={VIEWER_BUTTON} title={t("drive.download")} aria-label={t("drive.download")} onClick={download}>
            <Download size={18} />
          </button>
          <ViewerCloseButton />
        </>
      }
    >
      <div className="relative flex min-h-0 flex-1">
        <Stage key={item.id} cache={cache} controller={controller} item={item} original={showOriginal} fit={fit} onToggleFit={() => setFit((value) => !value)} onClose={onClose} onStep={step} onDownload={download} />
        {index > 0 && <StepButton side="left" onClick={() => step(-1)} />}
        {index < items.length - 1 && <StepButton side="right" onClick={() => step(1)} />}
        {details && <Details item={item} path={path} />}
      </div>
      <ReadAhead cache={cache} items={items} index={index} />
    </ViewerFrame>
  );
}

function ReadAhead({ cache, items, index }: { cache: BlobCache; items: readonly DriveItemOut[]; index: number }) {
  useReadAhead(cache, items, index);
  return null;
}

function StepButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const label = side === "left" ? t("albums.viewer.previous") : t("albums.viewer.next");
  return (
    <button
      type="button"
      data-album-step={side}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn("absolute top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/70 max-sm:hidden", side === "left" ? "left-3" : "right-3")}
    >
      {side === "left" ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </button>
  );
}

/** The photo (or video) itself, with the swipe. */
function Stage({ cache, controller, item, original, fit, onToggleFit, onClose, onStep, onDownload }: {
  cache: BlobCache;
  controller: AppController;
  item: DriveItemOut;
  original: boolean;
  fit: boolean;
  onToggleFit: () => void;
  onClose: () => void;
  onStep: (by: -1 | 1) => void;
  onDownload: () => void;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    start.current = { x: event.clientX, y: event.clientY };
    swiped.current = false;
  };
  const onPointerUp = (event: PointerEvent) => {
    const from = start.current;
    start.current = null;
    if (!from || !fit) return;
    const by = swipeStep(event.clientX - from.x, event.clientY - from.y);
    if (by !== 0) {
      swiped.current = true;
      onStep(by);
    }
  };
  const video = isVideo(item);
  const sources = viewerSources(item);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 touch-pan-y" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <ViewerBody onClose={onClose} fill={fit}>
        {video ? (
          <AlbumVideo controller={controller} item={item} />
        ) : sources ? (
          <Picture cache={cache} item={item} original={original} fit={fit} onClick={() => { if (!swiped.current) onToggleFit(); }} />
        ) : (
          <NoPicture item={item} onDownload={onDownload} />
        )}
      </ViewerBody>
    </div>
  );
}

function Picture({ cache, item, original, fit, onClick }: { cache: BlobCache; item: DriveItemOut; original: boolean; fit: boolean; onClick: () => void }) {
  const { url, failed } = usePicture(cache, item, original);
  // While the original comes, the display size stays (no blank between the two).
  const display = usePicture(cache, item, false);
  const shown = url ?? (original ? display.url : null);
  const backdrop = useTransparentBackdrop(shown, item.content_type);
  if (failed && !shown) return <p role="status" className="m-auto text-sm text-white/80">{t("attach.imageFailed")}</p>;
  if (!shown) return <span role="status" aria-label={t("attach.loadingImage")} className="m-auto h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />;
  return (
    <img
      src={shown}
      alt={item.name}
      data-album-picture={original && url ? "original" : "display"}
      data-viewer-content=""
      data-viewer-transparent={backdrop.transparent ? "" : undefined}
      draggable={false}
      onClick={onClick}
      onLoad={backdrop.onLoad}
      style={backdrop.style}
      className={cn("m-auto block select-none rounded-md", fit ? "min-h-0 min-w-0 max-h-full max-w-full cursor-zoom-in object-contain" : "max-w-none cursor-zoom-out")}
    />
  );
}

function Details({ item, path }: { item: DriveItemOut; path: string }) {
  const file = item.file;
  const shape = file?.width && file.height ? `${file.width} × ${file.height}` : null;
  return (
    <aside data-album-details="" aria-label={t("drive.details")} className="w-64 shrink-0 overflow-y-auto border-l border-white/10 p-4 text-[13px] max-sm:absolute max-sm:inset-y-0 max-sm:right-0 max-sm:z-20 max-sm:bg-[#1a1d21]">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-white/60">{t("albums.viewer.taken")}</dt>
        <dd>{file?.taken_at ? exactTime(file.taken_at) : t("albums.viewer.takenUnknown")}</dd>
        <dt className="text-white/60">{t("drive.column.size")}</dt>
        <dd>{formatBytes(item.size_bytes)}</dd>
        <dt className="text-white/60">{t("drive.detail.kind")}</dt>
        <dd className="truncate">{item.content_type ?? "—"}</dd>
        {shape && (
          <>
            <dt className="text-white/60">{t("albums.viewer.dimensions")}</dt>
            <dd className="tabular-nums">{shape}</dd>
          </>
        )}
        {hasLocation(item) && (
          <>
            <dt className="text-white/60">{t("albums.viewer.location")}</dt>
            <dd>{t("albums.viewer.hasLocationNote")}</dd>
          </>
        )}
        <dt className="text-white/60">{t("drive.detail.where")}</dt>
        <dd className="break-words">{path}</dd>
      </dl>
    </aside>
  );
}

// --- the slideshow ---------------------------------------------------------------------------------------------------

async function enterFullscreen(): Promise<"window" | "document" | null> {
  try {
    if (isTauri()) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (await win.isFullscreen()) return null;
      await win.setFullscreen(true);
      return "window";
    }
    if (typeof document !== "undefined" && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      return "document";
    }
  } catch {
    /* not allowed here: the slideshow fills the window instead */
  }
  return null;
}

async function leaveFullscreen(how: "window" | "document" | null): Promise<void> {
  try {
    if (how === "window") {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(false);
    } else if (how === "document" && document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch {
    /* already left */
  }
}

export function Slideshow({ controller, items, startId, settings, onClose }: {
  controller: AppController;
  items: readonly DriveItemOut[];
  startId: string | null;
  settings: SlideshowSettings;
  onClose: () => void;
}) {
  const cache = useCache(controller);
  const slides = useMemo(() => slideshowOrder(slideshowItems(items, settings.skipVideos), settings.random ? "random" : "order", startId), [items, settings.skipVideos, settings.random, startId]);
  const [at, setAt] = useState(0);
  const [paused, setPaused] = useState(false);
  const [chrome, setChrome] = useState(true);
  const slide = slides[at % Math.max(1, slides.length)];
  const next = useCallback(() => setAt((value) => (slides.length ? (value + 1) % slides.length : 0)), [slides.length]);
  const back = useCallback(() => setAt((value) => (slides.length ? (value - 1 + slides.length) % slides.length : 0)), [slides.length]);

  // The whole screen while it runs.
  useEffect(() => {
    let how: "window" | "document" | null = null;
    let gone = false;
    void enterFullscreen().then((entered) => {
      if (gone) void leaveFullscreen(entered);
      else how = entered;
    });
    return () => {
      gone = true;
      void leaveFullscreen(how);
    };
  }, []);

  // A photo stays the interval; a video to its end (its `ended`) or 60 seconds.
  useEffect(() => {
    if (!slide || paused || slides.length <= 1) return;
    const timer = setTimeout(next, slideDuration(slide, settings.interval));
    return () => clearTimeout(timer);
  }, [slide, paused, next, settings.interval, slides.length, at]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === " ") {
        event.preventDefault();
        setPaused((value) => !value);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, onClose]);

  // The controls show while the mouse moves, then step aside.
  useEffect(() => {
    if (!chrome) return;
    const timer = setTimeout(() => setChrome(false), 2500);
    return () => clearTimeout(timer);
  }, [chrome, at]);

  // The next two read ahead.
  const ahead = slides.slice(at + 1, at + 3).concat(at + 3 > slides.length ? slides.slice(0, Math.max(0, at + 3 - slides.length)) : []);
  useEffect(() => {
    if (!cache) return;
    for (const item of ahead) {
      const sources = viewerSources(item);
      if (sources) cache.warm(sources.display);
    }
    // `ahead` follows `at`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, at, slides]);

  if (!cache) return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("albums.slideshow.title")}
      data-album-slideshow={paused ? "paused" : "playing"}
      className={cn("fixed inset-0 z-[70] flex bg-black text-white", !chrome && "cursor-none")}
      onPointerMove={() => setChrome(true)}
    >
      {slide ? (
        isVideo(slide) ? (
          <AlbumVideo key={`${slide.id}:${at}`} controller={controller} item={slide} slideshow onEnded={next} />
        ) : (
          <SlidePicture key={slide.id} cache={cache} item={slide} />
        )
      ) : (
        <p className="m-auto text-sm text-white/70">{t("albums.slideshow.nothing")}</p>
      )}
      <div className={cn("absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-4 transition-opacity", chrome ? "opacity-100" : "pointer-events-none opacity-0")}>
        <button type="button" className={VIEWER_BUTTON} aria-label={t("albums.viewer.previous")} onClick={back}><ChevronLeft size={22} /></button>
        <button type="button" data-slideshow-pause="" className={VIEWER_BUTTON} aria-label={paused ? t("albums.slideshow.play") : t("albums.slideshow.pause")} onClick={() => setPaused((value) => !value)}>
          {paused ? <Play size={22} /> : <Pause size={22} />}
        </button>
        <button type="button" className={VIEWER_BUTTON} aria-label={t("albums.viewer.next")} onClick={next}><ChevronRight size={22} /></button>
        <span className="mx-2 text-xs tabular-nums text-white/70">{slides.length ? `${(at % slides.length) + 1} / ${slides.length}` : ""}</span>
        <button type="button" data-slideshow-close="" className={VIEWER_BUTTON} aria-label={t("albums.slideshow.end")} onClick={onClose}><X size={22} /></button>
      </div>
    </div>,
    document.body,
  );
}

function SlidePicture({ cache, item }: { cache: BlobCache; item: DriveItemOut }) {
  const { url, failed } = usePicture(cache, item, false);
  const backdrop = useTransparentBackdrop(url, item.content_type);
  if (failed) return <p role="status" className="m-auto text-sm text-white/70">{t("attach.imageFailed")}</p>;
  if (!url) return <span role="status" aria-label={t("attach.loadingImage")} className="m-auto h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />;
  return <img src={url} alt={item.name} data-slide={item.id} draggable={false} onLoad={backdrop.onLoad} style={backdrop.style} className="m-auto block max-h-full max-w-full select-none object-contain" />;
}
