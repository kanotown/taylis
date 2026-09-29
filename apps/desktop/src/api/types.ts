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
export type ChannelUpdate = components["schemas"]["ChannelUpdate"];
/** M15a: "owners" = an announcement channel. */
export type PostingPolicy = ChannelOut["posting_policy"];

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

/** Starred channels and 「すべて既読にする」 (M12a). */
export type FavoriteStateOut = components["schemas"]["FavoriteStateOut"];
export type ChannelReadStateOut = components["schemas"]["ChannelReadStateOut"];

/** PATCH /users/me body (M11d, M12c). */
export type UserUpdate = components["schemas"]["UserUpdate"];

/** Scheduled messages (M12d). */
export type ScheduledOut = components["schemas"]["ScheduledOut"];
export type ScheduledCreate = components["schemas"]["ScheduledCreate"];

/** Reminders (M12e). */
export type ReminderOut = components["schemas"]["ReminderOut"];
export type ReminderCreate = components["schemas"]["ReminderCreate"];

/** Custom emoji (M12f). */
export type CustomEmojiOut = components["schemas"]["CustomEmojiOut"];

/** Invite links (M12h). */
export type InviteOut = components["schemas"]["InviteOut"];
export type InviteCreate = components["schemas"]["InviteCreate"];
export type InviteCreated = components["schemas"]["InviteCreated"];
export type InvitePreviewOut = components["schemas"]["InvitePreviewOut"];
export type InviteAccept = components["schemas"]["InviteAccept"];

/** Two-factor authentication (M12i). */
export type TotpStatusOut = components["schemas"]["TotpStatusOut"];
export type TotpSetupOut = components["schemas"]["TotpSetupOut"];
export type TotpEnabledOut = components["schemas"]["TotpEnabledOut"];

/** User groups (M12k). */
export type GroupOut = components["schemas"]["GroupOut"];
export type GroupCreate = components["schemas"]["GroupCreate"];
export type GroupUpdate = components["schemas"]["GroupUpdate"];

/** The lab roster (M23). */
export type LabProfileOut = components["schemas"]["LabProfileOut"];
export type LabProfilePut = components["schemas"]["LabProfilePut"];
export type MyLabProfileUpdate = components["schemas"]["MyLabProfileUpdate"];
export type Affiliation = LabProfileOut["affiliation"];
export type FacultyRank = NonNullable<LabProfileOut["rank"]>;
export type Grade = NonNullable<LabProfileOut["grade"]>;

/** Incoming webhooks (M13a). */
export type WebhookOut = components["schemas"]["WebhookOut"];
export type WebhookCreate = components["schemas"]["WebhookCreate"];
export type WebhookUpdate = components["schemas"]["WebhookUpdate"];
export type WebhookCreated = components["schemas"]["WebhookCreated"];

/** Workspace roles (M13e adds guest). */
export type Role = components["schemas"]["AdminUserCreate"]["role"];

/**
 * Polls (M14b). `anonymous`, `counts` and `mine` came with M27: a server before it sends none of them, and rows stored
 * here before it lack them, so they are optional when read (ui/PollCard.tsx pollCounts / pollMine fall back).
 */
export type PollOut = Omit<components["schemas"]["PollOut"], "anonymous" | "counts"> & { anonymous?: boolean; counts?: number[] };
export type PollCreate = components["schemas"]["PollCreate"];

/** Edit history (M14c). */
export type MessageRevisionOut = components["schemas"]["MessageRevisionOut"];

/** Custom sidebar sections (M14f). */
export type SidebarSectionOut = components["schemas"]["SidebarSectionOut"];

/** Links pinned to the top of a conversation (M15f). */
export type ChannelLinkOut = components["schemas"]["ChannelLinkOut"];

/** Message priority and acknowledgements (M15e). */
export type Priority = NonNullable<MessageOut["priority"]>;
export type AckOut = components["schemas"]["AckOut"];

/** Drafts shared by my devices (M15d); draft.updated adds `deleted` (then `body` is empty). */
export type DraftOut = components["schemas"]["DraftOut"];
export interface DraftUpdated extends DraftOut {
  deleted: boolean;
}
export type ServerInfoOut = components["schemas"]["ServerInfoOut"];
export type UnreadSummaryOut = components["schemas"]["UnreadSummaryOut"];
