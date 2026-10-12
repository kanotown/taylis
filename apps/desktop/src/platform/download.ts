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
 */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "_").replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
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
 * `ask` (default: the setting); null when the dialog was cancelled. Browser: the browser's download.
 */
export async function saveDownload(filename: string, blob: Blob, options: { ask?: boolean } = {}): Promise<SavedFile | null> {
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

/** Extensions the app never opens itself (a program, a script, a shortcut, an installer): 「フォルダを開く」 only. */
const RUNNABLE = new Set([
  "app", "applescript", "bat", "cmd", "com", "command", "cpl", "dmg", "exe", "hta", "inf", "jar", "js", "jse", "lnk", "msc",
  "msi", "msix", "msp", "pif", "pkg", "ps1", "psm1", "reg", "scr", "sh", "terminal", "url", "vb", "vbe", "vbs", "workflow",
  "ws", "wsf", "wsh", "zsh", "bash", "py", "pl", "rb", "appref-ms", "webloc", "inetloc", "fileloc",
]);

/** Whether 「開く」 may hand this file to the system's default app (not for anything that would run). */
export function canOpenDownloaded(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return !RUNNABLE.has(name.slice(dot + 1).toLowerCase());
}

/** Shows the saved file selected in Finder / Explorer. */
export async function revealDownloaded(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** Opens the saved file in the system's default app (the capability allows paths under Downloads only). */
export async function openDownloaded(path: string): Promise<void> {
  if (!canOpenDownloaded(path)) throw new Error("not openable");
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}
