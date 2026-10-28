/**
 * AL2 (docs/ALBUMS.md §10.2): an album folder on Desktop / Web, in 「ドライブ」 and in a channel's 「ドライブ」 tab.
 *
 * - The header: where it is, the cover, the title (the folder's name), the days (its own, else the photos' range), the
 *   count, the description (three lines, 「もっと見る」), and 「スライドショー」, 「写真を追加」 (files, or
 *   「ドライブから追加」), 「共有」, 「チャンネルに知らせる」, 「すべてダウンロード」 (one ZIP), and ⋯ (the settings, the
 *   order for this look, 「ファイルの一覧で見る」 (remembered on this device), 「アルバムをやめる」).
 * - The grid: GET /drive/albums/{id} 100 at a time as it scrolls, square tiles 3–8 across, a heading per day in the
 *   capture-date order, videos with ▶ and their length. Only the rows in view (and a screen around) are drawn, so a
 *   tile's thumbnail is read only when it comes near. Its subfolders above and its other files below (collapsed) only
 *   when it has some (`folder_count`, `other_count`).
 * - Selecting (the tile's check box, ⌘ / Ctrl / Shift with a click, ⌘A): 「n 枚を選択中」 with download (ZIP), move,
 *   copy, the trash and 「表紙にする」 (one photo).
 * - Files dropped on it are uploaded into it, keeping both on a taken name (「IMG_1234 (1).jpg」).
 * - drive.changed for the folder (and a reconnect) reads it again.
 */
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Download, FilePlus2, Folder, FolderInput, HardDrive, Images, ImageUp, Link2, List, Loader2, MessageSquareShare, MoreHorizontal, Play, Presentation, Settings2, Trash2, Upload, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, describeError } from "../api/errors";
import type { AlbumDetailOut, AlbumOut, DriveItemOut, DriveLocationOut } from "../api/types";
import type { AppController } from "../state/app";
import { albumCount, albumDates, type AlbumOrder, type AlbumSort, dayGroups, durationLabel, isAlbumMedia, isVideo, layoutGrid, notifyDraft, readSlideshowSettings, type SlideshowSettings, SLIDESHOW_INTERVALS, visibleRows, writeSlideshowSettings } from "../drive/albums";
import { canRearrange, itemName, localizedPath } from "../drive/channelFiles";
import { clickSelection, formatBytes, locationName, pathLine, thumbnailPath, viewable, viewerKind } from "../drive/listing";
import { uploadQueueFor, useUploadsDone } from "../drive/session";
import { coalesce } from "../sync/drive";
import { dropEntries, type PickedTree, pickFilesNative, treeFromEntries, treeFromInput } from "../platform/driveFiles";
import { isTauri } from "../platform/env";
import { AddFromDriveDialog, AlbumSettingsDialog } from "./AlbumDialogs";
import { AlbumViewer, Slideshow } from "./AlbumViewer";
import { DriveIcon, useThumbnail } from "./DriveBrowser";
import { SendToConversationDialog } from "./DriveConversation";
import { ImpactDialog, MoveDialog, useImpactCheck } from "./DriveDialogs";
import { ShareLinksDialog } from "./DriveShareDialog";
import { DriveViewer } from "./DriveViewer";
import { DropOverlay, useFileDropZone } from "./FileDropZone";
import { FileName } from "./FileName";
import { Button, cn, IconButton, Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "./primitives";
import { t } from "../i18n";

const PAGE = 100;

interface Loaded {
  detail: AlbumDetailOut | null;
  items: DriveItemOut[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: Loaded = { detail: null, items: [], cursor: null, loading: true, error: null };

/** One tile: the thumbnail (read once its row is drawn), ▶ and the length of a video, the check box. */
function Tile({ controller, item, size, selected, showCheck, onOpen, onCheck }: {
  controller: AppController;
  item: DriveItemOut;
  size: number;
  selected: boolean;
  showCheck: boolean;
  onOpen: (event: ReactMouseEvent) => void;
  onCheck: (event: ReactMouseEvent) => void;
}) {
  const url = useThumbnail(controller, thumbnailPath(item));
  const video = isVideo(item);
  return (
    <div data-album-tile={item.id} aria-selected={selected} className="group/tile relative shrink-0" style={{ width: size, height: size }}>
      <button
        type="button"
        title={item.name}
        aria-label={item.name}
        onClick={onOpen}
        className={cn("block h-full w-full overflow-hidden bg-panel", selected ? "ring-[3px] ring-inset ring-accent" : "hover:opacity-90")}
      >
        {url ? (
          <img src={url} alt="" draggable={false} data-album-thumb="" className={cn("h-full w-full object-cover", selected && "scale-[0.92] rounded-sm")} />
        ) : (
          <span className="flex h-full w-full items-center justify-center"><DriveIcon item={item} size={Math.min(40, size / 3)} /></span>
        )}
      </button>
      {video && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
          <Play size={10} className="fill-white" /> {durationLabel(item.file?.duration_ms)}
        </span>
      )}
      <input
        type="checkbox"
        data-album-check={item.id}
        checked={selected}
        aria-label={t("drive.selectItem", { name: item.name })}
        onClick={(event) => {
          event.stopPropagation();
          onCheck(event);
        }}
        onChange={() => undefined}
        className={cn("absolute left-1.5 top-1.5 h-4 w-4 cursor-pointer accent-[var(--accent)] shadow", selected || showCheck ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover/tile:opacity-100 [@media(hover:none)]:opacity-100")}
      />
    </div>
  );
}

function Cover({ controller, album }: { controller: AppController; album: AlbumOut }) {
  const id = album.cover?.attachment_id ?? null;
  const url = useThumbnail(controller, id ? `/api/v1/attachments/${id}/thumbnail` : null);
  return (
    <span data-album-cover={album.cover?.item_id ?? ""} className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel ring-1 ring-line max-sm:h-16 max-sm:w-16">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <Images size={30} className="text-muted" />}
    </span>
  );
}

export function AlbumView({ controller, location, folderId, onFolder, onShowFiles, onNotAlbum, onLost, header }: {
  controller: AppController;
  location: DriveLocationOut;
  folderId: string;
  onFolder: (folderId: string) => void;
  /** 「ファイルの一覧で見る」. */
  onShowFiles: () => void;
  /** The folder is no longer an album (made a plain folder elsewhere): the listing takes over. */
  onNotAlbum: () => void;
  onLost?: () => void;
  header?: ReactNode;
}) {
  const api = controller.api;
  const engine = controller.engine;
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [override, setOverride] = useState<{ sort: AlbumSort; order: AlbumOrder } | null>(null);
  const [extras, setExtras] = useState<{ folders: DriveItemOut[]; others: DriveItemOut[] } | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [moreText, setMoreText] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [viewingOther, setViewingOther] = useState<DriveItemOut | null>(null);
  const [slides, setSlides] = useState<{ startId: string | null } | null>(null);
  const [slideSettings, setSlideSettings] = useState<SlideshowSettings>(readSlideshowSettings);
  const [dialog, setDialog] = useState<"settings" | "drive" | "share" | "notify" | { kind: "move" | "copy"; items: DriveItemOut[] } | null>(null);
  // Photos added on this screen (「チャンネルに知らせる」 says how many).
  const [added, setAdded] = useState(0);
  const generation = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState({ width: 0, top: 0, height: 800, gridTop: 0 });
  const resize = useRef<ResizeObserver | null>(null);
  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setView({ width: element.clientWidth, top: element.scrollTop, height: element.clientHeight || 800, gridTop: gridRef.current?.offsetTop ?? 0 });
  }, []);
  const measured = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element;
    resize.current?.disconnect();
    resize.current = null;
    if (!element) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    resize.current = new ResizeObserver(measure);
    resize.current.observe(element);
  }, [measure]);

  const detail = loaded.detail;
  const album = detail?.album ?? null;
  const folder = detail?.folder ?? null;
  const canWrite = detail?.can_write ?? false;
  const sort = override?.sort ?? album?.sort ?? "taken";
  const order = override?.order ?? album?.sort_order ?? "asc";

  // --- reading ------------------------------------------------------------------------------------------------------

  const load = useCallback(async (options: { keep?: boolean } = {}) => {
    if (!api) return;
    const run = ++generation.current;
    setLoaded((current) => (options.keep ? { ...current, loading: true } : EMPTY));
    try {
      // A reread keeps as many as were listed (a page of 200 at most each).
      const want = options.keep ? Math.max(PAGE, loaded.items.length) : PAGE;
      let out = await api.driveAlbum(folderId, { sort: override?.sort, order: override?.order, limit: Math.min(200, want) });
      let items = out.items;
      while (out.next_cursor && items.length < want) {
        out = { ...(await api.driveAlbum(folderId, { sort: override?.sort, order: override?.order, cursor: out.next_cursor, limit: 200 })), album: out.album, folder: out.folder };
        if (run !== generation.current) return;
        items = [...items, ...out.items];
      }
      if (run !== generation.current) return;
      setLoaded({ detail: out, items, cursor: out.next_cursor, loading: false, error: null });
    } catch (error) {
      if (run !== generation.current) return;
      if (error instanceof ApiError && error.code === "drive_album_not_found") {
        onNotAlbum();
        return;
      }
      if (error instanceof ApiError && error.code === "drive_item_not_found") {
        if (folderId !== location.root_id) onFolder(location.root_id);
        else onLost?.();
        return;
      }
      setLoaded((current) => ({ ...current, loading: false, error: describeError(error) }));
    }
    // `loaded.items.length` only sizes a reread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, folderId, override?.sort, override?.order, location.root_id]);

  useEffect(() => {
    setSelected(new Set());
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!api || !loaded.cursor || loaded.loading) return;
    const run = generation.current;
    setLoaded((current) => ({ ...current, loading: true }));
    try {
      const out = await api.driveAlbum(folderId, { sort: override?.sort, order: override?.order, cursor: loaded.cursor, limit: PAGE });
      if (run !== generation.current) return;
      setLoaded((current) => {
        const seen = new Set(current.items.map((item) => item.id));
        return { ...current, items: [...current.items, ...out.items.filter((item) => !seen.has(item.id))], cursor: out.next_cursor, loading: false };
      });
    } catch (error) {
      if (run === generation.current) setLoaded((current) => ({ ...current, loading: false, error: describeError(error) }));
    }
  }, [api, folderId, override?.sort, override?.order, loaded.cursor, loaded.loading]);

  // Subfolders and other files, only when there are some (§18.4).
  const folderCount = detail?.folder_count ?? 0;
  const otherCount = detail?.other_count ?? 0;
  const loadExtras = useCallback(async () => {
    if (!api || (folderCount === 0 && otherCount === 0)) {
      setExtras(null);
      return;
    }
    try {
      const found: DriveItemOut[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const out = await api.driveChildren(folderId, { sort: "name", order: "asc", cursor, limit: 200 });
        found.push(...out.items.filter((item) => !isAlbumMedia(item)));
        if (!out.next_cursor || found.length >= folderCount + otherCount) break;
        cursor = out.next_cursor;
      }
      setExtras({ folders: found.filter((item) => item.kind === "folder"), others: found.filter((item) => item.kind === "file") });
    } catch {
      setExtras(null);
    }
  }, [api, folderId, folderCount, otherCount]);
  useEffect(() => {
    void loadExtras();
  }, [loadExtras]);

  // --- live updates -------------------------------------------------------------------------------------------------

  const reload = useRef(coalesce(() => undefined));
  useEffect(() => {
    const again = coalesce(() => {
      void load({ keep: true });
      void loadExtras();
    });
    reload.current = again;
    const unsubscribe = engine?.drive.subscribe((signal) => {
      if (signal.kind === "resync") again.poke();
      else if (signal.kind === "changed" && signal.locationId === location.id && signal.folderIds.includes(folderId)) again.poke();
    });
    return () => {
      again.cancel();
      unsubscribe?.();
    };
  }, [engine, location.id, folderId, load, loadExtras]);
  useUploadsDone(controller.accountKey, useCallback((job) => {
    if (job.target.parentId !== folderId || job.relativeDir) return;
    setAdded((count) => count + 1);
    reload.current.poke();
  }, [folderId]));

  // --- the grid -----------------------------------------------------------------------------------------------------

  const media = loaded.items;
  const groups = useMemo(() => dayGroups(media, sort), [media, sort]);
  const layout = useMemo(() => layoutGrid(groups, view.width), [groups, view.width]);
  const range = visibleRows(layout.rows, view.top - view.gridTop, view.height);
  const order_ = media.map((item) => item.id);
  const chosen = media.filter((item) => selected.has(item.id));
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setView((current) => ({ ...current, top: element.scrollTop, height: element.clientHeight || current.height, gridTop: gridRef.current?.offsetTop ?? current.gridTop }));
    if (element.scrollTop + element.clientHeight > element.scrollHeight - 900) void loadMore();
  };
  // A short first page that does not fill the view: the next one at once.
  useEffect(() => {
    const element = scroller.current;
    if (element && loaded.cursor && !loaded.loading && element.scrollHeight <= element.clientHeight + 200) void loadMore();
  }, [loaded.cursor, loaded.loading, layout.height, loadMore]);
  // The grid's place under the header changes as the header does.
  useEffect(() => {
    measure();
  }, [measure, detail, extras, moreText]);

  const select = (item: DriveItemOut, keys: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, toggle = false) => {
    const next = clickSelection(order_, selected, anchor, item.id, { toggle: toggle || keys.metaKey || keys.ctrlKey, range: keys.shiftKey });
    setSelected(next.selected);
    setAnchor(next.anchor);
  };
  const clickTile = (item: DriveItemOut, event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || selected.size > 0) {
      select(item, event, selected.size > 0 && !event.shiftKey);
      return;
    }
    setViewing(item.id);
  };

  // --- actions ------------------------------------------------------------------------------------------------------

  const impact = useImpactCheck(controller);
  const downloadSelection = () => {
    if (chosen.length === 1) void controller.downloadDriveFile(chosen[0]!);
    else if (chosen.length > 1) void controller.downloadDriveZip(chosen.map((item) => item.id));
  };
  const trash = async (targets: DriveItemOut[]) => {
    if (!api || targets.length === 0 || !canRearrange(targets)) return;
    if (!(await impact.confirm(targets.map((item) => item.id), null))) return;
    try {
      const out = await api.trashDriveItems(targets.map((item) => item.id));
      const failed = out.results.filter((result) => !result.ok);
      if (failed.length > 0) controller.setError(new ApiError(409, failed[0]!.error ?? "unknown", ""));
      const gone = new Set(out.results.filter((result) => result.ok).map((result) => result.id));
      setLoaded((current) => ({ ...current, items: current.items.filter((item) => !gone.has(item.id)) }));
      setSelected(new Set());
      if (gone.size > 0) controller.setNotice(gone.size === 1 ? t("drive.trashedOne") : t("drive.trashedMany", { count: gone.size }));
      reload.current.poke();
    } catch (error) {
      controller.setError(error);
    }
  };
  const makeCover = async (item: DriveItemOut) => {
    if (!api) return;
    try {
      const changed = await api.putDriveAlbum(folderId, { cover_item_id: item.id });
      setLoaded((current) => (current.detail ? { ...current, detail: { ...current.detail, album: changed } } : current));
      controller.setNotice(t("albums.coverSet"));
    } catch (error) {
      controller.setError(error);
    }
  };

  const here = folder && detail ? [pathLine(localizedPath(detail.path, location.kind), locationName(location)), folder.name].filter(Boolean).join(" › ") : locationName(location);
  const upload = (tree: PickedTree | null) => {
    if (!tree || !api || !controller.accountKey) return;
    const files = tree.files.filter((file) => !file.relativeDir);
    if (files.length === 0) return;
    // §9: a name already there keeps both (photos named IMG_1234.jpg come from many people).
    uploadQueueFor(controller.accountKey, api).add(files, { parentId: folderId, locationId: location.id, label: here }, { onConflict: "rename" });
  };
  const pickFiles = () => (isTauri() ? void pickFilesNative().then(upload, (error) => controller.setError(error)) : filesInput.current?.click());
  const blocked = !canWrite ? t("drive.readOnly") : null;
  const zone = useFileDropZone({
    enabled: true,
    blocked,
    onFiles: () => undefined,
    onData: (data) => {
      const entries = dropEntries(data);
      const files = Array.from(data.files ?? []);
      void (entries ? treeFromEntries(entries) : Promise.resolve(treeFromInput(files))).then(upload, (error) => controller.setError(error));
    },
  });

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.target as HTMLElement).closest("input, textarea")) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Set(order_));
    } else if (event.key === "Escape" && selected.size > 0) {
      event.stopPropagation();
      setSelected(new Set());
    } else if ((event.key === "Delete" || (event.key === "Backspace" && mod)) && chosen.length > 0 && canWrite) {
      event.preventDefault();
      void trash(chosen);
    }
  };

  const changeSettings = (next: SlideshowSettings) => {
    setSlideSettings(next);
    writeSlideshowSettings(next);
  };

  // --- drawing ------------------------------------------------------------------------------------------------------

  if (!detail || !album || !folder) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-album-view="loading">
        {header && <div className="flex h-12 items-center px-3">{header}</div>}
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          {loaded.error ? (
            <div className="flex flex-col items-center gap-2"><p role="alert">{loaded.error}</p><Button size="sm" variant="secondary" onClick={() => void load()}>{t("common.retry")}</Button></div>
          ) : <Loader2 size={18} className="animate-spin" />}
        </div>
      </div>
    );
  }

  const crumbs = localizedPath(detail.path, location.kind);
  const dates = albumDates(album);
  const shareable = !!folder.parent_id && (location.can_share || folder.link_count > 0);
  const viewItems = media;
  const actions = chosen.length > 0 ? (
    <div data-album-selection-bar="" role="toolbar" aria-label={t("albums.selected", { count: chosen.length })} className="flex min-h-10 flex-wrap items-center gap-1">
      <IconButton label={t("drive.clearSelection")} onClick={() => setSelected(new Set())}><X size={16} /></IconButton>
      <strong className="mr-2 text-[13.5px]">{t("albums.selected", { count: chosen.length })}</strong>
      <Button size="sm" variant="secondary" onClick={downloadSelection}><Download size={14} /> {chosen.length > 1 ? t("drive.downloadZip") : t("drive.download")}</Button>
      {canWrite && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "move", items: chosen })}><FolderInput size={14} /> {t("drive.move")}</Button>}
      <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "copy", items: chosen })}><Copy size={14} /> {t("drive.copy")}</Button>
      {canWrite && chosen.length === 1 && !isVideo(chosen[0]!) && <Button size="sm" variant="ghost" data-album-cover-selected="" onClick={() => void makeCover(chosen[0]!)}><ImageUp size={14} /> {t("albums.makeCover")}</Button>}
      {canWrite && <Button size="sm" variant="ghost" className="text-danger" onClick={() => void trash(chosen)}><Trash2 size={14} /> {t("drive.toTrash")}</Button>}
    </div>
  ) : (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5">
      <div className="flex">
        <Button size="sm" data-album-slideshow-start="" disabled={media.length === 0} onClick={() => setSlides({ startId: null })} className="rounded-r-none"><Presentation size={14} /> {t("albums.slideshow.start")}</Button>
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" aria-label={t("albums.slideshow.settings")} className="rounded-l-none border-l border-white/25 px-1.5"><ChevronDown size={13} /></Button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuLabel>{t("albums.slideshow.interval")}</MenuLabel>
            <MenuRadioGroup value={String(slideSettings.interval)} onValueChange={(value) => changeSettings({ ...slideSettings, interval: Number(value) as SlideshowSettings["interval"] })}>
              {SLIDESHOW_INTERVALS.map((seconds) => <MenuRadioItem key={seconds} value={String(seconds)}>{t("albums.slideshow.seconds", { count: seconds })}</MenuRadioItem>)}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuCheckboxItem checked={slideSettings.random} onCheckedChange={(on) => changeSettings({ ...slideSettings, random: on === true })}>{t("albums.slideshow.random")}</MenuCheckboxItem>
            <MenuCheckboxItem checked={slideSettings.skipVideos} onCheckedChange={(on) => changeSettings({ ...slideSettings, skipVideos: on === true })}>{t("albums.slideshow.skipVideos")}</MenuCheckboxItem>
          </MenuContent>
        </Menu>
      </div>
      {canWrite && (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="secondary" data-album-add=""><Upload size={14} /> {t("albums.addPhotos")} <ChevronDown size={13} className="-mr-0.5 opacity-70" /></Button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem onSelect={pickFiles}><FilePlus2 size={14} /> {t("albums.add.files")}</MenuItem>
            <MenuItem onSelect={() => setDialog("drive")}><HardDrive size={14} /> {t("albums.add.fromDrive")}</MenuItem>
          </MenuContent>
        </Menu>
      )}
      {shareable && <Button size="sm" variant="ghost" onClick={() => setDialog("share")}><Link2 size={14} /> {t("albums.share")}</Button>}
      <Button size="sm" variant="ghost" data-album-notify="" onClick={() => setDialog("notify")}><MessageSquareShare size={14} /> {t("albums.notify.button")}</Button>
      <Button size="sm" variant="ghost" onClick={() => void controller.downloadDriveZip([folder.id])}><Download size={14} /> {t("albums.downloadAll")}</Button>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={t("drive.more")} data-album-more=""><MoreHorizontal size={16} /></IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          {canWrite && <MenuItem onSelect={() => setDialog("settings")}><Settings2 size={14} /> {t("albums.settings.open")}</MenuItem>}
          <MenuLabel>{t("albums.sort")}</MenuLabel>
          <MenuRadioGroup value={sort} onValueChange={(value) => setOverride({ sort: value as AlbumSort, order })}>
            <MenuRadioItem value="taken">{t("albums.sort.taken")}</MenuRadioItem>
            <MenuRadioItem value="name">{t("albums.sort.name")}</MenuRadioItem>
            <MenuRadioItem value="added">{t("albums.sort.added")}</MenuRadioItem>
          </MenuRadioGroup>
          <MenuItem onSelect={() => setOverride({ sort, order: order === "asc" ? "desc" : "asc" })}>
            {order === "asc" ? <ArrowDown size={14} /> : <ArrowUp size={14} />} {order === "asc" ? t("albums.order.desc") : t("albums.order.asc")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem data-album-as-files="" onSelect={onShowFiles}><List size={14} /> {t("albums.asFiles")}</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-album-view={folder.id}>
      <div
        ref={measured}
        data-scroll-memory=""
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none"
        data-drop-zone="drive"
        {...zone.handlers}
      >
        <header className="border-b border-line px-4 pb-3 pt-2">
          <div className="flex min-h-9 items-center gap-1">
            {header}
            <nav aria-label={t("drive.breadcrumbs")} className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-[13px] text-muted">
              {crumbs.map((crumb, index) => (
                <span key={crumb.id} className="flex min-w-0 items-center gap-0.5">
                  {index > 0 && <ChevronRight size={13} className="shrink-0" />}
                  <button type="button" data-album-crumb={crumb.id} className="truncate rounded px-1 py-0.5 hover:bg-ink/6 hover:text-ink" onClick={() => onFolder(crumb.id)}>
                    {index === 0 ? locationName(location) : crumb.name}
                  </button>
                </span>
              ))}
            </nav>
          </div>
          <div className="mt-1 flex items-start gap-4">
            <Cover controller={controller} album={album} />
            <div className="min-w-0 flex-1">
              <h1 className="flex items-center gap-2 break-words text-[20px] font-semibold leading-tight"><Images size={18} className="shrink-0 text-muted" aria-hidden /> {folder.name}</h1>
              <p data-album-summary="" className="mt-1 text-[13px] text-muted">{[dates, albumCount(album)].filter(Boolean).join(" · ")}</p>
              {album.description && (
                <div className="mt-1.5 max-w-3xl text-[13.5px]">
                  <p data-album-description="" className={cn("whitespace-pre-wrap break-words", !moreText && "line-clamp-3")}>{album.description}</p>
                  {(album.description.split("\n").length > 3 || album.description.length > 180) && (
                    <button type="button" className="mt-0.5 text-xs text-accent hover:underline" onClick={() => setMoreText((value) => !value)}>{moreText ? t("albums.less") : t("albums.more")}</button>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="mt-3">{actions}</div>
        </header>
        {detail.shared_above > 0 && (
          <p className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[12.5px] text-muted"><Link2 size={13} className="shrink-0 text-accent" /> {t("drive.share.banner")}</p>
        )}
        {extras && extras.folders.length > 0 && (
          <div data-album-folders="" className="flex flex-wrap gap-2 px-4 pt-3">
            {extras.folders.map((sub) => (
              <button key={sub.id} type="button" onClick={() => onFolder(sub.id)} className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-ink/6">
                {sub.album ? <Images size={15} className="shrink-0 text-muted" /> : <Folder size={15} className="shrink-0 text-muted" />}
                <span className="truncate">{itemName(sub)}</span>
              </button>
            ))}
          </div>
        )}
        {media.length === 0 && !loaded.loading ? (
          <div data-album-empty="" className="flex flex-col items-center justify-center gap-3 p-10 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-panel"><Images size={28} className="text-muted" /></span>
            <strong className="text-[15px]">{t("albums.emptyTitle")}</strong>
            <span className="max-w-sm text-sm text-muted">{canWrite ? t("albums.emptyHint") : t("drive.emptyReadOnly")}</span>
            {canWrite && <Button size="sm" onClick={pickFiles}><Upload size={14} /> {t("albums.add.files")}</Button>}
          </div>
        ) : (
          <div ref={gridRef} data-album-grid="" data-columns={layout.columns} className="relative" style={{ height: layout.height }}>
            {layout.rows.slice(range.from, range.to).map((row) =>
              row.kind === "heading" ? (
                <h2 key={row.key} data-album-day="" className="absolute inset-x-0 flex items-end px-4 pb-1.5 text-[13px] font-semibold" style={{ top: row.top, height: row.height }}>{row.label}</h2>
              ) : (
                <div key={row.key} data-album-row="" className="absolute inset-x-0 flex gap-1 px-4" style={{ top: row.top, height: row.height }}>
                  {row.items.map((item) => (
                    <Tile
                      key={item.id}
                      controller={controller}
                      item={item}
                      size={layout.tile}
                      selected={selected.has(item.id)}
                      showCheck={selected.size > 0}
                      onOpen={(event) => clickTile(item, event)}
                      onCheck={(event) => select(item, event, true)}
                    />
                  ))}
                </div>
              ),
            )}
          </div>
        )}
        {loaded.loading && media.length > 0 && <div className="flex justify-center py-4 text-muted"><Loader2 size={18} className="animate-spin" /></div>}
        {loaded.error && media.length > 0 && <p role="alert" className="px-4 py-2 text-sm text-danger">{loaded.error}</p>}
        {extras && extras.others.length > 0 && (
          <section data-album-others="" className="border-t border-line px-4 py-3">
            <button type="button" aria-expanded={othersOpen} onClick={() => setOthersOpen((value) => !value)} className="flex items-center gap-1 text-[13px] font-semibold">
              {othersOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {t("albums.others", { count: extras.others.length })}
            </button>
            {othersOpen && (
              <ul className="mt-2 space-y-0.5">
                {extras.others.map((file) => (
                  <li key={file.id}>
                    <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink/6" onClick={() => (viewerKind(file) ? setViewingOther(file) : void controller.downloadDriveFile(file))}>
                      <DriveIcon item={file} size={16} />
                      <FileName name={file.name} className="min-w-0 flex-1" />
                      <span className="shrink-0 text-xs text-muted">{formatBytes(file.size_bytes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <DropOverlay active={zone.active} blocked={blocked} destination={t("drive.dropTo", { path: here })} />
      </div>
      <input ref={filesInput} type="file" accept="image/*,video/*" multiple hidden onChange={(event) => { upload(treeFromInput(Array.from(event.target.files ?? []))); event.target.value = ""; }} />
      {viewing && (
        <AlbumViewer
          controller={controller}
          items={viewItems}
          startId={viewing}
          path={here}
          canWrite={canWrite}
          coverItemId={album.cover?.item_id ?? null}
          onClose={() => setViewing(null)}
          onNeedMore={loaded.cursor ? () => void loadMore() : undefined}
          onSlideshow={(fromId) => {
            setViewing(null);
            setSlides({ startId: fromId });
          }}
          onMakeCover={(item) => void makeCover(item)}
        />
      )}
      {slides && <Slideshow controller={controller} items={viewItems} startId={slides.startId} settings={slideSettings} onClose={() => setSlides(null)} />}
      {viewingOther && <DriveViewer controller={controller} item={viewingOther} siblings={viewable(extras?.others ?? [])} onStep={setViewingOther} onClose={() => setViewingOther(null)} />}
      {dialog === "settings" && (
        <AlbumSettingsDialog
          controller={controller}
          folder={folder}
          album={album}
          photos={media}
          onClose={() => setDialog(null)}
          onSaved={(changed) => {
            setOverride(null);
            setLoaded((current) => (current.detail ? { ...current, detail: { ...current.detail, album: changed } } : current));
            reload.current.poke();
          }}
          onRemoved={onNotAlbum}
        />
      )}
      {dialog === "drive" && <AddFromDriveDialog controller={controller} album={folder} onClose={() => setDialog(null)} onAdded={(count) => { setAdded((held) => held + count); reload.current.poke(); }} />}
      {dialog === "share" && <ShareLinksDialog controller={controller} item={{ ...folder, album }} onClose={() => setDialog(null)} onChanged={() => reload.current.poke()} />}
      {dialog === "notify" && (
        <SendToConversationDialog
          controller={controller}
          item={folder}
          title={t("albums.notify.title", { name: folder.name })}
          description={added > 0 ? t("albums.notify.descriptionAdded", { count: added }) : t("albums.notify.description")}
          compose={(current, url) => notifyDraft(current, url, added)}
          onClose={() => setDialog(null)}
        />
      )}
      {typeof dialog === "object" && dialog !== null && (
        <MoveDialog
          controller={controller}
          mode={dialog.kind}
          items={dialog.items}
          startLocation={location}
          startFolderId={folderId}
          onClose={() => setDialog(null)}
          onMoved={(_target, failed) => {
            if (failed > 0) controller.setError(t(dialog.kind === "copy" ? "drive.someNotCopied" : "drive.someNotMoved", { count: failed }));
            else if (dialog.kind === "copy") controller.setNotice(t("drive.copied", { count: dialog.items.length }));
            setSelected(new Set());
            reload.current.poke();
          }}
        />
      )}
      {impact.asking && <ImpactDialog controller={controller} asking={impact.asking} />}
    </div>
  );
}
