/**
 * AL2 (docs/ALBUMS.md §7, §18.4): an album on the public page of a share link. The title, the days, the count and the
 * description; the photos as a grid of thumbnails (read as they scroll into view: the browser's lazy images); a photo
 * full screen at the display size (/shares/{token}/items/{id}/display, not counted), ← → and a swipe to the next;
 * videos play from the file. A link that does not hand out the originals (`originals` false, an album's default)
 * saves a photo as its display size (「名前.webp」) and the album as the display-size ZIP, and offers no original
 * at all (the server refuses it: 403 share_originals_disabled). Subfolders above, other files below.
 */
import { ChevronLeft, ChevronRight, Download, File, Folder, Images, Play } from "lucide-react";
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { SharedAlbumOut, SharedItemOut } from "../api/types";
import { albumCount, albumDates, durationLabel, publicSave, swipeStep, webpName } from "../drive/albums";
import { formatBytes } from "../drive/listing";
import { t } from "../i18n";
import { cn } from "../ui/primitives";
import { VIEWER_BUTTON, ViewerBody, ViewerCloseButton, ViewerFrame } from "../ui/ViewerHeader";
import type { ShareApi } from "./api";

export function isMedia(item: SharedItemOut): boolean {
  const type = (item.content_type ?? "").toLowerCase();
  return item.kind === "file" && (type.startsWith("image/") || type.startsWith("video/"));
}

function isVideoItem(item: SharedItemOut): boolean {
  return (item.content_type ?? "").toLowerCase().startsWith("video/");
}

/** Where the public page saves a file from (null: it offers no download). */
export function saveHref(api: ShareApi, item: SharedItemOut, originals: boolean): { href: string; name: string | null } | null {
  const how = publicSave(item, originals);
  if (how === "original") return { href: api.contentUrl(item.id), name: null };
  if (how === "display") return { href: api.displayUrl(item.id), name: webpName(item.name) };
  return null;
}

export function SaveLink({ api, item, originals, className, children }: { api: ShareApi; item: SharedItemOut; originals: boolean; className?: string; children: ReactNode }) {
  const save = saveHref(api, item, originals);
  if (!save) return null;
  return (
    <a href={save.href} download={save.name ?? ""} rel="noreferrer" data-share-save={save.name ? "display" : "original"} aria-label={t("share.downloadOf", { name: save.name ?? item.name })} title={t("share.download")} className={className}>
      {children}
    </a>
  );
}

