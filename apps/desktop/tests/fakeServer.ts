/**
 * In-process model of the server side of SYNC_PROTOCOL.md: channel sequences, idempotent
 * posting, history / delta cursors, bootstrap and WebSocket event fan-out. It exists so the
 * engine tests and the shared contract fixtures run without a backend.
 */
import { ApiError } from "../src/api/errors";
import type { BootstrapOut, ChannelOut, DeltaOut, HistoryOut, MessageOut, UserMe, UserPublic } from "../src/api/types";
import type { SyncApi, WsConnector, WsLike } from "../src/sync/engine";
import type { EventFrame } from "../src/sync/types";

let counter = 0;
const nextId = (): string => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
const now = (): string => new Date().toISOString();

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
    return channel;
  }

  join(channelId: string, userId: string): void {
    this.record(channelId).members.add(userId);
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
  post(channelId: string, senderId: string, body: string, clientMsgId = nextId()): { message: MessageOut; created: boolean } {
    const record = this.requireMember(channelId, senderId);
    const existing = this.byClientKey.get(senderId + ":" + clientMsgId);
    if (existing) {
      if (existing.channel_id !== channelId) throw new ApiError(409, "idempotency_conflict", "conflict");
      return { message: existing, created: false };
    }
    const seq = ++record.channel.last_seq;
    const message: MessageOut = {
      id: nextId(),
      channel_id: channelId,
      sender_id: senderId,
      seq,
      updated_seq: seq,
      client_msg_id: clientMsgId,
      body,
      created_at: now(),
      edited_at: null,
      deleted: false,
    };
    record.messages.push(message);
    record.channel.last_message_at = message.created_at;
    this.byClientKey.set(senderId + ":" + clientMsgId, message);
    this.emit(record.members, {
      type: "event",
      id: ++this.eventId,
      event: "message.created",
      ts: now(),
      channel_id: channelId,
      seq,
      data: { message },
    });
    return { message, created: true };
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
          .map((r) => ({ ...r.channel, membership: { role: r.channel.created_by === userId ? "owner" : "member", joined_at: now() } }));
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
        let rows = record.messages.filter((m) => !m.deleted);
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
      postMessage: async (channelId, clientMsgId, body) => {
        maybeFail();
        return this.post(channelId, userId, body, clientMsgId);
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
