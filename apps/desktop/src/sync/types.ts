import type { ChannelOut, MessageOut, ReactionOut, UserMe, UserPublic } from "../api/types";

export type { ChannelOut, MessageOut, ReactionOut, UserMe, UserPublic };

/** A channel as the client stores it: server fields plus the sync cursor (SYNC_PROTOCOL.md §7.1). */
export interface ChannelState extends ChannelOut {
  isMember: boolean;
  /** null: no timeline loaded yet. */
  syncedSeq: number | null;
  lastSeq: number;
  /** Local read marker until the server read state arrives in M8b. */
  seenSeq: number;
  hasOlder: boolean;
}

/** A message as stored locally. Pending messages have seq null and id "local:<client_msg_id>". */
export interface MessageState extends Omit<MessageOut, "seq" | "type" | "mentioned_user_ids" | "mention_all" | "reactions"> {
  seq: number | null;
  /** M8a fields: optional so placeholders and rows persisted before M8a still load. */
  type?: string;
  mentioned_user_ids?: string[];
  mention_all?: boolean;
  reactions?: ReactionOut[];
  pending?: boolean;
  failed?: boolean;
}

export interface OutboxItem {
  client_msg_id: string;
  channel_id: string;
  body: string;
  created_at: string;
  failed?: string;
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
