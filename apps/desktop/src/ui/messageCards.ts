/** M185 (docs/LINK_PREVIEWS.md §5): what a message link's card shows, as plain rules (the card is MessageLinkCard.tsx). */
import type { AttachmentOut, GroupOut, MessagePreviewOut, UserPublic } from "../api/types";
import type { ChannelState } from "../sync/types";
import { t } from "../i18n";
import { conversationTitle } from "./channels";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";

/** Lines of the excerpt a card shows (the server sends at most 6). */
export const CARD_LINES = 4;

/**
 * The excerpt as the card shows it: each line as plain text (markers dropped, mentions as names, as one-line previews
 * do), blank lines left out, at most `lines` of them, 「…」 when anything was left out.
 */
export function excerptText(excerpt: string, truncated: boolean, users: ReadonlyMap<string, UserPublic>, groups?: ReadonlyMap<string, GroupOut>, lines = CARD_LINES): string {
  const rows = excerpt
    .split("\n")
    .map((line) => plainText(mentionsToNames(line, users, groups), 400))
    .filter((line) => line.trim() !== "");
  const text = rows.slice(0, lines).join("\n");
  return text && (truncated || rows.length > lines) ? `${text}…` : text;
}

/** The server's rule for the thumbnail (§3.2): the first photo or video poster not moved out of the channel's drive. */
export function cardThumbnail(attachments: readonly AttachmentOut[] | undefined): string | null {
  for (const file of attachments ?? []) {
    if (!(file.has_thumbnail || file.has_poster)) continue;
    if (file.drive && file.drive.state !== "available") continue;
    return file.id;
  }
  return null;
}

/**
 * Where the linked message is: `#name` for a channel (the server's name: a public channel I have not joined is not in my
 * list), the other people for a DM (I am in it, so it is in my list), 「#name のスレッド」 for a thread reply.
 */
export function cardConversation(preview: MessagePreviewOut, channel: ChannelState | undefined, users: ReadonlyMap<string, UserPublic>, meId: string | null): string {
  const isChannel = preview.channel_type === "public" || preview.channel_type === "private";
  const name = isChannel
    ? `#${preview.channel_name ?? channel?.name ?? ""}`
    : channel
      ? conversationTitle(channel, users, meId)
      : t("linkCards.directMessage");
  return preview.parent_id ? t("linkCards.inThread", { name }) : name;
}
