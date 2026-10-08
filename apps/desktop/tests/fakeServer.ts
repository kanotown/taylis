/**
 * In-process model of the server side of SYNC_PROTOCOL.md: channel sequences, idempotent
 * posting, history / delta cursors, bootstrap and WebSocket event fan-out. It exists so the
 * engine tests and the shared contract fixtures run without a backend.
 */
import { ApiError } from "../src/api/errors";
import type { PoolOut, ActivityFilter, ActivityItem, ActivityListOut, ActivitySummaryOut, AttachmentOut, BootstrapOut, CanvasConflict, CanvasCreate, CanvasMeta, CanvasOnConflict, CanvasOut, CanvasRevisionMeta, CanvasRevisionOut, CanvasRevisionPage, CanvasSaveIn, CanvasSaveOut, CanvasSearchOut, CanvasTemplateCreate, CanvasTemplateOut, CanvasTemplateUpdate, CanvasUpdate, ChannelLinkOut, MemberOut, ChannelOut, ChannelReadStateOut, CustomEmojiOut, DeltaOut, DraftOut, HistoryOut, MessageOut, NotificationLevel, NotificationPreferenceOut, ParentThread, ReadStateOut, ReminderOut, ScheduledOut, SessionOut, ThreadFilter, ThreadListOut, ThreadState, ThreadSummary, UserMe, UserPublic, LabProfileOut, TemplateOut } from "../src/api/types";
import type { ActionListOut, ActionStatusOut, AttendanceBoardOut, DmCloseStateOut, DmPinStateOut, LastMessageOut, WorkspaceSettingsOut } from "../src/api/types";
import { aiProviderOf, type AiAgentCreate, type AiAgentOut, type AiAgentUpdate, type AiAskCreate, type AiAskTargetOut, type AiProviderOut, type AiRunOut, type AiStatusOut, type AiSummaryCreate, type AiSummaryTargetOut, type AiUsageOut } from "../src/api/ai";
import type { components } from "../src/api/schema";
import type { SyncApi, WsConnector, WsLike } from "../src/sync/engine";
import { lastMessageOf } from "../src/ui/dmPreview";
import type { Persistence, Snapshot } from "../src/sync/store";
import type { ChannelState, EventFrame, MessageState, OutboxItem, SendOptions } from "../src/sync/types";

let counter = 0;
const nextId = (): string => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
// Strictly increasing so that timestamp cursors (threads) never tie inside one test.
let clock = Date.now();
const now = (): string => new Date(++clock).toISOString();
const MENTION_USER = /<@([0-9a-f-]{36})>/g;
const MENTION_ALL = /<!(channel|here)>/;
const mentionedIds = (body: string): string[] => [...new Set([...body.matchAll(MENTION_USER)].map((m) => m[1] ?? ""))];

interface ChannelRecord {
  channel: ChannelOut;
  members: Set<string>;
  messages: MessageOut[];
}

/** A poll as the server responds with it (all M27 fields present). */
type ServerPoll = components["schemas"]["PollOut"];

/** A poll's definition and its votes in voting order (DATA_MODEL.md poll_votes). */
interface PollRecord {
  question: string;
  options: string[];
  multiple: boolean;
  anonymous: boolean;
  closedAt: string | null;
  /** M53: a choice poll's votes are all "yes". */
  votes: { userId: string; option: number; answer: "yes" | "maybe" | "no" }[];
  /** M53 (SCHEDULING.md): a scheduling poll's candidates, the zone of their labels, the decision and the comments. */
  kind: "choice" | "schedule";
  slots: { starts_at?: string | null; ends_at?: string | null; date?: string | null }[];
  tz: string | null;
  decided: { index: number; event_id: string | null; by: string; at: string } | null;
  comments: { userId: string; text: string }[];
}

/** A scheduling poll as POST …/messages takes it (M53). */
export interface FakeSchedulePoll {
  question: string;
  slots: { starts_at?: string | null; ends_at?: string | null; date?: string | null }[];
  tz: string;
  anonymous?: boolean;
}

