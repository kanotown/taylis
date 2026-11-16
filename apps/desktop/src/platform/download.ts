/**
 * Saving a downloaded file (attachments, exports; docs/PREVIEWS.md §9).
 *
 * The desktop app saves straight into the user's Downloads folder, as Slack does, under a free name (「名前 (1).pdf」
 * when 「名前.pdf」 is there), unless 「保存先を毎回選ぶ」 is on (Settings → 入力, this device only), which asks with
 * the save dialog every time. The browser hands the file to its own download (an <a download>): it picks the folder
 * and the name itself, and we never learn where it went.
 */
import { isTauri } from "./env";

/** Where a file went: a path in the desktop app, null for the browser's own download. */
export interface SavedFile {
  path: string | null;
  /** In the Downloads folder (or below): the only place 「開く」 may open from (the opener's scope, capabilities). */
  inDownloads: boolean;
}

const ASK_KEY = "chikuwa.prefs.askDownloadLocation";

/** 「保存先を毎回選ぶ」 (desktop app; default off: straight into Downloads). */
export function readAskDownloadLocation(): boolean {
  try {
    return localStorage.getItem(ASK_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAskDownloadLocation(on: boolean): void {
  try {
    if (on) localStorage.setItem(ASK_KEY, "1");
    else localStorage.removeItem(ASK_KEY);
  } catch {
    /* per-device convenience only */
  }
}

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A file name that is safe as the last part of a path on macOS and Windows: no separators or characters Windows refuses,
 * no control characters, no leading dots (a hidden file) or trailing dots / spaces (Windows drops them), not a device
 * name (「CON.txt」), at most 200 characters (the extension kept). The server's name is the uploader's, so never trusted.
 * Unicode format characters (category Cf: the bidi controls U+202A–U+202E and U+2066–U+2069, U+200B–U+200F, U+FEFF …)
 * are dropped (2026-11-16): 「report<U+202E>fdp.exe」 shows as 「reportexe.pdf」 in Finder and Explorer.
 */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = name.replace(/\p{Cf}+/gu, "").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "_").replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (!clean) clean = "download";
  if (RESERVED_WINDOWS.test(clean)) clean = `_${clean}`;
  if (clean.length > 200) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
    clean = clean.slice(0, 200 - ext.length) + ext;
  }
  return clean;
}

/** 「report.pdf」, 1 → 「report (1).pdf」; a name without an extension gets the number at its end. */
export function numberedName(name: string, n: number): string {
  if (n <= 0) return name;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/** Paths handed out but not yet written: two downloads of the same name at once get different names. */
const reserved = new Set<string>();

export function releasePath(path: string): void {
  reserved.delete(path);
}

/**
 * The first free path for `name` in `dir`: the name itself, then 「name (1)」, 「name (2)」… (Finder and Explorer's own
 * rule, as Chrome and Slack name their downloads). `exists` asks the disk. The path is held (`releasePath`) until the
 * file is written, so another download meanwhile picks the next name.
 */
export async function freePath(dir: string, name: string, exists: (path: string) => Promise<boolean>, join: (...parts: string[]) => Promise<string>): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const path = await join(dir, numberedName(name, n));
    if (reserved.has(path)) continue;
    if (await exists(path)) continue;
    // Checked again after the wait: another download may have taken it meanwhile.
    if (reserved.has(path)) continue;
    reserved.add(path);
    return path;
  }
  // A thousand files of one name: give up numbering and stamp the time.
  const path = await join(dir, numberedName(name, Date.now()));
  reserved.add(path);
  return path;
}

/**
 * Saves `blob` as `filename`. Desktop app: into Downloads under a free name, or where the save dialog says when
 * `ask` (default: the setting); null when the dialog was cancelled. Browser: the browser's download. `source`: the
 * server it came from, written into the file's mark of the internet (markDownloaded).
 */
