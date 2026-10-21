/**
 * M165 (docs/DRIVE.md §13.1): a `<server>/d/<id>` link in a message as a card — the item as it is now (its current name,
 * a thumbnail or the first page, where it is, its size). A photo, a video or a document with a preview opens in the
 * app's viewer; a folder and any other file open in 「ドライブ」 at their folder (「ドライブで表示」). Whoever cannot
 * read the item (another location, a guest and 研究室ドライブ, the trash, deleted) sees 「表示できないファイル」 and
 * nothing of it, not even its name: the link changes no permission.
 */
import { FolderInput, Loader2, Lock, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import type { AppController, DriveLinkState } from "../state/app";
import { cardDetails } from "../drive/conversation";
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
    setLink(null);
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
