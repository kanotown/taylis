// Domain types come from the shared OpenAPI document (openapi/openapi.json → src/api/schema.d.ts).
import type { components } from "./schema";

export type UserPublic = components["schemas"]["UserPublic"];
export type UserMe = components["schemas"]["UserMe"];
export type TokenResponse = components["schemas"]["TokenResponse"];
export type ChannelOut = components["schemas"]["ChannelOut"];
/** M49: a member's conversation's newest message as one line (MOBILE_UI.md §7.1). */
export type LastMessageOut = components["schemas"]["LastMessageOut"];
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
  /** C3: the parent's repliers after the change (absent from older servers). */
  reply_user_ids?: string[];
  updated_seq: number;
  participant_ids?: string[];
}
export type HistoryOut = components["schemas"]["HistoryOut"];
export type DeltaOut = components["schemas"]["DeltaOut"];
export type BootstrapOut = components["schemas"]["BootstrapOut"];
export type MemberOut = components["schemas"]["MemberOut"];
/** L4 (M31): owner / member, set by an owner or an admin. */
export type MemberRole = MemberOut["role"];
export type AckPendingOut = components["schemas"]["AckPendingOut"];
export type AckRemindOut = components["schemas"]["AckRemindOut"];
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

/** Recurring posts and collections (L6, M59, RECURRING.md). */
export type RecurringPostOut = components["schemas"]["RecurringPostOut"];
export type RecurringPostCreate = components["schemas"]["RecurringPostCreate"];
export type RecurringPostUpdate = components["schemas"]["RecurringPostUpdate"];
export type RecurringRunOut = components["schemas"]["RecurringRunOut"];
export type WeeklySchedule = components["schemas"]["WeeklySchedule"];
export type MonthlySchedule = components["schemas"]["MonthlySchedule"];
export type RecurringSchedule = WeeklySchedule | MonthlySchedule;
export type CollectSpec = components["schemas"]["CollectSpec"];
export type CollectionOut = components["schemas"]["CollectionOut"];

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

/** Sign-in methods and Google sign-in (M48, docs/SSO.md). */
export type AuthMethodsOut = components["schemas"]["AuthMethodsOut"];

/** Two-factor authentication (M12i). */
export type TotpStatusOut = components["schemas"]["TotpStatusOut"];
export type TotpSetupOut = components["schemas"]["TotpSetupOut"];
export type TotpEnabledOut = components["schemas"]["TotpEnabledOut"];
/** M40: GET /auth/sessions — my signed-in devices, `current` = this one. */
export type SessionOut = components["schemas"]["SessionOut"];

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
/** L7 (M32): the roster line an invite link gives, and what the acceptance screen shows of it. */
export type LabPreset = components["schemas"]["LabPreset"];
export type InviteLabPreview = components["schemas"]["InviteLabPreview"];
/** L7 (M32): the yearly rollover. */
export type RolloverPreviewOut = components["schemas"]["RolloverPreviewOut"];
export type RolloverPreviewItem = components["schemas"]["RolloverPreviewItem"];
export type RolloverApply = components["schemas"]["RolloverApply"];
export type RolloverItem = components["schemas"]["RolloverItem"];
export type RolloverAction = RolloverItem["action"];
export type RolloverOut = components["schemas"]["RolloverOut"];

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
type ServerPoll = components["schemas"]["PollOut"];
/** M53 (SCHEDULING.md): a scheduling poll's fields; a server before M53 and rows stored before it have none. */
type SchedulePollFields = "kind" | "slots" | "tz" | "decided" | "answers" | "respondents" | "comments" | "my_answers" | "my_comment";
export type PollOut = Omit<ServerPoll, "anonymous" | "counts" | SchedulePollFields> & { anonymous?: boolean; counts?: number[] } & Partial<Pick<ServerPoll, SchedulePollFields>>;
export type PollCreate = components["schemas"]["PollCreate"];
/** M53: one candidate of a scheduling poll (a time, or a whole day) and the answers to it. */
export type ScheduleSlotIn = components["schemas"]["ScheduleSlotIn"];
export type ScheduleSlotOut = components["schemas"]["ScheduleSlotOut"];
export type SlotAnswersOut = components["schemas"]["SlotAnswersOut"];
export type PollAnswer = components["schemas"]["PollAnswerIn"]["answer"];
export type PollAnswersIn = components["schemas"]["PollAnswersIn"];
export type PollDecidedOut = components["schemas"]["PollDecidedOut"];

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

/** Post templates (M30); template.updated carries `{ template, deleted }`. */
export type TemplateOut = components["schemas"]["TemplateOut"];
export type TemplateCreate = components["schemas"]["TemplateCreate"];
export type TemplateUpdate = components["schemas"]["TemplateUpdate"];

/**
 * Activity, stage B (M39, MOBILE_UI.md §6.4 / §7.2): mentions of me, reactions to my messages (one item per message) and
 * replies in threads I follow, newest first, with one read position per person (`read_at`, only moves forward).
 */
