/**
 * CF5 (docs/CHANNEL_FILES.md §12.4, §23, §26): a file over the attachment limit (bootstrap's `max_attachment_bytes`,
 * 100 MB) added to the composer is offered to the drive instead of refused: it goes up with the drive's resumable upload
 * (16 MiB parts, DRIVE.md §6) into the channel's 「投稿のファイル › 2026-10」 (POST /drive/channel-posts) — the
 * channel drive's top where the channel's files stay out of its drive, マイドライブ in a DM or where I cannot write the
 * channel's drive — and its `/d/<id>` link goes into the draft when it is done. Sending does not wait for it.
 *
 * The composer's chips outlive the composer (I may open another conversation meanwhile) and a restart: what each chip
 * needs is kept here per account, matched to the upload queue's job by its `client_upload_id`.
 */
import type { DriveChannelPostsOut, DriveChildrenOut, DriveLocationOut, WorkspaceSettingsOut } from "../api/types";
import type { ChannelState } from "../sync/types";
import { ApiError } from "../api/errors";
import { t } from "../i18n";
import { ATTACHMENT_MAX_BYTES } from "../platform/pickedFiles";
import { filesToDrive, isSystemFolder } from "./channelFiles";
import { isFinished, type UploadJob, type UploadTarget } from "./uploads";

/** Larger than a message may carry (bootstrap's `limits.max_attachment_bytes`; the default before the first one). */
export function isBigFile(size: number, limit: number | null | undefined = ATTACHMENT_MAX_BYTES): boolean {
  return size > (limit ?? ATTACHMENT_MAX_BYTES);
}

/** The zone of the server's month folders (`CHANNEL_FILES_TZ`) when it does not say (bootstrap's `channel_files_timezone`). */
export const MONTH_FOLDER_TIME_ZONE = "Asia/Tokyo";

