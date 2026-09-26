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
