/**
 * M165 (docs/DRIVE.md §13.1): a `<server>/d/<id>` link in a message as a card — the item as it is now (its current name,
 * a thumbnail or the first page, where it is, its size). A photo, a video or a document with a preview opens in the
 * app's viewer; a folder and any other file open in 「ドライブ」 at their folder (「ドライブで表示」). Whoever cannot
 * read the item (another location, a guest and 研究室ドライブ, the trash, deleted) sees 「表示できないファイル」 and
 * nothing of it, not even its name: the link changes no permission.
 */
import { FolderInput, Images, Loader2, Lock, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AppController, DriveLinkState } from "../state/app";
import type { AlbumOut, DriveItemDetailOut } from "../api/types";
import { albumLine } from "../drive/albums";
import { cardDetails, locationLine } from "../drive/conversation";
import { thumbnailPath, viewerKind } from "../drive/listing";
import { DriveIcon, useThumbnail } from "./DriveBrowser";
import { DriveViewer } from "./DriveViewer";
import { FileName } from "./FileName";
import { cn, IconButton } from "./primitives";
import { t } from "../i18n";

const SHELL = "my-1 flex w-full max-w-md items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5 text-left align-top";

export function DriveLinkCard({ controller, itemId, url }: { controller: AppController; itemId: string; url: string }) {
  const [link, setLink] = useState<DriveLinkState | null>(null);
  const [viewing, setViewing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    // A card on screen stays while it is read again (an album that changed); a failed one shows the loading again.
    setLink((held) => (held?.state === "ok" && held.detail.item.id === itemId ? held : null));
    void controller.driveLink(itemId, attempt > 0).then((state) => {
      if (current) setLink(state);
    });
    return () => {
      current = false;
    };
  }, [controller, itemId, attempt]);

  const detail = link?.state === "ok" ? link.detail : null;
  const item = detail?.item ?? null;
  const thumbnail = useThumbnail(controller, item ? thumbnailPath(item) : null);

  if (!link) {
    return (
      <span data-drive-card={itemId} className={cn(SHELL, "text-sm text-muted")}>
        <Loader2 size={18} className="shrink-0 animate-spin" /> {t("driveCard.loading")}
      </span>
    );
  }
  if (link.state === "unreadable") {
    return (
      <span data-drive-card={itemId} data-readable="false" className={cn(SHELL, "text-sm")}>
        <Lock size={18} className="shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="block font-medium">{t("driveCard.unavailable")}</span>
          <span className="block text-xs text-muted">{t("driveCard.unavailableNote")}</span>
        </span>
      </span>
    );
  }
  if (!detail || !item) {
    return (
      <button type="button" data-drive-card={itemId} title={url} className={cn(SHELL, "text-sm")} onClick={() => setAttempt((n) => n + 1)}>
        <TriangleAlert size={18} className="shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="block font-medium">{t("driveCard.failed")}</span>
          <span className="block text-xs text-muted">{t("driveCard.retry")}</span>
        </span>
      </button>
    );
  }
  // AL2 (docs/ALBUMS.md §10.4): an album's card.
  if (item.kind === "folder" && item.album) return <AlbumCard controller={controller} itemId={itemId} url={url} detail={detail} album={item.album} onChanged={() => setAttempt((n) => n + 1)} />;
  const viewer = viewerKind(item);
  const open = () => {
    if (viewer) setViewing(true);
    else void controller.openDriveLink(itemId);
  };
  return (
    <span data-drive-card={itemId} data-readable="true" className={cn(SHELL, "p-0 pr-1.5")}>
      <button
        type="button"
        title={url}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent-soft/40"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-panel-2">
          {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-cover" /> : <DriveIcon item={item} size={20} />}
        </span>
        <span className="min-w-0 flex-1">
          <FileName name={item.name} className="text-sm font-semibold text-ink" />
          <span className="block truncate text-xs text-muted">{cardDetails(detail)}</span>
        </span>
      </button>
      {item.kind === "file" && (
        <IconButton
          label={t("driveCard.showInDrive")}
          className="h-8 w-8 shrink-0 text-muted hover:text-ink"
          onClick={(event) => {
            event.stopPropagation();
            void controller.openDriveLink(itemId);
          }}
        >
          <FolderInput size={16} />
        </IconButton>
      )}
      {viewing && viewer && <DriveViewer controller={controller} item={item} siblings={[item]} onStep={() => undefined} onClose={() => setViewing(false)} />}
    </span>
  );
}

function CardThumb({ controller, attachmentId }: { controller: AppController; attachmentId: string | undefined }) {
  const url = useThumbnail(controller, attachmentId ? `/api/v1/attachments/${attachmentId}/thumbnail` : null);
  return <span className="block h-full w-full bg-panel-2">{url && <img src={url} alt="" className="h-full w-full object-cover" />}</span>;
}

/**
 * AL2 (docs/ALBUMS.md §10.4): a `/d/<folder>` link to an album — four of its photos (2 × 2), its title, 「312 枚 ·
 * 2026/9/16〜9/19」 and where it is; a press opens the album in 「ドライブ」. It reads itself again when the album
 * changes (drive.changed for its folder or the folder above it). Whoever cannot read it sees the plain
 * 「表示できないファイル」 (above), never its name or count.
 */
export function AlbumCard({ controller, itemId, url, detail, album, onChanged }: {
  controller: AppController;
  itemId: string;
  url: string;
  detail: DriveItemDetailOut;
  album: AlbumOut;
  onChanged: () => void;
}) {
  const engine = controller.engine;
  const parentId = detail.item.parent_id;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => engine?.drive.subscribe((signal) => {
    if (signal.kind === "changed" && signal.locationId === detail.item.location_id && (signal.folderIds.includes(itemId) || (!!parentId && signal.folderIds.includes(parentId)))) changed.current();
  }), [engine, itemId, parentId, detail.item.location_id]);
  const previews = album.preview_attachment_ids.slice(0, 4);
  const where = locationLine(detail.path, detail.location_kind);
  return (
    <button
      type="button"
      data-drive-card={itemId}
      data-album-card=""
      data-readable="true"
      title={url}
      onClick={(event) => {
        event.stopPropagation();
        void controller.openDriveLink(itemId);
      }}
      className="my-1 flex w-full max-w-md items-stretch gap-3 overflow-hidden rounded-xl border border-line bg-panel p-2 text-left align-top transition-colors hover:bg-accent-soft/40"
    >
      <span data-album-card-photos={previews.length} className="grid h-[88px] w-[88px] shrink-0 grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-lg">
        {previews.length === 0 ? (
          <span className="col-span-2 row-span-2 flex items-center justify-center bg-panel-2"><Images size={26} className="text-muted" /></span>
        ) : (
          [0, 1, 2, 3].map((index) => <CardThumb key={index} controller={controller} attachmentId={previews[index]} />)
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted"><Images size={12} /> {t("albums.cardKind")}</span>
        <FileName name={detail.item.name} className="text-sm font-semibold text-ink" />
        <span data-album-card-line="" className="block truncate text-xs text-muted">{albumLine(album)}</span>
        {where && <span className="block truncate text-[11.5px] text-muted">{where}</span>}
      </span>
    </button>
  );
}
