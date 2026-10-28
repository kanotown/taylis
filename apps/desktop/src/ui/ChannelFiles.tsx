/**
 * CF2 (docs/CHANNEL_FILES.md §12): the screens' pieces for files posted in a channel, which live in the channel's drive
 * too. In a message (§12.1): a file in the trash or deleted for good is 「削除されたファイル」 (nothing of it: no name, no
 * thumbnail; 「戻す」 for who can write the drive while it is in the trash), one moved elsewhere is drawn as before for
 * who can read it there (GET /drive/items/{id}, a minute's memory as the `/d/` cards) and 「表示できないファイル」 for
 * anyone else, and the viewers say where it is and whether the drive has a newer version. In the drive (§12.2): the
 * folder 「投稿のファイル」's own icon, the mark of a file attached to a message and its 「投稿」 in the details. The
 * delete's check box (§7.3), the composer's line (§12.3) and the channel's switch (§12.7).
 *
 * The status is said by an icon and the text's colour only (no coloured band, §12.1). The pieces drawn in a message
 * are in the share page's bundle too (Attachments.tsx): the drive's viewer is loaded when asked for.
 */
import { Folder, FolderInput, Loader2, Lock, MessageSquare, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";

import type { AttachmentOut, DriveItemOut, DrivePostOut } from "../api/types";
import type { AppController, DriveLinkState } from "../state/app";
import type { ChannelState, MessageState } from "../sync/types";
import { asksDriveFiles, canRestorePosted, choiceValue, type DeleteDriveFiles, deleteDriveFiles, driveFilesParam, filesToDrive, filesToDriveChoice, type FilesToDriveChoice, hasNewerVersion, postedItemId } from "../drive/channelFiles";
import { locationLine } from "../drive/conversation";
import { driveTime, exactTime, itemTime } from "../drive/listing";
import { cn } from "./primitives";
import { t } from "../i18n";

const DriveViewer = lazy(() => import("./DriveViewer").then((module) => ({ default: module.DriveViewer })));

// --- the drive ------------------------------------------------------------------------------------------------------

/** 「投稿のファイル」's icon: a folder with a speech bubble (§12.2). */
export function SystemFolderIcon({ size = 18, className }: { size?: number; className?: string }) {
  const bubble = Math.max(8, Math.round(size * 0.55));
  return (
    <span data-drive-icon="channel_posts" aria-hidden className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <Folder size={size} className={cn("shrink-0", className)} />
      <MessageSquare size={bubble} strokeWidth={2.5} className="absolute -bottom-0.5 -right-1 rounded-sm bg-canvas text-muted" />
    </span>
  );
}

/** A drive row's mark: the file is attached to a message (DriveItemOut.posted). */
export function PostedMark() {
  return (
    <span data-drive-posted="" title={t("channelFiles.posted")} aria-label={t("channelFiles.posted")} role="img" className="inline-flex shrink-0 text-muted">
      <MessageSquare size={12} aria-hidden />
    </span>
  );
}

/** What GET /drive/items/{id} says of an item (the minute's memory of the `/d/` cards); null while asked. */
function useDriveLink(controller: AppController, itemId: string | null, attempt = 0): DriveLinkState | null {
  const [state, setState] = useState<{ id: string | null; attempt: number; link: DriveLinkState | null }>({ id: itemId, attempt, link: null });
  useEffect(() => {
    if (!itemId) return;
    let current = true;
    void controller.driveLink(itemId, attempt > 0).then((link) => {
      if (current) setState({ id: itemId, attempt, link });
    });
    return () => {
      current = false;
    };
  }, [controller, itemId, attempt]);
  return state.id === itemId && state.attempt === attempt ? state.link : null;
}

/**
 * The details pane's 「投稿」 (§12.2): who posted the file where and when — 「三井 · 10/28 15:02 · #m2（スレッド）」 —
 * with 「メッセージを表示」, from GET /drive/items/{id} `posts` (the messages I can read, five at most).
 */
export function PostsSection({ controller, item }: { controller: AppController; item: Pick<DriveItemOut, "id"> }) {
  const link = useDriveLink(controller, item.id);
  const posts: DrivePostOut[] = link?.state === "ok" ? (link.detail.item.posts ?? []) : [];
  return (
    <>
      <dt className="text-muted">{t("channelFiles.posts")}</dt>
      <dd data-drive-posts="" className="min-w-0 space-y-1.5">
        {!link ? (
          <Loader2 size={13} className="animate-spin text-muted" />
        ) : posts.length === 0 ? (
          <span className="text-muted">{t("channelFiles.posted")}</span>
        ) : (
          posts.map((post) => <PostLine key={post.message_id} controller={controller} post={post} />)
        )}
      </dd>
    </>
  );
}

function PostLine({ controller, post }: { controller: AppController; post: DrivePostOut }) {
  const store = controller.store;
  const who = store.users.get(post.sender_id)?.display_name ?? t("drive.someone");
  const channel = store.getChannel(post.channel_id);
  const where = channel?.name ? `#${channel.name}` : t("channelFiles.impact.aChannel");
  return (
    <div data-drive-post={post.message_id}>
      <div className="break-words">
        {who} · <span title={exactTime(post.posted_at)}>{driveTime(post.posted_at)}</span> · {post.parent_id ? t("channelFiles.inThread", { where }) : where}
      </div>
      <button type="button" className="text-accent hover:underline" onClick={() => void controller.openPermalink(post.message_id)}>
        {t("channelFiles.showMessage")}
      </button>
    </div>
  );
}

// --- a message's files ------------------------------------------------------------------------------------------------

/**
 * A file in the trash or deleted for good (§12.1): one quiet line, nothing of the file. In the trash, who can write the
 * channel's drive is offered 「ゴミ箱にあります · 戻す」.
 */
export function RemovedPostedFile({ attachment, controller, channel }: { attachment: AttachmentOut; controller: AppController; channel: ChannelState | null }) {
  const [busy, setBusy] = useState(false);
  const itemId = attachment.drive?.item_id ?? null;
  const trashed = attachment.drive?.state === "trashed" && !!itemId;
  const restorable = trashed && canRestorePosted(channel, controller.can("channels.moderate"));
  return (
    <div data-posted-file={attachment.drive?.state ?? "deleted"} className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted">
      <Trash2 size={16} className="shrink-0" aria-hidden />
      <span>{t("channelFiles.removed")}</span>
      {restorable && (
        <>
          <span aria-hidden>·</span>
          <span className="text-xs">{t("channelFiles.inTrash")}</span>
          <button
            type="button"
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
            onClick={() => {
              setBusy(true);
              void controller.restorePostedFile(itemId!).finally(() => setBusy(false));
            }}
          >
            <RotateCcw size={12} aria-hidden /> {t("channelFiles.restore")}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * A file moved to another location (§12.1): GET /drive/items/{id} decides. Readable: drawn as before (`children`) with
 * the place it is in now; not: 「表示できないファイル」 and nothing of it (not even its name).
 */
export function MovedPostedFile({ attachment, controller, children }: { attachment: AttachmentOut; controller: AppController; children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const itemId = attachment.drive?.item_id ?? null;
  const link = useDriveLink(controller, itemId, attempt);
  if (!link) {
    return (
      <div data-posted-file="checking" role="status" className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm text-muted">
        <Loader2 size={16} className="shrink-0 animate-spin" aria-hidden /> {t("channelFiles.checking")}
      </div>
    );
  }
  if (link.state === "unreadable") {
    return (
      <div data-posted-file="unreadable" className="flex max-w-md items-center gap-3 rounded-xl border border-line px-3 py-2 text-sm">
        <Lock size={16} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0">
          <span className="block font-medium">{t("channelFiles.unavailable")}</span>
          <span className="block text-xs text-muted">{t("channelFiles.movedNote")}</span>
        </span>
      </div>
    );
  }
  if (link.state === "error") {
    return (
      <button type="button" data-posted-file="failed" onClick={() => setAttempt((n) => n + 1)} className="flex max-w-md items-center gap-3 rounded-xl border border-line px-3 py-2 text-left text-sm text-muted">
        <TriangleAlert size={16} className="shrink-0" aria-hidden /> {t("channelFiles.failed")}
      </button>
    );
  }
  return (
    <div data-posted-file="moved" className="flex max-w-full flex-col items-start gap-1">
      {children}
      <button type="button" className="inline-flex max-w-full items-center gap-1 text-xs text-muted hover:text-ink" onClick={() => void controller.openDriveLink(link.detail.item.id)}>
        <FolderInput size={12} className="shrink-0" aria-hidden />
        <span className="truncate">{locationLine(link.detail.path, link.detail.location_kind)}</span>
      </button>
    </div>
  );
}

/**
 * The viewers' line under the name (§12.1): 「ドライブ：#m2 › 投稿のファイル › 2026-10」 (a press shows it there) and, when
 * the drive holds a newer version than the message shows, 「新しいバージョンがあります（…）」 with 「最新を開く」. Asked
 * only when a viewer opens (never per row of a timeline, §4.3).
 */
export function PostedFileLine({ attachment, controller, onClose }: { attachment: AttachmentOut; controller: AppController; onClose?: () => void }) {
  const itemId = postedItemId(attachment);
  const link = useDriveLink(controller, itemId);
  const [latest, setLatest] = useState<DriveItemOut | null>(null);
  if (!itemId || link?.state !== "ok") return null;
  const detail = link.detail;
  const newer = hasNewerVersion(attachment.drive, detail.item);
  const who = detail.item.updated_by ? controller.store.users.get(detail.item.updated_by)?.display_name ?? t("drive.someone") : t("drive.someone");
  return (
    <div data-posted-line="" className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-white/70">
      <button
        type="button"
        className="inline-flex min-w-0 items-center gap-1 hover:text-white hover:underline"
        onClick={() => {
          onClose?.();
          void controller.openDriveLink(itemId);
        }}
      >
        <FolderInput size={12} className="shrink-0" aria-hidden />
        <span className="truncate">{t("channelFiles.driveLine", { path: locationLine(detail.path, detail.location_kind) })}</span>
      </button>
      {newer && (
        <span data-posted-newer="" className="inline-flex items-center gap-1.5">
          <span>{t("channelFiles.newerVersion", { when: driveTime(itemTime(detail.item)), who })}</span>
          <button type="button" className="rounded px-1 font-medium text-white underline-offset-2 hover:underline" onClick={() => setLatest(detail.item)}>
            {t("channelFiles.openLatest")}
          </button>
        </span>
      )}
      {latest && (
        <Suspense fallback={null}>
          <DriveViewer controller={controller} item={latest} siblings={[latest]} onStep={() => undefined} onClose={() => setLatest(null)} />
        </Suspense>
      )}
    </div>
  );
}

// --- the delete's check box (§7.3) ------------------------------------------------------------------------------------

/**
 * Under 「このメッセージを削除しますか？」: 「ドライブの 2 件のファイルもゴミ箱に移す」 (on by default: what the server's
 * auto would do), and why the others stay. Asked of the server when it opens (GET /messages/{id}/drive-files);
 * `onChange` hands the delete's `drive_files` (undefined: say nothing, the server's auto).
 */
export function DeleteDriveFilesOption({ controller, message, onChange, tone = "panel" }: {
  controller: AppController;
  message: Pick<MessageState, "id" | "attachments">;
  onChange: (driveFiles: "auto" | "keep" | undefined) => void;
  tone?: "panel" | "sheet";
}) {
  const asks = asksDriveFiles(message.attachments);
  const [summary, setSummary] = useState<DeleteDriveFiles | null>(null);
  const [checked, setChecked] = useState(true);
  useEffect(() => {
    if (!asks) return;
    let current = true;
    void controller.messageDriveFiles(message.id).then((files) => {
      if (!current || !files || files.length === 0) return;
      setSummary(deleteDriveFiles(files));
    });
    return () => {
      current = false;
    };
  }, [asks, controller, message.id]);
  useEffect(() => {
    onChange(driveFilesParam(summary, checked));
    // `onChange` is the caller's setter: only the answer matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, checked]);
  if (!summary) return null;
  return (
    <div data-delete-drive-files="" className={cn("space-y-1 text-xs text-muted", tone === "sheet" ? "text-[13px]" : "mt-2")}>
      {summary.trash > 0 ? (
        <label className="flex cursor-pointer items-start gap-2 text-ink">
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>
            {t("channelFiles.delete.trash", { count: summary.trash })}
            <span className="block text-muted">{t("channelFiles.delete.trashNote")}</span>
          </span>
        </label>
      ) : (
        <p>{t("channelFiles.delete.stay")}</p>
      )}
      {summary.changed > 0 && <p>{t("channelFiles.delete.changed", { count: summary.changed })}</p>}
    </div>
  );
}

// --- the composer and the channel's switch (§12.3, §12.7) --------------------------------------------------------------

/** Under the composer's files: 「ファイルは #m2 のドライブ『投稿のファイル』にも保存されます」 (a channel with the switch on). */
export function ComposerDriveHint({ controller, channel, shown }: { controller: AppController; channel: ChannelState; shown: boolean }) {
  if (!shown || !filesToDrive(channel, controller.store.workspaceSettings)) return null;
  return (
    <p data-composer-drive-hint="" className="flex items-center gap-1.5 px-3 pb-1 text-[11.5px] text-muted">
      <Folder size={12} className="shrink-0" aria-hidden />
      {t("channelFiles.composerHint", { where: `#${channel.name ?? ""}` })}
    </p>
  );
}

/** The three choices and their names: 「ワークスペースに従う（オン）」, 「保存する」, 「保存しない」. */
export function filesToDriveChoices(controller: AppController): { value: FilesToDriveChoice; label: string }[] {
  const workspaceOn = controller.store.workspaceSettings?.channel_files_to_drive !== false;
  return [
    { value: "workspace", label: t("channelFiles.settings.workspace", { state: workspaceOn ? t("channelFiles.settings.stateOn") : t("channelFiles.settings.stateOff") }) },
    { value: "on", label: t("channelFiles.settings.on") },
    { value: "off", label: t("channelFiles.settings.off") },
  ];
}

/**
 * Whether the channel's switch is offered: a public or private channel I manage (owner, or by right), on a server that
 * knows it (CF1 sends the workspace's channel_files_to_drive).
 */
export function offersFilesToDrive(controller: AppController, channel: ChannelState, canManage: boolean): boolean {
  if (channel.type !== "public" && channel.type !== "private") return false;
  if (!canManage || channel.archived) return false;
  return typeof controller.store.workspaceSettings?.channel_files_to_drive === "boolean";
}

/** The channel details page's switch (a phone's 「設定」): three radios. */
export function FilesToDriveSetting({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const current = filesToDriveChoice(channel);
  return (
    <section aria-label={t("channelFiles.settings.title")} data-files-to-drive={current}>
      <h3 className="text-xs font-semibold text-muted">{t("channelFiles.settings.title")}</h3>
      <div role="radiogroup" aria-label={t("channelFiles.settings.title")} className="mt-1">
        {filesToDriveChoices(controller).map((choice) => (
          <label key={choice.value} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel">
            <input
              type="radio"
              name={`files-to-drive-${channel.id}`}
              className="h-4 w-4 accent-[var(--accent)]"
              checked={current === choice.value}
              onChange={() => void controller.setChannelFilesToDrive(channel.id, choiceValue(choice.value))}
            />
            {choice.label}
          </label>
        ))}
      </div>
      <p className="px-3 text-xs text-muted">{t("channelFiles.settings.note")}</p>
    </section>
  );
}