export type ActivityItem = components["schemas"]["ActivityItem"];
export type ActivityKind = ActivityItem["kind"];
export type ActivityListOut = components["schemas"]["ActivityListOut"];
export type ActivitySummaryOut = components["schemas"]["ActivitySummaryOut"];
export type ActivityFilter = "all" | "mentions" | "reactions" | "threads";
/** reaction.added (audience = the message's author): someone reacted to my message. */
export interface ReactionAdded {
  channel_id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  at: string;
}

/**
 * Canvases (CANVAS.md; the server in M41, this client in M43): Markdown documents of a conversation, saved whole with the
 * version they were written on and merged on the server (§4.4). The canvas.* events carry the metadata only (§4.6).
 */
export type CanvasMeta = components["schemas"]["CanvasMeta"];
export type CanvasOut = components["schemas"]["CanvasOut"];
export type CanvasPage = components["schemas"]["CanvasPage"];
export type CanvasCreate = components["schemas"]["CanvasCreate"];
export type CanvasUpdate = components["schemas"]["CanvasUpdate"];
export type CanvasSaveIn = components["schemas"]["ContentSave"];
export type CanvasSaveOut = components["schemas"]["SaveOut"];
export type CanvasConflict = components["schemas"]["ConflictOut"];
export type CanvasConflictDetails = components["schemas"]["CanvasConflictDetails"];
export type CanvasTemplateOut = components["schemas"]["CanvasTemplateOut"];
export type CanvasEditPolicy = CanvasMeta["edit_policy"];
export type CanvasOnConflict = "fail" | "ours" | "theirs" | "both";
/** M44: the history (§4.9), search (§4.8) and the administrators' templates (§4.12). */
export type CanvasRevisionMeta = components["schemas"]["RevisionMeta"];
export type CanvasRevisionOut = components["schemas"]["RevisionOut"];
export type CanvasRevisionPage = components["schemas"]["RevisionPage"];
export type CanvasSearchHit = components["schemas"]["CanvasSearchHit"];
export type CanvasSearchOut = components["schemas"]["CanvasSearchOut"];
export type CanvasTemplateCreate = components["schemas"]["CanvasTemplateCreate"];
export type CanvasTemplateUpdate = components["schemas"]["CanvasTemplateUpdate"];
/** canvas.updated: the new metadata and what changed ("content" | "title" | "settings" | "restore"). */
export interface CanvasUpdated {
  canvas: CanvasMeta;
  change: string;
}
/** canvas.deleted: moved to the trash. */
export interface CanvasDeleted {
  canvas_id: string;
  channel_id: string;
}

/**
 * Calendar (CALENDAR.md; M51): one-off events in my own calendar (`channel_id` null) or a channel's shared one. The
 * calendar.* events carry the event without the fields that differ per person: `can_edit` is `editor_ids` holding me,
 * and my alarm travels on calendar.alarm.updated (openapi/ws-events.json).
 */
export type CalendarEventOut = components["schemas"]["CalendarEventOut"];
export type CalendarEventCreate = components["schemas"]["CalendarEventCreate"];
export type CalendarEventUpdate = components["schemas"]["CalendarEventUpdate"];
export type CalendarAlarmOut = components["schemas"]["CalendarAlarmOut"];
export type CalendarEventData = Omit<CalendarEventOut, "can_edit" | "alarm">;
/** calendar.event.updated: a new or changed event, and who may change it now. */
export interface CalendarEventUpdated {
  event: CalendarEventData;
  editor_ids: string[];
}
/** calendar.event.deleted. */
export interface CalendarEventDeleted {
  id: string;
  channel_id: string | null;
}
/**
 * Tasks (TASKS.md; M55): a channel's board (`channel_id` set) or my personal list (`channel_id` null). task.updated
 * carries the task without `can_delete` (it differs per person): it is `deleter_ids` holding me (openapi/ws-events.json).
 */
export type TaskOut = components["schemas"]["TaskOut"];
export type TaskCreate = components["schemas"]["TaskCreate"];
export type TaskUpdate = components["schemas"]["TaskUpdate"];
export type TaskMove = components["schemas"]["TaskMove"];
export type TaskStatus = TaskOut["status"];
export type TaskData = Omit<TaskOut, "can_delete">;
/** task.updated: a new, changed or moved task, and who may delete it. */
export interface TaskUpdated {
  task: TaskData;
  deleter_ids: string[];
}
/** task.deleted. */
export interface TaskDeleted {
  id: string;
  channel_id: string | null;
}
/** task.assigned (to me only): someone else added me to a shared task's assignees. */
export interface TaskAssigned {
  task_id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  by_user_id: string;
}
/** task.due (to me only): one of my open tasks is due today (8:00 in my zone). */
export interface TaskDue {
  task_id: string;
  channel_id: string | null;
  channel_name: string | null;
  title: string;
  due_on: string;
}
/** calendar.alarm.updated: my alarm on an event was set, recomputed, fired (status "fired") or removed (null). */
export interface CalendarAlarmUpdated {
  event_id: string;
  channel_id: string | null;
  alarm: CalendarAlarmOut | null;
}
