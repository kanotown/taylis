/**
 * The drive's plain rules of phase D3 (M162, docs/DRIVE.md §7.2, §10.2, §10.3, §11, §17.2): what a download of a
 * selection is (one file, or a ZIP), the clipboard of ⌘X / ⌘C and what ⌘V does with it, the version history's labels,
 * and the quota field of the administrators' usage screen.
 */
import type { DriveItemOut, DriveVersionOut } from "../api/types";
import { type MessageKey, t } from "../i18n";

/** One file downloads as it is; a folder or several items download as one ZIP (§17.2). */
export type DownloadPlan = { kind: "file"; item: DriveItemOut } | { kind: "zip"; ids: string[] } | null;

export function downloadPlan(targets: readonly DriveItemOut[]): DownloadPlan {
  if (targets.length === 0) return null;
  if (targets.length === 1 && targets[0]!.kind === "file") return { kind: "file", item: targets[0]! };
  return { kind: "zip", ids: targets.map((item) => item.id) };
}

/** ⌘X (cut: moved on paste) or ⌘C (copy: copied on paste), one per window. */
export interface DriveClipboard {
  mode: "cut" | "copy";
  items: DriveItemOut[];
}

export type PasteAction = { action: "move" | "copy"; items: DriveItemOut[] } | null;

/**
 * ⌘V into `folderId`: a cut moves the items (those already there stay, nothing to do; a folder never into itself);
 * a copy copies them, into their own folder too (the copy is numbered 「名前 (1)」). The clipboard of a cut is used
 * once, of a copy as often as wanted (Finder's way).
 */
export function pasteAction(clipboard: DriveClipboard | null, folderId: string): PasteAction {
  if (!clipboard || clipboard.items.length === 0) return null;
  if (clipboard.mode === "copy") {
    const items = clipboard.items.filter((item) => item.id !== folderId);
    return items.length > 0 ? { action: "copy", items } : null;
  }
  const items = clipboard.items.filter((item) => item.id !== folderId && item.parent_id !== folderId);
  return items.length > 0 ? { action: "move", items } : null;
}

/** The clipboard after a paste: a cut is gone, a copy stays. */
export function afterPaste(clipboard: DriveClipboard | null): DriveClipboard | null {
  return clipboard?.mode === "copy" ? clipboard : null;
}

const SOURCES: Readonly<Record<string, MessageKey>> = {
  upload: "drive.versions.source.upload",
  copy: "drive.versions.source.copy",
  restore: "drive.versions.source.restore",
  attachment: "drive.versions.source.attachment",
  import: "drive.versions.source.import",
  // CF1 (docs/CHANNEL_FILES.md §3.2): the file of a message posted in the channel.
  message: "drive.versions.source.message",
};

/** How a version came to be (アップロード / コピー / 前の版から戻した / …). */
export function versionSourceLabel(version: Pick<DriveVersionOut, "source">): string {
  const key = SOURCES[version.source];
  return key ? t(key) : version.source;
}

/** What may be done with a version: the current one only downloads; older ones restore (writers) or go (managers). */
export function versionActions(version: Pick<DriveVersionOut, "current">, rights: { canWrite: boolean; canManage: boolean }): { restore: boolean; remove: boolean } {
  return { restore: !version.current && rights.canWrite, remove: !version.current && rights.canManage };
}

const GB = 1024 ** 3;

/** The quota field (GB, decimals allowed): "" removes the quota (null), anything else not a number ≥ 0 is invalid (undefined). */
export function parseQuotaGb(text: string): number | null | undefined {
  const trimmed = text.trim().replace(/[，,]/g, "").replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (trimmed === "") return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  return Math.round(Number(trimmed) * GB);
}

/** A quota in bytes shown in the GB field ("" for none). */
export function quotaGbText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "";
  const gb = bytes / GB;
  return Number.isInteger(gb) ? String(gb) : String(Math.round(gb * 100) / 100);
}

/** How full (0…1, past 1 when over), or null without a quota. */
export function usageRatio(used: number, quota: number | null | undefined): number | null {
  if (quota === null || quota === undefined) return null;
  if (quota <= 0) return used > 0 ? Infinity : 0;
  return used / quota;
}