const LABEL_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** The server's label for a candidate (messages/schedule.py slot_label), in `tz`. */
export function fakeSlotLabel(slot: FakeSchedulePoll["slots"][number], tz: string): string {
  const day = (y: number, m: number, d: number) => `${m}/${d} (${LABEL_WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
  if (slot.date) {
    const [y, m, d] = slot.date.split("-").map(Number);
    return `${day(y!, m!, d!)} 終日`;
  }
  const parts = (iso: string) => {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
        .formatToParts(new Date(iso))
        .map((p) => [p.type, p.value]),
    );
    return { y: Number(values.year), m: Number(values.month), d: Number(values.day), h: Number(values.hour), min: Number(values.minute) };
  };
  const start = parts(slot.starts_at!);
  const end = parts(slot.ends_at!);
  const clockOf = (p: { h: number; min: number }) => `${p.h}:${String(p.min).padStart(2, "0")}`;
  const sameDay = start.y === end.y && start.m === end.m && start.d === end.d;
  const until = sameDay ? clockOf(end) : end.h === 0 && end.min === 0 ? "24:00" : `翌${clockOf(end)}`;
  return `${day(start.y, start.m, start.d)} ${clockOf(start)}〜${until}`;
}

class FakeSocket implements WsLike {
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((code: number) => void) | null = null;
  dropNext = 0;
  /** Half-open: nothing reaches the client any more (no pongs, no events) and no close event comes. */
  silent = false;
  /** How long a pong takes to come back (0 = at once, inside send). */
  pongDelayMs = 0;
  closed = false;
  readonly sent: string[] = [];

  constructor(
    readonly server: FakeServer,
    readonly userId: string,
  ) {}

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as { type: string; token?: string; active?: boolean; channel_id?: string; parent_id?: string | null };
    if (frame.type === "auth") {
      this.authed = true;
      this.deliver({ type: "hello", session_id: "s-" + this.userId, server_time: now(), heartbeat_interval_sec: 30 });
      this.server.announcePresence(this.userId);
    } else if (frame.type === "ping") {
      if (frame.active) this.server.markActive(this.userId);
      const pong = { type: "pong", server_time: now() };
      if (this.pongDelayMs > 0) setTimeout(() => this.deliver(pong), this.pongDelayMs);
      else this.deliver(pong);
    } else if (frame.type === "typing" && frame.channel_id) {
      this.server.relayTyping(this.userId, frame.channel_id, frame.parent_id ?? null);
    }
  }

  authed = false;

  close(): void {
    this.closeRemote(1000);
  }

  closeRemote(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.server.sockets.delete(this);
    this.closeHandler?.(code);
    if (this.authed) this.server.announcePresence(this.userId);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number) => void): void {
    this.closeHandler = handler;
  }

  deliver(frame: unknown): void {
    if (this.closed || this.silent) return;
    if ((frame as { type?: string }).type === "event" && this.dropNext > 0) {
      this.dropNext -= 1; // simulated loss: the event never reaches the client
      return;
    }
    this.messageHandler?.(JSON.stringify(frame));
  }
}

export class FakeServer {
  readonly users = new Map<string, UserPublic>();
  readonly passwords = new Map<string, string>();
  readonly channels = new Map<string, ChannelRecord>();
  readonly sockets = new Set<FakeSocket>();
  private eventId = 0;
  /** While true, events are queued instead of delivered (simulates relay latency). */
  holdEvents = false;
  private held: { userIds: Set<string>; frame: EventFrame }[] = [];
  private byClientKey = new Map<string, MessageOut>();
  /** M12g notification keywords per user; like the server, hits never appear in mentioned_user_ids. */
  readonly keywords = new Map<string, string[]>();
  /** M39: users.notify_reactions (initially off). */
  readonly notifyReactions = new Set<string>();
  /** M55: users.notify_tasks off (initially on). */
  readonly tasksOff = new Set<string>();
  /** M35: users.notification_default (missing = the server's initial "mentions"). */
  readonly notificationDefaults = new Map<string, NotificationLevel>();
  /** notification_preferences rows by "channel:user" (level null = follows the overall setting). */
  readonly notificationPrefs = new Map<string, { level: NotificationLevel | null; muted_until: string | null; muted: boolean }>();

  /** M50: users.quick_reactions (missing = null, the recent-first rule). */
  readonly quickReactions = new Map<string, string[] | null>();

  /** PATCH /users/me {quick_reactions} (M50): a newer updated_at and user.updated to everyone, without the list itself. */
  setQuickReactions(userId: string, list: string[] | null): void {
    this.quickReactions.set(userId, list);
    const user = this.users.get(userId)!;
    user.updated_at = new Date(Math.max(Date.now(), Date.parse(user.updated_at) + 1)).toISOString();
    this.emit(new Set(this.users.keys()), { type: "event", id: ++this.eventId, event: "user.updated", ts: now(), channel_id: null, seq: null, data: { user: { ...user } } } as EventFrame);
  }

  /** PATCH /users/me {notification_default}: only what bootstrap and later preferences say (no event, like the server). */
  setNotificationDefault(userId: string, level: NotificationLevel): void {
    this.notificationDefaults.set(userId, level);
  }

  /** The preference as the server sends it: `level` resolved (PUSH_NOTIFICATIONS.md §4), plus follows_default / muted. */
  notificationPreference(userId: string, channelId: string): NotificationPreferenceOut {
    const channel = this.record(channelId).channel;
    const pref = this.notificationPrefs.get(`${channelId}:${userId}`);
    const own = pref?.level ?? null;
    const overall = this.notificationDefaults.get(userId) ?? "mentions";
    const dm = channel.type === "dm" || channel.type === "group_dm";
    const othersTimes = !!channel.times_owner_id && channel.times_owner_id !== userId;
    const level = own ?? (overall === "none" ? "none" : dm ? "all" : othersTimes ? "mentions" : overall);
    return { channel_id: channelId, level, muted_until: pref?.muted_until ?? null, follows_default: own === null, muted: pref?.muted ?? false };
  }

  /** PUT /channels/{id}/notification-preference: `muted` omitted keeps it; notification_preference.updated to the user. */
  setNotificationPreference(userId: string, channelId: string, body: { level: NotificationLevel | null; muted_until?: string | null; muted?: boolean | null }): NotificationPreferenceOut {
    this.requireMember(channelId, userId);
    const key = `${channelId}:${userId}`;
    const existing = this.notificationPrefs.get(key);
    this.notificationPrefs.set(key, { level: body.level, muted_until: body.muted_until ?? null, muted: body.muted ?? existing?.muted ?? false });
    const out = this.notificationPreference(userId, channelId);
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "notification_preference.updated", ts: now(), channel_id: null, seq: null, data: out });
    return out;
  }

  addUser(username: string, role: "admin" | "member" = "member"): UserPublic {
    const user: UserPublic = {
      id: nextId(),
      username,
      display_name: username[0]!.toUpperCase() + username.slice(1),
      role,
      deactivated_at: null,
      created_at: now(),
      updated_at: now(),
      title: null,
      status_text: null,
      status_emoji: null,
      status_expires_at: null,
    };
    this.users.set(user.id, user);
    this.activityReadAt.set(user.id, user.created_at); // users.activity_read_at defaults to now()
    return user;
  }

  userByName(username: string): UserPublic {
    const user = [...this.users.values()].find((u) => u.username === username);
    if (!user) throw new Error(`no user ${username}`);
    return user;
  }

  createChannel(name: string, ownerId: string, type: ChannelOut["type"] = "public"): ChannelOut {
    const channel: ChannelOut = {
      id: nextId(),
      type,
      name: type === "dm" || type === "group_dm" ? null : name,
      topic: null,
      purpose: null,
      archived: false,
      created_by: ownerId,
      last_seq: 0,
      last_message_at: null,
      created_at: now(),
      updated_at: now(),
      membership: null,
      dm_user_ids: null,
      posting_policy: "everyone",
    };
    this.channels.set(channel.id, { channel, members: new Set([ownerId]), messages: [] });
    this.readPositions.set(`${ownerId}:${channel.id}`, 0);
    return channel;
  }

  join(channelId: string, userId: string): void {
    const record = this.record(channelId);
    record.members.add(userId);
    const key = `${userId}:${channelId}`;
    if (!this.readPositions.has(key)) this.readPositions.set(key, record.channel.last_seq); // history before the join is read
  }

  /** "user:channel" → last_read_seq (DATA_MODEL.md read_states). */
  readonly readPositions = new Map<string, number>();

  readState(userId: string, channelId: string): ReadStateOut {
    const record = this.record(channelId);
    const position = this.readPositions.get(`${userId}:${channelId}`) ?? 0;
    // My own posts are never unread (the server's read_states counts skip sender = me), nor are system rows.
    const unread = record.messages.filter((m) => m.seq > position && !m.deleted && m.sender_id !== userId && (m.type ?? "user") === "user" && (!m.parent_id || m.also_in_channel));
    const mentions = unread.filter((m) => m.mention_all === true || (m.mentioned_user_ids ?? []).includes(userId)).length;
    // §10.1: the oldest counted message's time (the unread banner's 「… 以降」).
    const firstUnreadAt = unread.reduce<string | null>((min, m) => (min === null || m.created_at < min ? m.created_at : min), null);
    return { last_read_seq: position, unread_count: unread.length, mention_count: mentions, first_unread_at: firstUnreadAt };
  }

  // --- threads (THREADS.md §2) ---------------------------------------------------------------

  /**
   * "parent:user" → follow row; insertion order doubles as created_at. `unfollowed` marks a follow
   * turned off by hand (auto-follow keeps it off); a row created by reading alone is not following.
   */
  readonly threadFollows = new Map<string, { parentId: string; userId: string; following: boolean; unfollowed: boolean; lastReadSeq: number }>();

  private followers(parentId: string): string[] {
    return [...this.threadFollows.values()].filter((f) => f.parentId === parentId && f.following).map((f) => f.userId);
  }

  private autoFollow(parentId: string, userIds: string[]): void {
    for (const userId of userIds) {
      const key = `${parentId}:${userId}`;
      const row = this.threadFollows.get(key);
      if (!row) this.threadFollows.set(key, { parentId, userId, following: true, unfollowed: false, lastReadSeq: 0 });
      else if (!row.following && !row.unfollowed) row.following = true; // only read before
    }
  }

  private threadParent(messageId: string): { record: ChannelRecord; parent: MessageOut } {
    for (const record of this.channels.values()) {
      const message = record.messages.find((m) => m.id === messageId && !m.deleted);
      if (!message) continue;
      const parent = message.parent_id ? record.messages.find((m) => m.id === message.parent_id)! : message;
      return { record, parent };
    }
    throw new ApiError(404, "message_not_found", "not found");
  }

  threadState(userId: string, parentId: string): ThreadState {
    const { record, parent } = this.threadParent(parentId);
    this.requireMember(record.channel.id, userId);
    const row = this.threadFollows.get(`${parent.id}:${userId}`);
    const lastReadSeq = row?.lastReadSeq ?? 0;
    const unread = record.messages.filter((m) => m.parent_id === parent.id && !m.deleted && m.seq > lastReadSeq && m.sender_id !== userId);
    return {
      parent_id: parent.id,
      channel_id: record.channel.id,
      following: row?.following ?? false,
      last_read_seq: lastReadSeq,
      unread_count: unread.length,
      mention_count: unread.filter((m) => m.mention_all === true || (m.mentioned_user_ids ?? []).includes(userId)).length,
      reply_count: parent.reply_count,
      last_reply_at: parent.last_reply_at ?? null,
      participant_ids: this.followers(parent.id),
    };
  }

  private emitThread(parentId: string, userIds: string[], reason: "reply" | "deleted" | "read" | "follow"): void {
    for (const userId of userIds) {
      const state = this.threadState(userId, parentId);
      this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "thread.updated", ts: now(), channel_id: state.channel_id, seq: null, data: { reason, ...state } });
    }
  }

  threadSummary(userId: string): ThreadSummary {
    const states = [...this.threadFollows.values()].filter((f) => f.userId === userId && f.following).map((f) => this.threadState(userId, f.parentId));
    return { unread_count: states.filter((s) => s.unread_count > 0).length, mention_count: states.filter((s) => s.mention_count > 0).length };
  }

  /** false: answer GET /threads as a server before the reply previews did. */
  threadPreviews = true;

  threads(userId: string, filter: ThreadFilter, cursor: string | null, limit: number): ThreadListOut {
    let items = [...this.threadFollows.values()]
      .filter((f) => f.userId === userId && f.following)
      .map((f) => {
        const { record, parent } = this.threadParent(f.parentId);
        const replies = record.messages.filter((m) => m.parent_id === parent.id && !m.deleted).sort((a, b) => a.seq - b.seq).slice(-2);
        const item = { parent, state: this.threadState(userId, f.parentId), latest_replies: replies };
        // A server before the previews (THREADS.md §5) sends no latest_replies.
        if (!this.threadPreviews) delete (item as Partial<typeof item>).latest_replies;
        return item;
      })
      .filter((i) => !i.parent.deleted && i.parent.reply_count > 0)
      .sort((a, b) => (b.parent.last_reply_at ?? "").localeCompare(a.parent.last_reply_at ?? "") || b.parent.seq - a.parent.seq);
    if (cursor) items = items.filter((i) => (i.parent.last_reply_at ?? "") < cursor);
    if (filter === "unread") items = items.filter((i) => i.state.unread_count > 0);
    items = items.slice(0, limit);
    return { items, next_cursor: items.length > 0 ? items[items.length - 1]!.parent.last_reply_at ?? null : null, summary: this.threadSummary(userId) };
  }

  markThreadRead(userId: string, messageId: string, seq: number): ThreadState {
    const { record, parent } = this.threadParent(messageId);
    this.requireMember(record.channel.id, userId);
    const newest = Math.max(0, ...record.messages.filter((m) => m.parent_id === parent.id && !m.deleted).map((m) => m.seq));
    const target = Math.min(seq, newest);
    const key = `${parent.id}:${userId}`;
    // Reading is not following: a missing row is created with following = false.
    const row = this.threadFollows.get(key) ?? { parentId: parent.id, userId, following: false, unfollowed: false, lastReadSeq: 0 };
    if (!this.threadFollows.has(key)) this.threadFollows.set(key, row);
    if (target > row.lastReadSeq) {
      row.lastReadSeq = target;
      this.emitThread(parent.id, [userId], "read");
    }
    return this.threadState(userId, parent.id);
  }

  setThreadFollow(userId: string, messageId: string, following: boolean): ThreadState {
    const { record, parent } = this.threadParent(messageId);
    this.requireMember(record.channel.id, userId);
    const key = `${parent.id}:${userId}`;
    const row = this.threadFollows.get(key) ?? { parentId: parent.id, userId, following, unfollowed: false, lastReadSeq: 0 };
    const changed = !this.threadFollows.has(key) || row.following !== following;
    row.following = following;
    row.unfollowed = !following;
    this.threadFollows.set(key, row);
    if (changed) this.emitThread(parent.id, [userId], "follow");
    return this.threadState(userId, parent.id);
  }

  // --- activity (M39, MOBILE_UI.md §7.2) ----------------------------------------------------

  /** A server before M39: no `activity` in bootstrap, no reaction.added (the clients fall back to stage A). */
  activityEnabled = true;
  /** users.activity_read_at. */
  readonly activityReadAt = new Map<string, string>();
  /** "message:user:emoji" → when the reaction was made (reactions.created_at). */
  readonly reactionTimes = new Map<string, string>();
  /** GET /activity requests (filter and cursor) by user. */
  readonly activityRequests: Array<{ userId: string; filter: ActivityFilter; cursor: string | null }> = [];

  /** M76: canvas mention items by user (canvas_mentions), shown under 「すべて」 and 「メンション」. */
  readonly canvasMentions = new Map<string, ActivityItem[]>();

  /**
   * M76: a save of a canvas newly mentions `userId`: their unread item for that canvas moves, else a new one; and
   * canvas.mentioned to them (as the server writes both in the save's transaction).
   */
  mentionInCanvas(userId: string, by: string, canvas: { id: string; channel_id: string; title: string }, excerpt: string): ActivityItem {
    const at = now();
    const held = this.canvasMentions.get(userId) ?? [];
    const readAt = this.activityReadAt.get(userId)!;
    const unread = held.find((item) => item.canvas?.canvas_id === canvas.id && item.at > readAt && !this.openedSince(userId, item));
    const revId = `rev-${++this.eventId}`;
    const fields = { canvas_id: canvas.id, channel_id: canvas.channel_id, title: canvas.title, excerpt, rev_id: revId };
    let item: ActivityItem;
    if (unread) {
      Object.assign(unread, { at, actor_ids: [by], canvas: { ...unread.canvas!, ...fields } });
      item = unread;
    } else {
      const itemId = `cm-${held.length + 1}-${userId}`;
      item = { id: itemId, kind: "canvas_mention", at, message: null, actor_ids: [by], emojis: [], canvas: { item_id: itemId, ...fields } };
      this.canvasMentions.set(userId, [...held, item]);
    }
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "canvas.mentioned", ts: at, channel_id: canvas.channel_id, seq: null, data: { canvas_id: canvas.id, channel_id: canvas.channel_id, rev_id: revId, title: canvas.title, by_user_id: by } } as EventFrame);
    return item;
  }

  private mentions(message: MessageOut, userId: string): boolean {
    return message.mention_all === true || (message.mentioned_user_ids ?? []).includes(userId);
  }

  /** Everything, newest first: the server's three queries merged (members only, deleted rows left out). */
  activityItems(userId: string, filter: ActivityFilter = "all"): ActivityItem[] {
    const items: ActivityItem[] = [];
    for (const record of this.channels.values()) {
      if (!record.members.has(userId)) continue;
      for (const message of record.messages) {
        if (message.deleted) continue;
        const view = this.viewAs(message, userId);
        if (message.sender_id !== userId && this.mentions(message, userId)) {
          if (filter === "all" || filter === "mentions") items.push({ id: message.id, kind: "mention", at: message.created_at, message: view, actor_ids: [message.sender_id], emojis: [] });
        } else if (message.sender_id !== userId && message.parent_id && this.threadFollows.get(`${message.parent_id}:${userId}`)?.following) {
          if (filter === "all" || filter === "threads") items.push({ id: message.id, kind: "thread_reply", at: message.created_at, message: view, actor_ids: [message.sender_id], emojis: [] });
        }
        if (message.sender_id === userId && (filter === "all" || filter === "reactions")) {
          const others = (message.reactions ?? []).flatMap((r) => r.user_ids.filter((id) => id !== userId).map((id) => ({ id, emoji: r.emoji, at: this.reactionTimes.get(`${message.id}:${id}:${r.emoji}`) ?? message.created_at })));
          if (others.length === 0) continue;
          const at = others.map((o) => o.at).sort().at(-1)!;
          items.push({ id: message.id, kind: "reaction", at, message: view, actor_ids: [...new Set(others.map((o) => o.id))], emojis: [...new Set(others.map((o) => o.emoji))].sort() });
        }
      }
    }
    if (filter === "all" || filter === "mentions") {
      for (const item of this.canvasMentions.get(userId) ?? []) if (this.channels.get(item.canvas!.channel_id)?.members.has(userId)) items.push({ ...item });
    }
    // 2026-10-06 (MOBILE_UI.md §6.4): `read` — behind the read position, or a mention / reply read in its conversation.
    // A server before it (activityReadFlag false) sends none.
    const readAt = this.activityReadAt.get(userId)!;
    if (this.activityReadFlag) for (const item of items) item.read = item.at <= readAt || this.readInConversation(item, userId) || this.openedSince(userId, item);
    if (!this.activityItemReads) for (const item of items) delete item.id;
    const ref = (item: ActivityItem) => item.message?.id ?? item.canvas?.item_id ?? "";
    return items.sort((a, b) => b.at.localeCompare(a.at) || b.kind.localeCompare(a.kind) || ref(b).localeCompare(ref(a)));
  }

  /** A server before 2026-10-06: no `read` on the items, and the counts compare with the read position only. */
  activityReadFlag = true;
  /** A server before 2026-10-07: no item `id`, no PUT /activity/items/read. */
  activityItemReads = true;
  /** activity_item_reads: `${userId}:${itemId}` → when opened. */
  readonly openedItems = new Map<string, string>();
  /** PUT /activity/items/read requests (the ids) by user. */
  readonly itemReadRequests: Array<{ userId: string; itemIds: string[] }> = [];

  /** 2026-10-07 (§6.4): the item was opened since it happened. */
  private openedSince(userId: string, item: ActivityItem): boolean {
    const id = item.id ?? item.message?.id ?? item.canvas?.item_id;
    const at = id ? this.openedItems.get(`${userId}:${id}`) : undefined;
    return !!at && item.at <= at;
  }

  /** PUT /activity/items/read: each item opened now (idempotent); activity.items_read to the user's devices. */
  markActivityItemsRead(userId: string, itemIds: string[]): ActivitySummaryOut {
    this.itemReadRequests.push({ userId, itemIds });
    const at = now();
    for (const id of itemIds) this.openedItems.set(`${userId}:${id}`, at);
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "activity.items_read", ts: at, channel_id: null, seq: null, data: { item_ids: itemIds, read_at: at } } as EventFrame);
    return this.activitySummary(userId);
  }

  /** §6.4 rule 2: a mention or a thread reply I read in its conversation (timeline row) or its thread (a reply). */
  private readInConversation(item: ActivityItem, userId: string): boolean {
    const message = item.message;
    if (!message || (item.kind !== "mention" && item.kind !== "thread_reply")) return false;
    const inTimeline = !message.parent_id || message.also_in_channel === true;
    if (inTimeline && (this.readPositions.get(`${userId}:${message.channel_id}`) ?? 0) >= message.seq) return true;
    return !!message.parent_id && (this.threadFollows.get(`${message.parent_id}:${userId}`)?.lastReadSeq ?? 0) >= message.seq;
  }

  listActivity(userId: string, filter: ActivityFilter, cursor: string | null, limit: number): ActivityListOut {
    this.activityRequests.push({ userId, filter, cursor });
    const all = this.activityItems(userId, filter).filter((item) => !cursor || item.at < cursor);
    const page = all.slice(0, limit);
    return { items: page, next_cursor: all.length > limit ? page[page.length - 1]!.at : null, read_at: this.activityReadAt.get(userId)! };
  }

  activitySummary(userId: string): ActivitySummaryOut {
    const readAt = this.activityReadAt.get(userId)!;
    const unread = this.activityItems(userId).filter((item) => item.at > readAt && !(this.activityReadFlag && this.readInConversation(item, userId)) && !this.openedSince(userId, item));
    return { read_at: readAt, unread_count: Math.min(unread.length, 99), mention_unread: unread.some((item) => item.kind === "mention" || item.kind === "canvas_mention") };
  }

  /** PUT /activity/read: forward only, never past now; activity.read to the user's devices when it moved. */
  markActivityRead(userId: string, readAt: string): ActivitySummaryOut {
    const target = readAt < now() ? readAt : now();
    if (target > this.activityReadAt.get(userId)!) {
      this.activityReadAt.set(userId, target);
      for (const [key, at] of this.openedItems) if (key.startsWith(`${userId}:`) && at <= target) this.openedItems.delete(key);
      this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "activity.read", ts: now(), channel_id: null, seq: null, data: { read_at: target } });
    }
    return this.activitySummary(userId);
  }

  /** PUT /channels/{id}/read: clamp, never regress, read.updated to the user's own sockets on change. */
  markRead(userId: string, channelId: string, seq: number, mode: "advance" | "set" = "advance"): ReadStateOut {
    const record = this.requireMember(channelId, userId);
    const key = `${userId}:${channelId}`;
    const target = Math.min(seq, record.channel.last_seq);
    const current = this.readPositions.get(key) ?? 0;
    if (mode === "set" ? target !== current : target > current) {
      this.readPositions.set(key, target);
      const state = this.readState(userId, channelId);
      this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "read.updated", ts: now(), channel_id: channelId, seq: null, data: { channel_id: channelId, reason: mode, ...state } });
      return state;
    }
    return this.readState(userId, channelId);
  }

  private record(channelId: string): ChannelRecord {
    const record = this.channels.get(channelId);
    if (!record) throw new ApiError(404, "channel_not_found", "Channel not found");
    return record;
  }

  /** SECURITY.md §3.2 (M27): members read a channel, and so does anyone but a guest in a public one (its preview). */
  private requireReadable(channelId: string, userId: string): ChannelRecord {
    const record = this.record(channelId);
    if (record.members.has(userId)) return record;
    if (record.channel.type === "public" && (this.users.get(userId)?.role as string | undefined) !== "guest") {
      // M88: 「参加前にチャンネルの中を見られる」 off.
      if (!this.workspaceSettings.preview_before_join) throw new ApiError(403, "preview_disabled", "Join this channel to read its messages");
      return record;
    }
    throw new ApiError(403, "not_a_member", "Not a member");
  }

  /** M88 (docs/MEMBERSHIP.md §3): the workspace settings (bootstrap, workspace.settings_updated to everyone). */
  workspaceSettings: WorkspaceSettingsOut = { show_membership_messages: true, preview_before_join: true };

  setWorkspaceSettings(patch: Partial<WorkspaceSettingsOut>): void {
    this.workspaceSettings = { ...this.workspaceSettings, ...patch };
    this.emit(new Set(this.users.keys()), { type: "event", id: ++this.eventId, event: "workspace.settings_updated", ts: now(), channel_id: null, seq: null, data: { settings: this.workspaceSettings } });
  }

  private requireMember(channelId: string, userId: string): ChannelRecord {
    const record = this.record(channelId);
    if (!record.members.has(userId)) throw new ApiError(403, "not_a_member", "Not a member");
    return record;
  }

  /**
   * Server-side post (used by fixtures for "other users" and by the api for the client). `scheduled`: a scheduled
   * send going out (M12d), which does not read the channel; `type`: a system row.
   */
  post(channelId: string, senderId: string, body: string, clientMsgId = nextId(), parentId: string | null = null, attachmentIds: string[] = [], options: SendOptions & { scheduled?: boolean; type?: string; systemEvent?: MessageOut["system_event"]; poll?: { question: string; options: string[]; multiple?: boolean; anonymous?: boolean } } = {}): { message: MessageOut; created: boolean } {
    const record = this.requireMember(channelId, senderId);
    const existing = this.byClientKey.get(senderId + ":" + clientMsgId);
    if (existing) {
      if (existing.channel_id !== channelId) throw new ApiError(409, "idempotency_conflict", "conflict");
      return { message: existing, created: false };
    }
    let parentIndex = -1;
    if (parentId) {
      parentIndex = record.messages.findIndex((m) => m.id === parentId && !m.deleted);
      if (parentIndex < 0) throw new ApiError(404, "message_not_found", "parent not found");
      if (record.messages[parentIndex]!.parent_id) throw new ApiError(400, "reply_depth", "no replies to replies");
    }
    const seq = ++record.channel.last_seq;
    const message: MessageOut = {
      id: nextId(),
      tasks: [],
      channel_id: channelId,
      sender_id: senderId,
      parent_id: parentId,
      also_in_channel: options.alsoInChannel === true && parentId !== null,
      priority: parentId === null ? (options.priority ?? null) : null,
      ack_requested: parentId === null && options.ackRequested === true,
      acks: [],
      seq,
      updated_seq: seq,
      client_msg_id: clientMsgId,
      type: options.type ?? "user",
      body,
      mentioned_user_ids: mentionedIds(body),
      mention_all: MENTION_ALL.test(body),
      reactions: [],
      attachments: attachmentIds.map((id) => ({ id, filename: `file-${id}`, content_type: "application/octet-stream", size_bytes: 1, width: null, height: null, has_thumbnail: false, has_poster: false, duration_ms: null, status: "attached", created_at: now() })),
      reply_count: 0,
      last_reply_at: null,
      reply_user_ids: [],
      created_at: now(),
      edited_at: null,
      deleted: false,
      pinned_at: null,
      pinned_by: null,
      ...(options.systemEvent ? { system_event: options.systemEvent } : {}),
    };
    if (options.poll) {
      const { question, options: choices, multiple = false, anonymous = false } = options.poll;
      this.polls.set(message.id, { question, options: choices, multiple, anonymous, closedAt: null, votes: [], kind: "choice", slots: [], tz: null, decided: null, comments: [] });
      message.poll = this.pollOut(message.id, null);
    }
    record.messages.push(message);
    record.channel.last_message_at = message.created_at;
    this.byClientKey.set(senderId + ":" + clientMsgId, message);
    let parentThread: ParentThread | null = null;
    if (parentIndex >= 0) {
      const old = record.messages[parentIndex]!;
      // C3: the replier moves to the front, at most five.
      const repliers = [senderId, ...(old.reply_user_ids ?? []).filter((id) => id !== senderId)].slice(0, 5);
      const parent: MessageOut = { ...old, reply_count: old.reply_count + 1, last_reply_at: message.created_at, reply_user_ids: repliers, updated_seq: seq };
      record.messages[parentIndex] = parent;
      // THREADS.md §2: auto-follow, the replier has read their own reply, followers are the push targets.
      this.autoFollow(parent.id, [parent.sender_id, senderId, ...(parent.mentioned_user_ids ?? []), ...message.mentioned_user_ids]);
      const own = this.threadFollows.get(`${parent.id}:${senderId}`)!;
      own.lastReadSeq = Math.max(own.lastReadSeq, seq);
      parentThread = { id: parent.id, reply_count: parent.reply_count, last_reply_at: parent.last_reply_at ?? null, reply_user_ids: repliers, updated_seq: seq, participant_ids: this.followers(parent.id) };
    }
    this.emit(record.members, {
      type: "event",
      id: ++this.eventId,
      event: "message.created",
      ts: now(),
      channel_id: channelId,
      seq,
      data: parentThread ? { message, parent_thread: parentThread } : { message },
    });
    if (!parentId && !options.scheduled) this.markRead(senderId, channelId, seq); // a top-level post reads the channel; a reply does not (§10)
    if (parentThread) this.emitThread(parentThread.id, this.followers(parentThread.id), "reply");
    return { message, created: true };
  }

  // --- polls (M14b, M27) --------------------------------------------------------------------

  private readonly polls = new Map<string, PollRecord>();

  /**
   * The poll as the server shows it: voters per option (none in an anonymous poll), counts, and the options `viewer`
   * voted for; `viewer` null is an event's form (every member gets the same one, so `mine` is null).
   */
  private pollOut(messageId: string, viewer: string | null): ServerPoll {
    const poll = this.polls.get(messageId)!;
    const voters = poll.options.map((_, index) => poll.votes.filter((v) => v.option === index && v.answer === "yes").map((v) => v.userId));
    const out: ServerPoll = {
      question: poll.question,
      options: poll.options,
      multiple: poll.multiple,
      anonymous: poll.anonymous,
      closed_at: poll.closedAt,
      votes: poll.anonymous ? poll.options.map(() => []) : voters,
      counts: voters.map((ids) => ids.length),
      mine: viewer === null ? null : voters.flatMap((ids, index) => (ids.includes(viewer) ? [index] : [])),
      kind: poll.kind,
      slots: [],
      tz: null,
      decided: null,
      answers: [],
      respondents: [],
      comments: [],
      my_answers: null,
      my_comment: null,
    };
    if (poll.kind !== "schedule") return out;
    const of = (index: number, answer: string) => poll.votes.filter((v) => v.option === index && v.answer === answer).map((v) => v.userId);
    const respondents = [...new Set([...poll.votes.map((v) => v.userId), ...poll.comments.map((c) => c.userId)])];
    return {
      ...out,
      slots: poll.slots.map((s) => ({ starts_at: s.starts_at ?? null, ends_at: s.ends_at ?? null, date: s.date ?? null })),
      tz: poll.tz,
      decided: poll.decided,
      answers: poll.options.map((_, index) => {
        const [yes, maybe, no] = [of(index, "yes"), of(index, "maybe"), of(index, "no")];
        return { yes: poll.anonymous ? [] : yes, maybe: poll.anonymous ? [] : maybe, no: poll.anonymous ? [] : no, yes_count: yes.length, maybe_count: maybe.length, no_count: no.length };
      }),
      respondents: poll.anonymous ? [] : respondents,
      comments: poll.comments.map((c) => ({ user_id: poll.anonymous ? null : c.userId, text: c.text })),
      my_answers: viewer === null ? null : poll.options.map((_, index) => poll.votes.find((v) => v.userId === viewer && v.option === index)?.answer ?? null),
      my_comment: viewer === null ? null : (poll.comments.find((c) => c.userId === viewer)?.text ?? ""),
    };
  }

  /** M53: POST …/messages with a scheduling poll (the server writes the labels in `tz`); the response is the author's view. */
  postSchedule(channelId: string, userId: string, poll: FakeSchedulePoll, parentId: string | null = null): MessageOut {
    const options = poll.slots.map((slot) => fakeSlotLabel(slot, poll.tz));
    const message = this.post(channelId, userId, `📊 ${poll.question}`, nextId(), parentId, [], { poll: { question: poll.question, options, multiple: true, anonymous: poll.anonymous } }).message;
    const record = this.polls.get(message.id)!;
    Object.assign(record, { kind: "schedule", slots: poll.slots, tz: poll.tz });
    const shown = { ...message, poll: this.pollOut(message.id, null) };
    const rows = this.record(channelId).messages;
    rows[rows.findIndex((m) => m.id === message.id)] = shown;
    return this.viewAs(shown, userId);
  }

  private schedulePoll(messageId: string): PollRecord {
    const poll = this.polls.get(messageId);
    if (!poll) throw new ApiError(404, "poll_not_found", "no poll");
    if (poll.kind !== "schedule") throw new ApiError(400, "poll_not_schedule", "not a scheduling poll");
    return poll;
  }

  private bumpPoll(record: ChannelRecord, message: MessageOut): MessageOut {
    const seq = ++record.channel.last_seq;
    const updated: MessageOut = { ...message, updated_seq: seq, poll: this.pollOut(message.id, null) };
    this.replace(record, updated, "message.updated", "poll");
    return updated;
  }

  /** M53: PUT /messages/{id}/poll/answers (mine replaced; `comment` undefined keeps it, null or blank removes it). */
  answer(channelId: string, userId: string, messageId: string, answers: { index: number; answer: "yes" | "maybe" | "no" }[], comment?: string | null): MessageOut {
    const { record, message } = this.live(channelId, userId, messageId);
    const poll = this.schedulePoll(messageId);
    if (poll.decided) throw new ApiError(409, "poll_decided", "decided");
    if (poll.closedAt) throw new ApiError(409, "poll_closed", "closed");
    if (answers.some((a) => a.index >= poll.options.length)) throw new ApiError(400, "poll_option_invalid", "no such slot");
    const before = JSON.stringify([poll.votes, poll.comments]);
    const kept = poll.votes.filter((v) => v.userId !== userId || answers.some((a) => a.index === v.option));
    for (const vote of kept) {
      const wanted = vote.userId === userId ? answers.find((a) => a.index === vote.option) : undefined;
      if (wanted) vote.answer = wanted.answer;
    }
    for (const a of answers) if (!kept.some((v) => v.userId === userId && v.option === a.index)) kept.push({ userId, option: a.index, answer: a.answer });
    poll.votes = kept;
    if (comment !== undefined) {
      const text = (comment ?? "").split(/\s+/).filter(Boolean).join(" ");
      poll.comments = poll.comments.filter((c) => c.userId !== userId);
      if (text) poll.comments.push({ userId, text });
    }
    if (JSON.stringify([poll.votes, poll.comments]) === before) return this.viewAs(message, userId);
    return this.viewAs(this.bumpPoll(record, message), userId);
  }

  /** Calendar events the decisions made (M53): id → what the server would have stored. */
  readonly decidedEvents = new Map<string, { channelId: string; title: string; slot: PollRecord["slots"][number]; ownerId: string }>();

  /** M53: POST /messages/{id}/poll/decide: closed, decided, an event (not in a DM), a thread reply mentioning those who answered. */
  decide(channelId: string, userId: string, messageId: string, index: number, createEvent = true): MessageOut {
    const { record, message } = this.live(channelId, userId, messageId);
    const poll = this.schedulePoll(messageId);
    const allowed = message.sender_id === userId || this.roleOf(channelId, userId) === "owner" || this.users.get(userId)?.role === "admin";
    if (!allowed) throw new ApiError(403, "poll_decide_restricted", "restricted");
    if (index >= poll.options.length) throw new ApiError(400, "poll_option_invalid", "no such slot");
    if (poll.decided) {
      if (poll.decided.index === index) return this.viewAs(message, userId);
      throw new ApiError(409, "poll_decided", "decided");
    }
    const dm = record.channel.type === "dm" || record.channel.type === "group_dm";
    let eventId: string | null = null;
    if (createEvent && !dm) {
      eventId = nextId();
      this.decidedEvents.set(eventId, { channelId, title: poll.question, slot: poll.slots[index]!, ownerId: userId });
    }
    const at = now();
    poll.decided = { index, event_id: eventId, by: userId, at };
    poll.closedAt = poll.closedAt ?? at;
    const updated = this.bumpPoll(record, message);
    const chosen = poll.votes.filter((v) => v.option === index);
    let body = `📅 日程が決まりました: ${poll.options[index]} (○ ${chosen.filter((v) => v.answer === "yes").length} · △ ${chosen.filter((v) => v.answer === "maybe").length})`;
    if (!poll.anonymous) {
      const mentioned = [...new Set([...poll.votes.map((v) => v.userId), ...poll.comments.map((c) => c.userId)])].filter((id) => id !== userId && record.members.has(id));
      if (mentioned.length > 0) body += `\n${mentioned.map((id) => `<@${id}>`).join(" ")}`;
    }
    this.post(channelId, userId, body, nextId(), message.parent_id ?? message.id);
    const current = record.messages.find((m) => m.id === messageId) ?? updated;
    return this.viewAs(current, userId);
  }

  /** M53: DELETE /messages/{id}/poll/decide: answers open again; the event stays. */
  undecide(channelId: string, userId: string, messageId: string): MessageOut {
    const { record, message } = this.live(channelId, userId, messageId);
    const poll = this.schedulePoll(messageId);
    const allowed = message.sender_id === userId || this.roleOf(channelId, userId) === "owner" || this.users.get(userId)?.role === "admin";
    if (!allowed) throw new ApiError(403, "poll_decide_restricted", "restricted");
    if (!poll.decided) return this.viewAs(message, userId);
    poll.decided = null;
    poll.closedAt = null;
    return this.viewAs(this.bumpPoll(record, message), userId);
  }

  /** A row as a response to `userId` carries it (their own votes filled in); events and stored rows have `mine` null. */
  viewAs(message: MessageOut, userId: string): MessageOut {
    return message.poll && this.polls.has(message.id) ? { ...message, poll: this.pollOut(message.id, userId) } : message;
  }

  /** POST /channels/{id}/messages with `poll` (the body becomes 「📊 質問」); the response is the author's view. */
  postPoll(channelId: string, userId: string, poll: { question: string; options: string[]; multiple?: boolean; anonymous?: boolean }, parentId: string | null = null): MessageOut {
    return this.viewAs(this.post(channelId, userId, `📊 ${poll.question}`, nextId(), parentId, [], { poll }).message, userId);
  }

  /**
   * PUT / DELETE /messages/{id}/poll/votes/{index}: a change consumes a seq and goes out as message.updated
   * (change = poll, `mine` null); the response to the voter has their votes.
   */
  vote(channelId: string, userId: string, messageId: string, option: number, present: boolean): MessageOut {
    const { record, message } = this.live(channelId, userId, messageId);
    const poll = this.polls.get(messageId);
    if (!poll) throw new ApiError(404, "poll_not_found", "no poll");
    if (poll.decided) throw new ApiError(409, "poll_decided", "decided");
    if (poll.closedAt) throw new ApiError(409, "poll_closed", "closed");
    // M53: in a scheduling poll the vote of an app before M53 is ○ (taking it back unanswers the candidate).
    const had = poll.votes.some((v) => v.userId === userId && v.option === option && (present ? v.answer === "yes" : true));
    if (present === had) return this.viewAs(message, userId);
    if (present) {
      if (!poll.multiple) poll.votes = poll.votes.filter((v) => v.userId !== userId); // a single-answer poll moves the vote
      poll.votes = poll.votes.filter((v) => !(v.userId === userId && v.option === option));
      poll.votes.push({ userId, option, answer: "yes" });
    } else {
      poll.votes = poll.votes.filter((v) => !(v.userId === userId && v.option === option));
    }
    const seq = ++record.channel.last_seq;
    const updated: MessageOut = { ...message, updated_seq: seq, poll: this.pollOut(messageId, null) };
    this.replace(record, updated, "message.updated", "poll");
    return this.viewAs(updated, userId);
  }

  messageByBody(channelId: string, body: string): MessageOut {
    const message = this.record(channelId).messages.find((m) => m.body === body && !m.deleted);
    if (!message) throw new Error(`no message with body ${body}`);
    return message;
  }

  private replace(record: ChannelRecord, updated: MessageOut, event: string, change?: string): void {
    const index = record.messages.findIndex((m) => m.id === updated.id);
    record.messages[index] = updated;
    const data: Record<string, unknown> = change ? { message: updated, change } : { message: updated };
    this.emit(record.members, { type: "event", id: ++this.eventId, event, ts: now(), channel_id: updated.channel_id, seq: updated.updated_seq, data });
  }

  private live(channelId: string, userId: string, messageId: string): { record: ChannelRecord; message: MessageOut } {
    const record = this.requireMember(channelId, userId);
    const message = record.messages.find((m) => m.id === messageId && !m.deleted);
    if (!message) throw new ApiError(404, "message_not_found", "not found");
    return { record, message };
  }

  edit(channelId: string, userId: string, messageId: string, body: string): MessageOut {
    const { record, message } = this.live(channelId, userId, messageId);
    if (message.sender_id !== userId) throw new ApiError(403, "not_message_owner", "not the author");
    const seq = ++record.channel.last_seq;
    const updated: MessageOut = { ...message, body, edited_at: now(), updated_seq: seq, mentioned_user_ids: mentionedIds(body), mention_all: MENTION_ALL.test(body) };
    this.replace(record, updated, "message.updated", "body");
    return updated;
  }

  /** M49: ChannelOut.last_message as the server makes it: the newest live timeline row, one line (ui/dmPreview.ts's rule). */
  lastMessage(channelId: string): LastMessageOut | null {
    const rows = this.channels.get(channelId)?.messages ?? [];
    const row = rows.filter((m) => !m.deleted && (!m.parent_id || m.also_in_channel)).sort((a, b) => b.seq - a.seq)[0];
    return row ? lastMessageOf(row, this.users) : null;
  }

  delete(channelId: string, userId: string, messageId: string): MessageOut {
    const { record, message } = this.live(channelId, userId, messageId);
    const seq = ++record.channel.last_seq;
    const tombstone: MessageOut = { ...message, body: "", deleted: true, updated_seq: seq, reactions: [], mentioned_user_ids: [], mention_all: false, pinned_at: null, pinned_by: null };
    this.replace(record, tombstone, "message.deleted");
    return tombstone;
  }

  react(channelId: string, userId: string, messageId: string, emoji: string, present: boolean): { message: MessageOut; changed: boolean } {
    const { record, message } = this.live(channelId, userId, messageId);
    const groups = new Map<string, string[]>();
    for (const reaction of message.reactions ?? []) groups.set(reaction.emoji, [...reaction.user_ids]);
    const users = groups.get(emoji) ?? [];
    let changed = false;
    if (present && !users.includes(userId)) {
      users.push(userId);
      changed = true;
    } else if (!present && users.includes(userId)) {
      users.splice(users.indexOf(userId), 1);
      changed = true;
    }
    if (users.length > 0) groups.set(emoji, users);
    else groups.delete(emoji);
    if (!changed) return { message, changed: false };
    const seq = ++record.channel.last_seq;
    const updated: MessageOut = { ...message, updated_seq: seq, reactions: [...groups].map(([e, ids]) => ({ emoji: e, count: ids.length, user_ids: ids })) };
    this.replace(record, updated, "message.updated", "reactions");
    const at = now();
    if (present) this.reactionTimes.set(`${messageId}:${userId}:${emoji}`, at);
    else this.reactionTimes.delete(`${messageId}:${userId}:${emoji}`);
    // M39: news to the author (not for their own reaction, nor a reaction taken back).
    if (present && this.activityEnabled && message.sender_id !== userId) {
      this.emit(new Set([message.sender_id]), { type: "event", id: ++this.eventId, event: "reaction.added", ts: at, channel_id: channelId, seq: null, data: { channel_id: channelId, message_id: messageId, user_id: userId, emoji, at } });
    }
    return { message: updated, changed: true };
  }

  // --- presence / typing (SYNC_PROTOCOL.md §5.2, volatile) ---------------------------------

  /** Users whose window is "away" (set by tests); everyone connected is online otherwise. */
  readonly awayUsers = new Set<string>();
  private readonly announced = new Map<string, string>();

  presenceOf(userId: string): "online" | "away" | "offline" {
    if (![...this.sockets].some((s) => s.userId === userId && s.authed)) return "offline";
    return this.awayUsers.has(userId) ? "away" : "online";
  }

  markActive(userId: string): void {
    if (this.awayUsers.delete(userId)) this.announcePresence(userId);
  }

  /** Broadcast a presence frame when the user's status changed. */
  announcePresence(userId: string): void {
    const status = this.presenceOf(userId);
    if ((this.announced.get(userId) ?? "offline") === status) return;
    if (status === "offline") this.announced.delete(userId);
    else this.announced.set(userId, status);
    for (const socket of [...this.sockets]) if (socket.authed) socket.deliver({ type: "presence", user_id: userId, status });
  }

  relayTyping(userId: string, channelId: string, parentId: string | null): void {
    const record = this.channels.get(channelId);
    if (!record || !record.members.has(userId)) return;
    for (const socket of [...this.sockets]) {
      if (socket.authed && socket.userId !== userId && record.members.has(socket.userId)) {
        socket.deliver({ type: "typing", channel_id: channelId, parent_id: parentId, user_id: userId });
      }
    }
  }

  // --- pins and bookmarks (M11c) ----------------------------------------------------------

  /** PUT / DELETE /messages/{id}/pin: any member; a change consumes a seq (message.updated change=pin). */
  pin(channelId: string, userId: string, messageId: string, pinned: boolean): MessageOut {
    const { record, message } = this.live(channelId, userId, messageId);
    if ((message.pinned_at !== null) === pinned) return message;
    const seq = ++record.channel.last_seq;
    const updated: MessageOut = { ...message, updated_seq: seq, pinned_at: pinned ? now() : null, pinned_by: pinned ? userId : null };
    this.replace(record, updated, "message.updated", "pin");
    return updated;
  }

  /** L9: the shared tasks made from a message changed (created, status, due date, assignees, deleted): change=tasks. */
  setMessageTasks(channelId: string, messageId: string, tasks: MessageOut["tasks"]): MessageOut {
    const record = this.record(channelId);
    const message = record.messages.find((m) => m.id === messageId && !m.deleted);
    if (!message) throw new ApiError(404, "message_not_found", "not found");
    const seq = ++record.channel.last_seq;
    const updated: MessageOut = { ...message, updated_seq: seq, tasks };
    this.replace(record, updated, "message.updated", "tasks");
    return updated;
  }

  /** Custom emoji by name (M12f); everyone gets emoji.updated. */
  readonly customEmoji = new Map<string, CustomEmojiOut>();

  addEmoji(name: string, userId: string): CustomEmojiOut {
    const row: CustomEmojiOut = { id: `emoji-${++this.eventId}`, name, kind: "image", content_type: "image/png", width: 32, height: 32, keywords: [], position: 0, created_by: userId, created_at: now() };
    this.customEmoji.set(name, row);
    return row;
  }

  /** M30: post templates by id (bootstrap `templates`, template.updated: the workspace's to all, one's own to them). */
  readonly templates = new Map<string, TemplateOut>();

  emitTemplate(row: TemplateOut, deleted: boolean): void {
    if (deleted) this.templates.delete(row.id);
    else this.templates.set(row.id, row);
    const audience = row.scope === "workspace" ? new Set(this.users.keys()) : new Set([row.owner_id!]);
    this.emit(audience, { type: "event", id: ++this.eventId, event: "template.updated", ts: now(), channel_id: null, seq: null, data: { template: row, deleted } });
  }

  /** M140: the 在室状況 board (bootstrap `attendance`, GET /attendance); null = off. */
  attendance: AttendanceBoardOut | null = null;

  /** M140: attendance.updated / attendance.config_updated to everyone. */
  emitAttendance(event: "attendance.updated" | "attendance.config_updated", data: Record<string, unknown>): void {
    this.emit(new Set(this.users.keys()), { type: "event", id: ++this.eventId, event, ts: now(), channel_id: null, seq: null, data });
  }

  /** M143: the 操作ボタン (bootstrap `actions`, GET /actions); null = off. */
  actions: ActionListOut | null = null;

  /** M143: actions.updated to everyone. */
  emitActionsUpdated(): void {
    this.emit(new Set(this.users.keys()), { type: "event", id: ++this.eventId, event: "actions.updated", ts: now(), channel_id: null, seq: null, data: {} });
  }

  /** M143 §12: a group's state to everyone (the real server: who may press a button of the group). */
  emitActionStatus(status: ActionStatusOut): void {
    this.emit(new Set(this.users.keys()), { type: "event", id: ++this.eventId, event: "actions.status_updated", ts: now(), channel_id: null, seq: null, data: status as unknown as Record<string, unknown> });
  }

  /** M23: the lab roster by user id (bootstrap `roster`, roster.updated). */
  readonly roster = new Map<string, LabProfileOut>();

  setRosterLine(userId: string, profile: LabProfileOut | null): void {
    if (profile) this.roster.set(userId, profile);
    else this.roster.delete(userId);
    this.emit(new Set(this.users.keys()), { type: "event", id: ++this.eventId, event: "roster.updated", ts: now(), channel_id: null, seq: null, data: { user_id: userId, profile } });
  }

  emitEmoji(row: CustomEmojiOut, deleted: boolean): void {
    if (deleted) this.customEmoji.delete(row.name);
    else this.customEmoji.set(row.name, row);
    this.emit(new Set(this.users.keys()), { type: "event", id: ++this.eventId, event: "emoji.updated", ts: now(), channel_id: null, seq: null, data: { emoji: row, deleted } });
  }

  /** "user" → open reminders (M12e). */
  readonly reminders = new Map<string, ReminderOut[]>();

  remind(userId: string, channelId: string, messageId: string, remindAt: string, note: string | null = null): ReminderOut {
    const row: ReminderOut = { id: `rem-${++this.eventId}`, message_id: messageId, channel_id: channelId, note, preview: "preview", remind_at: remindAt, status: "pending", fired_at: null, created_at: now(), kind: "personal" };
    this.reminders.set(userId, [...(this.reminders.get(userId) ?? []), row]);
    return row;
  }

  emitReminder(userId: string, row: ReminderOut): void {
    const open = row.status === "pending" || row.status === "fired";
    this.reminders.set(userId, (this.reminders.get(userId) ?? []).filter((r) => r.id !== row.id).concat(open ? [row] : []));
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "reminder.updated", ts: now(), channel_id: row.channel_id, seq: null, data: { reminder: row } });
  }

  /** "user" → pending scheduled messages (M12d). */
  readonly scheduled = new Map<string, ScheduledOut[]>();

  /** A scheduled row for the user; `emitScheduled` reports later status changes. */
  schedule(userId: string, channelId: string, body: string, sendAt: string): ScheduledOut {
    const row: ScheduledOut = { id: `sch-${++this.eventId}`, channel_id: channelId, parent_id: null, client_msg_id: `c-${this.eventId}`, body, attachments: [], send_at: sendAt, status: "pending", error: null, sent_message_id: null, created_at: now() };
    this.scheduled.set(userId, [...(this.scheduled.get(userId) ?? []), row]);
    return row;
  }

  emitScheduled(userId: string, row: ScheduledOut): void {
    this.scheduled.set(userId, (this.scheduled.get(userId) ?? []).filter((r) => r.id !== row.id).concat(row.status === "pending" ? [row] : []));
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "scheduled.updated", ts: now(), channel_id: row.channel_id, seq: null, data: { scheduled: row } });
  }

  /** "user" → starred channel ids (M12a). */
  readonly favorites = new Map<string, string[]>();
  /** M118: each user's pinned DMs, oldest pin first; `dmPinsEnabled` false plays a server before M118 (no dm_pins). */
  readonly dmPins = new Map<string, string[]>();
  dmPinsEnabled = true;
  /**
   * M141: each user's closed DMs with the channel's last_seq when closed (DATA_MODEL.md conversation_closes);
   * `dmClosesEnabled` false plays a server before M141 (no closed_dms).
   */
  readonly dmCloses = new Map<string, Map<string, number>>();
  dmClosesEnabled = true;
  /** M15f: each conversation's link bar; setLinks announces it like the server does. */
  readonly links = new Map<string, ChannelLinkOut[]>();

  setLinks(channelId: string, titles: string[]): void {
    const record = this.record(channelId);
    const links: ChannelLinkOut[] = titles.map((title, position) => ({ id: `link-${channelId}-${title}`, title, url: `https://example.com/${position}`, position, created_by: record.channel.created_by ?? "", created_at: now() }));
    this.links.set(channelId, links);
    this.emit(record.members, { type: "event", id: ++this.eventId, event: "channel.links_updated", ts: now(), channel_id: channelId, seq: null, data: { channel_id: channelId, links } });
  }

  /** M112: the workspace's reservation pools; setPools announces a change like the server (to everyone, no pool in it). */
  pools: PoolOut[] = [];
  /** How many times GET /reservation-pools was read. */
  poolReads = 0;

  setPools(pools: PoolOut[], changed: string = pools[0]?.id ?? "p"): void {
    this.pools = pools;
    this.emit(new Set(this.users.keys()), { type: "event", id: ++this.eventId, event: "reservation.updated", ts: now(), channel_id: null, seq: null, data: { pool_id: changed, deleted: false } });
  }

  /** M112: a reservation notice for one person (an activity item; the badge refreshes, the app may show a banner). */
  noticeReservation(userId: string, text: string): void {
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "reservation.notice", ts: now(), channel_id: null, seq: null, data: { item_id: `n${this.eventId}`, pool_id: "p1", reservation_id: null, text, operator: true, at: now() } } as EventFrame);
  }

  // --- canvases (M43, CANVAS.md §4.4–§4.7) -------------------------------------------------------

  /**
   * Canvases by id with their versions (revision id → body, side versions too); `deleted` = in the trash. M44: `history`
   * the versions the history lists (no side ones), oldest first.
   */
  readonly canvases = new Map<string, { canvas: CanvasOut; deleted: boolean; revisions: Map<string, string>; history: CanvasRevisionMeta[] }>();
  /** (user, client_save_id) → the revision a save made (create: the canvas's first one), as the server's unique index. */
  private readonly canvasKeys = new Map<string, { canvasId: string; revisionId: string; side: boolean }>();
  /** Every PUT /content that reached the server (retries included). */
  readonly canvasSaveRequests: CanvasSaveIn[] = [];
  readonly canvasTemplates: CanvasTemplateOut[] = [
    { id: nextId(), key: "minutes", name: "議事録", description: "出席・議題・決定事項・TODO", title: "議事録 {{date}}", body: "# 議事録 {{date}}\n## 決定事項\n\n## TODO\n- [ ] 担当 @ / 期限 📅\n", position: 1, builtin: true, hidden: false, updated_at: now() },
  ];

  private canvasRecord(canvasId: string, userId: string, trashed = false) {
    const record = this.canvases.get(canvasId);
    if (!record || record.deleted !== trashed) throw new ApiError(404, "canvas_not_found", "Canvas not found");
    this.requireMember(record.canvas.channel_id, userId);
    return record;
  }

  private emitCanvas(channelId: string, event: string, data: unknown): void {
    this.emit(this.record(channelId).members, { type: "event", id: ++this.eventId, event, ts: now(), channel_id: channelId, seq: null, data } as EventFrame);
  }

  private canvasMeta(canvas: CanvasOut): CanvasMeta {
    const { body: _body, ...meta } = canvas;
    return meta;
  }

  /** CANVAS.md §4.7, the parts the tests use: owners-only canvases take ticks from the other members. */
  private mayEditCanvas(userId: string, canvas: CanvasOut): boolean {
    const channel = this.record(canvas.channel_id).channel;
    if (channel.type === "dm" || channel.type === "group_dm") return true;
    if (this.users.get(userId)?.role === "guest") return false;
    if (canvas.edit_policy === "members") return true;
    return canvas.created_by === userId || this.roleOf(canvas.channel_id, userId) === "owner" || this.users.get(userId)?.role === "admin";
  }

  createCanvas(userId: string, channelId: string, body: CanvasCreate): CanvasOut {
    this.requireMember(channelId, userId);
    const key = this.canvasKeys.get(`${userId}:${body.client_save_id}`);
    if (key) return { ...this.canvases.get(key.canvasId)!.canvas };
    const template = body.template_key ? this.canvasTemplates.find((t) => t.key === body.template_key) : undefined;
    if (body.template_key && !template) throw new ApiError(404, "template_not_found", "Template not found");
    const expand = (text: string) => text.replaceAll("{{date}}", "2026-10-01 (木)");
    if (body.as_tab && [...this.canvases.values()].some((r) => !r.deleted && r.canvas.channel_id === channelId && r.canvas.is_channel_tab)) throw new ApiError(409, "canvas_tab_taken", "taken");
    const text = body.body ?? (template ? expand(template.body) : "");
    const revisionId = nextId();
    const at = now();
    const canvas: CanvasOut = {
      id: nextId(), channel_id: channelId, title: body.title ?? (template ? expand(template.title) : "無題のキャンバス"), version: 1, head_rev_id: revisionId,
      is_channel_tab: body.as_tab ?? false, edit_policy: "members", template_key: template?.key ?? null, share_message_id: null,
      ...countTasks(text), created_by: userId, updated_by: userId, created_at: at, updated_at: at, body: text,
    };
    this.canvases.set(canvas.id, { canvas, deleted: false, revisions: new Map([[revisionId, text]]), history: [] });
    this.addRevision(canvas.id, { id: revisionId, kind: "create", author_id: userId, parent_rev_id: null, before: "", after: text, version: 1 });
    this.canvasKeys.set(`${userId}:${body.client_save_id}`, { canvasId: canvas.id, revisionId, side: false });
    this.emitCanvas(channelId, "canvas.created", { canvas: this.canvasMeta(canvas) });
    return { ...canvas };
  }

  listCanvases(userId: string, channelId: string, trashed = false): CanvasMeta[] {
    this.requireMember(channelId, userId);
    return [...this.canvases.values()]
      .filter((r) => r.canvas.channel_id === channelId && r.deleted === trashed)
      .map((r) => ({ ...this.canvasMeta(r.canvas), ...(trashed ? { deleted_at: r.canvas.updated_at } : {}) }))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  getCanvas(userId: string, canvasId: string): CanvasOut {
    return { ...this.canvasRecord(canvasId, userId).canvas };
  }

  /** Forget a version (as the pruning after 24 hours does): a save on it gets canvas_base_expired. */
  eraseCanvasRevision(canvasId: string, revisionId: string): void {
    this.canvases.get(canvasId)!.revisions.delete(revisionId);
  }

  /** PUT /canvases/{id}/content (§4.4) with the fake's line merge (merge3 below). */
  saveCanvas(userId: string, canvasId: string, req: CanvasSaveIn): CanvasSaveOut {
    this.canvasSaveRequests.push({ ...req });
    const record = this.canvasRecord(canvasId, userId);
    const canvas = record.canvas;
    const done = this.canvasKeys.get(`${userId}:${req.client_save_id}`);
    if (done) return { canvas: { ...canvas }, submitted_rev_id: done.revisionId, merged: done.side };
    const baseBody = record.revisions.get(req.base_rev_id);
    if (baseBody === undefined) throw new ApiError(409, "canvas_base_expired", "gone", { head: { ...canvas }, conflicts: [], timed_out: false });
    if (!this.mayEditCanvas(userId, canvas)) {
      const onlyTicks = onlyTasksToggled(baseBody, req.body);
      if (!onlyTicks || this.users.get(userId)?.role === "guest") throw new ApiError(403, "canvas_edit_restricted", "restricted");
      if (req.on_conflict === "ours" || req.on_conflict === "both") throw new ApiError(403, "canvas_edit_restricted", "ticks only");
    }
    const setHead = (body: string, key: string | null): string => {
      const revisionId = nextId();
      record.revisions.set(revisionId, body);
      this.addRevision(canvasId, { id: revisionId, kind: key ? "save" : "merge", author_id: userId, parent_rev_id: canvas.head_rev_id, before: canvas.body, after: body, version: canvas.version + 1 });
      Object.assign(canvas, { body, head_rev_id: revisionId, version: canvas.version + 1, updated_by: userId, updated_at: now(), ...countTasks(body) });
      if (key) this.canvasKeys.set(`${userId}:${key}`, { canvasId, revisionId, side: false });
      this.emitCanvas(canvas.channel_id, "canvas.updated", { canvas: this.canvasMeta(canvas), change: "content" });
      return revisionId;
    };
    if (req.base_rev_id === canvas.head_rev_id || req.body === canvas.body) {
      if (req.body === canvas.body) return { canvas: { ...canvas }, submitted_rev_id: canvas.head_rev_id, merged: false };
      const revisionId = setHead(req.body, req.client_save_id);
      return { canvas: { ...canvas }, submitted_rev_id: revisionId, merged: false };
    }
    const result = merge3(baseBody, req.body, canvas.body, req.on_conflict);
    if (result.conflicts.length > 0 && req.on_conflict === "fail") {
      throw new ApiError(409, "canvas_conflict", "Someone changed the same words", { head: { ...canvas }, conflicts: result.conflicts, timed_out: false });
    }
    const sideId = nextId();
    record.revisions.set(sideId, req.body);
    this.canvasKeys.set(`${userId}:${req.client_save_id}`, { canvasId, revisionId: sideId, side: true });
    if (result.text !== canvas.body) setHead(result.text, null);
    return { canvas: { ...canvas }, submitted_rev_id: sideId, merged: true };
  }

  updateCanvas(userId: string, canvasId: string, patch: CanvasUpdate): CanvasOut {
    const canvas = this.canvasRecord(canvasId, userId).canvas;
    Object.assign(canvas, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)), { version: canvas.version + 1, updated_by: userId, updated_at: now() });
    this.emitCanvas(canvas.channel_id, "canvas.updated", { canvas: this.canvasMeta(canvas), change: patch.title ? "title" : "settings" });
    return { ...canvas };
  }

  deleteCanvas(userId: string, canvasId: string): void {
    const record = this.canvasRecord(canvasId, userId);
    record.deleted = true;
    Object.assign(record.canvas, { version: record.canvas.version + 1, updated_at: now() });
    this.emitCanvas(record.canvas.channel_id, "canvas.deleted", { canvas_id: canvasId, channel_id: record.canvas.channel_id });
  }

  restoreCanvas(userId: string, canvasId: string): CanvasOut {
    const record = this.canvasRecord(canvasId, userId, true);
    record.deleted = false;
    Object.assign(record.canvas, { version: record.canvas.version + 1, updated_at: now() });
    this.emitCanvas(record.canvas.channel_id, "canvas.created", { canvas: this.canvasMeta(record.canvas) });
    return { ...record.canvas };
  }

  // --- M44: history, sharing, search, images, the administrators' templates ------------------------

  private revisionClock = 0;

  private addRevision(canvasId: string, r: { id: string; kind: CanvasRevisionMeta["kind"]; author_id: string; parent_rev_id: string | null; before: string; after: string; version: number }): void {
    const record = this.canvases.get(canvasId)!;
    const lines = (text: string) => (text === "" ? [] : text.split("\n"));
    const count = (a: string[], b: string[]) => {
      const left = new Map<string, number>();
      for (const line of a) left.set(line, (left.get(line) ?? 0) + 1);
      let n = 0;
      for (const line of b) {
        const k = left.get(line) ?? 0;
        if (k > 0) left.set(line, k - 1);
        else n++;
      }
      return n;
    };
    // Distinct, increasing times (the history is newest first).
    const at = new Date(Date.parse("2026-09-30T00:00:00Z") + ++this.revisionClock * 60_000).toISOString();
    record.history.push({
      id: r.id, canvas_id: canvasId, kind: r.kind, author_id: r.author_id, parent_rev_id: r.parent_rev_id, version: r.version,
      title: record.canvas.title, label: null, created_at: at, lines_added: count(lines(r.before), lines(r.after)), lines_removed: count(lines(r.after), lines(r.before)),
    });
  }

  canvasRevisions(userId: string, canvasId: string): CanvasRevisionPage {
    const record = this.canvasRecord(canvasId, userId);
    return { items: [...record.history].reverse().map((r) => ({ ...r })), next_cursor: null };
  }

  canvasRevision(userId: string, canvasId: string, revisionId: string): CanvasRevisionOut {
    const record = this.canvasRecord(canvasId, userId);
    const meta = record.history.find((r) => r.id === revisionId);
    if (!meta) throw new ApiError(404, "canvas_revision_not_found", "Version not found");
    return { ...meta, body: meta.kind === "erased" ? "" : record.revisions.get(revisionId) ?? "" };
  }

  /** Every POST …/revisions/{id}/restore that reached the server (retries included). */
  readonly revisionRestores: Array<{ revisionId: string; clientSaveId: string }> = [];

  restoreCanvasRevision(userId: string, canvasId: string, revisionId: string, clientSaveId: string): CanvasOut {
    this.revisionRestores.push({ revisionId, clientSaveId });
    const record = this.canvasRecord(canvasId, userId);
    const canvas = record.canvas;
    if (this.canvasKeys.has(`${userId}:${clientSaveId}`)) return { ...canvas }; // a retry
    if (!this.mayEditCanvas(userId, canvas)) throw new ApiError(403, "canvas_edit_restricted", "restricted");
    const meta = record.history.find((r) => r.id === revisionId);
    if (!meta) throw new ApiError(404, "canvas_revision_not_found", "Version not found");
    if (meta.kind === "erased") throw new ApiError(409, "canvas_revision_erased", "erased");
    const body = record.revisions.get(revisionId) ?? "";
    const id = nextId();
    this.canvasKeys.set(`${userId}:${clientSaveId}`, { canvasId, revisionId: id, side: false });
    if (body === canvas.body) return { ...canvas };
    record.revisions.set(id, body);
    this.addRevision(canvasId, { id, kind: "restore", author_id: userId, parent_rev_id: canvas.head_rev_id, before: canvas.body, after: body, version: canvas.version + 1 });
    Object.assign(canvas, { body, head_rev_id: id, version: canvas.version + 1, updated_by: userId, updated_at: now(), ...countTasks(body) });
    this.emitCanvas(canvas.channel_id, "canvas.updated", { canvas: this.canvasMeta(canvas), change: "restore" });
    return { ...canvas };
  }

  labelCanvasRevision(userId: string, canvasId: string, revisionId: string, label: string | null): CanvasRevisionMeta {
    const record = this.canvasRecord(canvasId, userId);
    if (!this.mayEditCanvas(userId, record.canvas)) throw new ApiError(403, "canvas_edit_restricted", "restricted");
    const meta = record.history.find((r) => r.id === revisionId);
    if (!meta) throw new ApiError(404, "canvas_revision_not_found", "Version not found");
    meta.label = (label ?? "").trim() || null;
    return { ...meta };
  }

  /** DELETE …/revisions/{id}: the body erased (owners and administrators; in a DM its creator). */
  eraseRevisionBody(userId: string, canvasId: string, revisionId: string): CanvasRevisionMeta {
    const record = this.canvasRecord(canvasId, userId);
    const channel = this.record(record.canvas.channel_id).channel;
    const dm = channel.type === "dm" || channel.type === "group_dm";
    const allowed = dm ? record.canvas.created_by === userId : this.roleOf(channel.id, userId) === "owner" || this.users.get(userId)?.role === "admin";
    if (!allowed) throw new ApiError(403, "canvas_edit_restricted", "restricted");
    if (revisionId === record.canvas.head_rev_id) throw new ApiError(409, "canvas_revision_is_head", "head");
    const meta = record.history.find((r) => r.id === revisionId);
    if (!meta) throw new ApiError(404, "canvas_revision_not_found", "Version not found");
    meta.kind = "erased";
    record.revisions.set(revisionId, "");
    return { ...meta };
  }

  /** POST /canvases/{id}/share: `📄 title` and the link as an ordinary message; nothing new while it exists. */
  shareCanvas(userId: string, canvasId: string, baseUrl = "http://server"): CanvasOut {
    const canvas = this.canvasRecord(canvasId, userId).canvas;
    const existing = canvas.share_message_id ? this.record(canvas.channel_id).messages.find((m) => m.id === canvas.share_message_id && !m.deleted) : undefined;
    if (existing) return { ...canvas };
    const { message } = this.post(canvas.channel_id, userId, `📄 ${canvas.title}\n${baseUrl}/c/${canvas.id}`);
    Object.assign(canvas, { share_message_id: message.id, version: canvas.version + 1 });
    this.emitCanvas(canvas.channel_id, "canvas.updated", { canvas: this.canvasMeta(canvas), change: "settings" });
    return { ...canvas };
  }

  /** GET /search/canvases, simply: the words in the title or body of the member's canvases; an excerpt around them. */
  searchCanvases(userId: string, query: { q: string; channel_id?: string | null; limit?: number; offset?: number }): CanvasSearchOut {
    const q = query.q.trim();
    const hits = [...this.canvases.values()]
      .filter((r) => !r.deleted && this.channels.get(r.canvas.channel_id)?.members.has(userId))
      .filter((r) => !query.channel_id || r.canvas.channel_id === query.channel_id)
      .filter((r) => !q || r.canvas.title.includes(q) || r.canvas.body.includes(q))
      .map((r) => {
        const at = r.canvas.body.indexOf(q);
        const snippet = at < 0 ? r.canvas.body.slice(0, 120) : r.canvas.body.slice(Math.max(0, at - 60), at + q.length + 60);
        return { canvas: this.canvasMeta(r.canvas), score: 1, snippet: snippet.replace(/\s+/g, " ").trim() };
      });
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 20;
    return { hits: hits.slice(offset, offset + limit), keywords: q ? [q] : [], total: hits.length, total_capped: false, has_more: offset + limit < hits.length, limit, offset, filters: { unresolved: [] } as unknown as CanvasSearchOut["filters"] };
  }

  /** A conversation's messages as the server holds them (M44 tests: the shared message). */
  channelMessages(channelId: string): MessageOut[] {
    return this.record(channelId).messages;
  }

  /** Every GET /search/canvases that reached the server. */
  readonly canvasSearches: Array<{ q: string; channel_id?: string | null }> = [];

  /** Uploads (POST /attachments): pending until a save names them. */
  readonly uploads = new Map<string, AttachmentOut & { uploader: string }>();

  upload(userId: string, filename: string, contentType: string): AttachmentOut {
    const attachment: AttachmentOut = { id: nextId(), filename, content_type: contentType, size_bytes: 10, width: 40, height: 30, has_thumbnail: contentType.startsWith("image/"), has_poster: false, duration_ms: null, status: "pending", created_at: now() };
    this.uploads.set(attachment.id, { ...attachment, uploader: userId });
    return attachment;
  }

  attachment(userId: string, attachmentId: string): AttachmentOut {
    const row = this.uploads.get(attachmentId);
    if (!row) throw new ApiError(404, "attachment_not_found", "Attachment not found");
    if (row.status === "pending" && row.uploader !== userId) throw new ApiError(403, "not_uploader", "pending");
    const { uploader: _uploader, ...attachment } = row;
    return attachment;
  }

  adminTemplates(userId: string): CanvasTemplateOut[] {
    if (this.users.get(userId)?.role !== "admin") throw new ApiError(403, "admin_required", "admin");
    return this.canvasTemplates.map((t) => ({ ...t }));
  }

  /** M15d: "user:channel:parent" → the saved draft. */
  readonly drafts = new Map<string, DraftOut>();
  draftSaves = 0;

  saveDraft(userId: string, channelId: string, parentId: string | null, body: string): DraftOut {
    this.requireMember(channelId, userId);
    const draft: DraftOut = { channel_id: channelId, parent_id: parentId, body, updated_at: now() };
    this.drafts.set(`${userId}:${channelId}:${parentId ?? ""}`, draft);
    this.draftSaves += 1;
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "draft.updated", ts: now(), channel_id: null, seq: null, data: { ...draft, deleted: false } });
    return draft;
  }

  deleteDraft(userId: string, channelId: string, parentId: string | null): void {
    if (!this.drafts.delete(`${userId}:${channelId}:${parentId ?? ""}`)) return;
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "draft.updated", ts: now(), channel_id: null, seq: null, data: { channel_id: channelId, parent_id: parentId, body: "", updated_at: now(), deleted: true } });
  }

  draftsOf(userId: string): DraftOut[] {
    return [...this.drafts.entries()].filter(([key]) => key.startsWith(`${userId}:`)).map(([, draft]) => draft);
  }

  setFavorite(userId: string, channelId: string, on: boolean): void {
    const list = this.favorites.get(userId) ?? [];
    if (on ? list.includes(channelId) : !list.includes(channelId)) return;
    this.favorites.set(userId, on ? [...list, channelId] : list.filter((id) => id !== channelId));
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "favorite.updated", ts: now(), channel_id: channelId, seq: null, data: { channel_id: channelId, favorite: on } });
  }

  /** M118: PUT / DELETE /channels/{id}/dm-pin; dm_pin.updated to the user only when it changed. */
  setDmPin(userId: string, channelId: string, on: boolean): void {
    const list = this.dmPins.get(userId) ?? [];
    if (on === list.includes(channelId)) return;
    this.dmPins.set(userId, on ? [...list, channelId] : list.filter((id) => id !== channelId));
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "dm_pin.updated", ts: now(), channel_id: null, seq: null, data: { channel_id: channelId, pinned: on, at: now() } });
  }

  /**
   * M141: closed while no timeline row (top level or also_in_channel) is newer than the closing seq; a new message opens
   * it without a write, as on the server.
   */
  isDmClosedFor(userId: string, channelId: string): boolean {
    const closedSeq = this.dmCloses.get(userId)?.get(channelId);
    if (closedSeq === undefined) return false;
    const record = this.channels.get(channelId);
    return !!record && !record.messages.some((m) => m.seq !== null && m.seq > closedSeq && (!m.parent_id || m.also_in_channel));
  }

  /** M141: PUT / DELETE /channels/{id}/close; dm_close.updated to the user only when it changed. */
  setDmClose(userId: string, channelId: string, closed: boolean): void {
    const record = this.channels.get(channelId);
    if (!record) throw new ApiError(404, "not_found", "Channel not found");
    if (record.channel.type !== "dm" && record.channel.type !== "group_dm") throw new ApiError(422, "dm_close_not_dm", "Only DMs can be closed");
    const was = this.isDmClosedFor(userId, channelId);
    const map = this.dmCloses.get(userId) ?? new Map<string, number>();
    this.dmCloses.set(userId, map);
    if (closed) map.set(channelId, record.channel.last_seq);
    else map.delete(channelId);
    if (was === closed) return;
    this.emitDmClose(userId, channelId, closed, closed ? record.channel.last_seq : null);
  }

  /**
   * dm_close.updated as it is sent (closed_seq: where it was closed, Review v0.1.43 #6). Called alone, it replays the
   * race the review found: a close that read the seq before a new message, delivered after that message.created.
   */
  emitDmClose(userId: string, channelId: string, closed: boolean, closedSeq: number | null): void {
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "dm_close.updated", ts: now(), channel_id: null, seq: null, data: { channel_id: channelId, closed, at: now(), closed_seq: closedSeq } });
  }

  /**
   * POST /channels/read-all: every membership read to its end; read.updated per moved channel. L8: scope "times" reads only
   * the Times feed's channels (member, a times, not muted).
   */
  readAll(userId: string, scope: "all" | "times" = "all"): ChannelReadStateOut[] {
    this.readAllScopes.push(scope);
    return [...this.channels.values()]
      .filter((r) => r.members.has(userId) && (scope === "all" || this.inTimesFeed(userId, r.channel.id)))
      .map((r) => ({ channel_id: r.channel.id, ...this.markRead(userId, r.channel.id, r.channel.last_seq) }));
  }

  /** The scopes read-all was called with (L8 tests). */
  readonly readAllScopes: Array<"all" | "times"> = [];
  /** GET /times/feed calls (L8 tests). */
  readonly timesFeedCalls: Array<string | null> = [];

  /** L8 (TIMES_FEED.md §2): a times I am in and have not muted. */
  inTimesFeed(userId: string, channelId: string): boolean {
    const record = this.record(channelId);
    if (!record.members.has(userId) || !record.channel.times_owner_id) return false;
    const pref = this.notificationPreference(userId, channelId);
    const mutedUntil = pref.muted_until ? Date.parse(pref.muted_until) > Date.now() : false;
    return !(pref.follows_default === false && pref.level === "none") && !pref.muted && !mutedUntil;
  }

  /** GET /times/feed (TIMES_FEED.md §3): (created_at, id) descending, cursor "<created_at>_<id>". */
  timesFeed(userId: string, cursor: string | null, limit: number): { items: MessageOut[]; next_cursor: string | null } {
    this.timesFeedCalls.push(cursor);
    const key = (m: MessageOut) => `${m.created_at}_${m.id}`;
    const rows = [...this.channels.values()]
      .filter((r) => this.inTimesFeed(userId, r.channel.id))
      .flatMap((r) => r.messages.filter((m) => !m.deleted && m.type === "user" && (!m.parent_id || m.also_in_channel)))
      .sort((a, b) => (key(b) < key(a) ? -1 : key(b) > key(a) ? 1 : 0))
      .filter((m) => !cursor || key(m) < cursor);
    const page = rows.slice(0, limit);
    return { items: page.map((m) => this.viewAs(m, userId)), next_cursor: rows.length > limit ? key(page[page.length - 1]!) : null };
  }

  /** "user" → saved message ids, newest first. */
  readonly bookmarks = new Map<string, string[]>();

  setBookmark(userId: string, messageId: string, on: boolean): void {
    const list = this.bookmarks.get(userId) ?? [];
    if (on ? list.includes(messageId) : !list.includes(messageId)) return;
    this.bookmarks.set(userId, on ? [messageId, ...list] : list.filter((id) => id !== messageId));
    const record = [...this.channels.values()].find((r) => r.messages.some((m) => m.id === messageId));
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "bookmark.updated", ts: now(), channel_id: record?.channel.id ?? null, seq: null, data: { message_id: messageId, channel_id: record?.channel.id ?? null, bookmarked: on } });
  }

  private emit(userIds: Set<string>, frame: EventFrame): void {
    if (this.holdEvents) {
      this.held.push({ userIds: new Set(userIds), frame });
      return;
    }
    for (const socket of [...this.sockets]) if (userIds.has(socket.userId)) socket.deliver(frame);
  }

  /** Deliver events held while `holdEvents` was true. */
  release(): void {
    const held = this.held;
    this.held = [];
    for (const { userIds, frame } of held) this.emit(userIds, frame);
  }

  /** PATCH /channels/{id} as the real server announces it (M15): to the members, to everyone for a conversion. */
  updateChannel(channelId: string, patch: Partial<Pick<ChannelOut, "posting_policy" | "type">>): void {
    const record = this.record(channelId);
    const converted = patch.type !== undefined && patch.type !== record.channel.type;
    Object.assign(record.channel, patch, { updated_at: now() });
    const memberIds = [...record.members];
    const audience = converted ? new Set(this.users.keys()) : record.members;
    this.emit(audience, { type: "event", id: ++this.eventId, event: "channel.updated", ts: now(), channel_id: channelId, seq: null, data: { channel: { ...record.channel, membership: null }, member_ids: memberIds } });
  }

  /** L4 (M31): owners made or taken back ("channel:user" → role); the creator is an owner unless changed here. */
  readonly roles = new Map<string, "owner" | "member">();

  roleOf(channelId: string, userId: string): "owner" | "member" {
    return this.roles.get(`${channelId}:${userId}`) ?? (this.record(channelId).channel.created_by === userId ? "owner" : "member");
  }

  /** GET /channels/{id}/members as the server answers it. */
  memberList(channelId: string): MemberOut[] {
    return [...this.record(channelId).members].map((userId) => ({ user_id: userId, role: this.roleOf(channelId, userId), joined_at: now() }));
  }

  /** PATCH /channels/{id}/members/{user_id} (L4): channel.member_updated to the channel's members. */
  setMemberRole(channelId: string, userId: string, role: "owner" | "member"): MemberOut {
    const record = this.record(channelId);
    this.roles.set(`${channelId}:${userId}`, role);
    this.emit(record.members, { type: "event", id: ++this.eventId, event: "channel.member_updated", ts: now(), channel_id: channelId, seq: null, data: { channel_id: channelId, user_id: userId, role } });
    return { user_id: userId, role, joined_at: now() };
  }

  /** What the real server emits after a join / add: member_added to the channel, channel.created to the user. */
  emitMembership(channelId: string, userId: string): void {
    const record = this.record(channelId);
    const memberIds = [...record.members];
    this.emit(record.members, { type: "event", id: ++this.eventId, event: "channel.member_added", ts: now(), channel_id: channelId, seq: null, data: { channel_id: channelId, user_id: userId } });
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "channel.created", ts: now(), channel_id: channelId, seq: null, data: { channel: { ...record.channel, member_count: memberIds.length, membership: null }, member_ids: memberIds } });
  }

  /** M40: each user's signed-in sessions, newest sign-in first (GET /auth/sessions); `current` = the device apiFor speaks for. */
  readonly sessions = new Map<string, SessionOut[]>();

  addSession(userId: string, device: { device_name: string | null; platform: string }, options: { current?: boolean; lastUsedAt?: string } = {}): SessionOut {
    const at = now();
    const session: SessionOut = {
      id: nextId(),
      created_at: at,
      expires_at: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
      last_used_at: options.lastUsedAt ?? at,
      last_ip: null,
      current: options.current ?? false,
      device: { id: nextId(), platform: device.platform, device_name: device.device_name, app_version: null, created_at: at, updated_at: at, last_seen_at: at, enabled: true, disabled_reason: null, push_provider: "none", push_environment: null, push_registered: false },
    };
    this.sessions.set(userId, [session, ...(this.sessions.get(userId) ?? [])]);
    return session;
  }

  /** DELETE /auth/sessions/{id}: only one of the user's own (else 404 session_not_found, like the server). */
  revokeSessionById(userId: string, sessionId: string): void {
    const list = this.sessions.get(userId) ?? [];
    if (!list.some((s) => s.id === sessionId)) throw new ApiError(404, "session_not_found", "Session not found");
    this.sessions.set(userId, list.filter((s) => s.id !== sessionId));
  }

  revokeSession(userId: string): void {
    for (const socket of [...this.sockets]) {
      if (socket.userId !== userId) continue;
      socket.deliver({ type: "event", id: ++this.eventId, event: "session.revoked", ts: now(), channel_id: null, seq: null, data: { reason: "logout" } });
      socket.closeRemote(4003);
    }
  }

  /** Kill every socket of a user (network loss); the client is expected to reconnect. */
  disconnect(userId: string, code = 1006): void {
    for (const socket of [...this.sockets]) if (socket.userId === userId) socket.closeRemote(code);
  }

  socketsOf(userId: string): FakeSocket[] {
    return [...this.sockets].filter((s) => s.userId === userId);
  }

  // --- the API as seen by one user ------------------------------------------------------

  /** UserMe as bootstrap and GET /users/me give it. */
  meOf(userId: string): UserMe {
    const user = this.users.get(userId)!;
    return { ...user, email: null, must_change_password: false, notify_keywords: this.keywords.get(userId) ?? [], presence_hidden: false, notification_default: this.notificationDefaults.get(userId) ?? "mentions", notify_reactions: this.notifyReactions.has(userId), notify_tasks: !this.tasksOff.has(userId), has_password: true, quick_reactions: this.quickReactions.get(userId) ?? null, composer_mode: "markdown" }; // the text area: the rich composer has tests of its own
  }

  apiFor(userId: string): SyncApi & FakeCanvasApi & FakeAiApi & { failNext: (error: Error) => void; listActivity: (options: { filter?: ActivityFilter; cursor?: string | null; limit?: number }) => Promise<ActivityListOut>; sessions: () => Promise<SessionOut[]>; revokeSession: (sessionId: string) => Promise<void>; closeDm: (channelId: string) => Promise<DmCloseStateOut>; reopenDm: (channelId: string) => Promise<DmCloseStateOut>; pinDm: (channelId: string) => Promise<DmPinStateOut> } {
    let pendingFailure: Error | null = null;
    const maybeFail = (): void => {
      if (pendingFailure) {
        const err = pendingFailure;
        pendingFailure = null;
        throw err;
      }
    };
    return {
      ...this.aiApiFor(userId),
      failNext: (error: Error) => {
        pendingFailure = error;
      },
      // M141: closing reads it to its end and unpins it (the star and the section stay), as on the server.
      closeDm: async (channelId: string) => {
        maybeFail();
        this.requireMember(channelId, userId);
        this.setDmClose(userId, channelId, true);
        this.markRead(userId, channelId, this.channels.get(channelId)!.channel.last_seq);
        this.setDmPin(userId, channelId, false);
        return { channel_id: channelId, closed: true, closed_at: now() };
      },
      reopenDm: async (channelId: string) => {
        maybeFail();
        this.requireMember(channelId, userId);
        this.setDmClose(userId, channelId, false);
        return { channel_id: channelId, closed: false, closed_at: null };
      },
      pinDm: async (channelId: string) => {
        maybeFail();
        this.setDmPin(userId, channelId, true);
        return { channel_id: channelId, pinned: true };
      },
      me: async (): Promise<UserMe> => {
        maybeFail();
        return this.meOf(userId);
      },
      bootstrap: async (): Promise<BootstrapOut> => {
        maybeFail();
        const me = this.meOf(userId);
        const channels = [...this.channels.values()]
          .filter((r) => r.members.has(userId))
          .map((r) => ({
            ...r.channel,
            member_count: r.members.size,
            membership: { role: this.roleOf(r.channel.id, userId), joined_at: now() },
            read_state: this.readState(userId, r.channel.id),
            notification: this.notificationPreference(userId, r.channel.id),
            last_message: this.lastMessage(r.channel.id),
          }));
        return {
          server_time: now(),
          me,
          users: [...this.users.values()],
          channels,
          limits: { max_message_length: 20000, max_attachment_bytes: 1, max_attachments_per_message: 10 },
          threads: this.threadSummary(userId),
          presence: [...new Set([...this.sockets].filter((s) => s.authed).map((s) => s.userId))].map((id) => ({ user_id: id, status: this.presenceOf(id) })),
          bookmarks: this.bookmarks.get(userId) ?? [],
          favorites: (this.favorites.get(userId) ?? []).filter((id) => this.channels.get(id)?.members.has(userId)),
          ...(this.dmPinsEnabled ? { dm_pins: (this.dmPins.get(userId) ?? []).filter((id) => this.channels.get(id)?.members.has(userId)) } : {}),
          ...(this.dmClosesEnabled ? { closed_dms: [...(this.dmCloses.get(userId)?.keys() ?? [])].filter((id) => this.channels.get(id)?.members.has(userId) && this.isDmClosedFor(userId, id)) } : {}),
          blocked_user_ids: [],
          custom_emoji: [...this.customEmoji.values()],
          emoji_packs: [],
          templates: [...this.templates.values()].filter((t) => t.scope === "workspace" || t.owner_id === userId),
          groups: [],
          roster: [...this.roster.values()],
          sidebar_sections: [],
          sidebar_defaults: [],
          drafts: this.draftsOf(userId),
          workspace_settings: this.workspaceSettings,
          ...(this.activityEnabled ? { activity: this.activitySummary(userId) } : {}),
          ...(this.attendance ? { attendance: this.attendance } : {}),
          ...(this.actions ? { actions: this.actions } : {}),
        };
      },
      ...(this.activityEnabled
        ? {
            listActivity: async ({ filter = "all", cursor = null, limit = 50 }: { filter?: ActivityFilter; cursor?: string | null; limit?: number }) => {
              maybeFail();
              return this.listActivity(userId, filter, cursor, limit);
            },
            activitySummary: async () => {
              maybeFail();
              return this.activitySummary(userId);
            },
            markActivityRead: async (readAt: string) => {
              maybeFail();
              return this.markActivityRead(userId, readAt);
            },
            ...(this.activityItemReads
              ? {
                  markActivityItemsRead: async (itemIds: string[]) => {
                    maybeFail();
                    return this.markActivityItemsRead(userId, itemIds);
                  },
                }
              : {}),
          }
        : {
            listActivity: async () => {
              throw new ApiError(404, "not_found", "Not Found");
            },
          }),
      sessions: async (): Promise<SessionOut[]> => {
        maybeFail();
        return [...(this.sessions.get(userId) ?? [])];
      },
      revokeSession: async (sessionId: string): Promise<void> => {
        maybeFail();
        this.revokeSessionById(userId, sessionId);
      },
      // M43: canvases, named as ApiClient names them (the screen reaches them through controller.api).
      listCanvases: async (channelId: string, trashed = false) => {
        maybeFail();
        return this.listCanvases(userId, channelId, trashed);
      },
      getCanvas: async (canvasId: string, knownVersion: number | null) => {
        maybeFail();
        const canvas = this.getCanvas(userId, canvasId);
        return knownVersion !== null && knownVersion === canvas.version ? null : canvas;
      },
      saveCanvas: async (canvasId: string, body: CanvasSaveIn) => {
        maybeFail();
        return this.saveCanvas(userId, canvasId, body);
      },
      createCanvas: async (channelId: string, body: CanvasCreate) => {
        maybeFail();
        return this.createCanvas(userId, channelId, body);
      },
      updateCanvas: async (canvasId: string, patch: CanvasUpdate) => {
        maybeFail();
        return this.updateCanvas(userId, canvasId, patch);
      },
      deleteCanvas: async (canvasId: string) => {
        maybeFail();
        this.deleteCanvas(userId, canvasId);
      },
      restoreCanvas: async (canvasId: string) => {
        maybeFail();
        return this.restoreCanvas(userId, canvasId);
      },
      canvasTemplates: async () => {
        maybeFail();
        return this.canvasTemplates.filter((t) => !t.hidden).map((t) => ({ ...t }));
      },
      // M44
      canvasRevisions: async (canvasId: string) => {
        maybeFail();
        return this.canvasRevisions(userId, canvasId);
      },
      canvasRevision: async (canvasId: string, revisionId: string) => {
        maybeFail();
        return this.canvasRevision(userId, canvasId, revisionId);
      },
      restoreCanvasRevision: async (canvasId: string, revisionId: string, clientSaveId: string) => {
        maybeFail();
        return this.restoreCanvasRevision(userId, canvasId, revisionId, clientSaveId);
      },
      labelCanvasRevision: async (canvasId: string, revisionId: string, label: string | null) => {
        maybeFail();
        return this.labelCanvasRevision(userId, canvasId, revisionId, label);
      },
      eraseCanvasRevision: async (canvasId: string, revisionId: string) => {
        maybeFail();
        return this.eraseRevisionBody(userId, canvasId, revisionId);
      },
      shareCanvas: async (canvasId: string) => {
        maybeFail();
        return this.shareCanvas(userId, canvasId);
      },
      myCanvases: async () => {
        maybeFail();
        const items = [...this.canvases.values()]
          .filter((r) => !r.deleted && this.channels.get(r.canvas.channel_id)?.members.has(userId))
          .map((r) => this.canvasMeta(r.canvas))
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        return { items, next_cursor: null };
      },
      searchCanvases: async (query: { q: string; channel_id?: string | null; limit?: number; offset?: number }) => {
        maybeFail();
        this.canvasSearches.push({ ...query });
        return this.searchCanvases(userId, query);
      },
      uploadAttachment: async (file: Blob, filename: string) => {
        maybeFail();
        return this.upload(userId, filename, file.type || "application/octet-stream");
      },
      getAttachment: async (attachmentId: string) => {
        maybeFail();
        return this.attachment(userId, attachmentId);
      },
      fetchBlob: async (path: string) => {
        maybeFail();
        const id = /attachments\/([^/]+)\//.exec(path)?.[1] ?? "";
        this.attachment(userId, id);
        return new Blob(["img"], { type: "image/png" });
      },
      adminCanvasTemplates: async () => {
        maybeFail();
        return this.adminTemplates(userId);
      },
      adminCreateCanvasTemplate: async (body: CanvasTemplateCreate) => {
        maybeFail();
        this.adminTemplates(userId);
        const row: CanvasTemplateOut = { id: nextId(), key: body.key ?? `custom_${nextId().slice(0, 8)}`, name: body.name, description: body.description ?? null, title: body.title, body: body.body, position: body.position ?? this.canvasTemplates.length, builtin: false, hidden: false, updated_at: now() };
        this.canvasTemplates.push(row);
        return { ...row };
      },
      adminUpdateCanvasTemplate: async (templateId: string, patch: CanvasTemplateUpdate) => {
        maybeFail();
        this.adminTemplates(userId);
        const row = this.canvasTemplates.find((t) => t.id === templateId);
        if (!row) throw new ApiError(404, "template_not_found", "Template not found");
        Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)), { updated_at: now() });
        return { ...row };
      },
      adminDeleteCanvasTemplate: async (templateId: string) => {
        maybeFail();
        this.adminTemplates(userId);
        const index = this.canvasTemplates.findIndex((t) => t.id === templateId);
        if (index < 0) throw new ApiError(404, "template_not_found", "Template not found");
        if (this.canvasTemplates[index]!.builtin) throw new ApiError(409, "template_builtin", "builtin");
        this.canvasTemplates.splice(index, 1);
      },
      attendance: async () => this.attendance ?? { enabled: false, states: [], entries: [], can_personalize: false },
      actions: async () => this.actions ?? { enabled: false, show_on_attendance: false, actions: [] },
      reservationPools: async () => {
        maybeFail();
        this.poolReads += 1;
        return this.pools;
      },
      channelLinks: async (channelId) => {
        maybeFail();
        this.requireMember(channelId, userId);
        return this.links.get(channelId) ?? [];
      },
      saveDraft: async (channelId, parentId, body) => {
        maybeFail();
        return this.saveDraft(userId, channelId, parentId, body);
      },
      deleteDraft: async (channelId, parentId) => {
        maybeFail();
        this.deleteDraft(userId, channelId, parentId);
      },
      history: async (channelId, beforeSeq, limit): Promise<HistoryOut> => {
        maybeFail();
        const record = this.requireReadable(channelId, userId);
        const channelLastSeq = record.channel.last_seq; // read BEFORE the rows (§4.3)
        let rows = record.messages.filter((m) => !m.deleted && (!m.parent_id || m.also_in_channel));
        if (beforeSeq !== null) rows = rows.filter((m) => m.seq < beforeSeq);
        rows = rows.sort((a, b) => b.seq - a.seq);
        return { channel_last_seq: channelLastSeq, messages: rows.slice(0, limit).map((m) => this.viewAs(m, userId)), has_more: rows.length > limit };
      },
      delta: async (channelId, sinceSeq, limit): Promise<DeltaOut> => {
        maybeFail();
        const record = this.requireReadable(channelId, userId);
        const channelLastSeq = record.channel.last_seq;
        const rows = record.messages.filter((m) => m.updated_seq > sinceSeq).sort((a, b) => a.updated_seq - b.updated_seq);
        const page = rows.slice(0, limit).map((m) => this.viewAs(m, userId));
        const hasMore = rows.length > limit;
        return { messages: page, next_since_seq: hasMore ? page[page.length - 1]!.updated_seq : Math.max(channelLastSeq, sinceSeq), has_more: hasMore };
      },
      getMessage: async (messageId): Promise<MessageOut> => {
        maybeFail();
        const record = [...this.channels.values()].find((r) => r.messages.some((m) => m.id === messageId && !m.deleted));
        if (!record) throw new ApiError(404, "message_not_found", "not found");
        this.requireReadable(record.channel.id, userId);
        return this.viewAs(record.messages.find((m) => m.id === messageId)!, userId);
      },
      postMessage: async (channelId, clientMsgId, body, parentId = null, attachmentIds = [], options = {}) => {
        maybeFail();
        return this.post(channelId, userId, body, clientMsgId, parentId, attachmentIds, options);
      },
      replies: async (messageId): Promise<MessageOut[]> => {
        maybeFail();
        const record = [...this.channels.values()].find((r) => r.messages.some((m) => m.id === messageId));
        if (!record) return [];
        // As the server: a deleted root has no thread to read (THREADS.md §5 「元のメッセージの削除」).
        if (record.messages.some((m) => m.id === messageId && m.deleted)) throw new ApiError(404, "message_not_found", "not found");
        this.requireReadable(record.channel.id, userId);
        return record.messages.filter((m) => m.parent_id === messageId && !m.deleted).sort((a, b) => a.seq - b.seq).map((m) => this.viewAs(m, userId));
      },
      listReminders: async (): Promise<ReminderOut[]> => {
        maybeFail();
        return this.reminders.get(userId) ?? [];
      },
      listScheduled: async (): Promise<ScheduledOut[]> => {
        maybeFail();
        return this.scheduled.get(userId) ?? [];
      },
      readAll: async (scope?: "all" | "times"): Promise<ChannelReadStateOut[]> => {
        maybeFail();
        return this.readAll(userId, scope);
      },
      timesFeed: async (cursor?: string | null, limit?: number) => {
        maybeFail();
        return this.timesFeed(userId, cursor ?? null, limit ?? 50);
      },
      markRead: async (channelId, lastReadSeq, mode = "advance"): Promise<ReadStateOut> => {
        maybeFail();
        return this.markRead(userId, channelId, lastReadSeq, mode);
      },
      threads: async ({ filter, cursor = null, limit = 50 }): Promise<ThreadListOut> => {
        maybeFail();
        return this.threads(userId, filter, cursor, limit);
      },
      threadState: async (messageId): Promise<ThreadState> => {
        maybeFail();
        return this.threadState(userId, messageId);
      },
      markThreadRead: async (messageId, lastReadSeq): Promise<ThreadState> => {
        maybeFail();
        return this.markThreadRead(userId, messageId, lastReadSeq);
      },
      setThreadFollow: async (messageId, following): Promise<ThreadState> => {
        maybeFail();
        return this.setThreadFollow(userId, messageId, following);
      },
      channel: async (channelId: string): Promise<ChannelOut> => {
        maybeFail();
        const record = this.channels.get(channelId);
        if (!record) throw new ApiError(404, "channel_not_found", "not found");
        const member = record.members.has(userId);
        if (!member && record.channel.type !== "public") throw new ApiError(403, "not_a_member", "not a member");
        return {
          ...record.channel,
          member_count: record.members.size,
          membership: member ? { role: this.roleOf(channelId, userId), joined_at: now() } : null,
          last_message: member ? this.lastMessage(channelId) : null, // M49: members only
        };
      },
      publicChannels: async (): Promise<ChannelOut[]> =>
        [...this.channels.values()]
          .filter((r) => r.channel.type === "public" && !r.members.has(userId))
          .map((r) => ({ ...r.channel, member_count: r.members.size, membership: null })),
    };
  }

  // --- AI (M65, docs/AI.md §5) ---------------------------------------------------------------

  /** The server answers 404 to every AI route (a server before M65). */
  aiMissing = false;
  /** AI_API_KEY_FILE is there. */
  aiKey = true;
  /** This month's budget is not used up. */
  aiBudgetLeft = true;
  /** The next POST /ai/summaries is refused with this (429 ai_daily_limit …). */
  aiRefuseNext: ApiError | null = null;
  /** GET /ai/summaries/target: false is a server before review v0.1.18 (404 without a code); an object overrides the answer. */
  aiSummaryTargetRoute = true;
  aiSummaryTargetAnswer: AiSummaryTargetOut | null = null;
  readonly aiAgents: AiAgentOut[] = [];
  readonly aiRuns = new Map<string, { run: AiRunOut; userId: string }>();
  aiUsage: AiUsageOut = { month: "2026-10", budget_usd: 30, total_cost_usd: 0, total_runs: 0, by_agent: [], by_user: [] };
  /** GET /admin/ai/providers (docs/AI.md §12); null: an older server (404). */
  aiProviders: AiProviderOut[] | null = [
    { name: "anthropic", configured: true, models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"] },
    { name: "openai", configured: false, models: ["gpt-6.1-sol", "gpt-6-luna"] },
  ];

  private aiGate(): void {
    if (this.aiMissing) throw new ApiError(404, "not_found", "Not Found");
  }

  private aiAdmin(userId: string): void {
    this.aiGate();
    if (this.users.get(userId)?.role !== "admin") throw new ApiError(403, "forbidden", "admins only");
  }

  aiStatusOut(): AiStatusOut {
    const enabled = this.aiAgents.filter((a) => a.enabled);
    const available = this.aiKey && enabled.length > 0;
    return {
      available,
      summary_available: available && this.aiBudgetLeft,
      agents: enabled.map((a) => ({ id: a.id, bot_user_id: a.bot_user_id, name: a.name, model: a.model })),
    };
  }

  /** POST /admin/ai/agents: the agent and its bot user (role bot). */
  createAiAgent(body: AiAgentCreate): AiAgentOut {
    if ([...this.users.values()].some((u) => u.username === body.username)) throw new ApiError(409, "username_taken", "taken");
    const bot = this.addUser(body.username);
    bot.role = "bot";
    bot.display_name = body.name;
    const at = now();
    const agent: AiAgentOut = {
      id: nextId(),
      bot_user_id: bot.id,
      username: body.username,
      name: body.name,
      character: body.character,
      model: body.model,
      effort: body.effort ?? "medium",
      allow_private: body.allow_private ?? false,
      enabled: body.enabled ?? true,
      created_at: at,
      updated_at: at,
    };
    this.aiAgents.push(agent);
    return agent;
  }

  /** A summary's state changes (the worker): ai.run_updated to the one who asked, unless `emit` is false (a lost event). */
  updateAiRun(runId: string, patch: Partial<AiRunOut>, options: { emit?: boolean } = {}): AiRunOut {
    const entry = this.aiRuns.get(runId)!;
    entry.run = { ...entry.run, ...patch };
    if (options.emit !== false) {
      this.emit(new Set([entry.userId]), { type: "event", id: ++this.eventId, event: "ai.run_updated", ts: now(), channel_id: null, seq: null, data: { run: { ...entry.run } } });
    }
    return entry.run;
  }

  /** The newest run someone asked for. */
  lastAiRun(): AiRunOut | undefined {
    return [...this.aiRuns.values()].pop()?.run;
  }

  /** §2.3: the conversation's first enabled bot, else the first enabled one. */
  private summaryAgent(channelId: string): AiAgentOut | undefined {
    const enabled = this.aiAgents.filter((a) => a.enabled);
    const members = this.channels.get(channelId)?.members;
    return enabled.find((a) => members?.has(a.bot_user_id)) ?? enabled[0];
  }

  private summaryTarget(userId: string, channelId: string): AiSummaryTargetOut {
    this.aiGate();
    if (!this.aiSummaryTargetRoute) throw new ApiError(404, "http_404", "Not Found");
    const record = this.channels.get(channelId);
    if (!record || !record.members.has(userId)) throw new ApiError(404, "channel_not_found", "not found");
    if (this.aiSummaryTargetAnswer) return { ...this.aiSummaryTargetAnswer };
    const agent = this.aiKey ? this.summaryAgent(channelId) : undefined;
    if (!agent) return { available: false, provider: null, model: null, agent_name: null, reason: "ai_unavailable" };
    const sent = { provider: aiProviderOf(agent.model), model: agent.model, agent_name: agent.name };
    return this.aiBudgetLeft ? { available: true, ...sent, reason: null } : { available: false, ...sent, reason: "ai_budget_exceeded" };
  }

  private createAiSummary(userId: string, body: AiSummaryCreate): AiRunOut {
    this.aiGate();
    const record = this.channels.get(body.channel_id);
    if (!record || !record.members.has(userId)) throw new ApiError(404, "channel_not_found", "not found");
    if (body.scope === "thread" && (!body.thread_id || !record.messages.some((m) => m.id === body.thread_id && !m.parent_id))) {
      throw new ApiError(400, "validation_error", "thread_id");
    }
    const status = this.aiStatusOut();
    if (!status.available) throw new ApiError(409, "ai_unavailable", "unavailable");
    if (!status.summary_available) throw new ApiError(429, "ai_budget_exceeded", "budget");
    if (this.aiRefuseNext) {
      const err = this.aiRefuseNext;
      this.aiRefuseNext = null;
      throw err;
    }
    const run: AiRunOut = {
      id: nextId(),
      kind: "summary",
      status: "pending",
      channel_id: body.channel_id,
      thread_id: body.thread_id ?? null,
      scope: body.scope,
      days: body.scope === "recent" ? (body.days ?? 1) : null,
      output: null,
      error: null,
      omitted_count: 0,
      created_at: now(),
      finished_at: null,
      provider: aiProviderOf(this.summaryAgent(body.channel_id)!.model),
      model: this.summaryAgent(body.channel_id)!.model,
    };
    this.aiRuns.set(run.id, { run, userId });
    return { ...run };
  }

  /** M70: GET /ai/ask/target exists (false: a server before M70, 404); an object overrides the answer. */
  aiAskRoute = true;
  aiAskTargetAnswer: AiAskTargetOut | null = null;
  /** Every POST /ai/ask that reached the server. */
  readonly aiAsks: AiAskCreate[] = [];

  private askTarget(userId: string, q: string, channelId: string | null): AiAskTargetOut {
    this.aiGate();
    if (!this.aiAskRoute) throw new ApiError(404, "http_404", "Not Found");
    if (channelId) {
      const record = this.channels.get(channelId);
      if (!record || !record.members.has(userId)) throw new ApiError(404, "channel_not_found", "not found");
    }
    if (this.aiAskTargetAnswer) return { ...this.aiAskTargetAnswer };
    const agent = this.aiKey ? (channelId ? this.summaryAgent(channelId) : this.aiAgents.find((a) => a.enabled)) : undefined;
    if (!agent) return { available: false, provider: null, model: null, agent_name: null, reason: "ai_unavailable" };
    const sent = { provider: aiProviderOf(agent.model), model: agent.model, agent_name: agent.name };
    void q;
    return this.aiBudgetLeft ? { available: true, ...sent, reason: null } : { available: false, ...sent, reason: "ai_budget_exceeded" };
  }

  private createAiAsk(userId: string, body: AiAskCreate): AiRunOut {
    this.aiGate();
    if (!this.aiAskRoute) throw new ApiError(404, "http_404", "Not Found");
    this.aiAsks.push({ ...body });
    const target = this.askTarget(userId, body.q, body.channel_id ?? null);
    if (!target.available) throw new ApiError(target.reason === "ai_budget_exceeded" ? 429 : 409, target.reason ?? "ai_unavailable", "refused");
    if (this.aiRefuseNext) {
      const err = this.aiRefuseNext;
      this.aiRefuseNext = null;
      throw err;
    }
    const run: AiRunOut = {
      id: nextId(),
      kind: "ask",
      status: "pending",
      channel_id: body.channel_id ?? null,
      thread_id: null,
      scope: null,
      days: null,
      output: null,
      error: null,
      omitted_count: 0,
      created_at: now(),
      finished_at: null,
      provider: target.provider,
      model: target.model,
      question: body.q,
      sources: [],
    };
    this.aiRuns.set(run.id, { run, userId });
    return { ...run };
  }

  aiApiFor(userId: string): FakeAiApi {
    const admin = (): void => this.aiAdmin(userId);
    return {
      createAiAsk: async (body) => this.createAiAsk(userId, body),
      aiAskTarget: async (q, channelId) => this.askTarget(userId, q, channelId),
      aiStatus: async () => {
        this.aiGate();
        return this.aiStatusOut();
      },
      createAiSummary: async (body) => this.createAiSummary(userId, body),
      aiSummaryTarget: async (channelId) => this.summaryTarget(userId, channelId),
      getAiRun: async (runId) => {
        this.aiGate();
        const entry = this.aiRuns.get(runId);
        if (!entry || entry.userId !== userId) throw new ApiError(404, "ai_run_not_found", "not found");
        return { ...entry.run };
      },
      aiRuns: async (kind = "summary") => {
        this.aiGate();
        return [...this.aiRuns.values()].filter((e) => e.userId === userId && e.run.kind === kind).map((e) => ({ ...e.run })).reverse().slice(0, 20);
      },
      adminAiAgents: async () => {
        admin();
        return this.aiAgents.map((a) => ({ ...a }));
      },
      adminCreateAiAgent: async (body) => {
        admin();
        return { ...this.createAiAgent(body) };
      },
      adminUpdateAiAgent: async (agentId, patch) => {
        admin();
        const agent = this.aiAgents.find((a) => a.id === agentId);
        if (!agent) throw new ApiError(404, "not_found", "not found");
        if ("username" in patch) throw new ApiError(400, "validation_error", "username");
        Object.assign(agent, patch, { updated_at: now() });
        const bot = this.users.get(agent.bot_user_id);
        if (bot && patch.name) bot.display_name = patch.name;
        return { ...agent };
      },
      adminDeleteAiAgent: async (agentId) => {
        admin();
        const index = this.aiAgents.findIndex((a) => a.id === agentId);
        if (index < 0) throw new ApiError(404, "not_found", "not found");
        const [agent] = this.aiAgents.splice(index, 1);
        for (const record of this.channels.values()) record.members.delete(agent!.bot_user_id);
      },
      adminAiUsage: async (month) => {
        admin();
        return { ...this.aiUsage, month: month ?? this.aiUsage.month };
      },
      adminAiProviders: async () => {
        admin();
        if (!this.aiProviders) throw new ApiError(404, "not_found", "Not Found");
        return this.aiProviders.map((p) => ({ ...p }));
      },
    };
  }

  connectorFor(userId: string): WsConnector {
    return async () => {
      const socket = new FakeSocket(this, userId);
      this.sockets.add(socket);
      return socket;
    };
  }
}

