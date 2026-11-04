/**
 * A drive item's menu (docs/DRIVE.md §17.2, §27) in one place, used by the drive's listing (a row's ⋯ and its right
 * click) and by the album view (a tile's ⋯ and right click, the album's ⋯, an album card's ⋯; docs/ALBUMS.md §27):
 *
 * - `useDriveItemActions`: the actions (download, the trash and a move with the warning for posted files, a copy,
 *   「アルバムにする」 / 「アルバムを解除」, the link) and the dialogs they open (rename, move / copy, the version history,
 *   the share links, 「会話に送る」, the warning). The caller says what to do with the result (read again, drop the
 *   trashed ones, take the renamed item).
 * - `DriveItemMenuItems`: the items for one item (or the selection it is part of), shown by what may be done there:
 *   reading gives open / preview, download, the link, 「会話に送る」, copy and (files) the versions; sharing gives the share
 *   links; writing (not a system folder) gives rename, the album switch, move and the trash. Drawn as a context menu's
 *   items or a drop-down menu's (the same Radix parts underneath).
 * - `ItemMenuButton`: a ⋯ that opens a context menu where it is (a click, Enter or Space).
 */
import { Copy, Download, FolderInput, History, Images, Link as LinkIcon, Link2, MessageSquareShare, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { ContextMenu, DropdownMenu } from "radix-ui";
import { type ComponentType, type ReactNode, useState } from "react";

import { ApiError } from "../api/errors";
import type { DriveItemOut, DriveLocationOut } from "../api/types";
import type { AppController } from "../state/app";
import { downloadPlan } from "../drive/actions";
import { canBecomeAlbum } from "../drive/albums";
import { canRearrange } from "../drive/channelFiles";
import { viewerKind } from "../drive/listing";
import { SendToConversationDialog } from "./DriveConversation";
import { ImpactDialog, MoveDialog, newOpId, RenameDialog, useImpactCheck } from "./DriveDialogs";
import { ShareLinksDialog } from "./DriveShareDialog";
import { VersionsDialog } from "./DriveVersions";
import { driveLink } from "./permalink";
import { cn } from "./primitives";
import { t } from "../i18n";

export const MENU_CONTENT = "rx-popover z-50 min-w-48 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
export const MENU_ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

/** Where the items are: the move / copy dialog starts there. */
export interface ItemPlace {
  location: DriveLocationOut;
  folderId: string;
}

export type ItemDialog =
  | { kind: "rename"; item: DriveItemOut }
  | { kind: "move" | "copy"; items: DriveItemOut[]; place: ItemPlace }
  | { kind: "versions"; item: DriveItemOut; location: Pick<DriveLocationOut, "can_write" | "can_manage"> }
  | { kind: "share"; item: DriveItemOut }
  | { kind: "send"; item: DriveItemOut };

export interface DriveItemActionsOptions {
  /** Something changed (moved, copied, a link, a version, an album made or undone): read again. */
  onChanged: () => void;
  /** These went to the trash (drop them from what is shown). */
  onTrashed?: (gone: ReadonlySet<string>) => void;
  /** The item came back changed (renamed, a version restored). */
  onReplaced?: (item: DriveItemOut) => void;
  /** The move / copy dialog finished (the selection is done with). */
  onMoved?: () => void;
}

export interface DriveItemActions {
  dialog: ItemDialog | null;
  show: (dialog: ItemDialog) => void;
  download: (targets: DriveItemOut[]) => void;
  trash: (targets: DriveItemOut[]) => Promise<void>;
  move: (targets: DriveItemOut[], targetFolderId: string) => Promise<void>;
  copy: (targets: DriveItemOut[], targetFolderId: string) => Promise<void>;
  setAlbum: (item: DriveItemOut, on: boolean) => Promise<void>;
  copyLink: (item: DriveItemOut) => void;
  /** The dialogs (and the posted-files warning) to draw once. */
  dialogs: ReactNode;
}

export function useDriveItemActions(controller: AppController, options: DriveItemActionsOptions): DriveItemActions {
  const api = controller.api;
  const [dialog, setDialog] = useState<ItemDialog | null>(null);
  // CF2 (docs/CHANNEL_FILES.md §6.4, §6.5): before a trash or a move, the warning when posted files would change.
  const impact = useImpactCheck(controller);
  const { onChanged, onTrashed, onReplaced, onMoved } = options;

  /** One file as it is; a folder or several items as one ZIP (M162). */
  const download = (targets: DriveItemOut[]) => {
    const plan = downloadPlan(targets);
    if (plan?.kind === "file") void controller.downloadDriveFile(plan.item);
    else if (plan?.kind === "zip") void controller.downloadDriveZip(plan.ids);
  };

  const trash = async (targets: DriveItemOut[]) => {
    if (!api || targets.length === 0) return;
    if (!canRearrange(targets)) return;
    if (!(await impact.confirm(targets.map((item) => item.id), null))) return;
    try {
      const out = await api.trashDriveItems(targets.map((item) => item.id));
      const failed = out.results.filter((result) => !result.ok);
      if (failed.length > 0) controller.setError(new ApiError(409, failed[0]!.error ?? "unknown", ""));
      const gone = new Set(out.results.filter((result) => result.ok).map((result) => result.id));
      onTrashed?.(gone);
      if (gone.size > 0) controller.setNotice(gone.size === 1 ? t("drive.trashedOne") : t("drive.trashedMany", { count: gone.size }));
    } catch (error) {
      controller.setError(error);
    }
  };

  const move = async (targets: DriveItemOut[], targetFolderId: string) => {
    if (!api || targets.length === 0) return;
    const moving = targets.filter((item) => item.id !== targetFolderId && item.parent_id !== targetFolderId);
    if (moving.length === 0 || !canRearrange(moving)) return;
    if (!(await impact.confirm(moving.map((item) => item.id), targetFolderId))) return;
    try {
      const out = await api.moveDriveItems(moving.map((item) => item.id), targetFolderId, "fail");
      const failed = out.results.filter((result) => !result.ok);
      if (failed.length > 0) controller.setError(new ApiError(409, failed[0]!.error ?? "unknown", ""));
      onChanged();
    } catch (error) {
      controller.setError(error);
    }
  };

  /** M162: copies into `targetFolderId` (numbered 「名前 (1)」 where the name is taken). */
  const copy = async (targets: DriveItemOut[], targetFolderId: string) => {
    if (!api || targets.length === 0) return;
    try {
      const out = await api.copyDriveItems(targets.map((item) => item.id), targetFolderId, "rename", newOpId());
      const failed = out.results.filter((result) => !result.ok);
      if (failed.length > 0) controller.setError(new ApiError(409, failed[0]!.error ?? "unknown", ""));
      const done = out.results.length - failed.length;
      if (done > 0) controller.setNotice(t("drive.copied", { count: done }));
      onChanged();
    } catch (error) {
      controller.setError(error);
    }
  };

  /** AL2: 「アルバムにする」 / 「アルバムを解除」 on a folder (its files stay as they are). */
  const setAlbum = async (item: DriveItemOut, on: boolean) => {
    if (!api) return;
    try {
      if (on) await api.putDriveAlbum(item.id, {});
      else await api.deleteDriveAlbum(item.id);
      controller.setNotice(on ? t("albums.made", { name: item.name }) : t("albums.removed", { name: item.name }));
      onChanged();
    } catch (error) {
      controller.setError(error);
    }
  };

  /** M165 (docs/DRIVE.md §13.1): the item's link `<server>/d/<id>` (a card in a conversation for whoever can read it). */
  const copyLink = (item: DriveItemOut) => {
    const base = api?.baseUrl;
    if (base) void controller.copyToClipboard(driveLink(base, item.id), t("driveLink.copied"));
  };

  const close = () => setDialog(null);
  const dialogs = (
    <>
      {dialog?.kind === "rename" && <RenameDialog controller={controller} item={dialog.item} onClose={close} onDone={(renamed) => {
        onReplaced?.(renamed);
        onChanged();
      }} />}
      {(dialog?.kind === "move" || dialog?.kind === "copy") && <MoveDialog controller={controller} mode={dialog.kind} items={dialog.items} startLocation={dialog.place.location} startFolderId={dialog.place.folderId} onClose={close} onMoved={(_target, failed) => {
        if (failed > 0) controller.setError(t(dialog.kind === "copy" ? "drive.someNotCopied" : "drive.someNotMoved", { count: failed }));
        else if (dialog.kind === "copy") controller.setNotice(t("drive.copied", { count: dialog.items.length }));
        onMoved?.();
        onChanged();
      }} />}
      {dialog?.kind === "send" && <SendToConversationDialog controller={controller} item={dialog.item} onClose={close} />}
      {dialog?.kind === "share" && <ShareLinksDialog controller={controller} item={dialog.item} onClose={close} onChanged={onChanged} />}
      {dialog?.kind === "versions" && (
        <VersionsDialog
          controller={controller}
          item={dialog.item}
          location={dialog.location}
          onClose={close}
          onChanged={(changed) => {
            if (changed) onReplaced?.(changed);
            onChanged();
          }}
        />
      )}
      {impact.asking && <ImpactDialog controller={controller} asking={impact.asking} />}
    </>
  );

  return { dialog, show: setDialog, download, trash, move, copy, setAlbum, copyLink, dialogs };
}

type ItemPart = ComponentType<{ className?: string; onSelect?: (event: Event) => void; children?: ReactNode; "data-item-action"?: string }>;
const PARTS: Record<"context" | "dropdown", { Item: ItemPart; Separator: ComponentType<{ className?: string }> }> = {
  context: { Item: ContextMenu.Item as ItemPart, Separator: ContextMenu.Separator },
  dropdown: { Item: DropdownMenu.Item as ItemPart, Separator: DropdownMenu.Separator },
};

/** An item that may be left out of a menu (the album's own ⋯ has buttons for some of them beside it). */
export type ItemAction = "open" | "download" | "versions" | "share" | "send" | "copyLink" | "copy" | "rename" | "album" | "move" | "trash";

export function DriveItemMenuItems({ actions, item, targets = [item], place, canWrite, canShare, onOpen, openLabel, onShowInFolder, extra, omit = [], kind = "context" }: {
  actions: DriveItemActions;
  item: DriveItemOut;
  /** The selection the item is part of (several: only what applies to all of them). */
  targets?: DriveItemOut[];
  /** Where the item is (for the move / copy dialog). Without it there is no 「コピー」 or 「移動」. */
  place: ItemPlace | null;
  /** May write in the item's location (rename, move, the trash, the album switch). */
  canWrite: boolean;
  /** May make share links in the item's location (one with links already shows them anyway). */
  canShare: boolean;
  onOpen?: () => void;
  openLabel?: string;
  /** A search hit's 「フォルダで表示」. */
  onShowInFolder?: () => void;
  /** Items of the caller's own (the album's 「表紙にする」), after the reading ones. */
  extra?: ReactNode;
  omit?: readonly ItemAction[];
  kind?: "context" | "dropdown";
}) {
  const { Item, Separator } = PARTS[kind];
  const many = targets.length > 1;
  const shown = (action: ItemAction) => !omit.includes(action);
  const single = !many && !!item.parent_id;
  const writes = canWrite && canRearrange(targets);
  return (
    <>
      {!many && onOpen && shown("open") && (
        <Item className={MENU_ITEM} data-item-action="open" onSelect={onOpen}>{openLabel ?? (item.kind === "folder" ? t("drive.open") : viewerKind(item) ? t("drive.preview") : t("drive.details"))}</Item>
      )}
      {shown("download") && (
        <Item className={MENU_ITEM} data-item-action="download" onSelect={() => actions.download(targets)}><Download size={14} /> {many || item.kind === "folder" ? t("drive.downloadZip") : t("drive.download")}</Item>
      )}
      {!many && item.kind === "file" && place && shown("versions") && (
        <Item className={MENU_ITEM} data-item-action="versions" onSelect={() => actions.show({ kind: "versions", item, location: place.location })}><History size={14} /> {t("drive.versions.open")}</Item>
      )}
      {single && (canShare || item.link_count > 0) && shown("share") && (
        <Item className={MENU_ITEM} data-item-action="share" onSelect={() => actions.show({ kind: "share", item })}><Link2 size={14} /> {t("drive.share.open")}</Item>
      )}
      {single && shown("send") && (
        <Item className={MENU_ITEM} data-item-action="send" onSelect={() => actions.show({ kind: "send", item })}><MessageSquareShare size={14} /> {t("driveLink.send")}</Item>
      )}
      {single && shown("copyLink") && (
        <Item className={MENU_ITEM} data-item-action="copy-link" onSelect={() => actions.copyLink(item)}><LinkIcon size={14} /> {t("driveLink.copy")}</Item>
      )}
      {onShowInFolder && single && (
        <Item className={MENU_ITEM} data-item-action="show-in-folder" onSelect={onShowInFolder}><FolderInput size={14} /> {t("drive.showInFolder")}</Item>
      )}
      {extra}
      {place && shown("copy") && (
        // Copying needs only reading here (the dialog lists the folders I can write in).
        <Item className={MENU_ITEM} data-item-action="copy" onSelect={() => actions.show({ kind: "copy", items: targets, place })}><Copy size={14} /> {t("drive.copy")}</Item>
      )}
      {writes && (
        <>
          <Separator className="my-1 h-px bg-line" />
          {!many && shown("rename") && <Item className={MENU_ITEM} data-item-action="rename" onSelect={() => actions.show({ kind: "rename", item })}><Pencil size={14} /> {t("drive.rename")}</Item>}
          {!many && shown("album") && canBecomeAlbum(item) && <Item data-drive-make-album="" className={MENU_ITEM} onSelect={() => void actions.setAlbum(item, true)}><Images size={14} /> {t("albums.make")}</Item>}
          {!many && shown("album") && item.kind === "folder" && item.album && <Item data-drive-unmake-album="" className={MENU_ITEM} onSelect={() => void actions.setAlbum(item, false)}><Images size={14} /> {t("albums.unmake")}</Item>}
          {place && shown("move") && <Item className={MENU_ITEM} data-item-action="move" onSelect={() => actions.show({ kind: "move", items: targets, place })}><FolderInput size={14} /> {t("drive.move")}</Item>}
          {shown("trash") && <Item className={cn(MENU_ITEM, "text-danger")} data-item-action="trash" onSelect={() => void actions.trash(targets)}><Trash2 size={14} /> {t("drive.toTrash")}</Item>}
        </>
      )}
    </>
  );
}

/** A ⋯ that opens `children` (context menu items) as a menu below it; it never reaches what it sits on. */
export function ItemMenuButton({ children, className, iconSize = 15, ...data }: { children: ReactNode; className?: string; iconSize?: number } & { [key: `data-${string}`]: string }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          type="button"
          aria-label={t("drive.actions")}
          aria-haspopup="menu"
          title={t("drive.actions")}
          className={className ?? "rounded-md p-1 text-muted hover:bg-ink/8 hover:text-ink"}
          {...data}
          onClick={(event) => {
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom }));
          }}
        >
          <MoreHorizontal size={iconSize} />
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_CONTENT} collisionPadding={8}>{children}</ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
