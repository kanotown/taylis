/**
 * In-process model of the server side of SYNC_PROTOCOL.md: channel sequences, idempotent
 * posting, history / delta cursors, bootstrap and WebSocket event fan-out. It exists so the
 * engine tests and the shared contract fixtures run without a backend.
 */
import { ApiError } from "../src/api/errors";
import type { BootstrapOut, ChannelOut, DeltaOut, HistoryOut, MessageOut, ParentThread, ReadStateOut, UserMe, UserPublic } from "../src/api/types";
import type { SyncApi, WsConnector, WsLike } from "../src/sync/engine";
import type { EventFrame } from "../src/sync/types";

let counter = 0;
const nextId = (): string => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
const now = (): string => new Date().toISOString();
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
    const frame = JSON.parse(data) as { type: string; token?: string };
    if (frame.type === "auth") {
      this.deliver({ type: "hello", session_id: "s-" + this.userId, server_time: now(), heartbeat_interval_sec: 30 });
    } else if (frame.type === "ping") {
      this.deliver({ type: "pong", server_time: now() });
    }
  }

  close(): void {
    this.closeRemote(1000);
  }

  closeRemote(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.server.sockets.delete(this);
    this.closeHandler?.(code);
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

  /** PUT /channels/{id}/read: clamp, never regress, read.updated to the user's own sockets on change. */
  markRead(userId: string, channelId: string, seq: number): ReadStateOut {
    const record = this.requireMember(channelId, userId);
    const key = `${userId}:${channelId}`;
    const target = Math.min(seq, record.channel.last_seq);
    if (target > (this.readPositions.get(key) ?? 0)) {
      this.readPositions.set(key, target);
      const state = this.readState(userId, channelId);
      this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "read.updated", ts: now(), channel_id: channelId, seq: null, data: { channel_id: channelId, ...state } });
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
  post(channelId: string, senderId: string, body: string, clientMsgId = nextId(), parentId: string | null = null): { message: MessageOut; created: boolean } {
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
      reply_count: 0,
      last_reply_at: null,
      created_at: now(),
      edited_at: null,
      deleted: false,
    };
    record.messages.push(message);
    record.channel.last_message_at = message.created_at;
    this.byClientKey.set(senderId + ":" + clientMsgId, message);
    let parentThread: ParentThread | null = null;
    if (parentIndex >= 0) {
      const old = record.messages[parentIndex]!;
      const parent: MessageOut = { ...old, reply_count: old.reply_count + 1, last_reply_at: message.created_at, updated_seq: seq };
      record.messages[parentIndex] = parent;
      const participants = [parent.sender_id];
      for (const reply of record.messages) if (reply.parent_id === parent.id && !reply.deleted && !participants.includes(reply.sender_id)) participants.push(reply.sender_id);
      parentThread = { id: parent.id, reply_count: parent.reply_count, last_reply_at: parent.last_reply_at ?? null, updated_seq: seq, participant_ids: participants };
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
    const tombstone: MessageOut = { ...message, body: "", deleted: true, updated_seq: seq, reactions: [], mentioned_user_ids: [], mention_all: false };
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
    this.emit(new Set([userId]), { type: "event", id: ++this.eventId, event: "channel.created", ts: now(), channel_id: channelId, seq: null, data: { channel: { ...record.channel, membership: null }, member_ids: memberIds } });
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
            membership: { role: r.channel.created_by === userId ? "owner" : "member", joined_at: now() },
            read_state: this.readState(userId, r.channel.id),
          }));
        return {
          server_time: now(),
          me,
          users: [...this.users.values()],
          channels,
          limits: { max_message_length: 20000, max_attachment_bytes: 1, max_attachments_per_message: 10 },
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
      postMessage: async (channelId, clientMsgId, body, parentId = null) => {
        maybeFail();
        return this.post(channelId, userId, body, clientMsgId, parentId);
      },
      replies: async (messageId): Promise<MessageOut[]> => {
        maybeFail();
        const record = [...this.channels.values()].find((r) => r.messages.some((m) => m.id === messageId));
        if (!record) return [];
        this.requireMember(record.channel.id, userId);
        return record.messages.filter((m) => m.parent_id === messageId && !m.deleted).sort((a, b) => a.seq - b.seq);
      },
      markRead: async (channelId, lastReadSeq): Promise<ReadStateOut> => {
        maybeFail();
        return this.markRead(userId, channelId, lastReadSeq);
      },
      publicChannels: async (): Promise<ChannelOut[]> =>
        [...this.channels.values()]
          .filter((r) => r.channel.type === "public" && !r.members.has(userId))
          .map((r) => ({ ...r.channel, membership: null })),
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
