import type { MessageState, ThreadEntry } from "../sync/types";

/** One reply shown under a threads-list card's parent (THREADS.md §5). */
export interface ThreadCardReply {
  message: MessageState;
  /** Someone else's reply after my read position in the thread (marked as the thread view marks it). */
  unread: boolean;
}

/** The replies part of a card: null when the server sent no previews (the card is the parent only, as before). */
export interface ThreadCardReplies {
  replies: ThreadCardReply[];
  /** Replies not shown (「他 n 件の返信」), 0 when every reply is in the card. */
  more: number;
}

export function threadCardReplies(entry: ThreadEntry, me: string | null | undefined, isBlocked: (userId: string) => boolean): ThreadCardReplies | null {
  if (!entry.latestReplies) return null;
  // Someone blocked after the list came: their replies leave the card at once (the server leaves them out too).
  const replies = entry.latestReplies
    .filter((m) => !m.deleted && !isBlocked(m.sender_id))
    .map((message) => ({ message, unread: message.sender_id !== me && (message.seq ?? 0) > entry.state.last_read_seq }));
  return { replies, more: Math.max(0, entry.state.reply_count - replies.length) };
}
