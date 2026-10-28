/**
 * AL2 (docs/ALBUMS.md §10.1): 「アルバム」 at the top of the drive's locations column — every album of the locations I
 * can read, newest first (GET /drive/albums, 50 at a time), each with its cover, title, count and days, and where it
 * is. The search (GET /search/drive?kind=album) finds them by name and description. 「新しいアルバム」 makes one in a
 * location I can write (its 「アルバム」 folder). drive.changed reads the list again (once a second at most).
 */
import { Images, Loader2, Plus, Search, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { describeError } from "../api/errors";
import type { AlbumOut, DriveCrumb, DriveItemOut, DriveLocationOut } from "../api/types";
import type { AppController } from "../state/app";
import { albumLine } from "../drive/albums";
import { localizedPath } from "../drive/channelFiles";
import { pathLine } from "../drive/listing";
import { coalesce } from "../sync/drive";
import { NewAlbumDialog } from "./AlbumDialogs";
import { useThumbnail } from "./DriveBrowser";
import { Button, Input } from "./primitives";
import { t } from "../i18n";

export interface AlbumEntry {
  folder: DriveItemOut;
  album: AlbumOut | null;
  path: DriveCrumb[];
  location_kind: "workspace" | "channel" | "user";
}

/** Where an album is, in the UI language, without the album itself: 「研究室ドライブ › アルバム」. */
export function albumWhere(entry: Pick<AlbumEntry, "path" | "location_kind">): string {
  const root = entry.location_kind === "workspace" ? t("drive.location.workspace") : entry.location_kind === "user" ? t("drive.location.mine") : `#${entry.path[0]?.name ?? ""}`;
  return pathLine(localizedPath(entry.path, entry.location_kind), root);
}

function AlbumTile({ controller, entry, onOpen }: { controller: AppController; entry: AlbumEntry; onOpen: () => void }) {
  const cover = entry.album?.cover?.attachment_id ?? entry.album?.preview_attachment_ids[0] ?? null;
  const url = useThumbnail(controller, cover ? `/api/v1/attachments/${cover}/thumbnail` : null);
  return (
    <li>
      <button type="button" data-album-entry={entry.folder.id} onClick={onOpen} className="group flex w-full min-w-0 flex-col text-left">
        <span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg bg-panel ring-1 ring-line group-hover:ring-ink/25">
          {url ? <img src={url} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]" /> : <Images size={34} className="text-muted" />}
        </span>
        <span className="mt-2 block truncate text-[14px] font-semibold">{entry.folder.name}</span>
        {entry.album && <span className="block truncate text-xs text-muted">{albumLine(entry.album)}</span>}
        <span className="block truncate text-[11.5px] text-muted">{albumWhere(entry)}</span>
      </button>
    </li>
  );
}

export function AlbumsHome({ controller, locations, onOpen, header }: {
  controller: AppController;
  locations: readonly DriveLocationOut[];
  onOpen: (target: { locationId: string; folderId: string }) => void;
  header?: ReactNode;
}) {
  const api = controller.api;
  const engine = controller.engine;
  const [entries, setEntries] = useState<AlbumEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<AlbumEntry[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (after: string | null = null) => {
    if (!api) return;
    try {
      const out = await api.driveAlbums({ cursor: after, limit: 50 });
      setEntries((held) => [...(after ? held ?? [] : []), ...out.items]);
      setCursor(out.next_cursor);
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
      setEntries((held) => held ?? []);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const again = coalesce(() => void load(), 1000);
    const unsubscribe = engine?.drive.subscribe((signal) => {
      if (signal.kind === "changed" || signal.kind === "resync" || signal.kind === "locations") again.poke();
    });
    return () => {
      again.cancel();
      unsubscribe?.();
    };
  }, [engine, load]);

  // The search: names and descriptions (§14).
  useEffect(() => {
    const words = query.trim();
    if (!api || !words) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api.searchDrive({ q: words, kind: "album", limit: 50 }).then(
        (out) => { if (!cancelled) setHits(out.items.filter((hit) => hit.item.kind === "folder").map((hit) => ({ folder: hit.item, album: hit.item.album ?? null, path: hit.path, location_kind: hit.location_kind }))); },
        (failure) => { if (!cancelled) { setHits([]); controller.setError(failure); } },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, query, controller]);

  const writable = locations.filter((loc) => loc.can_write);
  const shown = hits ?? entries;
  const open = (entry: AlbumEntry) => onOpen({ locationId: entry.folder.location_id, folderId: entry.folder.id });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-albums-home="">
      <div className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        {header}
        <strong className="mr-auto flex items-center gap-2 text-[17px] font-semibold"><Images size={17} className="text-muted" /> {t("albums.title")}</strong>
        <label className="relative flex items-center">
          <Search size={14} className="pointer-events-none absolute left-2.5 text-muted" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("albums.search")} aria-label={t("albums.search")} className="h-8 w-56 rounded-full py-1 pl-8 pr-7 text-[13px] max-md:w-40" />
          {query && <button type="button" aria-label={t("drive.clearSearch")} className="absolute right-2 rounded p-0.5 text-muted hover:text-ink" onClick={() => setQuery("")}><X size={13} /></button>}
        </label>
        {writable.length > 0 && <Button size="sm" data-albums-new="" onClick={() => setCreating(true)}><Plus size={14} /> {t("albums.new")}</Button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4" data-scroll-memory="">
        {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
        {shown === null ? (
          <div className="flex justify-center py-10 text-muted"><Loader2 size={18} className="animate-spin" /></div>
        ) : shown.length === 0 ? (
          <div data-albums-empty="" className="flex flex-col items-center gap-2 py-14 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-panel"><Images size={28} className="text-muted" /></span>
            <strong className="text-[15px]">{hits ? t("albums.noMatch") : t("albums.none")}</strong>
            {!hits && <span className="max-w-sm text-sm text-muted">{t("albums.noneHint")}</span>}
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-x-4 gap-y-5">
            {shown.map((entry) => <AlbumTile key={entry.folder.id} controller={controller} entry={entry} onOpen={() => open(entry)} />)}
          </ul>
        )}
        {!hits && cursor && (
          <div className="mt-4 flex justify-center"><Button size="sm" variant="ghost" onClick={() => void load(cursor)}>{t("drive.showMore")}</Button></div>
        )}
      </div>
      {creating && (
        <NewAlbumDialog
          controller={controller}
          locations={writable}
          location={writable.find((loc) => loc.kind === "workspace") ?? writable[0] ?? null}
          onClose={() => setCreating(false)}
          onMade={(made) => onOpen({ locationId: made.folder.location_id, folderId: made.folder.id })}
        />
      )}
    </div>
  );
}
