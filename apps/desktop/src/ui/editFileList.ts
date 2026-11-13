/**
 * M186 (docs/CHANNEL_FILES.md §7.6): the files of a message being edited. The ones it has (×: taken off on save) and
 * the ones added during the edit (uploaded at once, bound on save), in the order the save sends them: the kept ones
 * first in their own order, the added ones after.
 */
import type { AttachmentOut } from "../api/types";
import { ATTACHMENT_MAX_COUNT } from "../platform/pickedFiles";

export type EditFile =
  /** On the message now (a 「削除されたファイル」 tombstone too). */
  | { key: string; state: "kept"; attachment: AttachmentOut }
  /** Uploaded during this edit (POST /attachments, still pending). */
  | { key: string; state: "added"; attachment: AttachmentOut }
  | { key: string; state: "uploading"; file: File }
  /** The upload failed: × takes it away, 「もう一度」 uploads it again. Not sent with the save. */
  | { key: string; state: "failed"; file: File; error: string };

/** The editor's files on opening: the message's own. */
export function startEditFiles(attachments: readonly AttachmentOut[] | undefined): EditFile[] {
  return (attachments ?? []).map((attachment) => ({ key: `kept:${attachment.id}`, state: "kept", attachment }));
}

/** The ids the save names: the kept ones in the message's order, then the added ones in the order they came. */
export function editFileIds(files: readonly EditFile[]): string[] {
  const kept = files.flatMap((file) => (file.state === "kept" ? [file.attachment.id] : []));
  const added = files.flatMap((file) => (file.state === "added" ? [file.attachment.id] : []));
  return [...kept, ...added];
}

/** The files differ from the message's: one taken off or one added. */
export function editFilesChanged(original: readonly AttachmentOut[] | undefined, files: readonly EditFile[]): boolean {
  const before = (original ?? []).map((attachment) => attachment.id);
  const after = editFileIds(files);
  return before.length !== after.length || before.some((id, index) => id !== after[index]);
}

/** How many more files may be added: every tile counts (a failed one too, until it is taken away), as in the composer. */
export function editFileRoom(files: readonly EditFile[]): number {
  return Math.max(0, ATTACHMENT_MAX_COUNT - files.length);
}

export function editFilesUploading(files: readonly EditFile[]): boolean {
  return files.some((file) => file.state === "uploading");
}

export type EditSave =
  /** Nothing to save: the body and the files are as they were (the editor just closes). */
  | { kind: "unchanged" }
  /** 保存 cannot be pressed: an upload is still going, or nothing would be left (no body, no file). */
  | { kind: "blocked" }
  /** PATCH /messages/{id}: `attachmentIds` only when the files changed (or the body is empty, see below). */
  | { kind: "save"; body: string; attachmentIds?: string[] };

/**
 * What 保存 does. `body` is the edited text as the server takes it (trimmed, mentions encoded). The files are sent
 * only when they changed (an unchanged list keeps the body-only edit older servers know), except when the body is
 * empty: the server takes an empty body only with `attachment_ids` (an edit without them still needs a body).
 */
export function planEditSave(message: { body: string; attachments?: readonly AttachmentOut[] }, body: string, files: readonly EditFile[]): EditSave {
  const ids = editFileIds(files);
  if (editFilesUploading(files) || (!body && ids.length === 0)) return { kind: "blocked" };
  const changed = editFilesChanged(message.attachments, files);
  if (body === message.body && !changed) return { kind: "unchanged" };
  return changed || !body ? { kind: "save", body, attachmentIds: ids } : { kind: "save", body };
}

/**
 * The answer has the files the save named (compared as sets: the server puts the added ones in the order they were
 * uploaded). False: a server older than M186 ignored `attachment_ids` (the body is saved, the files are as they were).
 */
export function editFilesApplied(sent: readonly string[], answer: readonly Pick<AttachmentOut, "id">[] | undefined): boolean {
  const got = new Set((answer ?? []).map((attachment) => attachment.id));
  const wanted = new Set(sent);
  return got.size === wanted.size && [...wanted].every((id) => got.has(id));
}
