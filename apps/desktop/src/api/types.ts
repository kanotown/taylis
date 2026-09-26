// Domain types come from the shared OpenAPI document (openapi/openapi.json → src/api/schema.d.ts).
import type { components } from "./schema";

export type UserPublic = components["schemas"]["UserPublic"];
export type UserMe = components["schemas"]["UserMe"];
export type TokenResponse = components["schemas"]["TokenResponse"];
export type ChannelOut = components["schemas"]["ChannelOut"];
export type MessageOut = components["schemas"]["MessageOut"];
export type ReactionOut = components["schemas"]["ReactionOut"];
export type ReadStateOut = components["schemas"]["ReadStateOut"];
export type AttachmentOut = components["schemas"]["AttachmentOut"];
export type NotificationPreferenceOut = components["schemas"]["NotificationPreferenceOut"];
export type NotificationLevel = NotificationPreferenceOut["level"];
/** message.created / message.deleted payloads for thread replies (SYNC_PROTOCOL.md §6). */
export interface ParentThread {
  id: string;
  reply_count: number;
  last_reply_at: string | null;
  updated_seq: number;
  participant_ids?: string[];
}
export type HistoryOut = components["schemas"]["HistoryOut"];
export type DeltaOut = components["schemas"]["DeltaOut"];
export type BootstrapOut = components["schemas"]["BootstrapOut"];
export type MemberOut = components["schemas"]["MemberOut"];
export type ChannelType = ChannelOut["type"];

export type SearchHit = components["schemas"]["SearchHit"];
export type SearchOut = components["schemas"]["SearchOut"];
export type SearchFilters = components["schemas"]["SearchFilters"];
export type ReadMode = components["schemas"]["ReadMark"]["mode"];

/** Followed threads (THREADS.md §3). */
export type ThreadState = components["schemas"]["ThreadState"];
export type ThreadItem = components["schemas"]["ThreadItem"];
export type ThreadListOut = components["schemas"]["ThreadListOut"];
export type ThreadSummary = components["schemas"]["ThreadSummary"];
export type ThreadFilter = "all" | "unread";
/** thread.updated payload: the state plus why it changed (SYNC_PROTOCOL.md §6). */
export type ThreadUpdated = ThreadState & { reason: "reply" | "deleted" | "read" | "follow" };

/** Volatile WebSocket frames (SYNC_PROTOCOL.md §5.2, M11b). */
export type PresenceStatus = "online" | "away" | "offline";
export interface PresenceEntry {
  user_id: string;
  status: PresenceStatus;
}

/** Saved messages (M11c). */
export type BookmarkStateOut = components["schemas"]["BookmarkStateOut"];
export type BookmarkItem = components["schemas"]["BookmarkItem"];
export type BookmarkListOut = components["schemas"]["BookmarkListOut"];

/** Administration (M11e). */
export type AdminUserOut = components["schemas"]["AdminUserOut"];
export type AdminUserCreate = components["schemas"]["AdminUserCreate"];
export type AdminUserCreated = components["schemas"]["AdminUserCreated"];
export type AdminUserUpdate = components["schemas"]["AdminUserUpdate"];
export type TemporaryPasswordOut = components["schemas"]["TemporaryPasswordOut"];

/** Link previews (M11g). */
export type LinkPreviewOut = components["schemas"]["LinkPreviewOut"];

/** Recent mentions (M11h). */
export type MentionListOut = components["schemas"]["MentionListOut"];

/** Files list (M11i). */
export type FileItem = components["schemas"]["FileItem"];
export type FileListOut = components["schemas"]["FileListOut"];
