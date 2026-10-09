import { AtSign, Hash, Lock } from "lucide-react";

import type { ChannelOut, MessageOut, SearchHit } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { sinceLabel } from "./format";
import { highlightPieces, leadToFirstHit } from "./highlight";
import { type LiveQuery, useLiveQuery } from "./liveQuery";
import { channelTitle } from "./MainScreen";
import { plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { cn } from "./primitives";
import { EMPTY_SEARCH, toQuery } from "./search";
import { EmojiText } from "./UserPopover";
import { t } from "../i18n";

export { LIVE_DEBOUNCE_MS } from "./liveQuery";

/** How many messages the box shows while typing. */
export const LIVE_LIMIT = 5;

export interface LiveMessages {
  hits: SearchHit[];
  keywords: string[];
  /** Hit channels I am not a member of (SearchOut.channels), by id. */
  channels: Record<string, ChannelOut>;
}

export type LiveResults = LiveQuery<LiveMessages>;

const NOTHING: LiveMessages = { hits: [], keywords: [], channels: {} };

/**
 * The few best messages for what is typed in a search box (docs/IMPLEMENTATION_PLAN.md M16b, the live results):
 * GET /search/messages with a small limit, once typing pauses (useLiveQuery: the debounce, the IME, dropped late
 * answers, the box's memory); nothing for an empty box (the results page's own minimum: any word).
 */
export function useLiveSearch(controller: AppController, text: string, paused: boolean): LiveResults {
  return useLiveQuery(controller, text, paused, async (api, q) => {
    const result = await api.search({ ...toQuery({ ...EMPTY_SEARCH, q }), limit: LIVE_LIMIT, offset: 0 });
    return { hits: result.hits.slice(0, LIVE_LIMIT), keywords: result.keywords, channels: Object.fromEntries((result.channels ?? []).map((c) => [c.id, c])) };
  }, NOTHING);
}

/** One live result: conversation, sender, when, and a line or two of the body with the words marked. */
export function LiveMessageRow({ controller, message, keywords, other }: { controller: AppController; message: MessageOut; keywords: string[]; other?: ChannelOut }) {
  const store = controller.store;
  const channel = store.getChannel(message.channel_id) ?? (other ? ({ ...other, isMember: false } as ChannelState) : undefined);
  const sender = store.users.get(message.sender_id)?.display_name ?? "?";
  const body = plainText(mentionsToNames(message.body, store.users, store.groups), 2000);
  const text = leadToFirstHit(body || message.attachments.map((a) => a.filename).join(" "), keywords);
  const Icon = channel?.type === "private" ? Lock : channel?.type === "public" ? Hash : AtSign;
  return (
    <>
      <Avatar id={message.sender_id} name={sender} size={24} className="mt-0.5 self-start rounded-md text-[10px]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <strong className="min-w-0 truncate font-semibold text-ink">{sender}</strong>
          <Icon size={11} className="shrink-0" />
          <span className="min-w-0 truncate">{channel ? channelTitle(channel, controller).replace(/^#/, "") : "?"}</span>
          {message.parent_id && <span className="shrink-0">· {t("composer.threadReply")}</span>}
          <time className="ml-auto shrink-0 pl-2">{sinceLabel(message.created_at)}</time>
        </span>
        <span className={cn("line-clamp-2 break-words text-[13px] leading-snug text-ink")}>
          {highlightPieces(text, keywords).map((piece, i) =>
            piece.hit ? (
              <mark key={i} className="rounded bg-warning/35 px-0.5 text-ink">{piece.text}</mark>
            ) : (
              <span key={i}><EmojiText controller={controller} text={piece.text} /></span>
            ),
          )}
        </span>
      </span>
    </>
  );
}

/** The compact line under 「メッセージ」 while there is nothing to list: searching, nothing found, or an error. */
export function LiveStatus({ live }: { live: LiveResults }) {
  const text = live.status === "loading" ? t("searchBar.searching") : live.status === "error" ? t("searchBar.liveError") : t("searchBar.noMessages");
  return <div className={cn("px-2.5 py-1.5 text-xs", live.status === "error" ? "text-danger" : "text-muted")} role="status">{text}</div>;
}