/** The canvas calls the screen makes through controller.api besides the engine's (SyncApi) ones. */
/** M65: the AI routes (docs/AI.md §5) as ApiClient names them. */
export interface FakeAiApi {
  aiStatus(): Promise<AiStatusOut>;
  createAiSummary(body: AiSummaryCreate): Promise<AiRunOut>;
  aiSummaryTarget(channelId: string): Promise<AiSummaryTargetOut>;
  getAiRun(runId: string): Promise<AiRunOut>;
  aiRuns(kind?: "summary" | "mention" | "ask"): Promise<AiRunOut[]>;
  createAiAsk(body: AiAskCreate): Promise<AiRunOut>;
  aiAskTarget(q: string, channelId: string | null): Promise<AiAskTargetOut>;
  adminAiAgents(): Promise<AiAgentOut[]>;
  adminCreateAiAgent(body: AiAgentCreate): Promise<AiAgentOut>;
  adminUpdateAiAgent(agentId: string, patch: AiAgentUpdate): Promise<AiAgentOut>;
  adminDeleteAiAgent(agentId: string): Promise<void>;
  adminAiUsage(month?: string): Promise<AiUsageOut>;
  adminAiProviders(): Promise<AiProviderOut[]>;
}

export interface FakeCanvasApi {
  createCanvas(channelId: string, body: CanvasCreate): Promise<CanvasOut>;
  updateCanvas(canvasId: string, patch: CanvasUpdate): Promise<CanvasOut>;
  deleteCanvas(canvasId: string): Promise<void>;
  restoreCanvas(canvasId: string): Promise<CanvasOut>;
  canvasTemplates(): Promise<CanvasTemplateOut[]>;
  // M44
  canvasRevisions(canvasId: string): Promise<CanvasRevisionPage>;
  canvasRevision(canvasId: string, revisionId: string): Promise<CanvasRevisionOut>;
  restoreCanvasRevision(canvasId: string, revisionId: string, clientSaveId: string): Promise<CanvasOut>;
  labelCanvasRevision(canvasId: string, revisionId: string, label: string | null): Promise<CanvasRevisionMeta>;
  eraseCanvasRevision(canvasId: string, revisionId: string): Promise<CanvasRevisionMeta>;
  shareCanvas(canvasId: string): Promise<CanvasOut>;
  myCanvases(): Promise<{ items: CanvasMeta[]; next_cursor: string | null }>;
  searchCanvases(query: { q: string; channel_id?: string | null; limit?: number; offset?: number }): Promise<CanvasSearchOut>;
  uploadAttachment(file: Blob, filename: string): Promise<AttachmentOut>;
  getAttachment(attachmentId: string): Promise<AttachmentOut>;
  fetchBlob(path: string): Promise<Blob>;
  adminCanvasTemplates(): Promise<CanvasTemplateOut[]>;
  adminCreateCanvasTemplate(body: CanvasTemplateCreate): Promise<CanvasTemplateOut>;
  adminUpdateCanvasTemplate(templateId: string, patch: CanvasTemplateUpdate): Promise<CanvasTemplateOut>;
  adminDeleteCanvasTemplate(templateId: string): Promise<void>;
}

