/**
 * One drive location's folders (M161, docs/DRIVE.md §17.2), used by 「ドライブ」 and by a channel's 「ドライブ」 tab:
 *
 * - The bar: breadcrumbs (a crumb takes dropped items: moved there), the search of this location, 「新しいフォルダ」,
 *   「アップロード」 (files / a folder), sort, list or grid (remembered on this device), the trash, the details pane.
 * - The listing reads 100 items a page by cursor as it scrolls (folders first, then by name, time or size), lists them
 *   (icon or thumbnail, name, time, who changed it, size; the less needed columns give way as the listing narrows) or
 *   tiles them (thumbnails). §27: a click opens — a folder (into it), a photo, a video, a PDF or an Office file (the
 *   app's viewers), anything else (its details; only 「ダウンロード」 downloads) — and ⌘ / Ctrl, Shift or the
 *   row's check box only select; ↑ ↓ Enter, Space (preview), F2 (rename), Delete (trash), ⌘A, ⌘X then ⌘V (move),
 *   ⌘C then ⌘V (copy, M162). A right-click or the row's ⋯ opens its menu: download (a folder or several items as one
 *   ZIP, M162), rename, move, copy, the version history (M162), the trash.
 * - Files and folders dragged from the desktop drop onto the listing (into this folder) or onto a folder row (into it);
 *   rows dragged onto a folder or a crumb move there.
 * - The trash: what was put there together, restored as a whole (to where it was, else the top) or deleted for good by
 *   who may (§3.2).
 * - drive.changed for this folder reads it again (several within 300 ms once); a reconnect reads it again too.
 */
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Download, File, FileArchive, FileAudio, FileImage, FilePlus2, FileSpreadsheet, FileText, FileVideo, Folder, FolderInput, FolderOpen, Hash, HardDrive, User, FolderPlus, FolderUp, History, Images, Info, LayoutGrid, Link as LinkIcon, Link2, List, Loader2, MessageSquareShare, MoreHorizontal, Pencil, Presentation, RotateCcw, Search, Trash2, Upload, X } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { type DragEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, describeError } from "../api/errors";
import type { DriveCrumb, DriveItemOut, DriveLocationOut, DriveSearchHitOut, DriveTrashEntryOut } from "../api/types";
import type { AppController } from "../state/app";
import { appendPage, breadcrumbs, clickAction, clickSelection, type DriveIconKind, driveColumns, type DriveOrder, type DriveSort, type DriveViewMode, driveTime, exactTime, formatBytes, iconKind, itemTime, locationName, nextSort, pathLine, readViewMode, sortLabel, thumbnailPath, viewable, viewerKind, writeViewMode } from "../drive/listing";
import { openPage } from "../drive/snippet";
import { afterPaste, type DriveClipboard, downloadPlan, pasteAction } from "../drive/actions";
import { canRearrange, isSystemFolder, itemName, localizedPath, rememberSystemFolders } from "../drive/channelFiles";
import { uploadQueueFor, useUploadsDone } from "../drive/session";
import { canBecomeAlbum, readAlbumAsFiles, writeAlbumAsFiles } from "../drive/albums";
import { NewAlbumDialog } from "./AlbumDialogs";
import { AlbumView } from "./AlbumView";
import { coalesce } from "../sync/drive";
import { dropEntries, emptyFolders, type PickedTree, pickFilesNative, pickFolderNative, treeFromEntries, treeFromInput } from "../platform/driveFiles";
import { isFileDrag } from "../platform/fileDrops";
import { isTauri } from "../platform/env";
import { DeleteForeverDialog, ImpactDialog, MoveDialog, NewFolderDialog, RenameDialog, useImpactCheck } from "./DriveDialogs";
import { PostedMark, PostsSection, SystemFolderIcon } from "./ChannelFiles";
import { onDriveTarget, takeDriveSelection } from "./DriveSearch";
import { SendToConversationDialog } from "./DriveConversation";
import { driveLink } from "./permalink";
import { DriveSnippet } from "./DriveSnippet";
import { DriveViewer } from "./DriveViewer";
import { VersionsDialog } from "./DriveVersions";
import { SharedMark, ShareLinksDialog } from "./DriveShareDialog";
import { DropOverlay, useFileDropZone } from "./FileDropZone";
import { FileName } from "./FileName";
import { sinceLabel } from "./format";
import { Button, cn, IconButton, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, modKey } from "./primitives";
import { t } from "../i18n";

const PAGE = 100;
/** The details pane's width (w-72), and the listing width below which it lies over the listing instead (§27). */
const DETAILS_WIDTH = 288;
const DETAILS_BESIDE_MIN = 640;
const ROW_DRAG = "application/x-taylis-drive-items";
const MENU_CONTENT = "rx-popover z-50 min-w-48 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const MENU_ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

/** Items cut with ⌘X (moved by ⌘V) or copied with ⌘C (copied by ⌘V) into the open folder: one per window. */
let clipboard: DriveClipboard | null = null;

function newOpId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

const ICONS: Readonly<Record<DriveIconKind, typeof File>> = {
  folder: Folder, image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, document: FileText, sheet: FileSpreadsheet, slides: Presentation, archive: FileArchive, text: FileText, file: File,
};

/**
 * §27: one colour per kind of file, the same in the list, the grid, the details, the trash and the search (as Box,
 * Dropbox and Nextcloud do): folders in the app's warm brown, PDF red, Word blue, Excel green, PowerPoint orange,
 * photos violet, videos rose, sounds teal, archives umber, the rest grey.
 */
export const ICON_COLOURS: Readonly<Record<DriveIconKind, string>> = {
  folder: "text-[#b7791f] fill-[#b7791f]/20",
  pdf: "text-[#d14b3d]",
  document: "text-[#2f6fd6]",
  sheet: "text-[#1f8a4c]",
  slides: "text-[#d9731a]",
  image: "text-[#8b5cf6]",
  video: "text-[#d6457a]",
  audio: "text-[#0f8f8f]",
  archive: "text-[#8a6d3b]",
  text: "text-muted",
  file: "text-muted",
};

export function DriveIcon({ item, size = 18 }: { item: Pick<DriveItemOut, "kind" | "name" | "content_type"> & { system_role?: DriveItemOut["system_role"]; album?: DriveItemOut["album"] }; size?: number }) {
  // CF2 (docs/CHANNEL_FILES.md §12.2): 「投稿のファイル」 has its own icon (a folder with a speech bubble).
  if (isSystemFolder(item)) return <SystemFolderIcon size={size} className={ICON_COLOURS.folder} />;
  // AL2 (docs/ALBUMS.md §10.1): an album folder shows photos.
  if (item.kind === "folder" && item.album) return <Images size={size} data-drive-icon="album" className={cn("shrink-0", ICON_COLOURS.folder)} aria-hidden />;
  const kind = iconKind(item);
  const Icon = ICONS[kind];
  return <Icon size={size} data-drive-icon={kind} className={cn("shrink-0", ICON_COLOURS[kind])} aria-hidden />;
}

function LocationGlyph({ kind }: { kind: DriveLocationOut["kind"] }) {
  const Icon = kind === "workspace" ? HardDrive : kind === "user" ? User : Hash;
  return <Icon size={14} className="shrink-0 text-muted" aria-hidden />;
}

