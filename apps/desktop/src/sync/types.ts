import type { AckOut, AttachmentOut, MessageTaskOut, ChannelLinkOut, ChannelOut, CustomEmojiOut, DraftOut, DraftUpdated, GroupOut, MessageOut, PollOut, Priority, SidebarSectionOut, NotificationLevel, ParentThread, PresenceEntry, PresenceStatus, ReactionOut, ReadStateOut, ReminderOut, ScheduledOut, ThreadFilter, ThreadItem, ThreadState, ThreadSummary, ThreadUpdated, UserMe, UserPublic } from "../api/types";

export type { AckOut, AttachmentOut, ChannelLinkOut, ChannelOut, CustomEmojiOut, DraftOut, DraftUpdated, GroupOut, MessageOut, Priority, SidebarSectionOut, NotificationLevel, ParentThread, PresenceEntry, PresenceStatus, ReactionOut, ReadStateOut, ReminderOut, ScheduledOut, ThreadFilter, ThreadItem, ThreadState, ThreadSummary, ThreadUpdated, UserMe, UserPublic };

/** One row of the threads view: the parent message and my relation to the thread (THREADS.md §5). */
export interface ThreadEntry {
  parent: MessageOut;
  state: ThreadState;
}

/** A channel as the client stores it: server fields plus the sync cursor (SYNC_PROTOCOL.md §7.1). */
export interface ChannelState extends ChannelOut {
  isMember: boolean;
  /** null: no timeline loaded yet. */
  syncedSeq: number | null;
  lastSeq: number;
  /** Server read position and counts (SYNC_PROTOCOL.md §10); counts are replaced by read.updated. */
  lastReadSeq: number;
  unreadCount: number;
  mentionCount: number;
  /**
   * §10.1: created_at of the oldest message counted in unreadCount (the banner's 「… 以降」); null when nothing
   * is unread or the server did not say. Replaced together with unreadCount.
   */
  firstUnreadAt: string | null;
  /**
   * A read position shown here that the server has not confirmed yet (a failed PUT, or the app closed
   * during the debounce); sent again after reconnecting (§10). null when there is none.
   */
  pendingReadSeq: number | null;
  hasOlder: boolean;
  /**
   * §7.3: the oldest seq of the contiguous range loaded by the latest page and 「以前を読み込む」 (0 once
   * the start is reached; null while no timeline is loaded). Only rows at or after it are shown.
   */
  oldestLoadedSeq: number | null;
  /**
   * My notification preference (PUSH_NOTIFICATIONS.md §4): the conversation's OWN level, null while it follows my
   * overall setting (M35; the server's `level` is resolved, `follows_default` says which). ui/channels.ts resolves it.
   */
  notificationLevel: NotificationLevel | null;
  mutedUntil: string | null;
  /** M35: muted until unmuted (rows persisted earlier lack it: not muted). */
  muted?: boolean;
}

/** A message as stored locally. Pending messages have seq null and id "local:<client_msg_id>". */
export interface MessageState
  extends Omit<MessageOut, "seq" | "type" | "mentioned_user_ids" | "mention_all" | "reactions" | "parent_id" | "also_in_channel" | "reply_count" | "last_reply_at" | "reply_user_ids" | "attachments" | "pinned_at" | "pinned_by" | "poll" | "priority" | "ack_requested" | "acks" | "tasks"> {
  seq: number | null;
  /** M8 fields: optional so placeholders and rows persisted before M8 still load. */
  type?: string;
  mentioned_user_ids?: string[];
  mention_all?: boolean;
  reactions?: ReactionOut[];
  /** L9: shared tasks made from it (review requests); optional like the other server-filled fields. */
  tasks?: MessageTaskOut[];
  parent_id?: string | null;
  /** M15c: a reply shown in the channel timeline as well as in its thread. */
  also_in_channel?: boolean;
  reply_count?: number;
  last_reply_at?: string | null;
  /** C3: who replied, most recent first (at most 5); absent from older servers and rows persisted earlier. */
  reply_user_ids?: string[];
  attachments?: AttachmentOut[];
  /** M11c: pinned in the channel; rows persisted earlier lack the fields. */
  pinned_at?: string | null;
  pinned_by?: string | null;
  /** M14b: the poll, when the message carries one. */
  poll?: PollOut | null;
  /** M15e: priority label and acknowledgements (only when asked for). */
  priority?: Priority | null;
  ack_requested?: boolean;
  acks?: AckOut[];
  pending?: boolean;
  failed?: boolean;
}

export interface OutboxItem {
  client_msg_id: string;
  channel_id: string;
  body: string;
  created_at: string;
  failed?: string;
  parent_id?: string | null;
  attachment_ids?: string[];
  also_in_channel?: boolean;
  /** M15e */
  priority?: Priority | null;
  ack_requested?: boolean;
}

/** Extras for a send (they travel with the outbox so retries keep them). */
export interface SendOptions {
  /** M15c: a thread reply also shown in the channel. */
  alsoInChannel?: boolean;
  /** M15e: top-level posts only. */
  priority?: Priority | null;
  ackRequested?: boolean;
}

export interface EventFrame {
  type: "event";
  id: number;
  event: string;
  ts: string;
  channel_id: string | null;
  seq: number | null;
  data: Record<string, unknown>;
}

export interface HelloFrame {
  type: "hello";
  session_id: string;
  server_time: string;
  heartbeat_interval_sec: number;
}

/** Volatile frames (M11b): never stored, never replayed. */
export interface TypingFrame {
  type: "typing";
  channel_id: string;
  parent_id: string | null;
  user_id: string;
}

export interface PresenceFrame {
  type: "presence";
  user_id: string;
  status: PresenceStatus;
}

export type ServerFrame =
  | HelloFrame
  | { type: "pong"; server_time: string }
  | { type: "error"; code: string; message: string }
  | EventFrame
  | TypingFrame
  | PresenceFrame;

export const LOCAL_PREFIX = "local:";
