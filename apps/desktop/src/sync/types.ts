import type { ChannelOut, MessageOut, ParentThread, ReactionOut, ReadStateOut, UserMe, UserPublic } from "../api/types";

export type { ChannelOut, MessageOut, ParentThread, ReactionOut, ReadStateOut, UserMe, UserPublic };

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
  hasOlder: boolean;
}

/** A message as stored locally. Pending messages have seq null and id "local:<client_msg_id>". */
export interface MessageState
  extends Omit<MessageOut, "seq" | "type" | "mentioned_user_ids" | "mention_all" | "reactions" | "parent_id" | "reply_count" | "last_reply_at"> {
  seq: number | null;
  /** M8 fields: optional so placeholders and rows persisted before M8 still load. */
  type?: string;
  mentioned_user_ids?: string[];
  mention_all?: boolean;
  reactions?: ReactionOut[];
  parent_id?: string | null;
  reply_count?: number;
  last_reply_at?: string | null;
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

export type ServerFrame =
  | HelloFrame
  | { type: "pong"; server_time: string }
  | { type: "error"; code: string; message: string }
  | EventFrame;

export const LOCAL_PREFIX = "local:";
