/**
 * M49, the DM list's preview line (MOBILE_UI.md §6.3 / §7.1). The rule and its cases are shared with the server and the
 * phones: apps/shared/dm-preview.json. Pure (no store, no React): the store keeps `last_message` current with it too.
 */
import type { ChannelOut, GroupOut, LastMessageOut, UserPublic } from "../api/types";
import { attachmentText, plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { t } from "../i18n";

/** The excerpt's length, the server's (messages/service.py PREVIEW_LENGTH); the row cuts it to one line anyway. */
export const PREVIEW_LENGTH = 140;

/** A message as the preview reads it: an event's MessageOut or a stored row. */
export interface PreviewSource {
  id: string;
  sender_id: string;
  type?: string;
  seq: number | null;
  body: string;
  attachments?: ReadonlyArray<{ content_type: string }>;
  created_at: string;
}

/**
 * The server's excerpt (ChannelOut.last_message.excerpt): the body as one line with mention names (the push body's rule),
 * or, without text, what the attachments were (「画像を送信しました」 …).
 */
export function previewExcerpt(
  body: string,
  attachments: ReadonlyArray<{ content_type: string }> | undefined,
  users: Map<string, UserPublic>,
  groups: ReadonlyMap<string, GroupOut> = new Map(),
): string {
  return plainText(mentionsToNames(body, users, groups), PREVIEW_LENGTH) || attachmentText(attachments);
}

/** A held or live message as `last_message` (what the server would send for it). */
export function lastMessageOf(message: PreviewSource, users: Map<string, UserPublic>, groups: ReadonlyMap<string, GroupOut> = new Map()): LastMessageOut {
  return {
    id: message.id,
    sender_id: message.sender_id,
    type: message.type ?? "user",
    seq: message.seq ?? 0,
    excerpt: previewExcerpt(message.body, message.attachments, users, groups),
    has_attachments: (message.attachments?.length ?? 0) > 0,
    created_at: message.created_at,
  };
}

/**
 * The line under the conversation's name. Nothing without a last message or with an empty excerpt; a system message as it
 * is; mine 「あなた: 」 (not in my own DM, where every message is mine); someone else's in a 1:1 DM as it is (the row
 * already names them, as Slack); elsewhere 「<表示名>: 」 (an unknown sender 「メンバー: 」).
 */
export function previewLine(
  channel: Pick<ChannelOut, "type" | "dm_user_ids">,
  last: Pick<LastMessageOut, "sender_id" | "type" | "excerpt"> | null | undefined,
  meId: string | null,
  users: ReadonlyMap<string, Pick<UserPublic, "display_name">>,
): string {
  if (!last || !last.excerpt) return "";
  if (last.type !== "user") return last.excerpt;
  if (meId && last.sender_id === meId) {
    const selfNotes = channel.type === "dm" && (channel.dm_user_ids ?? []).every((id) => id === meId);
    return selfNotes ? last.excerpt : t("dmPreview.you", { text: last.excerpt });
  }
  if (channel.type === "dm") return last.excerpt;
  const name = users.get(last.sender_id)?.display_name?.trim() || t("common.member");
  return `${name}: ${last.excerpt}`;
}

/** The same preview (nothing the row shows changed): an event that only moved reactions or pins. */
export function sameLastMessage(a: LastMessageOut | null | undefined, b: LastMessageOut | null | undefined): boolean {
  if (!a || !b) return !a && !b; // null and undefined both say "none"
  return a.id === b.id && a.seq === b.seq && a.excerpt === b.excerpt && a.has_attachments === b.has_attachments && a.type === b.type && a.sender_id === b.sender_id;
}
