/**
 * CF2 (docs/CHANNEL_FILES.md §12, §19.3): the plain rules of the files posted in a channel, which live in the channel's
 * drive too — what a message shows for each state, the server's 「投稿のファイル」 folder, the composer's line, the
 * delete's check box and the warning before a move or a trash. Kept apart from the screens so the tests read them.
 */
import type { AttachmentDriveOut, AttachmentOut, DriveCrumb, DriveImpactOut, DriveItemOut, DriveLocationOut, DriveMessageFileOut, WorkspaceSettingsOut } from "../api/types";
import type { ChannelState } from "../sync/types";
import { t } from "../i18n";

/** The name the server stores for 「投稿のファイル」 (CHANNEL_FILES.md §3.3); the screens show their own language's. */
export const POSTED_FOLDER_STORED_NAME = "投稿のファイル";

/**
 * How a message draws one of its files (§12.1):
 * - "plain": an ordinary attachment (a DM, a server before CF1, a channel with the switch off);
 * - "available": in the channel's drive — drawn as before, with 「ドライブで表示」;
 * - "moved": in another location — readable only by who can read it there (the client asks GET /drive/items/{id});
 * - "gone": in the trash or deleted for good — 「削除されたファイル」, nothing of it (no name, no thumbnail).
 */
export type PostedView = "plain" | "available" | "moved" | "gone";

export function postedView(attachment: Pick<AttachmentOut, "drive">): PostedView {
  const drive = attachment.drive;
  if (!drive) return "plain";
  if (drive.state === "available") return "available";
  if (drive.state === "moved") return drive.item_id ? "moved" : "gone";
  return "gone";
}

/** The item a 「ドライブで表示」 opens (null: none, a tombstone or a plain attachment). */
export function postedItemId(attachment: Pick<AttachmentOut, "drive">): string | null {
  const view = postedView(attachment);
  return view === "available" || view === "moved" ? (attachment.drive?.item_id ?? null) : null;
}

/** The message's first file that can be shown in the drive (the message menu's 「ドライブで表示」). */
export function firstPostedItem(attachments: readonly AttachmentOut[] | undefined): AttachmentOut | null {
  return (attachments ?? []).find((attachment) => postedItemId(attachment) !== null) ?? null;
}

/**
 * 「新しいバージョンがあります」 (§4.1, §12.1): the drive's current version is not the one the message shows. False when
 * the item is not a file or the message carries no version (a tombstone).
 */
export function hasNewerVersion(drive: Pick<AttachmentDriveOut, "version_id"> | null | undefined, item: Pick<DriveItemOut, "kind" | "file">): boolean {
  if (!drive?.version_id || item.kind !== "file" || !item.file) return false;
  return item.file.version_id !== drive.version_id;
}

/**
 * Who sees 「ゴミ箱にあります · 戻す」 under a trashed file (§12.1): whoever can write the channel's drive (DRIVE.md §3.2,
 * the server's drive/access.py) — a member of a channel that is not archived, where everyone posts, or its owner or a
 * moderator where only owners do. The server decides again; this only hides a button that would be refused.
 */
export function canRestorePosted(channel: Pick<ChannelState, "isMember" | "archived" | "posting_policy" | "membership" | "type"> | null | undefined, canModerate: boolean): boolean {
  if (!channel || !channel.isMember || channel.archived) return false;
  if (channel.type !== "public" && channel.type !== "private") return false;
  return channel.posting_policy !== "owners" || canModerate || channel.membership?.role === "owner";
}

// --- the server's folder 「投稿のファイル」 -----------------------------------------------------------------------

/** 「投稿のファイル」 only: the 「アルバム」 folder (`albums`, docs/ALBUMS.md §23) is an ordinary folder with a localized name. */
export function isSystemFolder(item: Pick<DriveItemOut, "system_role"> | null | undefined): boolean {
  return item?.system_role === "channel_posts";
}

/** The name the server stores the 「アルバム」 folder under (POST /drive/albums {location_id}). */
export const ALBUMS_FOLDER_STORED_NAME = "アルバム";

/**
 * The 「アルバム」 folder in the UI language (docs/ALBUMS.md §23) while it keeps the name the server gave it; renamed by
 * someone, it is shown as they named it (the role stays: new albums still go there).
 */
function albumsFolderName(item: { name: string; system_role?: DriveItemOut["system_role"] }): string | null {
  return item.system_role === "albums" && item.name === ALBUMS_FOLDER_STORED_NAME ? t("albums.folder") : null;
}

/** The folders the server keeps (seen in a listing): their crumbs, which carry no role, are named in the UI language. */
const systemFolders = new Set<string>();

export function rememberSystemFolders(items: readonly Pick<DriveItemOut, "id" | "system_role">[]): void {
  for (const item of items) if (item.system_role === "channel_posts") systemFolders.add(item.id);
}

/** An item's name as the screens show it: 「投稿のファイル」 in the UI language, any other item by its own name. */
export function itemName(item: Pick<DriveItemOut, "name" | "system_role">): string {
  if (item.system_role === "channel_posts") return t("channelFiles.folder");
  return albumsFolderName(item) ?? item.name;
}

/**
 * A crumb's name: 「投稿のファイル」 in the UI language, by the crumb's `system_role` (CHANNEL_FILES.md §19.4). A server
 * that sends no role (the first CF1): a folder seen in a listing counts, and so does the stored name right under a
 * channel drive's top (names are unique per folder, and the server makes the folder there).
 */
