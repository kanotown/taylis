/**
 * M165 (docs/DRIVE.md §13): the drive and the conversations — the rules the card of a `/d/<id>` link, the composer's
 * 「ドライブから」 and 「ドライブに保存」 share, kept apart from the screens so the tests can read them.
 */
import type { DriveCrumb, DriveItemDetailOut, DriveLocationOut, DriveReachOut } from "../api/types";
import type { ChannelState } from "../sync/types";
import { t } from "../i18n";
import { formatBytes, pathLine } from "./listing";

/** The root's name in the UI language (the server names it in Japanese), then the folders: 「研究室ドライブ › 資料」. */
export function locationLine(path: readonly DriveCrumb[], kind: DriveItemDetailOut["location_kind"]): string {
  const root = kind === "workspace" ? t("drive.location.workspace") : kind === "user" ? t("drive.location.mine") : path[0] ? `#${path[0].name}` : "";
  return pathLine(path, root);
}

/** The card's second line: where the item is, and its size (a folder: 「フォルダ」). */
export function cardDetails(detail: DriveItemDetailOut): string {
  const where = locationLine(detail.path, detail.location_kind);
  const what = detail.item.kind === "folder" ? t("driveCard.folder") : formatBytes(detail.item.size_bytes);
  return where ? `${where} · ${what}` : what;
}

/** The composer's warning (§13.1): null when everyone in the conversation can read the item. */
export function reachWarning(reach: DriveReachOut | null | undefined, channel: Pick<ChannelState, "type">): string | null {
  if (!reach || reach.unreadable <= 0) return null;
  const dm = channel.type === "dm" || channel.type === "group_dm";
  return t(dm ? "driveLink.reachWarningDm" : "driveLink.reachWarning", { count: reach.unreadable });
}

/**
 * Where 「ドライブに保存」 starts (§13.2): the conversation's own drive when it has one I can write, else マイドライブ,
 * else the first location I can write (a guest has neither 研究室ドライブ nor マイドライブ).
 */
export function defaultSaveLocation(locations: readonly DriveLocationOut[], channelId: string | null): DriveLocationOut | null {
  const writable = locations.filter((loc) => loc.can_write);
  return (
    writable.find((loc) => loc.kind === "channel" && loc.channel_id === channelId) ??
    writable.find((loc) => loc.kind === "user") ??
    writable[0] ??
    null
  );
}

/** A draft with the link to `itemId` (and the text around it) taken out, for 「コピーとして送る」. */
export function withoutDriveLink(text: string, baseUrl: string, itemId: string): string {
  const link = `${baseUrl.replace(/\/+$/, "")}/d/${itemId}`;
  let out = text;
  for (let at = out.toLowerCase().indexOf(link.toLowerCase()); at >= 0; at = out.toLowerCase().indexOf(link.toLowerCase())) {
    out = out.slice(0, at) + out.slice(at + link.length);
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
