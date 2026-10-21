/**
 * Downloading a drive file (M161, docs/DRIVE.md §7.3), however large, without holding it in memory:
 *
 * - The desktop app fetches /drive/items/{id}/content with the bearer token and writes each chunk of the body to the
 *   file as it arrives (fs `open` / `write`): into Downloads under a free name, or where the save dialog says when
 *   「保存先を毎回選ぶ」 is on (platform/download.ts, the same names and toasts as attachments). A failure removes the
 *   half-written file.
 * - The browser follows a download ticket's URL with its own download (<a href download>): it streams to disk, shows
 *   its own progress, and resumes a broken download with a Range request (the ticket stays valid while used).
 */
import { freePath, readAskDownloadLocation, releasePath, safeFileName, type SavedFile } from "../platform/download";

export type DownloadRoute = "stream-to-file" | "browser";

/** How this client downloads a drive file. */
export function downloadRoute(tauri: boolean): DownloadRoute {
  return tauri ? "stream-to-file" : "browser";
}

/** The ticket's URL on this server (the ticket is relative to it). */
export function ticketUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** The browser's own download of `url` (same origin: the name comes from Content-Disposition). */
export function browserDownload(url: string, filename: string, doc: Pick<Document, "createElement" | "body"> = document): void {
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export interface ChunkSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Removes what was written (a failure). */
  discard(): Promise<void>;
}

/**
 * Copies `body` into `sink` chunk by chunk, telling `onProgress` the bytes so far; on any failure the sink is
 * discarded and the error passed on. Resolves to the bytes written.
 */
export async function pipeToSink(body: ReadableStream<Uint8Array>, sink: ChunkSink, onProgress: (loaded: number) => void): Promise<number> {
  const reader = body.getReader();
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      await sink.write(value);
      loaded += value.byteLength;
      onProgress(loaded);
    }
    await sink.close();
    return loaded;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      /* already broken */
    }
    await sink.discard().catch(() => undefined);
    throw error;
  }
}

/** A file opened for writing in the desktop app (fs plugin), written in full chunk after chunk. */
async function fileSink(path: string, replace: boolean): Promise<ChunkSink> {
  const fs = await import("@tauri-apps/plugin-fs");
  const handle = await fs.open(path, replace ? { write: true, create: true, truncate: true } : { write: true, createNew: true });
  let closed = false;
  return {
    async write(chunk) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await handle.write(chunk.subarray(offset));
        if (written <= 0) throw new Error("could not write the file");
        offset += written;
      }
    },
    async close() {
      closed = true;
      await handle.close();
    },
    async discard() {
      if (!closed) await handle.close().catch(() => undefined);
      await fs.remove(path).catch(() => undefined);
    },
  };
}

/**
 * The desktop app: `response`'s body written to a file named `filename` (Downloads under a free name, or the save
 * dialog's choice when `ask`). null when the dialog was cancelled.
 */
export async function saveStreamToFile(filename: string, response: Response, onProgress: (loaded: number) => void, options: { ask?: boolean } = {}): Promise<SavedFile | null> {
  const name = safeFileName(filename);
  const ask = options.ask ?? readAskDownloadLocation();
  const [{ downloadDir, join }, { exists }] = await Promise.all([import("@tauri-apps/api/path"), import("@tauri-apps/plugin-fs")]);
  const dir = await downloadDir();
  let path: string;
  if (ask) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({ defaultPath: await join(dir, name) });
    if (!picked) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    path = picked;
  } else {
    path = await freePath(dir, name, exists, join);
  }
  try {
    if (!response.body) throw new Error("no body");
    // A picked path replaces what is there (the dialog asked); our own never does (createNew fails instead).
    await pipeToSink(response.body, await fileSink(path, ask), onProgress);
  } finally {
    releasePath(path);
  }
  const base = dir.replace(/[\\/]+$/, "");
  const windows = /^[a-z]:/i.test(base);
  const norm = (value: string) => (windows ? value.toLowerCase().replace(/\//g, "\\") : value);
  return { path, inDownloads: !ask || norm(path).startsWith(norm(base) + (windows ? "\\" : "/")) };
}