export function crumbName(crumb: DriveCrumb, index: number, locationKind: DriveLocationOut["kind"] | null | undefined): string {
  if (crumb.system_role === "channel_posts") return t("channelFiles.folder");
  const albums = albumsFolderName(crumb);
  if (albums) return albums;
  if (crumb.system_role === undefined && systemFolders.has(crumb.id)) return t("channelFiles.folder");
  if (crumb.system_role === undefined && index === 1 && locationKind === "channel" && crumb.name === POSTED_FOLDER_STORED_NAME) return t("channelFiles.folder");
  return crumb.name;
}

/** The crumbs with 「投稿のファイル」 named in the UI language (the root keeps its name: the caller names it). */
export function localizedPath(path: readonly DriveCrumb[], locationKind: DriveLocationOut["kind"] | null | undefined): DriveCrumb[] {
  return path.map((crumb, index) => ({ ...crumb, name: index === 0 ? crumb.name : crumbName(crumb, index, locationKind) }));
}

/**
 * §3.3: 「投稿のファイル」 is never renamed, moved or put in the trash (the server says 409 drive_folder_system). A
 * selection holding it offers none of the three; its contents may be.
 */
export function canRearrange(items: readonly Pick<DriveItemOut, "system_role">[]): boolean {
  return !items.some((item) => isSystemFolder(item));
}

// --- the composer and the switches (§9, §12.3, §12.7) ----------------------------------------------------------------

/**
 * Whether the conversation's files go into its drive when sent: a public or private channel whose own switch, else the
 * workspace's, is on. A server before CF1 says neither: false (no line in the composer).
 */
export function filesToDrive(channel: Pick<ChannelState, "type" | "files_to_drive"> & { files_to_drive_effective?: boolean | null }, settings: Pick<WorkspaceSettingsOut, "channel_files_to_drive"> | null | undefined): boolean {
  if (channel.type !== "public" && channel.type !== "private") return false;
  return channel.files_to_drive ?? channel.files_to_drive_effective ?? settings?.channel_files_to_drive ?? false;
}

/** The channel's choice (§12.7): its own value, or "workspace" while it follows the workspace's switch. */
export type FilesToDriveChoice = "workspace" | "on" | "off";

export function filesToDriveChoice(channel: Pick<ChannelState, "files_to_drive">): FilesToDriveChoice {
  return channel.files_to_drive === true ? "on" : channel.files_to_drive === false ? "off" : "workspace";
}

export function choiceValue(choice: FilesToDriveChoice): boolean | null {
  return choice === "on" ? true : choice === "off" ? false : null;
}

// --- the delete's check box (§7.3) --------------------------------------------------------------------------------------

/** Whether the delete's confirmation asks the server what would become of the files (some are in a drive still). */
export function asksDriveFiles(attachments: readonly AttachmentOut[] | undefined): boolean {
  return (attachments ?? []).some((attachment) => attachment.drive?.state === "available" || attachment.drive?.state === "moved");
}

export interface DeleteDriveFiles {
  /** Files drive_files=auto puts in the drive's trash: the check box 「ドライブの n 件のファイルもゴミ箱に移す」. */
  trash: number;
  /** Files that changed since they were posted: 「n 件は投稿の後に変更されたため、ドライブに残ります」. */
  changed: number;
  /** Files that stay for another reason (another's, moved, in the trash already). */
  others: number;
}

export function deleteDriveFiles(files: readonly Pick<DriveMessageFileOut, "trash" | "reason">[]): DeleteDriveFiles {
  let trash = 0;
  let changed = 0;
  let others = 0;
  for (const file of files) {
    if (file.trash) trash += 1;
    else if (file.reason === "changed") changed += 1;
    else others += 1;
  }
  return { trash, changed, others };
}

/** What the delete sends: the check box on (or nothing to put in the trash) is the server's auto, off is keep. */
export function driveFilesParam(summary: DeleteDriveFiles | null, checked: boolean): "auto" | "keep" | undefined {
  if (!summary) return undefined;
  if (summary.trash === 0) return "keep";
  return checked ? "auto" : "keep";
}

// --- the warning before a move or a trash (§6.4, §6.5) -----------------------------------------------------------------

/** Only when posted files would change for a message (§19.3: `posted_messages > 0`). */
export function needsImpactWarning(impact: DriveImpactOut | null | undefined): impact is DriveImpactOut {
  return !!impact && impact.posted_messages > 0;
}

/**
 * The warning's lines, one per conversation I can read: 「#m2 の 2 件のメッセージに付いています。」 then what changes
 * for its members; then the messages in conversations I cannot read, as a count.
 */
export function impactLines(impact: DriveImpactOut, mode: "move" | "trash", channelName: (id: string) => string | null): string[] {
  const lines: string[] = [];
  let listed = 0;
  for (const entry of impact.channels) {
    listed += entry.messages;
    const name = channelName(entry.channel_id);
    const where = name ? `#${name}` : t("channelFiles.impact.aChannel");
    lines.push(t("channelFiles.impact.attached", { where, count: entry.messages }));
    if (mode === "trash") continue;
    if (entry.unreadable_after <= 0) lines.push(t("channelFiles.impact.stillReadable"));
    else if (entry.unreadable_guests > 0) lines.push(t("channelFiles.impact.unreadableGuests", { where, count: entry.unreadable_after, guests: entry.unreadable_guests }));
    else lines.push(t("channelFiles.impact.unreadable", { where, count: entry.unreadable_after }));
  }
  const hidden = impact.posted_messages - listed;
  if (hidden > 0) lines.push(t("channelFiles.impact.hidden", { count: hidden }));
  if (mode === "trash") lines.push(t("channelFiles.impact.trashNote"));
  return lines;
}