function Tile({ api, item, onOpen }: { api: ShareApi; item: SharedItemOut; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const picture = (item.has_thumbnail || item.has_poster) && !failed;
  return (
    <li className="relative aspect-square overflow-hidden bg-panel">
      <button type="button" data-share-tile={item.id} aria-label={item.name} title={item.name} onClick={onOpen} className="block h-full w-full hover:opacity-90">
        {picture ? (
          <img src={api.thumbnailUrl(item.id)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center"><Images size={26} className="text-muted" /></span>
        )}
      </button>
      {isVideoItem(item) && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
          <Play size={10} className="fill-white" /> {durationLabel(item.duration_ms)}
        </span>
      )}
    </li>
  );
}

export function ShareAlbumView({ api, album, title, items, originals, zipFolderId, cursor, onMore, onFolder }: {
  api: ShareApi;
  album: SharedAlbumOut;
  title: string;
  /** The folder's items as listed (folders first, then files in the album's order). */
  items: readonly SharedItemOut[];
  originals: boolean;
  /** The folder of the ZIP (null: the link's own). */
  zipFolderId: string | null;
  cursor: string | null;
  onMore: () => void;
  onFolder: (id: string) => void;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const folders = items.filter((item) => item.kind === "folder");
  const media = items.filter(isMedia);
  const others = items.filter((item) => item.kind === "file" && !isMedia(item));
  const dates = albumDates(album);
  // The next page as the end of the grid comes near.
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = end.current;
    if (!element || !cursor || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onMore();
    }, { rootMargin: "600px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [cursor, onMore]);
  return (
    <section data-share-album="" aria-label={title}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold"><Images size={20} className="shrink-0 text-muted" /> <span className="break-words">{title}</span></h1>
          <p data-share-album-summary="" className="mt-1 text-sm text-muted">{[dates, albumCount(album)].filter(Boolean).join(" · ")}</p>
          {album.description && <p className="mt-2 max-w-2xl whitespace-pre-wrap break-words text-sm">{album.description}</p>}
        </div>
        <a href={api.zipUrl(zipFolderId, !originals)} download rel="noreferrer" data-share-album-zip={originals ? "original" : "display"} className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:opacity-90">
          <Download size={15} /> {t("share.downloadZip")}
        </a>
      </div>
      {!originals && <p data-share-display-note="" className="mt-2 text-xs text-muted">{t("albums.public.displayOnly")}</p>}
      {folders.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {folders.map((folder) => (
            <button key={folder.id} type="button" onClick={() => onFolder(folder.id)} className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-ink/6">
              <Folder size={15} className="shrink-0 text-muted" /> <span className="truncate">{folder.name}</span>
            </button>
          ))}
        </div>
      )}
      {media.length === 0 && others.length === 0 && folders.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">{t("albums.emptyTitle")}</p>
      ) : (
        <ul data-share-album-grid="" className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(140px,30%),1fr))] gap-1">
          {media.map((item) => <Tile key={item.id} api={api} item={item} onOpen={() => setViewing(item.id)} />)}
        </ul>
      )}
      <div ref={end} className="h-px" />
      {cursor && (
        <div className="mt-3 flex justify-center">
          <button type="button" className="rounded-lg border border-line px-4 py-1.5 text-sm hover:bg-ink/6" onClick={onMore}>{t("share.more")}</button>
        </div>
      )}
      {others.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">{t("albums.others", { count: others.length })}</h2>
          <ul className="divide-y divide-line/60 rounded-xl border border-line">
            {others.map((item) => (
              <li key={item.id} data-share-other={item.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                <File size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted">{formatBytes(item.size_bytes)}</span>
                <SaveLink api={api} item={item} originals={originals} className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-ink/6"><Download size={15} /></SaveLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      {viewing && <ShareMediaViewer api={api} items={media} startId={viewing} originals={originals} onClose={() => setViewing(null)} />}
    </section>
  );
}

/** A photo or video of the album, full screen (the app's viewer frame). */
export function ShareMediaViewer({ api, items, startId, originals, onClose }: { api: ShareApi; items: readonly SharedItemOut[]; startId: string; originals: boolean; onClose: () => void }) {
  const [id, setId] = useState(startId);
  const index = Math.max(0, items.findIndex((item) => item.id === id));
  const item = items[index];
  const step = (by: -1 | 1) => {
    const next = items[index + by];
    if (next) setId(next.id);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if ((event.target as HTMLElement | null)?.closest?.("video")) return;
      if (event.key === "ArrowLeft") stepRef.current(-1);
      else if (event.key === "ArrowRight") stepRef.current(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The neighbours' display sizes come ahead (the browser's own cache keeps them).
  useEffect(() => {
    for (const near of [items[index + 1], items[index - 1], items[index + 2]]) {
      if (near && near.has_display && !isVideoItem(near)) {
        const image = new Image();
        image.src = api.displayUrl(near.id);
      }
    }
  }, [api, items, index]);
  const start = useRef<{ x: number; y: number } | null>(null);
  if (!item) return null;
  const video = isVideoItem(item);
  // The display size when there is one; else the thumbnail (the original is not handed out, or would count).
  const src = item.has_display ? api.displayUrl(item.id) : originals ? api.contentUrl(item.id, true) : api.thumbnailUrl(item.id);
  return (
    <ViewerFrame
      title={item.name}
      description={t("share.imageViewer")}
      onClose={onClose}
      header={
        <>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{item.name}</p>
            <p className="text-xs text-white/70">{t("albums.viewer.position", { at: index + 1, count: items.length })}</p>
          </div>
          <SaveLink api={api} item={item} originals={originals} className={VIEWER_BUTTON}><Download size={18} /></SaveLink>
          <ViewerCloseButton />
        </>
      }
    >
      <div
        className="relative flex min-h-0 flex-1 touch-pan-y"
        onPointerDown={(event: PointerEvent) => { if (event.pointerType !== "mouse") start.current = { x: event.clientX, y: event.clientY }; }}
        onPointerUp={(event: PointerEvent) => {
          const from = start.current;
          start.current = null;
          if (!from) return;
          const by = swipeStep(event.clientX - from.x, event.clientY - from.y);
          if (by !== 0) step(by);
        }}
      >
        <ViewerBody onClose={onClose} fill>
          {video ? (
            <video key={item.id} src={api.contentUrl(item.id, true)} controls autoPlay playsInline data-share-video="" className="m-auto max-h-full max-w-full rounded-md bg-black object-contain" />
          ) : (
            <img key={item.id} src={src} alt={item.name} data-share-image="" data-share-source={item.has_display ? "display" : originals ? "original" : "thumbnail"} className="m-auto max-h-full max-w-full object-contain" />
          )}
        </ViewerBody>
        {index > 0 && (
          <button type="button" aria-label={t("albums.viewer.previous")} onClick={() => step(-1)} className={cn("absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/70 max-sm:hidden")}><ChevronLeft size={22} /></button>
        )}
        {index < items.length - 1 && (
          <button type="button" aria-label={t("albums.viewer.next")} onClick={() => step(1)} className={cn("absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/70 max-sm:hidden")}><ChevronRight size={22} /></button>
        )}
      </div>
    </ViewerFrame>
  );
}