/** 「2026-10」: the month folder the server would file a message sent at `at` under (channel_files.month_name). */
export function monthFolderName(at: Date, timeZone = MONTH_FOLDER_TIME_ZONE): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit" }).formatToParts(at);
  }
  const year = parts.find((part) => part.type === "year")?.value ?? String(at.getFullYear());
  const month = parts.find((part) => part.type === "month")?.value ?? String(at.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Where a big file goes (§26, the same on every client): in a public or private channel whose drive I can write, its
 * 「投稿のファイル › 2026-10」 while its files go to its drive (CF1's switch), else the drive's top; マイドライブ in a DM
 * or group DM and where I cannot write the channel's drive (only owners post). Whether I can write is the server's
 * answer in the end (`can_write`, 403).
 */
export function bigFileWhere(
  channel: Pick<ChannelState, "type" | "files_to_drive"> & { files_to_drive_effective?: boolean | null },
  settings: Pick<WorkspaceSettingsOut, "channel_files_to_drive"> | null | undefined,
  canWriteChannelDrive = true,
): "posts" | "channel" | "me" {
  if ((channel.type !== "public" && channel.type !== "private") || !canWriteChannelDrive) return "me";
  return filesToDrive(channel, settings) ? "posts" : "channel";
}

/** The place found for the upload: the folder, the folder below it (the month, made at completion) and its line. */
export interface BigFilePlace {
  target: UploadTarget;
  /** "2026-10" under 「投稿のファイル」 (the server finds or makes it when the upload completes); "" for none. */
  relativeDir: string;
  /** posts: 「投稿のファイル」 found; root: the channel's drive has none yet (its top instead); me: マイドライブ. */
  kind: "posts" | "root" | "me";
}

export interface BigFileApi {
  driveChannelPosts(channelId: string): Promise<DriveChannelPostsOut>;
  resolveDriveLocation(body: { kind: "channel"; channel_id: string } | { kind: "me" }): Promise<DriveLocationOut>;
  driveChildren(folderId: string, query?: { sort?: "name"; cursor?: string | null; limit?: number }): Promise<DriveChildrenOut>;
}

/** How many pages of the channel drive's top are read looking for 「投稿のファイル」 (200 items a page). */
const ROOT_PAGES = 5;

/**
 * 「投稿のファイル」 of a channel's drive (null: not made yet — a server before CF5 makes it with the channel's first
 * posted file). For a server without POST /drive/channel-posts, which names it: the top is listed.
 */
export async function findPostsFolder(api: BigFileApi, rootId: string): Promise<string | null> {
  let cursor: string | null = null;
  for (let page = 0; page < ROOT_PAGES; page++) {
    const listing: DriveChildrenOut = await api.driveChildren(rootId, { sort: "name", cursor, limit: 200 });
    const found = listing.items.find((item) => item.kind === "folder" && isSystemFolder(item));
    if (found) return found.id;
    cursor = listing.next_cursor;
    if (!cursor) return null;
  }
  return null;
}

function myDrive(location: DriveLocationOut): BigFilePlace {
  return { target: { parentId: location.root_id, locationId: location.id, label: t("drive.location.mine") }, relativeDir: "", kind: "me" };
}

/** A server before CF5's POST /drive/channel-posts (no such route), not a refusal of it. */
function noChannelPostsRoute(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 405 || (error.status === 404 && error.code !== "drive_item_not_found"));
}

function channelTop(location: DriveLocationOut, where: string): BigFilePlace {
  return { target: { parentId: location.root_id, locationId: location.id, label: where }, relativeDir: "", kind: "root" };
}

/** A server before CF5: 「投稿のファイル」 found by listing the top, the month made at completion (`relative_dir`). */
async function legacyPostsPlace(api: BigFileApi, location: DriveLocationOut, where: string, now: Date, timeZone: string): Promise<BigFilePlace> {
  const posts = await findPostsFolder(api, location.root_id);
  if (!posts) return channelTop(location, where);
  const month = monthFolderName(now, timeZone);
  return { target: { parentId: posts, locationId: location.id, label: `${where} › ${t("channelFiles.folder")} › ${month}` }, relativeDir: month, kind: "posts" };
}

/** The channel's drive when I can write it (null: マイドライブ instead — read-only for me, or refused). */
async function writableChannelDrive(api: BigFileApi, channelId: string): Promise<DriveLocationOut | null> {
  try {
    const location = await api.resolveDriveLocation({ kind: "channel", channel_id: channelId });
    return location.can_write ? location : null;
  } catch (error) {
    // Not allowed there (a guest's view of it, a channel left meanwhile): マイドライブ, as where I cannot write.
    if (error instanceof ApiError && error.status === 403) return null;
    throw error;
  }
}

/**
 * The folder a big file of `channel` goes to (§26). Throws when there is none I can write — an archived channel, a
 * server without the drive, a guest (no マイドライブ): the composer then says the file is too large, as before CF5.
 */
export async function resolveBigFilePlace(
  api: BigFileApi,
  channel: Pick<ChannelState, "id" | "name" | "type" | "files_to_drive"> & { files_to_drive_effective?: boolean | null; archived?: boolean },
  settings: Pick<WorkspaceSettingsOut, "channel_files_to_drive"> | null | undefined,
  now: Date = new Date(),
  timeZone: string | null = null,
): Promise<BigFilePlace> {
  if (channel.archived) throw new Error("an archived channel takes no files");
  const where = bigFileWhere(channel, settings);
  const label = `#${channel.name ?? ""}`;
  if (where === "posts") {
    let out: DriveChannelPostsOut | null = null;
    try {
      out = await api.driveChannelPosts(channel.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) return myDrive(await api.resolveDriveLocation({ kind: "me" }));
      if (!noChannelPostsRoute(error)) throw error;
    }
    if (out) {
      if (!out.location.can_write) return myDrive(await api.resolveDriveLocation({ kind: "me" }));
      if (out.posts_folder && out.month_folder) {
        return { target: { parentId: out.month_folder.id, locationId: out.location.id, label: `${label} › ${t("channelFiles.folder")} › ${out.month_folder.name}` }, relativeDir: "", kind: "posts" };
      }
      return channelTop(out.location, label); // the switch turned off meanwhile
    }
    const location = await writableChannelDrive(api, channel.id);
    if (location) return legacyPostsPlace(api, location, label, now, timeZone ?? MONTH_FOLDER_TIME_ZONE);
  } else if (where === "channel") {
    const location = await writableChannelDrive(api, channel.id);
    if (location) return channelTop(location, label);
  }
  return myDrive(await api.resolveDriveLocation({ kind: "me" }));
}

/** The draft with the link at its end (a space before it when it would touch a word, one after it). */
export function appendLink(text: string, url: string): string {
  if (text.includes(url)) return text;
  const before = text.length > 0 && !/\s$/.test(text) ? " " : "";
  return `${text}${before}${url} `;
}

// --- the composer's chips, kept per account --------------------------------------------------------------------------

/** One big file of a composer (`key`: ui/FileDropZone.composerKey). */
export interface BigUpload {
  clientUploadId: string;
  key: string;
  name: string;
  size: number;
  /** Where it goes (「#m2 › 投稿のファイル › 2026-10」, 「マイドライブ」). */
  label: string;
}

/** A chip's state: the queue's job (null after a restart until the queue has it, or once it is gone). */
export function chipJob(upload: BigUpload, jobs: readonly UploadJob[], held?: UploadJob | null): UploadJob | null {
  return jobs.find((job) => job.clientUploadId === upload.clientUploadId) ?? held ?? null;
}

/** Whether the chip is still under way: anything but done (the link goes in), cancelled or skipped. Sending does not wait. */
export function holdsSend(job: UploadJob | null): boolean {
  return !job || !isFinished(job.state);
}

interface Book {
  uploads: BigUpload[];
  /** The jobs seen, kept after the panel clears them (「閉じる」 drops finished jobs from the queue). */
  jobs: Map<string, UploadJob>;
  /** A picked file's input to clear once its upload is over (the macOS app reads a picked File only until then). */
  releases: Map<string, () => void>;
  version: number;
  listeners: Set<() => void>;
}

const books = new Map<string, Book>();

function storageKey(account: string): string {
  return `taylis.composerBigUploads.v1:${account}`;
}

function load(account: string): BigUpload[] {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(account));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is BigUpload => !!entry && typeof entry.clientUploadId === "string" && typeof entry.key === "string" && typeof entry.name === "string");
  } catch {
    return [];
  }
}

