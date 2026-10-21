/**
 * Where the drive's uploads read their bytes (M161, docs/DRIVE.md §17.3), never a whole file at once:
 *
 * - A browser's File (picked, a folder picked with webkitdirectory, or dropped): `File.slice` part by part. It lives
 *   only as long as the tab; after a reload the session waits for the same file to be picked again.
 * - The desktop app's picks (the open dialog, files or a folder): read from disk by path, part by part (fs `open`,
 *   `seek`, `read`). The dialog adds what was picked to the fs scope and persisted-scope keeps it after a restart, so an
 *   unfinished upload goes on by itself when the app starts again.
 * - Folders dropped from Finder / Explorer: DataTransferItem.webkitGetAsEntry() walked (in the drop handler, before the
 *   items go away), each file with the folders above it as its `relativeDir`; empty folders are listed to be made.
 */
import type { UploadSource } from "../drive/uploads";
import type { PersistedUpload } from "../drive/uploads";
import { isTauri } from "./env";

/** What a pick or a drop holds: files to send and folders to make even when empty ("a/b"). */
export interface PickedTree {
  files: UploadSource[];
  folders: string[];
}

export function fileSource(file: File, relativeDir = ""): UploadSource {
  return {
    name: file.name,
    size: file.size,
    lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
    relativeDir,
    path: null,
    read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
  };
}

/** "a/b/c.txt" → "a/b". */
export function dirOf(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

/** Every folder of `paths` and the folders above them ("a/b" → "a", "a/b"), each once, parents first. */
export function foldersOf(dirs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const dir of dirs) {
    const parts = dir.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** The folders that hold no file (directly or below): only these need making before the upload (the rest come with it). */
export function emptyFolders(folders: readonly string[], files: readonly Pick<UploadSource, "relativeDir">[]): string[] {
  const filled = new Set(foldersOf(files.map((file) => file.relativeDir).filter(Boolean)));
  return foldersOf(folders).filter((folder) => !filled.has(folder) && ![...filled].some((dir) => dir.startsWith(`${folder}/`)));
}

/** <input type="file" webkitdirectory>: each file's webkitRelativePath gives its folders ("Folder/sub/x.pdf"). */
export function treeFromInput(files: readonly File[]): PickedTree {
  const sources = files.map((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    return fileSource(file, relative ? dirOf(relative) : "");
  });
  return { files: sources, folders: [] };
}

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void) => void };
}

/** The entries of a drop, taken synchronously (the DataTransfer's items are gone once the handler returns). */
export function dropEntries(data: DataTransfer | null): EntryLike[] | null {
  const items = data?.items;
  if (!items || items.length === 0) return null;
  const entries: EntryLike[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry?.();
    if (!entry) return null; // a browser without entries: use the plain files
    entries.push(entry);
  }
  return entries;
}

function readAll(reader: { readEntries: (success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void) => void }): Promise<EntryLike[]> {
  // readEntries answers in batches (100 in Chrome) until an empty one.
  return new Promise((resolve, reject) => {
    const all: EntryLike[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

/** Walks dropped entries: files with their folders, and every folder (empty ones are made too). */
export async function treeFromEntries(entries: readonly EntryLike[]): Promise<PickedTree> {
  const files: UploadSource[] = [];
  const folders: string[] = [];
  const walk = async (entry: EntryLike): Promise<void> => {
    const relative = entry.fullPath.replace(/^\/+/, "");
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
      files.push(fileSource(file, dirOf(relative)));
    } else if (entry.isDirectory && entry.createReader) {
      folders.push(relative);
      for (const child of await readAll(entry.createReader())) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  return { files, folders };
}

// --- the desktop app: paths read from disk ------------------------------------------------------------------------

async function tauriFs() {
  return import("@tauri-apps/plugin-fs");
}

/** A file on disk, read part by part (a handle per read: the parts of one file go at once). */
export function pathSource(path: string, name: string, size: number, lastModified: number | null, relativeDir: string): UploadSource {
  return {
    name,
    size,
    lastModified,
    relativeDir,
    path,
    read: async (start, end) => {
      const fs = await tauriFs();
      const handle = await fs.open(path, { read: true });
      try {
        await handle.seek(start, fs.SeekMode.Start);
        const out = new Uint8Array(end - start);
        let filled = 0;
        while (filled < out.byteLength) {
          const chunk = new Uint8Array(Math.min(out.byteLength - filled, 4 * 1024 * 1024));
          const read = await handle.read(chunk);
          if (read === null || read === 0) break;
          out.set(chunk.subarray(0, read), filled);
          filled += read;
        }
        return filled === out.byteLength ? out : out.subarray(0, filled);
      } finally {
        await handle.close();
      }
    },
  };
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

async function statSource(path: string, relativeDir: string): Promise<UploadSource | null> {
  const fs = await tauriFs();
  const info = await fs.stat(path);
  if (!info.isFile) return null;
  return pathSource(path, baseName(path), info.size, info.mtime ? info.mtime.getTime() : null, relativeDir);
}

/** The open dialog's files (null: cancelled). */
export async function pickFilesNative(): Promise<PickedTree | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: true, directory: false });
  if (!picked) return null;
  const paths = Array.isArray(picked) ? picked : [picked];
  const files = (await Promise.all(paths.map((path) => statSource(path, "")))).filter((file): file is UploadSource => file !== null);
  return { files, folders: [] };
}

/** The open dialog's folder, walked (null: cancelled). Its own name is the top folder of the upload. */
export async function pickFolderNative(): Promise<PickedTree | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, recursive: true });
  if (!picked || Array.isArray(picked)) return null;
  const fs = await tauriFs();
  const { join } = await import("@tauri-apps/api/path");
  const files: UploadSource[] = [];
  const folders: string[] = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    folders.push(relative);
    for (const entry of await fs.readDir(dir)) {
      if (entry.isSymlink) continue; // never follow a link out of the folder
      const path = await join(dir, entry.name);
      if (entry.isDirectory) await walk(path, `${relative}/${entry.name}`);
      else if (entry.isFile) {
        const source = await statSource(path, relative);
        if (source) files.push(source);
      }
    }
  };
  await walk(picked, baseName(picked));
  return { files, folders };
}

/** After a restart: the file of a kept session read again from its path, when it is still there and the same size. */
export async function reopenNative(entry: PersistedUpload): Promise<UploadSource | null> {
  if (!isTauri() || !entry.path) return null;
  try {
    const source = await statSource(entry.path, entry.relativeDir);
    return source && source.size === entry.size ? { ...source, name: entry.name } : null;
  } catch {
    return null;
  }
}
