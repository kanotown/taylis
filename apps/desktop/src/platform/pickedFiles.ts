/**
 * Files from an `<input type="file">`, checked before any byte is read and copied one at a time.
 *
 * In the macOS app (WKWebView) a File picked through an input could no longer be read once the input's value was
 * reset: the upload body broke off part way, the server answered 400 (multipart could not be parsed) and WebKit
 * reported a network error (「サーバーに接続できません」, the workspace icon on 2026-10-04). Profile pictures were
 * fine because the crop dialog turns them into a new Blob first.
 *
 * So a picked file is copied into memory (a new File, readable whatever happens to the input) before it is used, and
 * the input keeps its value until the last copy is made (`takePicked` … `release`). Review v0.1.30 #5: the count and
 * each `File.size` are checked synchronously first (a refused pick reads nothing), and the copies are made one at a
 * time, each handed on (uploaded) before the next is read, so at most one picked file is held in memory.
 */

/** The server's default `attachment_max_bytes` (server/app/core/settings.py); the server checks again. */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
/** At most this many attachments on one message (the composer and the server). */
export const ATTACHMENT_MAX_COUNT = 10;

export interface PickLimits {
  /** How many files may still be added (already pending and uploading counted out). */
  maxFiles: number;
  /** The largest single file. */
  maxBytes: number;
  /** The message for too many files (default 「添付は10件までです」). */
  tooMany?: string;
}

/** 「12.5 MB」. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * Synchronous: why these files are refused (too many, one too large), or null. Reads only `length`, `name` and
 * `size`, never the bytes.
 */
export function refusePicked(files: readonly File[], limits: PickLimits): string | null {
  if (files.length > limits.maxFiles) return limits.tooMany ?? `添付は${ATTACHMENT_MAX_COUNT}件までです`;
  const large = files.find((file) => file.size > limits.maxBytes);
  if (large) return `「${large.name}」は大きすぎます (${formatMegabytes(limits.maxBytes)} まで)`;
  return null;
}

/** A copy of a picked file in memory (name, type and lastModified kept). */
export async function copyPickedFile(file: File): Promise<File> {
  const bytes = await file.arrayBuffer();
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}

/**
 * Call synchronously in the change handler: the picked files, and `release` that clears the input (call it once the
 * last copy is made, or at once when the pick is refused). The input is marked busy until then: a second pick on it
 * would replace the files still being read (`isPickBusy`).
 */
export function takePicked(input: HTMLInputElement): { files: File[]; release: () => void } {
  const files = input.files ? Array.from(input.files) : [];
  busyInputs.add(input);
  let released = false;
  return {
    files,
    release: () => {
      if (released) return;
      released = true;
      busyInputs.delete(input);
      input.value = "";
    },
  };
}

const busyInputs = new WeakSet<HTMLInputElement>();

/** Files picked on this input are still being read: do not open it again yet. */
export function isPickBusy(input: HTMLInputElement | null | undefined): boolean {
  return !!input && busyInputs.has(input);
}

/**
 * Copies the files one after another and hands each copy to `each` (awaited before the next is read), then calls
 * `release`. A file that cannot be read goes to `onError` and the others still follow.
 */
export async function forEachPicked(
  files: readonly File[],
  each: (copy: File) => Promise<void>,
  release: () => void,
  onError: (error: unknown, file: File) => void,
): Promise<void> {
  try {
    for (const file of files) {
      let copy: File;
      try {
        copy = await copyPickedFile(file);
      } catch (error) {
        onError(error, file);
        continue;
      }
      await each(copy);
    }
  } finally {
    release();
  }
}