function book(account: string): Book {
  let found = books.get(account);
  if (!found) {
    found = { uploads: load(account), jobs: new Map(), releases: new Map(), version: 0, listeners: new Set() };
    books.set(account, found);
  }
  return found;
}

function changed(account: string, entry: Book): void {
  try {
    globalThis.localStorage?.setItem(storageKey(account), JSON.stringify(entry.uploads));
  } catch {
    /* a convenience for a restart only */
  }
  entry.version += 1;
  for (const listener of [...entry.listeners]) listener();
}

/** The composer `key`'s big files, oldest first. */
export function bigUploadsOf(account: string, key: string): BigUpload[] {
  return book(account).uploads.filter((upload) => upload.key === key);
}

/** The job last seen for a chip (kept here when the queue has let it go). */
export function heldJob(account: string, clientUploadId: string): UploadJob | null {
  return book(account).jobs.get(clientUploadId) ?? null;
}

export function addBigUploads(account: string, key: string, jobs: readonly UploadJob[], label: string, release?: () => void): void {
  const entry = book(account);
  let left = jobs.length;
  for (const job of jobs) {
    entry.uploads.push({ clientUploadId: job.clientUploadId, key, name: job.name, size: job.size, label });
    entry.jobs.set(job.clientUploadId, job);
    if (release) {
      entry.releases.set(job.clientUploadId, () => {
        left -= 1;
        if (left === 0) release();
      });
    }
  }
  if (release && jobs.length === 0) release();
  changed(account, entry);
}

/** Takes the chip away (its link went into the draft, or it was cancelled or given up). */
export function removeBigUpload(account: string, clientUploadId: string): void {
  const entry = book(account);
  entry.uploads = entry.uploads.filter((upload) => upload.clientUploadId !== clientUploadId);
  entry.jobs.delete(clientUploadId);
  const release = entry.releases.get(clientUploadId);
  entry.releases.delete(clientUploadId);
  release?.();
  changed(account, entry);
}

export function subscribeBigUploads(account: string, listener: () => void): () => void {
  const entry = book(account);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

export function bigUploadsVersion(account: string): number {
  return book(account).version;
}

/** Tests: forget every account's chips. */
export function resetBigUploads(): void {
  books.clear();
}

/** `release` split in `parts`: it is called once every part has been (each part counts once). */
export function splitRelease(release: () => void, parts: number): (() => void)[] {
  let left = parts;
  return Array.from({ length: parts }, () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      left -= 1;
      if (left === 0) release();
    };
  });
}