const FAKE_TASK = /^([ \t]*[-*] \[)([ xX])(\](?: .*)?)$/;

function countTasks(body: string): { task_total: number; task_done: number } {
  let total = 0;
  let done = 0;
  for (const line of body.split("\n")) {
    const m = FAKE_TASK.exec(line);
    if (m) {
      total += 1;
      if (m[2] !== " ") done += 1;
    }
  }
  return { task_total: total, task_done: done };
}

function onlyTasksToggled(before: string, after: string): boolean {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) return false;
  return a.every((line, i) => {
    const other = b[i]!;
    if (line === other) return true;
    const ma = FAKE_TASK.exec(line);
    const mb = FAKE_TASK.exec(other);
    return !!ma && !!mb && ma[1] === mb[1] && ma[3] === mb[3];
  });
}

/** base index → other index of a longest common subsequence of lines (monotonic). */
function lineMatches(a: string[], b: string[]): Map<number, number> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const matches = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) matches.set(i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return matches;
}

/**
 * The fake's merge (diff3 on lines): a region only one side changed takes that side, insertions at the same place keep
 * both (theirs, then ours), a line both changed is a conflict. The real one (server/app/modules/canvases/merge.py) also
 * merges words within a line.
 */
export function merge3(base: string, ours: string, theirs: string, resolve: CanvasOnConflict): { text: string; conflicts: CanvasConflict[] } {
  if (ours === base) return { text: theirs, conflicts: [] };
  if (theirs === base || ours === theirs) return { text: ours, conflicts: [] };
  const B = base.split("\n");
  const O = ours.split("\n");
  const T = theirs.split("\n");
  const mo = lineMatches(B, O);
  const mt = lineMatches(B, T);
  const conflicts: CanvasConflict[] = [];
  const out: string[] = [];
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, k) => line === y[k]);
  const region = (b: string[], o: string[], t: string[], oLine: number, tLine: number) => {
    if (same(o, b)) out.push(...t);
    else if (same(t, b) || same(o, t)) out.push(...o);
    else if (b.length === 0) out.push(...t, ...o);
    else if (resolve === "ours") out.push(...o);
    else if (resolve === "theirs") out.push(...t);
    else if (resolve === "both") out.push(...t, ...o.map((l) => `> ${l}`));
    else {
      conflicts.push({ base: b.join("\n"), ours: o.join("\n"), theirs: t.join("\n"), ours_line: oLine, theirs_line: tLine });
      out.push(...t);
    }
  };
  let iB = 0;
  let iO = 0;
  let iT = 0;
  for (;;) {
    let j = iB;
    while (j < B.length && !(mo.has(j) && mt.has(j))) j++;
    if (j >= B.length) {
      region(B.slice(iB), O.slice(iO), T.slice(iT), iO, iT);
      break;
    }
    const oj = mo.get(j)!;
    const tj = mt.get(j)!;
    if (j > iB || oj > iO || tj > iT) region(B.slice(iB, j), O.slice(iO, oj), T.slice(iT, tj), iO, iT);
    out.push(B[j]!);
    iB = j + 1;
    iO = oj + 1;
    iT = tj + 1;
  }
  return { text: out.join("\n"), conflicts };
}