export async function saveDownload(filename: string, blob: Blob, options: { ask?: boolean; source?: string | null } = {}): Promise<SavedFile | null> {
  if (isTauri()) {
    const name = safeFileName(filename);
    const ask = options.ask ?? readAskDownloadLocation();
    const [{ downloadDir, join }, { exists, writeFile }] = await Promise.all([import("@tauri-apps/api/path"), import("@tauri-apps/plugin-fs")]);
    const dir = await downloadDir();
    let path: string;
    if (ask) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({ defaultPath: await join(dir, name) });
      if (!picked) return null;
      path = picked;
    } else {
      path = await freePath(dir, name, exists, join);
    }
    try {
      // A picked path replaces what is there (the dialog asked); our own never does (createNew fails instead).
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()), ask ? undefined : { createNew: true });
    } finally {
      releasePath(path);
    }
    await markDownloaded(path, options.source ?? null);
    return { path, inDownloads: !ask || isInside(path, dir) };
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { path: null, inDownloads: false };
}

function isInside(path: string, dir: string): boolean {
  const base = dir.replace(/[\\/]+$/, "");
  const windows = /^[a-z]:/i.test(base);
  const norm = (value: string) => (windows ? value.toLowerCase().replace(/\//g, "\\") : value);
  return norm(path).startsWith(norm(base) + (windows ? "\\" : "/"));
}

/**
 * The kinds 「開く」 hands to the system's default app (2026-11-16: an allowlist; before, a list of programs and
 * scripts that was never complete — a hostile server names the file, and Windows runs .hta, .chm, .scf, .library-ms …
 * by their extension): documents, pictures, sound, video, plain text and common archives. Anything else is only shown
 * in Finder / Explorer. The same list is the opener's scope in src-tauri/capabilities/default.json (`allow-open-path`,
 * case-insensitive patterns; tests/downloads.test.tsx keeps the two the same), so a script could not open more.
 * Not here on purpose: web pages, SVG and XML (a browser opens them with a local file's rights) and Office files with
 * macros (.docm …).
 */
export const OPENABLE_EXTENSIONS: readonly string[] = [
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key",
  // plain text
  "txt", "csv", "tsv", "md", "markdown", "json", "log",
  // pictures
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "avif",
  // sound
  "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus",
  // video
  "mp4", "m4v", "mov", "webm", "mkv", "avi",
  // archives (what they hold keeps the mark of the internet: Windows and Archive Utility pass it on)
  "zip", "7z", "tar", "gz", "tgz",
];
const OPENABLE = new Set(OPENABLE_EXTENSIONS);

/** Whether 「開く」 may hand this file to the system's default app (an allowlisted kind; anything else is revealed only). */
export function canOpenDownloaded(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return OPENABLE.has(name.slice(dot + 1).toLowerCase());
}

/** An extension as the opener's scope matches it in any case: "pdf" → "$DOWNLOAD/**\/*.[pP][dD][fF]". */
export function openableScopePattern(extension: string): string {
  const letters = [...extension].map((ch) => (/[a-z]/.test(ch) ? `[${ch}${ch.toUpperCase()}]` : ch)).join("");
  return `$DOWNLOAD/**/*.${letters}`;
}

/**
 * Marks a saved file as downloaded from the internet (2026-11-16): Windows' mark of the web (the `Zone.Identifier`
 * stream, ZoneId=3: SmartScreen, Office's Protected View) and macOS' quarantine (Gatekeeper; Archive Utility passes
 * it on to what it unpacks), written by the Rust side (src-tauri/src/downloads.rs). Best effort: a disk without
 * streams or extended attributes (FAT, some network shares) keeps the file unmarked, and the download still counts.
 */
export async function markDownloaded(path: string, source: string | null): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("download_mark", { path, source });
  } catch (err) {
    console.warn("could not mark the download as from the internet", err);
  }
}

/** Shows the saved file selected in Finder / Explorer. */
export async function revealDownloaded(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** Opens the saved file in the system's default app (the capability allows the allowlisted kinds under Downloads only). */
export async function openDownloaded(path: string): Promise<void> {
  if (!canOpenDownloaded(path)) throw new Error("not openable");
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}