/** A thumbnail fetched with the bearer token (an object URL, revoked when gone); null while none. */
export function useThumbnail(controller: AppController, path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const api = controller.api;
    if (!path || !api) {
      setUrl(null);
      return;
    }
    let made: string | null = null;
    let cancelled = false;
    void api.fetchBlob(path).then(
      (blob) => {
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [controller.api, path]);
  return url;
}

function Thumb({ controller, item, className, iconSize = 18 }: { controller: AppController; item: DriveItemOut; className?: string; iconSize?: number }) {
  const url = useThumbnail(controller, thumbnailPath(item));
  return url ? <img src={url} alt="" draggable={false} className={cn("object-cover", className)} /> : <span className={cn("flex items-center justify-center", className)}><DriveIcon item={item} size={iconSize} /></span>;
}

/** A list row's picture (§27): a photo's or a video's thumbnail, else the kind's icon (a page shrunk to 32 px says nothing). */
function RowIcon({ controller, item }: { controller: AppController; item: DriveItemOut }) {
  const kind = iconKind(item);
  const media = kind === "image" || kind === "video";
  const url = useThumbnail(controller, media ? thumbnailPath(item) : null);
  if (url) return <img src={url} alt="" draggable={false} className="h-8 w-8 shrink-0 rounded-md object-cover ring-1 ring-line" />;
  return <span className="flex h-8 w-8 shrink-0 items-center justify-center"><DriveIcon item={item} size={22} /></span>;
}

/** A tile's picture (§27): photos fill it, a document's first page sits on paper, anything else is a large icon. */
function TileThumb({ controller, item }: { controller: AppController; item: DriveItemOut }) {
  const url = useThumbnail(controller, thumbnailPath(item));
  const kind = iconKind(item);
  return (
    <span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-panel">
      {url ? (
        kind === "image" || kind === "video" ? (
          <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <img src={url} alt="" draggable={false} className="mt-4 h-full w-[78%] rounded-t-sm bg-white object-cover object-top shadow-sm ring-1 ring-line" />
        )
      ) : (
        <DriveIcon item={item} size={44} />
      )}
    </span>
  );
}

interface Listing {
  folder: DriveItemOut | null;
  path: DriveCrumb[];
  items: DriveItemOut[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
  /** M163: external links on the open folder or a folder above it (what is put here is shared outside). */
  sharedAbove: number;
}

const EMPTY_LISTING: Listing = { folder: null, path: [], items: [], cursor: null, loading: true, error: null, sharedAbove: 0 };

export type DriveMode = "folder" | "trash";

export function DriveBrowser({ controller, location, folderId, onFolder, mode = "folder", onMode, onLost, header, locations }: {
  controller: AppController;
  location: DriveLocationOut;
  folderId: string;
  onFolder: (folderId: string) => void;
  mode?: DriveMode;
  onMode?: (mode: DriveMode) => void;
  /** The folder and the location's root are gone or unreadable (left the channel): the caller picks another place. */
  onLost?: () => void;
  /** Drawn before the breadcrumbs (a narrow layout's back button). */
  header?: ReactNode;
  /** §27: the locations the root crumb's ▾ offers (「ドライブ」 only; not a channel's tab). */
  locations?: { list: readonly DriveLocationOut[]; onChoose: (location: DriveLocationOut) => void };
}) {
  const api = controller.api;
  const engine = controller.engine;
  const [listing, setListing] = useState<Listing>(EMPTY_LISTING);
  const [sort, setSort] = useState<{ sort: DriveSort; order: DriveOrder }>({ sort: "name", order: "asc" });
  const [view, setView] = useState<DriveViewMode>(readViewMode);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DriveSearchHitOut[] | null>(null);
  const [details, setDetails] = useState(false);
  // AL2 (docs/ALBUMS.md §10.1): an album folder opens as the album unless 「ファイルの一覧で見る」 (this device).
  const [asFiles, setAsFiles] = useState(readAlbumAsFiles);
  const showFiles = (value: boolean) => {
    setAsFiles(value);
    writeAlbumAsFiles(value);
  };
  const [dialog, setDialog] = useState<{ kind: "new-folder" } | { kind: "new-album" } | { kind: "rename"; item: DriveItemOut } | { kind: "move" | "copy"; items: DriveItemOut[] } | { kind: "versions"; item: DriveItemOut } | { kind: "share"; item: DriveItemOut } | { kind: "send"; item: DriveItemOut } | null>(null);
  const [viewing, setViewing] = useState<DriveItemOut | null>(null);
  // §29: the page a document found by its text opens at (stepping to another file starts at its top).
  const [openAt, setOpenAt] = useState<{ id: string; page: number } | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // §27: the listing's own width decides the list's columns (the window's would not: the rail, the sidebar and the
  // locations column take part of it).
  const [width, setWidth] = useState(0);
  const resize = useRef<ResizeObserver | null>(null);
  const measured = useCallback((element: HTMLDivElement | null) => {
    resize.current?.disconnect();
    resize.current = null;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    resize.current = new ResizeObserver(measure);
    resize.current.observe(element);
  }, []);
  const generation = useRef(0);
  const canWrite = location.can_write;

  // --- reading ----------------------------------------------------------------------------------------------------

  const load = useCallback(async (options: { keep?: boolean } = {}) => {
    if (!api || mode !== "folder") return;
    const run = ++generation.current;
    setListing((current) => (options.keep ? { ...current, loading: true } : { ...EMPTY_LISTING }));
    // Another folder starts at its top (back / forward puts a folder back where it was: MainScreen's scroll memory).
    if (!options.keep && listRef.current) listRef.current.scrollTop = 0;
    try {
      const held = options.keep ? listing.items.length : 0;
      const out = await api.driveChildren(folderId, { sort: sort.sort, order: sort.order, limit: Math.min(200, Math.max(PAGE, held)) });
      if (run !== generation.current) return;
      rememberSystemFolders(out.folder ? [out.folder, ...out.items] : out.items);
      setListing({ folder: out.folder, path: out.path, items: out.items, cursor: out.next_cursor, loading: false, error: null, sharedAbove: out.shared_above ?? 0 });
      // CF2 (docs/CHANNEL_FILES.md §12.1): 「ドライブで表示」 of a message's file selects it in its folder.
      const asked = takeDriveSelection(folderId);
      if (asked && out.items.some((item) => item.id === asked)) {
        setSelected(new Set([asked]));
        setAnchor(asked);
        setFocusId(asked);
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-drive-item="${asked}"]`)?.scrollIntoView({ block: "nearest" }));
      }
    } catch (error) {
      if (run !== generation.current) return;
      if (error instanceof ApiError && error.code === "drive_item_not_found") {
        if (folderId !== location.root_id) onFolder(location.root_id);
        else onLost?.();
        return;
      }
      setListing((current) => ({ ...current, loading: false, error: describeError(error) }));
    }
    // `listing.items.length` only sizes a reload; reading again on its change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, folderId, sort.sort, sort.order, mode, location.root_id]);

  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
    void load();
  }, [load]);
  // CF2: 「ドライブで表示」 for a file of the folder already open (no new listing to take it).
  useEffect(() => onDriveTarget(() => {
    const asked = takeDriveSelection(folderId);
    if (!asked) return;
    setSelected(new Set([asked]));
    setAnchor(asked);
    setFocusId(asked);
    listRef.current?.querySelector<HTMLElement>(`[data-drive-item="${asked}"]`)?.scrollIntoView({ block: "nearest" });
  }), [folderId]);

  const loadMore = useCallback(async () => {
    if (!api || !listing.cursor || listing.loading) return;
    const run = generation.current;
    setListing((current) => ({ ...current, loading: true }));
    try {
      const out = await api.driveChildren(folderId, { sort: sort.sort, order: sort.order, cursor: listing.cursor, limit: PAGE });
      if (run !== generation.current) return;
      rememberSystemFolders(out.items);
      setListing((current) => ({ ...current, items: appendPage(current.items, out.items), cursor: out.next_cursor, loading: false }));
    } catch (error) {
      if (run === generation.current) setListing((current) => ({ ...current, loading: false, error: describeError(error) }));
    }
  }, [api, folderId, sort.sort, sort.order, listing.cursor, listing.loading]);

  // The next page when the end of the list comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root: listRef.current, rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loadMore, listing.cursor]);

  // --- the trash ----------------------------------------------------------------------------------------------------

  const [trash, setTrash] = useState<{ entries: DriveTrashEntryOut[]; cursor: string | null; loading: boolean; error: string | null }>({ entries: [], cursor: null, loading: true, error: null });
  const [forever, setForever] = useState<DriveTrashEntryOut | null>(null);
  const loadTrash = useCallback(async (cursor: string | null = null) => {
    if (!api || mode !== "trash") return;
    setTrash((current) => ({ ...current, loading: true, ...(cursor ? {} : { entries: [] }) }));
    try {
      const out = await api.driveTrash(location.id, cursor);
      setTrash((current) => ({ entries: cursor ? [...current.entries, ...out.entries] : out.entries, cursor: out.next_cursor, loading: false, error: null }));
    } catch (error) {
      setTrash((current) => ({ ...current, loading: false, error: describeError(error) }));
    }
  }, [api, location.id, mode]);
  useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  // --- live updates -------------------------------------------------------------------------------------------------

  const reload = useRef(coalesce(() => undefined));
  useEffect(() => {
    const again = coalesce(() => {
      if (mode === "trash") void loadTrash();
      else void load({ keep: true });
    });
    reload.current = again;
    const hub = engine?.drive;
    const unsubscribe = hub?.subscribe((signal) => {
      if (signal.kind === "resync") again.poke();
      else if (signal.kind === "changed" && signal.locationId === location.id && (mode === "trash" || signal.folderIds.includes(folderId))) again.poke();
    });
    return () => {
      again.cancel();
      unsubscribe?.();
    };
  }, [engine, location.id, folderId, mode, load, loadTrash]);
  useUploadsDone(controller.accountKey, useCallback((job) => {
    if (job.target.parentId === folderId && !job.relativeDir) reload.current.poke();
  }, [folderId]));

  // --- search in this location ---------------------------------------------------------------------------------------

  useEffect(() => {
    const words = query.trim();
    if (!api || !words) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api.searchDrive({ q: words, location_id: location.id, limit: 50, content: true }).then(
        (out) => { if (!cancelled) setHits(out.items); },
        (error) => { if (!cancelled) { setHits([]); controller.setError(error); } },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, query, location.id, controller]);

  // --- actions --------------------------------------------------------------------------------------------------------

  const items = hits ? hits.map((hit) => hit.item) : listing.items;
  const order = items.map((item) => item.id);
  const chosen = items.filter((item) => selected.has(item.id));
  const viewables = useMemo(() => viewable(items), [items]);

  const open = (item: DriveItemOut) => {
    if (item.kind === "folder") {
      setQuery("");
      onFolder(item.id);
      return;
    }
    if (viewerKind(item)) {
      const page = openPage(hits?.find((hit) => hit.item.id === item.id));
      setOpenAt(page ? { id: item.id, page } : null);
      setViewing(item);
    } else {
      // §27: a file no viewer shows opens its details (with 「ダウンロード」), never a download by itself.
      setSelected(new Set([item.id]));
      setAnchor(item.id);
      setFocusId(item.id);
      setDetails(true);
    }
  };

  /** One file as it is; a folder or several items as one ZIP (M162). */
  const download = (targets: DriveItemOut[]) => {
    const plan = downloadPlan(targets);
    if (plan?.kind === "file") void controller.downloadDriveFile(plan.item);
    else if (plan?.kind === "zip") void controller.downloadDriveZip(plan.ids);
  };

  // CF2 (docs/CHANNEL_FILES.md §6.4, §6.5): before a trash or a move, the warning when posted files would change.
  const impact = useImpactCheck(controller);

  const trashItems = async (targets: DriveItemOut[]) => {
    if (!api || targets.length === 0) return;
    if (!canRearrange(targets)) return;
    if (!(await impact.confirm(targets.map((item) => item.id), null))) return;
    try {
      const out = await api.trashDriveItems(targets.map((item) => item.id));
      const failed = out.results.filter((result) => !result.ok);
      if (failed.length > 0) controller.setError(new ApiError(409, failed[0]!.error ?? "unknown", ""));
      const gone = new Set(out.results.filter((result) => result.ok).map((result) => result.id));
      setListing((current) => ({ ...current, items: current.items.filter((item) => !gone.has(item.id)) }));
      setHits((current) => current && current.filter((hit) => !gone.has(hit.item.id)));
      setSelected(new Set());
      if (gone.size > 0) controller.setNotice(gone.size === 1 ? t("drive.trashedOne") : t("drive.trashedMany", { count: gone.size }));
    } catch (error) {
      controller.setError(error);
    }
  };

  const moveItems = async (targets: DriveItemOut[], targetFolderId: string) => {
    if (!api || targets.length === 0) return;
    const moving = targets.filter((item) => item.id !== targetFolderId && item.parent_id !== targetFolderId);
    if (moving.length === 0 || !canRearrange(moving)) return;
    if (!(await impact.confirm(moving.map((item) => item.id), targetFolderId))) return;
    try {
      const out = await api.moveDriveItems(moving.map((item) => item.id), targetFolderId, "fail");
      const failed = out.results.filter((result) => !result.ok);
      if (failed.length > 0) controller.setError(new ApiError(409, failed[0]!.error ?? "unknown", ""));
      void load({ keep: true });
    } catch (error) {
      controller.setError(error);
    }
  };

  /** M162: copies into `targetFolderId` (numbered 「名前 (1)」 where the name is taken). */
  const copyItems = async (targets: DriveItemOut[], targetFolderId: string) => {
    if (!api || targets.length === 0) return;
    try {
      const out = await api.copyDriveItems(targets.map((item) => item.id), targetFolderId, "rename", newOpId());
      const failed = out.results.filter((result) => !result.ok);
      if (failed.length > 0) controller.setError(new ApiError(409, failed[0]!.error ?? "unknown", ""));
      const done = out.results.length - failed.length;
      if (done > 0) controller.setNotice(t("drive.copied", { count: done }));
      if (targetFolderId === folderId) void load({ keep: true });
    } catch (error) {
      controller.setError(error);
    }
  };

  /** AL2: 「アルバムにする」 / 「アルバムをやめる」 on a folder (its files stay as they are). */
  const setAlbum = async (item: DriveItemOut, on: boolean) => {
    if (!api) return;
    try {
      if (on) await api.putDriveAlbum(item.id, {});
      else await api.deleteDriveAlbum(item.id);
      controller.setNotice(on ? t("albums.made", { name: item.name }) : t("albums.removed", { name: item.name }));
      void load({ keep: true });
    } catch (error) {
      controller.setError(error);
    }
  };

  /** Files (and the empty folders of a folder upload) into `parentId`. */
  const upload = async (tree: PickedTree, parentId: string, label: string) => {
    if (!api || !controller.accountKey) return;
    const empty = emptyFolders(tree.folders, tree.files);
    for (const path of empty) {
      try {
        await api.createDriveFolder({ parent_id: parentId, path, client_op_id: crypto.randomUUID() });
      } catch (error) {
        controller.setError(error);
        break;
      }
    }
    if (empty.length > 0 && tree.files.length === 0) void load({ keep: true });
    if (tree.files.length === 0) return;
    uploadQueueFor(controller.accountKey, api).add(tree.files, { parentId, locationId: location.id, label });
  };

  const here = pathLine(localizedPath(listing.path, location.kind), locationName(location));
  const uploadHere = (tree: PickedTree | null) => {
    if (tree) void upload(tree, folderId, here);
  };
  const pickFiles = () => (isTauri() ? void pickFilesNative().then(uploadHere, (error) => controller.setError(error)) : filesInput.current?.click());
  const pickFolder = () => (isTauri() ? void pickFolderNative().then(uploadHere, (error) => controller.setError(error)) : folderInput.current?.click());

  /** A drop: its entries walked (folders kept), else its plain files. */
  const takeDrop = (data: DataTransfer, parentId: string, label: string) => {
    const entries = dropEntries(data);
    const files = Array.from(data.files ?? []);
    void (entries ? treeFromEntries(entries) : Promise.resolve(treeFromInput(files))).then(
      (tree) => upload(tree, parentId, label),
      (error) => controller.setError(error),
    );
  };

  const blocked = !canWrite ? t("drive.readOnly") : mode === "trash" ? t("drive.dropNotInTrash") : null;
  const zone = useFileDropZone({
    enabled: true,
    blocked,
    onFiles: () => undefined,
    onData: (data) => takeDrop(data, folderId, here),
  });

  // --- keyboard -------------------------------------------------------------------------------------------------------

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("input, textarea")) return;
    const mod = event.metaKey || event.ctrlKey;
    const at = focusId ? order.indexOf(focusId) : -1;
    const focus = (index: number, extend: boolean) => {
      const id = order[Math.max(0, Math.min(order.length - 1, index))];
      if (!id) return;
      setFocusId(id);
      const next = clickSelection(order, selected, anchor, id, { toggle: false, range: extend });
      setSelected(next.selected);
      setAnchor(next.anchor);
      listRef.current?.querySelector<HTMLElement>(`[data-drive-item="${id}"]`)?.scrollIntoView({ block: "nearest" });
    };
    const current = at >= 0 ? items[at] : chosen[0];
    if (event.key === "ArrowDown" || (view === "grid" && event.key === "ArrowRight")) {
      event.preventDefault();
      focus(at + 1, event.shiftKey);
    } else if (event.key === "ArrowUp" || (view === "grid" && event.key === "ArrowLeft")) {
      event.preventDefault();
      focus(at < 0 ? 0 : at - 1, event.shiftKey);
    } else if (event.key === "Enter" && current) {
      event.preventDefault();
      open(current);
    } else if (event.key === " " && current) {
      event.preventDefault();
      if (viewerKind(current)) setViewing(current);
    } else if (event.key === "F2" && current && canWrite && mode === "folder" && !isSystemFolder(current)) {
      event.preventDefault();
      setDialog({ kind: "rename", item: current });
    } else if ((event.key === "Delete" || (event.key === "Backspace" && mod)) && chosen.length > 0 && canWrite && mode === "folder" && canRearrange(chosen)) {
      event.preventDefault();
      void trashItems(chosen);
    } else if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Set(order));
    } else if (mod && event.key.toLowerCase() === "x" && chosen.length > 0 && canWrite && canRearrange(chosen)) {
      event.preventDefault();
      clipboard = { mode: "cut", items: chosen };
      controller.setNotice(t("drive.cut", { count: chosen.length }));
    } else if (mod && event.key.toLowerCase() === "c" && chosen.length > 0 && mode === "folder") {
      event.preventDefault();
      clipboard = { mode: "copy", items: chosen };
      controller.setNotice(t("drive.copiedToClipboard", { count: chosen.length }));
    } else if (mod && event.key.toLowerCase() === "v" && clipboard && canWrite && mode === "folder") {
      event.preventDefault();
      const paste = pasteAction(clipboard, folderId);
      clipboard = afterPaste(clipboard);
      if (paste?.action === "move") void moveItems(paste.items, folderId);
      else if (paste?.action === "copy") void copyItems(paste.items, folderId);
    } else if (event.key === "Escape" && selected.size > 0) {
      // Only the selection: not the screen's own Esc (which would leave 「ドライブ」).
      event.stopPropagation();
      setSelected(new Set());
    }
  };

  const select = (item: DriveItemOut, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, toggle = false) => {
    const next = clickSelection(order, selected, anchor, item.id, { toggle: toggle || event.metaKey || event.ctrlKey, range: event.shiftKey });
    setSelected(next.selected);
    setAnchor(next.anchor);
    setFocusId(item.id);
  };
  /** §27: a plain click opens (and selects) the item; with ⌘ / Ctrl or Shift it only selects. */
  const clickItem = (item: DriveItemOut, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; detail: number }) => {
    const action = clickAction(item, event);
    if (action === "none") return;
    // A file opened in a viewer is not left selected (the selection bar is for what was picked to act on).
    if (action === "view") setFocusId(item.id);
    else select(item, event);
    if (action !== "select") open(item);
  };
  /** The row's check box: adds or removes the item (Shift: the range), never opens it. */
  const checkItem = (item: DriveItemOut, event: { stopPropagation: () => void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    event.stopPropagation();
    select(item, event, true);
  };

  // --- rows: drag to move, drop files into a folder --------------------------------------------------------------------

  const rowDrag = (item: DriveItemOut) => ({
    draggable: canWrite && mode === "folder" && !isSystemFolder(item),
    onDragStart: (event: DragEvent) => {
      const moving = (selected.has(item.id) ? chosen : [item]).filter((entry) => !isSystemFolder(entry));
      event.dataTransfer.setData(ROW_DRAG, JSON.stringify(moving.map((entry) => entry.id)));
      event.dataTransfer.effectAllowed = "move";
    },
  });
  const folderDrop = (folder: { id: string; name: string }) => ({
    onDragOver: (event: DragEvent) => {
      if (!canWrite || mode !== "folder") return;
      const internal = event.dataTransfer.types.includes(ROW_DRAG);
      if (!internal && !isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = internal ? "move" : "copy";
      setDropFolder(folder.id);
    },
    onDragLeave: () => setDropFolder((current) => (current === folder.id ? null : current)),
    onDrop: (event: DragEvent) => {
      setDropFolder(null);
      if (!canWrite || mode !== "folder") return;
      const raw = event.dataTransfer.getData(ROW_DRAG);
      if (raw) {
        event.preventDefault();
        event.stopPropagation();
        const ids = new Set(JSON.parse(raw) as string[]);
        void moveItems(items.filter((entry) => ids.has(entry.id)), folder.id);
        return;
      }
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      // Not to the listing's own zone: its overlay ends with the window's drop listener.
      window.dispatchEvent(new Event("drop"));
      takeDrop(event.dataTransfer, folder.id, `${here} › ${folder.name}`);
    },
  });

  const rowMenu = (item: DriveItemOut) => {
    const targets = selected.has(item.id) && chosen.length > 1 ? chosen : [item];
    const many = targets.length > 1;
    return (
      <>
        {!many && <ContextMenu.Item className={MENU_ITEM} onSelect={() => open(item)}>{item.kind === "folder" ? t("drive.open") : viewerKind(item) ? t("drive.preview") : t("drive.details")}</ContextMenu.Item>}
        <ContextMenu.Item className={MENU_ITEM} onSelect={() => download(targets)}><Download size={14} /> {many || item.kind === "folder" ? t("drive.downloadZip") : t("drive.download")}</ContextMenu.Item>
        {!many && item.kind === "file" && mode === "folder" && (
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: "versions", item })}><History size={14} /> {t("drive.versions.open")}</ContextMenu.Item>
        )}
        {!many && mode === "folder" && item.parent_id && (location.can_share || item.link_count > 0) && (
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: "share", item })}><Link2 size={14} /> {t("drive.share.open")}</ContextMenu.Item>
        )}
        {!many && mode === "folder" && item.parent_id && (
          // M165 (docs/DRIVE.md §13.1): the item's link `<server>/d/<id>` for a conversation (a card there for whoever can read it).
          <>
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: "send", item })}><MessageSquareShare size={14} /> {t("driveLink.send")}</ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => { const base = controller.api?.baseUrl; if (base) void controller.copyToClipboard(driveLink(base, item.id), t("driveLink.copied")); }}><LinkIcon size={14} /> {t("driveLink.copy")}</ContextMenu.Item>
          </>
        )}
        {hits && !many && item.parent_id && (
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => { setQuery(""); onFolder(item.parent_id!); }}><FolderInput size={14} /> {t("drive.showInFolder")}</ContextMenu.Item>
        )}
        {mode === "folder" && (
          // Copying needs only reading here (the dialog lists the folders I can write in).
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: "copy", items: targets })}><Copy size={14} /> {t("drive.copy")}</ContextMenu.Item>
        )}
        {canWrite && mode === "folder" && canRearrange(targets) && (
          <>
            <ContextMenu.Separator className="my-1 h-px bg-line" />
            {!many && <ContextMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: "rename", item })}><Pencil size={14} /> {t("drive.rename")}</ContextMenu.Item>}
            {!many && canBecomeAlbum(item) && <ContextMenu.Item data-drive-make-album="" className={MENU_ITEM} onSelect={() => void setAlbum(item, true)}><Images size={14} /> {t("albums.make")}</ContextMenu.Item>}
            {!many && item.kind === "folder" && item.album && <ContextMenu.Item data-drive-unmake-album="" className={MENU_ITEM} onSelect={() => void setAlbum(item, false)}><Images size={14} /> {t("albums.unmake")}</ContextMenu.Item>}
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: "move", items: targets })}><FolderInput size={14} /> {t("drive.move")}</ContextMenu.Item>
            <ContextMenu.Item className={cn(MENU_ITEM, "text-danger")} onSelect={() => void trashItems(targets)}><Trash2 size={14} /> {t("drive.toTrash")}</ContextMenu.Item>
          </>
        )}
      </>
    );
  };

  // --- drawing ------------------------------------------------------------------------------------------------------

  const users = controller.store.users;
  const who = (id: string | null | undefined) => (id ? users.get(id)?.display_name ?? t("drive.someone") : "");
  const crumbs = breadcrumbs(localizedPath(listing.path, location.kind), locationName(location));
  const emptyFolder = !listing.loading && !listing.error && listing.items.length === 0 && !hits;
  const canShareItem = (item: DriveItemOut) => mode === "folder" && !!item.parent_id && (location.can_share || item.link_count > 0);

  /** §27: the root crumb's ▾ lists the other locations (the way back to them while the locations column is hidden). */
  const rootSwitcher = locations && locations.list.length > 1 ? (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" data-drive-switch-location="" aria-label={t("drive.switchLocation")} title={t("drive.switchLocation")} className="flex h-7 w-5 shrink-0 items-center justify-center rounded-md text-muted hover:bg-ink/6 hover:text-ink">
          <ChevronDown size={14} />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-80 overflow-y-auto">
        <MenuLabel>{t("drive.locations")}</MenuLabel>
        {locations.list.map((loc) => (
          <MenuItem key={loc.id} onSelect={() => locations.onChoose(loc)}>
            <LocationGlyph kind={loc.kind} /> <span className={cn("truncate", loc.id === location.id && "font-semibold")}>{locationName(loc)}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  ) : null;

  const crumbClass = (current: boolean) => cn("truncate rounded-md px-1.5 py-0.5 hover:bg-ink/6", current ? "max-w-[24rem] text-[17px] font-semibold text-ink" : "max-w-[14rem] text-[14px] text-muted hover:text-ink");
  const toolbar = (
    <div className="flex shrink-0 flex-col border-b border-line">
      <div className="flex min-h-[52px] items-center gap-1 px-3 pt-1">
        {header}
        <nav aria-label={t("drive.breadcrumbs")} className="flex min-w-0 flex-1 items-center gap-0.5">
          {mode === "trash" ? (
            <>
              <button type="button" className={crumbClass(false)} onClick={() => onMode?.("folder")}>{locationName(location)}</button>
              <ChevronRight size={14} className="shrink-0 text-muted" />
              <strong className={crumbClass(true)}>{t("drive.trash")}</strong>
            </>
          ) : (
            crumbs.shown.map((crumb, index) => (
              <span key={crumb.id} className="flex min-w-0 items-center gap-0.5">
                {index > 0 && <ChevronRight size={14} className="shrink-0 text-muted" />}
                {index === 1 && crumbs.hidden.length > 0 && (
                  <>
                    <Menu>
                      <MenuTrigger asChild>
                        <button type="button" className="rounded-md px-1.5 py-0.5 text-muted hover:bg-ink/6" aria-label={t("drive.moreFolders")}>…</button>
                      </MenuTrigger>
                      <MenuContent align="start">
                        {crumbs.hidden.map((hidden) => <MenuItem key={hidden.id} onSelect={() => onFolder(hidden.id)}>{hidden.name}</MenuItem>)}
                      </MenuContent>
                    </Menu>
                    <ChevronRight size={14} className="shrink-0 text-muted" />
                  </>
                )}
                <button
                  type="button"
                  data-drive-crumb={crumb.id}
                  aria-current={crumb.id === folderId ? "page" : undefined}
                  onClick={() => onFolder(crumb.id)}
                  {...folderDrop(crumb)}
                  className={cn(crumbClass(crumb.id === folderId), dropFolder === crumb.id && "bg-accent-soft ring-1 ring-accent")}
                >
                  {crumb.name}
                </button>
                {index === 0 && rootSwitcher}
              </span>
            ))
          )}
        </nav>
      </div>
      {mode === "folder" && chosen.length > 0 ? (
        // §27: the selection bar takes the actions row's place while something is selected.
        <div data-drive-selection-bar="" role="toolbar" aria-label={t("drive.selectedCount", { count: chosen.length })} className="flex min-h-11 flex-wrap items-center gap-1 px-3 pb-2">
          <IconButton label={t("drive.clearSelection")} onClick={() => setSelected(new Set())}><X size={16} /></IconButton>
          <strong className="mr-2 text-[13.5px]">{t("drive.selectedCount", { count: chosen.length })}</strong>
          <Button size="sm" variant="secondary" onClick={() => download(chosen)}><Download size={14} /> {chosen.length > 1 || chosen[0]!.kind === "folder" ? t("drive.downloadZip") : t("drive.download")}</Button>
          {chosen.length === 1 && canShareItem(chosen[0]!) && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "share", item: chosen[0]! })}><Link2 size={14} /> {t("drive.share.open")}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "copy", items: chosen })}><Copy size={14} /> {t("drive.copy")}</Button>
          {canWrite && canRearrange(chosen) && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "move", items: chosen })}><FolderInput size={14} /> {t("drive.move")}</Button>}
          {canWrite && canRearrange(chosen) && <Button size="sm" variant="ghost" className="text-danger" onClick={() => void trashItems(chosen)}><Trash2 size={14} /> {t("drive.toTrash")}</Button>}
        </div>
      ) : mode === "folder" ? (
        <div className="flex min-h-11 flex-wrap items-center gap-1.5 px-3 pb-2">
          <label className="relative mr-auto flex items-center">
            <Search size={14} className="pointer-events-none absolute left-2.5 text-muted" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("drive.searchIn", { name: locationName(location) })} aria-label={t("drive.search")} className="h-8 w-56 rounded-full py-1 pl-8 pr-7 text-[13px] max-md:w-40" />
            {query && <button type="button" aria-label={t("drive.clearSearch")} className="absolute right-2 rounded p-0.5 text-muted hover:text-ink" onClick={() => setQuery("")}><X size={13} /></button>}
          </label>
          {canWrite && (
            <>
              <Menu>
                <MenuTrigger asChild>
                  <Button size="sm" data-drive-upload=""><Upload size={14} /> {t("drive.upload")} <ChevronDown size={13} className="-mr-0.5 opacity-80" /></Button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem onSelect={pickFiles}><FilePlus2 size={14} /> {t("drive.uploadFiles")}</MenuItem>
                  <MenuItem onSelect={pickFolder}><FolderUp size={14} /> {t("drive.uploadFolder")}</MenuItem>
                </MenuContent>
              </Menu>
              <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "new-folder" })}><FolderPlus size={14} /> {t("drive.newFolder")}</Button>
              <Button size="sm" variant="secondary" data-drive-new-album="" onClick={() => setDialog({ kind: "new-album" })}><Images size={14} /> {t("albums.new")}</Button>
            </>
          )}
          {listing.folder?.album && asFiles && (
            <Button size="sm" variant="ghost" data-drive-as-album="" onClick={() => showFiles(false)}><Images size={14} /> {t("albums.asAlbum")}</Button>
          )}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          <div role="group" aria-label={t("drive.viewMode")} className="flex rounded-lg border border-line">
            {(["list", "grid"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                aria-label={value === "list" ? t("drive.viewList") : t("drive.viewGrid")}
                title={value === "list" ? t("drive.viewList") : t("drive.viewGrid")}
                onClick={() => { setView(value); writeViewMode(value); }}
                className={cn("flex h-7 w-8 items-center justify-center first:rounded-l-lg last:rounded-r-lg", view === value ? "bg-ink/8 text-ink" : "text-muted hover:text-ink")}
              >
                {value === "list" ? <List size={15} /> : <LayoutGrid size={15} />}
              </button>
            ))}
          </div>
          <IconButton label={t("drive.details")} aria-pressed={details} onClick={() => setDetails((value) => !value)} className={cn(details && "bg-ink/8")}><Info size={16} /></IconButton>
          {/* Secondary actions: the order (the list's headers sort too) and the trash. */}
          <Menu>
            <MenuTrigger asChild>
              <IconButton label={t("drive.more")} data-drive-more=""><MoreHorizontal size={16} /></IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>{t("drive.sortBy", { sort: sortLabel(sort.sort) })}</MenuLabel>
              <MenuRadioGroup value={sort.sort} onValueChange={(value) => setSort(nextSort({ sort: "name", order: "asc" }, value as DriveSort))}>
                {(["name", "modified", "size"] as const).map((value) => <MenuRadioItem key={value} value={value}>{sortLabel(value)}</MenuRadioItem>)}
              </MenuRadioGroup>
              <MenuItem onSelect={() => setSort((current) => ({ ...current, order: current.order === "asc" ? "desc" : "asc" }))}>
                {sort.order === "asc" ? <ArrowDown size={14} /> : <ArrowUp size={14} />} {sort.order === "asc" ? t("drive.sortDesc") : t("drive.sortAsc")}
              </MenuItem>
              {onMode && (
                <>
                  <MenuSeparator />
                  <MenuItem onSelect={() => onMode("trash")}><Trash2 size={14} /> {t("drive.openTrash")}</MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        </div>
      ) : null}
    </div>
  );

  const sharedBanner = mode === "folder" && !hits && listing.sharedAbove > 0 ? (
    <p data-drive-shared-banner="" className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5 text-[12.5px] text-muted">
      <Link2 size={13} className="shrink-0 text-accent" /> {t("drive.share.banner")}
    </p>
  ) : null;

  // A narrow listing keeps only the ⋯ (the hover buttons would take the names' room).
  const hoverActions = width === 0 || width >= 520;
  /** §27: a row's actions on hover (共有・ダウンロード) and its ⋯. */
  const rowActions = (item: DriveItemOut) => (
    <div className="flex items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
      <span data-drive-hover-actions="" className={cn("flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:hidden", !hoverActions && "hidden")}>
        {canShareItem(item) && (
          <button type="button" data-drive-row-share="" aria-label={t("drive.share.open")} title={t("drive.share.open")} className="rounded-md p-1.5 text-muted hover:bg-ink/8 hover:text-ink" onClick={() => setDialog({ kind: "share", item })}>
            <Link2 size={15} />
          </button>
        )}
        <button type="button" data-drive-row-download="" aria-label={item.kind === "folder" ? t("drive.downloadZip") : t("drive.download")} title={item.kind === "folder" ? t("drive.downloadZip") : t("drive.download")} className="rounded-md p-1.5 text-muted hover:bg-ink/8 hover:text-ink" onClick={() => download([item])}>
          <Download size={15} />
        </button>
      </span>
      <RowMenuButton>{rowMenu(item)}</RowMenuButton>
    </div>
  );

  // Beside the details pane the listing is narrower by its width.
  const columns = driveColumns(width === 0 ? Infinity : width - (details && mode === "folder" && width >= DETAILS_BESIDE_MIN ? DETAILS_WIDTH : 0));
  const now = new Date();
  const listingBody = mode === "trash" ? (
    <TrashList
      controller={controller}
      location={location}
      trash={trash}
      onMore={() => void loadTrash(trash.cursor)}
      onRestore={async (entry) => {
        if (!api) return;
        try {
          await api.restoreDriveItem(entry.item.id, "rename");
          controller.setNotice(t("drive.restored", { name: entry.item.name }));
          void loadTrash();
        } catch (error) {
          controller.setError(error);
        }
      }}
      onDelete={setForever}
    />
  ) : listing.error && listing.items.length === 0 ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
      <p role="alert">{listing.error}</p>
      <Button variant="secondary" size="sm" onClick={() => void load()}>{t("common.retry")}</Button>
    </div>
  ) : emptyFolder ? (
    <div data-drive-empty="" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-panel"><FolderOpen size={30} className={ICON_COLOURS.folder} /></span>
      <strong className="text-[15px]">{t("drive.emptyFolder")}</strong>
      <span className="max-w-sm text-sm text-muted">{canWrite ? t("drive.emptyFolderHint") : t("drive.emptyReadOnly")}</span>
      {canWrite && (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <Button size="sm" onClick={pickFiles}><Upload size={14} /> {t("drive.uploadFiles")}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "new-folder" })}><FolderPlus size={14} /> {t("drive.newFolder")}</Button>
        </div>
      )}
    </div>
  ) : hits && hits.length === 0 ? (
    <p className="p-6 text-center text-sm text-muted">{t("drive.noResults", { q: query.trim() })}</p>
  ) : view === "list" ? (
    <table className="w-full table-fixed border-collapse text-[13.5px]" data-drive-columns={[columns.modified && "modified", columns.by && "by", columns.size && "size"].filter(Boolean).join(" ")}>
      <thead className="sticky top-0 z-10 bg-canvas text-left text-xs text-muted">
        <tr className="border-b border-line">
          <th className="w-10 pl-4" aria-label={t("drive.select")} />
          <SortHeader label={t("drive.column.name")} sort="name" current={sort} onSort={setSort} disabled={!!hits} />
          {columns.modified && <SortHeader label={t("drive.column.modified")} sort="modified" current={sort} onSort={setSort} disabled={!!hits} className="w-36" />}
          {columns.by && <th className="w-32 px-2 py-2 font-medium">{t("drive.column.by")}</th>}
          {columns.size && <SortHeader label={t("drive.column.size")} sort="size" current={sort} onSort={setSort} disabled={!!hits} className="w-20 text-right" align="right" />}
          <th className={hoverActions ? "w-[6.5rem]" : "w-10"} aria-label={t("drive.actions")} />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const hit = hits?.find((entry) => entry.item.id === item.id);
          const time = itemTime(item);
          return (
            <ContextMenu.Root key={item.id}>
              <ContextMenu.Trigger asChild>
                <tr
                  data-drive-item={item.id}
                  data-row-key={item.id}
                  aria-selected={selected.has(item.id)}
                  onClick={(event) => clickItem(item, event)}
                  {...rowDrag(item)}
                  {...(item.kind === "folder" ? folderDrop(item) : {})}
                  className={cn("group/row h-12 cursor-pointer border-b border-line/60", selected.has(item.id) ? "bg-accent-soft" : "hover:bg-ink/[0.045]", dropFolder === item.id && "bg-accent-soft ring-1 ring-inset ring-accent", focusId === item.id && "outline outline-1 -outline-offset-1 outline-accent/50")}
                >
                  <td className="pl-4">
                    <ItemCheck item={item} checked={selected.has(item.id)} shown={selected.size > 0} onCheck={checkItem} />
                  </td>
                  <td className={cn("overflow-hidden pr-2", hit?.snippet && "py-1.5")}>
                    <div className="flex min-w-0 items-center gap-3">
                      <RowIcon controller={controller} item={item} />
                      <div className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <FileName name={itemName(item)} className="min-w-0 font-medium" />
                          <SharedMark count={item.link_count} />
                          {item.posted && <PostedMark />}
                        </span>
                        {hit && <div className="truncate text-[11.5px] text-muted">{pathLine(localizedPath(hit.path, location.kind), locationName(location))}</div>}
                        {hit && <DriveSnippet hit={hit} className="mt-0.5" />}
                      </div>
                    </div>
                  </td>
                  {columns.modified && <td className="truncate px-2 text-[13px] text-muted" title={exactTime(time)}>{driveTime(time, now)}</td>}
                  {columns.by && <td className="truncate px-2 text-[13px] text-muted">{who(item.updated_by ?? item.created_by)}</td>}
                  {columns.size && <td className="truncate px-2 text-right text-[13px] tabular-nums text-muted">{item.kind === "file" ? formatBytes(item.size_bytes) : "—"}</td>}
                  <td className="pr-2">{rowActions(item)}</td>
                </tr>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className={MENU_CONTENT} collisionPadding={8}>{rowMenu(item)}</ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          );
        })}
      </tbody>
    </table>
  ) : (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(168px,100%),1fr))] gap-4 p-4 max-sm:grid-cols-2 max-sm:gap-2.5 max-sm:p-3">
      {items.map((item) => (
        <ContextMenu.Root key={item.id}>
          <ContextMenu.Trigger asChild>
            <li
              data-drive-item={item.id}
              data-row-key={item.id}
              aria-selected={selected.has(item.id)}
              onClick={(event) => clickItem(item, event)}
              {...rowDrag(item)}
              {...(item.kind === "folder" ? folderDrop(item) : {})}
              className={cn("group/row relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-xl border bg-canvas transition-shadow", selected.has(item.id) ? "border-accent ring-1 ring-accent" : "border-line hover:border-ink/20 hover:shadow-md", dropFolder === item.id && "ring-2 ring-accent", focusId === item.id && "outline outline-1 outline-offset-1 outline-accent/50")}
            >
              <span className="absolute left-2 top-2 z-[1]"><ItemCheck item={item} checked={selected.has(item.id)} shown={selected.size > 0} onCheck={checkItem} tile /></span>
              <span className="absolute right-1.5 top-1.5 z-[1] rounded-md bg-canvas/90 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100" onClick={(event) => event.stopPropagation()}>
                <RowMenuButton>{rowMenu(item)}</RowMenuButton>
              </span>
              <TileThumb controller={controller} item={item} />
              <div className="flex min-w-0 items-center gap-2 border-t border-line/70 px-2.5 py-2">
                <DriveIcon item={item} size={15} />
                <div className="min-w-0 flex-1">
                  <FileName name={itemName(item)} className="min-w-0 text-[13px] font-medium" />
                  <div className="truncate text-[11.5px] text-muted" title={exactTime(itemTime(item))}>
                    {item.kind === "file" ? `${formatBytes(item.size_bytes)} · ${driveTime(itemTime(item), now)}` : driveTime(itemTime(item), now)}
                  </div>
                </div>
                <SharedMark count={item.link_count} />
                {item.posted && <PostedMark />}
              </div>
            </li>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className={MENU_CONTENT} collisionPadding={8}>{rowMenu(item)}</ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ))}
    </ul>
  );

  const detailItem = chosen.length === 1 ? chosen[0]! : chosen.length === 0 ? listing.folder : null;
  // The details pane beside a wide listing; over a narrow one (it would squeeze the names).
  const overlayDetails = width > 0 && width < DETAILS_BESIDE_MIN;

  // AL2 (docs/ALBUMS.md §10.1): an album folder is the album screen (in 「ドライブ」 and in a channel's tab alike).
  if (mode === "folder" && !hits && !asFiles && listing.folder?.album && listing.folder.id === folderId) {
    return (
      <AlbumView
        key={folderId}
        controller={controller}
        location={location}
        folderId={folderId}
        onFolder={onFolder}
        onShowFiles={() => showFiles(true)}
        onNotAlbum={() => void load({ keep: true })}
        onLost={onLost}
        header={header}
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-drive-browser={mode}>
      {toolbar}
      {sharedBanner}
      <div ref={measured} className="relative flex min-h-0 flex-1">
        <div
          ref={listRef}
          data-scroll-memory=""
          role="grid"
          aria-label={mode === "trash" ? t("drive.trash") : here}
          aria-multiselectable
          tabIndex={0}
          onKeyDown={onKeyDown}
          onClick={(event) => { if (event.target === event.currentTarget) setSelected(new Set()); }}
          className="relative flex min-h-0 flex-1 flex-col overflow-y-auto outline-none"
          data-drop-zone="drive"
          {...zone.handlers}
        >
          {listingBody}
          {mode === "folder" && !hits && <div ref={sentinel} className="h-px shrink-0" />}
          {listing.loading && mode === "folder" && <div className="flex justify-center py-4 text-muted"><Loader2 size={18} className="animate-spin" /></div>}
          <DropOverlay active={zone.active} blocked={blocked} destination={t("drive.dropTo", { path: here })} />
        </div>
        {details && mode === "folder" && (
          <DetailsPane
            controller={controller}
            item={detailItem}
            count={chosen.length}
            path={here}
            onClose={() => setDetails(false)}
            onVersions={(item) => setDialog({ kind: "versions", item })}
            onShare={(item) => setDialog({ kind: "share", item })}
            canShare={location.can_share}
            onDownload={() => download(chosen.length > 0 ? chosen : listing.folder ? [listing.folder] : [])}
            overlay={overlayDetails}
          />
        )}
      </div>
      <input ref={filesInput} type="file" multiple hidden onChange={(event) => { uploadHere(treeFromInput(Array.from(event.target.files ?? []))); event.target.value = ""; }} />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        // webkitdirectory: a folder and everything in it (React has no typed prop for it).
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(event) => { uploadHere(treeFromInput(Array.from(event.target.files ?? []))); event.target.value = ""; }}
      />
      {dialog?.kind === "new-folder" && <NewFolderDialog controller={controller} parentId={folderId} onClose={() => setDialog(null)} onMade={() => void load({ keep: true })} />}
      {dialog?.kind === "new-album" && (
        <NewAlbumDialog
          controller={controller}
          locations={[location]}
          location={location}
          folder={folderId !== location.root_id && listing.folder && !isSystemFolder(listing.folder) ? { id: folderId, name: itemName(listing.folder) } : null}
          onClose={() => setDialog(null)}
          onMade={(made) => onFolder(made.folder.id)}
        />
      )}
      {dialog?.kind === "rename" && <RenameDialog controller={controller} item={dialog.item} onClose={() => setDialog(null)} onDone={(renamed) => {
        setListing((current) => ({ ...current, items: current.items.map((item) => (item.id === renamed.id ? renamed : item)) }));
        void load({ keep: true });
      }} />}
      {(dialog?.kind === "move" || dialog?.kind === "copy") && <MoveDialog controller={controller} mode={dialog.kind} items={dialog.items} startLocation={location} startFolderId={folderId} onClose={() => setDialog(null)} onMoved={(_target, failed) => {
        if (failed > 0) controller.setError(t(dialog.kind === "copy" ? "drive.someNotCopied" : "drive.someNotMoved", { count: failed }));
        else if (dialog.kind === "copy") controller.setNotice(t("drive.copied", { count: dialog.items.length }));
        setSelected(new Set());
        void load({ keep: true });
      }} />}
      {dialog?.kind === "send" && <SendToConversationDialog controller={controller} item={dialog.item} onClose={() => setDialog(null)} />}
      {dialog?.kind === "share" && (
        <ShareLinksDialog controller={controller} item={dialog.item} onClose={() => setDialog(null)} onChanged={() => void load({ keep: true })} />
      )}
      {dialog?.kind === "versions" && (
        <VersionsDialog
          controller={controller}
          item={dialog.item}
          location={location}
          onClose={() => setDialog(null)}
          onChanged={(changed) => {
            if (changed) setListing((current) => ({ ...current, items: current.items.map((item) => (item.id === changed.id ? changed : item)) }));
            void load({ keep: true });
          }}
        />
      )}
      {forever && (
        <DeleteForeverDialog
          name={forever.item.name}
          count={forever.item_count}
          onClose={() => setForever(null)}
          onConfirm={async () => {
            if (!api) return;
            try {
              await api.deleteDriveItem(forever.item.id);
              setForever(null);
              void loadTrash();
            } catch (error) {
              controller.setError(error);
            }
          }}
        />
      )}
      {viewing && <DriveViewer controller={controller} item={viewing} siblings={viewables} onStep={setViewing} onClose={() => setViewing(null)} page={openAt?.id === viewing.id ? openAt.page : null} />}
      {impact.asking && <ImpactDialog controller={controller} asking={impact.asking} />}
    </div>
  );
}

/**
 * A row's or a tile's check box (§27): selects without opening. Shown while something is selected, on hover, when
 * focused, and always where there is no hover (touch).
 */
function ItemCheck({ item, checked, shown, onCheck, tile = false }: {
  item: DriveItemOut;
  checked: boolean;
  shown: boolean;
  onCheck: (item: DriveItemOut, event: { stopPropagation: () => void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  tile?: boolean;
}) {
  return (
    <input
      type="checkbox"
      data-drive-check={item.id}
      checked={checked}
      aria-label={t("drive.selectItem", { name: item.name })}
      onClick={(event) => onCheck(item, event)}
      onChange={() => undefined}
      className={cn(
        "block h-4 w-4 cursor-pointer accent-[var(--accent)]",
        checked || shown ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100",
        tile && "rounded shadow-sm",
      )}
    />
  );
}

function SortHeader({ label, sort, current, onSort, disabled, className, align = "left" }: { label: string; sort: DriveSort; current: { sort: DriveSort; order: DriveOrder }; onSort: (next: { sort: DriveSort; order: DriveOrder }) => void; disabled: boolean; className?: string; align?: "left" | "right" }) {
  const active = current.sort === sort;
  return (
    <th className={cn("px-2 py-2 font-medium", className)} aria-sort={active ? (current.order === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" disabled={disabled} onClick={() => onSort(nextSort(current, sort))} className={cn("inline-flex items-center gap-1 hover:text-ink disabled:hover:text-muted", align === "right" && "flex-row-reverse", active && !disabled && "text-ink")}>
        {label}
        {active && !disabled && (current.order === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );
}

/** The row's ⋯: the same items as its context menu, opened by a click. */
function RowMenuButton({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          type="button"
          aria-label={t("drive.actions")}
          className="rounded-md p-1 text-muted hover:bg-ink/8 hover:text-ink"
          onClick={(event) => {
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom }));
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_CONTENT} collisionPadding={8}>{children}</ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function TrashList({ controller, location, trash, onMore, onRestore, onDelete }: {
  controller: AppController;
  location: DriveLocationOut;
  trash: { entries: DriveTrashEntryOut[]; cursor: string | null; loading: boolean; error: string | null };
  onMore: () => void;
  onRestore: (entry: DriveTrashEntryOut) => Promise<void>;
  onDelete: (entry: DriveTrashEntryOut) => void;
}) {
  const users = controller.store.users;
  if (trash.error && trash.entries.length === 0) return <p role="alert" className="p-6 text-center text-sm text-muted">{trash.error}</p>;
  if (!trash.loading && trash.entries.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent"><Trash2 size={22} /></span>
        <strong>{t("drive.trashEmpty")}</strong>
        <span className="max-w-sm text-sm text-muted">{t("drive.trashHint")}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <p className="border-b border-line px-4 py-2 text-xs text-muted">{t("drive.trashHint")}</p>
      <ul>
        {trash.entries.map((entry) => (
          <li key={entry.item.id} data-drive-trash={entry.item.id} className="flex items-center gap-3 border-b border-line/60 px-4 py-2 text-[13px]">
            <DriveIcon item={entry.item} />
            <div className="min-w-0 flex-1">
              <FileName name={entry.item.name} className="font-medium" />
              <div className="truncate text-[11px] text-muted">
                {t("drive.trashedBy", { who: entry.trashed_by ? users.get(entry.trashed_by)?.display_name ?? t("drive.someone") : t("drive.someone"), when: sinceLabel(entry.trashed_at) })}
                {entry.item.kind === "folder" ? ` · ${t("drive.itemCount", { count: entry.item_count - 1 })}` : ""} · {formatBytes(entry.size_bytes)}
              </div>
            </div>
            {location.can_write && (
              <Button size="sm" variant="secondary" onClick={() => void onRestore(entry)}><RotateCcw size={13} /> {t("drive.restore")}</Button>
            )}
            {location.can_manage && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => onDelete(entry)}><Trash2 size={13} /> {t("drive.deleteForever")}</Button>
            )}
          </li>
        ))}
      </ul>
      {trash.cursor && <Button variant="ghost" size="sm" className="m-3 self-center" onClick={onMore}>{t("drive.showMore")}</Button>}
      {trash.loading && <div className="flex justify-center py-4 text-muted"><Loader2 size={18} className="animate-spin" /></div>}
    </div>
  );
}

function DetailsPane({ controller, item, count, path, onClose, onVersions, onShare, canShare, onDownload, overlay = false }: {
  controller: AppController;
  item: DriveItemOut | null;
  count: number;
  path: string;
  onClose: () => void;
  onVersions: (item: DriveItemOut) => void;
  /** M163: the item's 「共有リンク」 (not the top folder). */
  onShare: (item: DriveItemOut) => void;
  canShare: boolean;
  /** The selection (or the open folder) downloaded: a file as it is, else a ZIP. */
  onDownload: () => void;
  /** Over the listing's right edge (a narrow listing) instead of beside it. */
  overlay?: boolean;
}) {
  const users = controller.store.users;
  const who = (id: string | null | undefined) => (id ? users.get(id)?.display_name ?? t("drive.someone") : "—");
  return (
    <aside aria-label={t("drive.details")} data-drive-details={overlay ? "overlay" : "beside"} className={cn("flex shrink-0 flex-col border-l border-line", overlay ? "absolute inset-y-0 right-0 z-20 w-[min(18rem,100%)] bg-canvas shadow-xl" : "w-72 bg-panel/40")}>
      <header className="flex h-11 items-center gap-2 border-b border-line px-3">
        <Info size={15} className="text-muted" />
        <strong className="flex-1 text-sm">{t("drive.details")}</strong>
        <IconButton label={t("common.close")} onClick={onClose} className="h-7 w-7"><X size={14} /></IconButton>
      </header>
      {count > 1 ? (
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted">{t("drive.selectedCount", { count })}</p>
          <Button size="sm" variant="secondary" onClick={onDownload}><Download size={13} /> {t("drive.downloadZip")}</Button>
        </div>
      ) : item ? (
        <div className="space-y-3 overflow-y-auto p-4 text-[13px]">
          <Thumb controller={controller} item={item} iconSize={40} className="h-36 w-full rounded-lg bg-panel" />
          <FileName name={(item.name && itemName(item)) || path} className="min-w-0 text-sm font-semibold" />
          {isSystemFolder(item) && <p data-drive-system-note="" className="text-xs text-muted">{t("channelFiles.folderNote")}</p>}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <dt className="text-muted">{t("drive.detail.kind")}</dt>
            <dd className="min-w-0 truncate">{item.kind === "folder" ? t("drive.detail.folder") : item.content_type ?? "—"}</dd>
            {item.kind === "file" && (
              <>
                <dt className="text-muted">{t("drive.column.size")}</dt>
                <dd>{formatBytes(item.size_bytes)}</dd>
              </>
            )}
            <dt className="text-muted">{t("drive.column.modified")}</dt>
            <dd title={exactTime(itemTime(item))}>{driveTime(itemTime(item))}</dd>
            <dt className="text-muted">{t("drive.detail.createdBy")}</dt>
            <dd className="truncate">{who(item.created_by)}</dd>
            <dt className="text-muted">{t("drive.column.by")}</dt>
            <dd className="truncate">{who(item.updated_by)}</dd>
            {item.kind === "file" && (
              <>
                <dt className="text-muted">{t("drive.detail.versions")}</dt>
                <dd>
                  <button type="button" className="text-accent hover:underline" onClick={() => onVersions(item)}>
                    {t("drive.versions.count", { count: item.version_count })}
                  </button>
                </dd>
              </>
            )}
            <dt className="text-muted">{t("drive.detail.where")}</dt>
            <dd className="break-words">{path}</dd>
            {item.posted && <PostsSection controller={controller} item={item} />}
            {item.parent_id && (canShare || item.link_count > 0) && (
              <>
                <dt className="text-muted">{t("drive.share.detail")}</dt>
                <dd>
                  <button type="button" className="text-accent hover:underline" onClick={() => onShare(item)}>
                    {item.link_count > 0 ? t("drive.share.sharedCount", { count: item.link_count }) : t("drive.share.notShared")}
                  </button>
                </dd>
              </>
            )}
          </dl>
          <div className="flex flex-wrap gap-2">
            {item.kind === "file" ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => void controller.downloadDriveFile(item)}><Download size={13} /> {t("drive.download")}</Button>
                <Button size="sm" variant="ghost" onClick={() => onVersions(item)}><History size={13} /> {t("drive.versions.open")}</Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" onClick={onDownload}><Download size={13} /> {t("drive.downloadZip")}</Button>
            )}
          </div>
        </div>
      ) : (
        <p className="p-4 text-sm text-muted">{t("drive.detailsHint")}</p>
      )}
      <p className="mt-auto border-t border-line px-4 py-2 text-[11px] text-muted">{t("drive.shortcutsHint", { key: modKey() })}</p>
    </aside>
  );
}