/** The SQLite store's stand-in (src/platform/sqlite.ts): rows kept as JSON text, like its tables. */
export class MemoryPersistence implements Persistence {
  readonly meta = new Map<string, string>();
  readonly users = new Map<string, string>();
  readonly channels = new Map<string, string>();
  readonly messages = new Map<string, { channelId: string; seq: number | null; json: string }>();
  readonly outbox = new Map<string, string>();

  async loadAll(): Promise<Snapshot> {
    return {
      meta: Object.fromEntries(this.meta),
      users: [...this.users.values()].map((json) => JSON.parse(json) as UserPublic),
      channels: [...this.channels.values()].map((json) => JSON.parse(json) as ChannelState),
      messages: [...this.messages.values()].map((row) => JSON.parse(row.json) as MessageState),
      outbox: [...this.outbox.values()].map((json) => JSON.parse(json) as OutboxItem),
    };
  }

  async saveMeta(key: string, value: string | null): Promise<void> {
    if (value === null) this.meta.delete(key);
    else this.meta.set(key, value);
  }

  async saveUser(user: UserPublic): Promise<void> {
    this.users.set(user.id, JSON.stringify(user));
  }

  async saveChannel(channel: ChannelState): Promise<void> {
    this.channels.set(channel.id, JSON.stringify(channel));
  }

  async deleteChannel(channelId: string): Promise<void> {
    this.channels.delete(channelId);
  }

  async saveMessage(message: MessageState): Promise<void> {
    this.messages.set(message.id, { channelId: message.channel_id, seq: message.seq, json: JSON.stringify(message) });
  }

  async deleteMessage(id: string): Promise<void> {
    this.messages.delete(id);
  }

  async clearMessages(channelId: string): Promise<void> {
    for (const [id, row] of this.messages) if (row.channelId === channelId) this.messages.delete(id);
  }

  async deleteOlderMessages(channelId: string, beforeSeq: number): Promise<void> {
    for (const [id, row] of this.messages) if (row.channelId === channelId && row.seq !== null && row.seq < beforeSeq) this.messages.delete(id);
  }

  async saveOutbox(item: OutboxItem): Promise<void> {
    this.outbox.set(item.client_msg_id, JSON.stringify(item));
  }

  async deleteOutbox(clientMsgId: string): Promise<void> {
    this.outbox.delete(clientMsgId);
  }

  async clearAll(): Promise<void> {
    for (const table of [this.meta, this.users, this.channels, this.messages, this.outbox]) table.clear();
  }
}
