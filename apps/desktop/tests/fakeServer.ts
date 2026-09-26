/**
 * In-process model of the server side of SYNC_PROTOCOL.md: channel sequences, idempotent
 * posting, history / delta cursors, bootstrap and WebSocket event fan-out. It exists so the
 * engine tests and the shared contract fixtures run without a backend.
 */
import { ApiError } from "../src/api/errors";
import type { BootstrapOut, ChannelOut, ChannelReadStateOut, DeltaOut, HistoryOut, MessageOut, ParentThread, ReadStateOut, ScheduledOut, ThreadFilter, ThreadListOut, ThreadState, ThreadSummary, UserMe, UserPublic } from "../src/api/types";
import type { SyncApi, WsConnector, WsLike } from "../src/sync/engine";
import type { EventFrame } from "../src/sync/types";

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

class FakeSocket implements WsLike {
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((code: number) => void) | null = null;
  dropNext = 0;
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
      this.deliver({ type: "pong", server_time: now() });
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
    if (this.closed) return;
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
    const unread = record.messages.filter((m) => m.seq > position && !m.deleted && !m.parent_id);
    const mentions = unread.filter((m) => m.mention_all === true || (m.mentioned_user_ids ?? []).includes(userId)).length;
    return { last_read_seq: position, unread_count: unread.length, mention_count: mentions };
  }

  // --- threads (THREADS.md §2) ---------------------------------------------------------------

  /** "parent:user" → follow row; insertion order doubles as created_at. */
  readonly threadFollows = new Map<string, { parentId: string; userId: string; following: boolean; lastReadSeq: number }>();

  private followers(parentId: string): string[] {
    return [...this.threadFollows.values()].filter((f) => f.parentId === parentId && f.following).map((f) => f.userId);
  }

  private autoFollow(parentId: string, userIds: string[]): void {
    for (const userId of userIds) {
      const key = `${parentId}:${userId}`;
      if (!this.threadFollows.has(key)) this.threadFollows.set(key, { parentId, userId, following: true, lastReadSeq: 0 });
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

  threads(userId: string, filter: ThreadFilter, cursor: string | null, limit: number): ThreadListOut {
    let items = [...this.threadFollows.values()]
      .filter((f) => f.userId === userId && f.following)
      .map((f) => ({ parent: this.threadParent(f.parentId).parent, state: this.threadState(userId, f.parentId) }))
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
    const row = this.threadFollows.get(key) ?? { parentId: parent.id, userId, following: true, lastReadSeq: 0 };
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
    const row = this.threadFollows.get(key) ?? { parentId: parent.id, userId, following, lastReadSeq: 0 };
    const changed = !this.threadFollows.has(key) || row.following !== following;
    row.following = following;
    this.threadFollows.set(key, row);
    if (changed) this.emitThread(parent.id, [userId], "follow");
    return this.threadState(userId, parent.id);
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

  private requireMember(channelId: string, userId: string): ChannelRecord {
    const record = this.record(channelId);
    if (!record.members.has(userId)) throw new ApiError(403, "not_a_member", "Not a member");
    return record;
  }

  /** Server-side post (used by fixtures for "other users" and by the api for the client). */
  post(channelId: string, senderId: string, body: string, clientMsgId = nextId(), parentId: string | null = null, attachmentIds: string[] = []): { message: MessageOut; created: boolean } {
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
      channel_id: channelId,
      sender_id: senderId,
      parent_id: parentId,
      seq,
      updated_seq: seq,
      client_msg_id: clientMsgId,
      type: "user",
      body,
      mentioned_user_ids: mentionedIds(body),
      mention_all: MENTION_ALL.test(body),
      reactions: [],
      attachments: attachmentIds.map((id) => ({ id, filename: `file-${id}`, content_type: "application/octet-stream", size_bytes: 1, width: null, height: null, has_thumbnail: false, status: "attached", created_at: now() })),
      reply_count: 0,
      last_reply_at: null,
      created_at: now(),
      edited_at: null,
      deleted: false,
      pinned_at: null,
      pinned_by: null,
    };
    record.messages.push(message);
    record.channel.last_message_at = message.created_at;
    this.byClientKey.set(senderId + ":" + clientMsgId, message);
    let parentThread: ParentThread | null = null;
    if (parentIndex >= 0) {
      const old = record.messages[parentIndex]!;
      const parent: MessageOut = { ...old, reply_count: old.reply_count + 1, last_reply_at: message.created_at, updated_seq: seq };
      record.messages[parentIndex] = parent;
      // THREADS.md §2: auto-follow, the replier has read their own reply, followers are the push targets.
      this.autoFollow(parent.id, [parent.sender_id, senderId, ...(parent.mentioned_user_ids ?? []), ...message.mentioned_user_ids]);
      const own = this.threadFollows.get(`${parent.id}:${senderId}`)!;
      own.lastReadSeq = Math.max(own.lastReadSeq, seq);
      parentThread = { id: parent.id, reply_count: parent.reply_count, last_reply_at: parent.last_reply_at ?? null, updated_seq: seq, participant_ids: this.followers(parent.id) };
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
    this.markRead(senderId, channelId, seq); // the sender has read their own message (§10)
    if (parentThread) this.emitThread(parentThread.id, this.followers(parentThread.id), "reply");
    return { message, created: true };
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

  setFavorite(userId: string, channelId: string, on: boolean): void {
    const list = this.favorites.get(userId) ?? [];
    if (on ? list.includes(channelId) : !list.includes(channelId)) return;
    this.favorites.set(userId, on ? [...list, channelId] : list.filter((id) => id !== channelId));
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "favorite.updated", ts: now(), channel_id: channelId, seq: null, data: { channel_id: channelId, favorite: on } });
  }

  /** POST /channels/read-all: every membership read to its end; read.updated per moved channel. */
  readAll(userId: string): ChannelReadStateOut[] {
    return [...this.channels.values()]
      .filter((r) => r.members.has(userId))
      .map((r) => ({ channel_id: r.channel.id, ...this.markRead(userId, r.channel.id, r.channel.last_seq) }));
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

  /** What the real server emits after a join / add: member_added to the channel, channel.created to the user. */
  emitMembership(channelId: string, userId: string): void {
    const record = this.record(channelId);
    const memberIds = [...record.members];
    this.emit(record.members, { type: "event", id: ++this.eventId, event: "channel.member_added", ts: now(), channel_id: channelId, seq: null, data: { channel_id: channelId, user_id: userId } });
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "channel.created", ts: now(), channel_id: channelId, seq: null, data: { channel: { ...record.channel, member_count: memberIds.length, membership: null }, member_ids: memberIds } });
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

  apiFor(userId: string): SyncApi & { failNext: (error: Error) => void } {
    let pendingFailure: Error | null = null;
    const maybeFail = (): void => {
      if (pendingFailure) {
        const err = pendingFailure;
        pendingFailure = null;
        throw err;
      }
    };
    return {
      failNext: (error: Error) => {
        pendingFailure = error;
      },
      bootstrap: async (): Promise<BootstrapOut> => {
        maybeFail();
        const user = this.users.get(userId)!;
        const me: UserMe = { ...user, email: null, must_change_password: false };
        const channels = [...this.channels.values()]
          .filter((r) => r.members.has(userId))
          .map((r) => ({
            ...r.channel,
            member_count: r.members.size,
            membership: { role: r.channel.created_by === userId ? "owner" : "member", joined_at: now() },
            read_state: this.readState(userId, r.channel.id),
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
        };
      },
      history: async (channelId, beforeSeq, limit): Promise<HistoryOut> => {
        maybeFail();
        const record = this.requireMember(channelId, userId);
        const channelLastSeq = record.channel.last_seq; // read BEFORE the rows (§4.3)
        let rows = record.messages.filter((m) => !m.deleted && !m.parent_id);
        if (beforeSeq !== null) rows = rows.filter((m) => m.seq < beforeSeq);
        rows = rows.sort((a, b) => b.seq - a.seq);
        return { channel_last_seq: channelLastSeq, messages: rows.slice(0, limit), has_more: rows.length > limit };
      },
      delta: async (channelId, sinceSeq, limit): Promise<DeltaOut> => {
        maybeFail();
        const record = this.requireMember(channelId, userId);
        const channelLastSeq = record.channel.last_seq;
        const rows = record.messages.filter((m) => m.updated_seq > sinceSeq).sort((a, b) => a.updated_seq - b.updated_seq);
        const page = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        return { messages: page, next_since_seq: hasMore ? page[page.length - 1]!.updated_seq : Math.max(channelLastSeq, sinceSeq), has_more: hasMore };
      },
      postMessage: async (channelId, clientMsgId, body, parentId = null, attachmentIds = []) => {
        maybeFail();
        return this.post(channelId, userId, body, clientMsgId, parentId, attachmentIds);
      },
      replies: async (messageId): Promise<MessageOut[]> => {
        maybeFail();
        const record = [...this.channels.values()].find((r) => r.messages.some((m) => m.id === messageId));
        if (!record) return [];
        this.requireMember(record.channel.id, userId);
        return record.messages.filter((m) => m.parent_id === messageId && !m.deleted).sort((a, b) => a.seq - b.seq);
      },
      listScheduled: async (): Promise<ScheduledOut[]> => {
        maybeFail();
        return this.scheduled.get(userId) ?? [];
      },
      readAll: async (): Promise<ChannelReadStateOut[]> => {
        maybeFail();
        return this.readAll(userId);
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
      publicChannels: async (): Promise<ChannelOut[]> =>
        [...this.channels.values()]
          .filter((r) => r.channel.type === "public" && !r.members.has(userId))
          .map((r) => ({ ...r.channel, member_count: r.members.size, membership: null })),
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
