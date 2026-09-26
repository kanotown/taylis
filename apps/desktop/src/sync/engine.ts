/**
 * SyncEngine: the client side of SYNC_PROTOCOL.md (§7 start / catch_up / live, §8 merge,
 * §9 optimistic send, §5 heartbeat and reconnect). Transport is injected so the same code runs
 * in Tauri (WebSocket API) and in tests (fake server).
 */
import { ApiError, isRetryable } from "../api/errors";
import type { BootstrapOut, ChannelOut, DeltaOut, HistoryOut, MessageOut, UserPublic } from "../api/types";
import type { Store } from "./store";
import type { ChannelState, EventFrame, MessageState, OutboxItem, ServerFrame } from "./types";
import { LOCAL_PREFIX } from "./types";

export interface SyncApi {
  bootstrap(): Promise<BootstrapOut>;
  history(channelId: string, beforeSeq: number | null, limit: number): Promise<HistoryOut>;
  delta(channelId: string, sinceSeq: number, limit: number): Promise<DeltaOut>;
  postMessage(channelId: string, clientMsgId: string, body: string): Promise<{ message: MessageOut; created: boolean }>;
  /** Public channels the user has not joined (for the browse list). Optional. */
  publicChannels?(): Promise<ChannelOut[]>;
}

export interface WsLike {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number) => void): void;
}

export type WsConnector = (token: string) => Promise<WsLike>;

export type EngineStatus = "idle" | "connecting" | "online" | "offline" | "signed_out";

export interface EngineDeps {
  api: SyncApi;
  connect: WsConnector;
  store: Store;
  getAccessToken: () => string | null;
  onSignedOut?: () => void;
  onNotify?: (message: MessageOut, channel: ChannelState) => void;
  isActive?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  newId?: () => string;
  now?: () => string;
}

export interface EngineOptions {
  pageSize?: number;
  gapLimit?: number;
  deltaLimit?: number;
  helloTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export class SyncEngine {
  status: EngineStatus = "idle";
  currentChannelId: string | null = null;
  readonly stats = { catchUps: 0, reloads: 0, reconnects: 0 };
  private ws: WsLike | null = null;
  private chain: Promise<void> = Promise.resolve();
  private helloResolve: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private flushing = false;
  private reconnectAttempt = 0;
  private readonly listeners = new Set<() => void>();
  private readonly opts: Required<EngineOptions>;

  constructor(
    private readonly deps: EngineDeps,
    options: EngineOptions = {},
  ) {
    this.opts = {
      pageSize: options.pageSize ?? 50,
      gapLimit: options.gapLimit ?? 5000,
      deltaLimit: options.deltaLimit ?? 200,
      helloTimeoutMs: options.helloTimeoutMs ?? 10_000,
      reconnectMinMs: options.reconnectMinMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
    };
  }

  get store(): Store {
    return this.deps.store;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  /** Runs `work` after everything already queued: frames and sync steps never interleave. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work, work);
    this.chain = next.catch((err: unknown) => console.error("sync step failed", err));
    return next;
  }

  /** Resolves once all queued frames / steps have been processed (tests and UI hooks). */
  idle(): Promise<void> {
    return this.chain;
  }

  // --- §7.2 start, §7.5 reconnect ------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.setStatus("idle");
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const token = this.deps.getAccessToken();
    if (!token) {
      this.signOut();
      return;
    }
    this.setStatus("connecting");
    let ws: WsLike;
    try {
      ws = await this.deps.connect(token);
    } catch {
      await this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const hello = new Promise<void>((resolve) => {
      this.helloResolve = resolve;
    });
    ws.onMessage((raw) => this.onRaw(raw));
    ws.onClose((code) => void this.handleClose(ws, code));
    ws.send(JSON.stringify({ type: "auth", token }));

    await this.enqueue(async () => {
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), this.opts.helloTimeoutMs),
      );
      if ((await Promise.race([hello, timeout])) === "timeout") {
        ws.close();
        throw new Error("hello timeout");
      }
      // Frames that arrive from here on are queued behind this step (= buffered, §7.2).
      const bootstrap = await this.deps.api.bootstrap();
      this.applyBootstrap(bootstrap);
      await this.loadBrowsableChannels();
      if (this.currentChannelId) await this.catchUp(this.currentChannelId);
      this.reconnectAttempt = 0;
      this.setStatus("online");
    }).catch(async (err: unknown) => {
      if (err instanceof ApiError && err.isAuth) {
        this.signOut();
        return;
      }
      ws.close();
      await this.scheduleReconnect();
    });
    if (this.status === "online") void this.flushOutbox();
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.stopped || this.status === "signed_out") return;
    this.setStatus("offline");
    this.reconnectAttempt += 1;
    this.stats.reconnects += 1;
    const base = Math.min(this.opts.reconnectMinMs * 2 ** (this.reconnectAttempt - 1), this.opts.reconnectMaxMs);
    const jitter = 0.5 + (this.deps.random ?? Math.random)();
    await (this.deps.sleep ?? defaultSleep)(Math.round(base * jitter));
    await this.connect();
  }

  private async handleClose(ws: WsLike, code: number): Promise<void> {
    if (this.ws !== ws) return; // an older socket
    this.ws = null;
    this.clearTimers();
    if (code === 4003 || code === 4001) {
      this.signOut();
      return;
    }
    if (!this.stopped) await this.scheduleReconnect();
  }

  private signOut(): void {
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.setStatus("signed_out");
    this.deps.onSignedOut?.();
  }

  /** The app calls this after a successful refresh / network change to skip the backoff. */
  reconnectNow(): void {
    if (this.status === "offline" && !this.ws) void this.connect();
  }

  // --- frames ---------------------------------------------------------------------------

  private onRaw(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    if (frame.type === "hello") {
      this.helloResolve?.();
      this.helloResolve = null;
      this.startHeartbeat(frame.heartbeat_interval_sec * 1000);
      return;
    }
    if (frame.type === "pong") {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      return;
    }
    if (frame.type === "event") void this.enqueue(() => this.applyEvent(frame));
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearTimers();
    const tick = (): void => {
      const ws = this.ws;
      if (!ws) return;
      ws.send(JSON.stringify({ type: "ping", active: this.deps.isActive?.() ?? true }));
      this.pongTimer = setTimeout(() => ws.close(), intervalMs * 2);
      this.heartbeat = setTimeout(tick, intervalMs);
    };
    this.heartbeat = setTimeout(tick, intervalMs);
  }

  private clearTimers(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeat = null;
    this.pongTimer = null;
  }

  private applyBootstrap(bootstrap: BootstrapOut): void {
    const store = this.deps.store;
    store.setMe(bootstrap.me);
    for (const user of bootstrap.users) store.upsertUser(user);
    const seen = new Set<string>();
    for (const channel of bootstrap.channels) {
      seen.add(channel.id);
      store.upsertChannel(channel, { isMember: true });
    }
    for (const channel of [...store.channels.values()]) {
      if (channel.isMember && !seen.has(channel.id)) store.removeChannel(channel.id); // no longer a member
    }
  }

  /** Public channels I am not a member of; bootstrap only lists my own channels. */
  async loadBrowsableChannels(): Promise<void> {
    if (!this.deps.api.publicChannels) return;
    try {
      const store = this.deps.store;
      const listed = await this.deps.api.publicChannels();
      const listedIds = new Set(listed.map((c) => c.id));
      for (const channel of listed) {
        if (!store.getChannel(channel.id)) store.upsertChannel(channel, { isMember: false });
      }
      for (const channel of [...store.channels.values()]) {
        if (!channel.isMember && !listedIds.has(channel.id)) store.removeChannel(channel.id);
      }
    } catch (err) {
      console.warn("could not load public channels", err);
    }
  }

  private async applyEvent(frame: EventFrame): Promise<void> {
    const store = this.deps.store;
    switch (frame.event) {
      case "message.created":
      case "message.updated":
      case "message.deleted":
        await this.applyTimelineEvent(frame);
        return;
      case "channel.created":
      case "channel.updated": {
        const data = frame.data as { channel: ChannelOut; member_ids: string[] };
        const isMember = store.me !== null && data.member_ids.includes(store.me.id);
        if (isMember || data.channel.type === "public") store.upsertChannel(data.channel, { isMember });
        return;
      }
      case "channel.archived": {
        const data = frame.data as { channel_id: string };
        store.updateChannel(data.channel_id, { archived: true });
        return;
      }
      case "channel.member_removed": {
        const data = frame.data as { channel_id: string; user_id: string };
        if (store.me && data.user_id === store.me.id) store.removeChannel(data.channel_id);
        return;
      }
      case "user.created":
      case "user.updated":
      case "user.deactivated": {
        const data = frame.data as { user: UserPublic };
        store.upsertUser(data.user);
        return;
      }
      case "session.revoked":
        this.signOut();
        return;
      default:
        return;
    }
  }

  // --- §7.4 live timeline events ---------------------------------------------------------

  private async applyTimelineEvent(frame: EventFrame): Promise<void> {
    const store = this.deps.store;
    if (!frame.channel_id || frame.seq === null) return;
    const channel = store.getChannel(frame.channel_id);
    if (!channel) return;
    const seq = frame.seq;
    const message = frame.data["message"] as MessageOut;
    const isNew = frame.event === "message.created";

    if (channel.syncedSeq === null) {
      store.updateChannel(channel.id, { lastSeq: Math.max(channel.lastSeq, seq) });
      if (isNew) this.maybeNotify(message, channel);
      return;
    }
    if (seq === channel.syncedSeq + 1) {
      store.upsertMessage(message);
      store.updateChannel(channel.id, { syncedSeq: seq, lastSeq: Math.max(channel.lastSeq, seq) });
      if (isNew) this.maybeNotify(message, channel);
      return;
    }
    if (seq > channel.syncedSeq + 1) {
      store.updateChannel(channel.id, { lastSeq: Math.max(channel.lastSeq, seq) });
      await this.catchUp(channel.id);
      if (isNew) this.maybeNotify(message, channel);
    }
    // seq <= syncedSeq: already applied.
  }

  private maybeNotify(message: MessageOut, channel: ChannelState): void {
    const me = this.deps.store.me;
    if (!me || message.sender_id === me.id) return;
    if (channel.type !== "dm" && channel.type !== "group_dm") return; // mentions arrive in M8a
    if (this.deps.isActive?.() && this.currentChannelId === channel.id) return;
    this.deps.onNotify?.(message, channel);
  }

  // --- §7.3 catch_up ----------------------------------------------------------------------

  openChannel(channelId: string): Promise<void> {
    this.currentChannelId = channelId;
    return this.enqueue(async () => {
      const channel = this.deps.store.getChannel(channelId);
      if (!channel) return;
      if (channel.syncedSeq === null || channel.syncedSeq < channel.lastSeq) await this.catchUp(channelId);
      this.markSeen(channelId);
    });
  }

  markSeen(channelId: string): void {
    const channel = this.deps.store.getChannel(channelId);
    if (channel && channel.seenSeq < channel.lastSeq) this.deps.store.updateChannel(channelId, { seenSeq: channel.lastSeq });
  }

  async catchUp(channelId: string): Promise<void> {
    const store = this.deps.store;
    this.stats.catchUps += 1;
    let channel = store.getChannel(channelId);
    if (!channel) return;
    if (channel.syncedSeq !== null && channel.lastSeq - channel.syncedSeq > this.opts.gapLimit) {
      store.clearMessages(channelId);
      channel = store.updateChannel(channelId, { syncedSeq: null, hasOlder: true }) ?? channel;
      this.stats.reloads += 1;
    }
    if (channel.syncedSeq === null) {
      const page = await this.deps.api.history(channelId, null, this.opts.pageSize);
      for (const message of page.messages) store.upsertMessage(message);
      store.updateChannel(channelId, {
        syncedSeq: page.channel_last_seq,
        lastSeq: Math.max(channel.lastSeq, page.channel_last_seq),
        hasOlder: page.has_more,
      });
      return;
    }
    let since = channel.syncedSeq;
    for (;;) {
      const delta = await this.deps.api.delta(channelId, since, this.opts.deltaLimit);
      for (const message of delta.messages) store.upsertMessage(message);
      since = delta.next_since_seq;
      const current = store.getChannel(channelId);
      store.updateChannel(channelId, { syncedSeq: since, lastSeq: Math.max(current?.lastSeq ?? 0, since) });
      if (!delta.has_more) return;
    }
  }

  /** Scroll-up pagination: older messages by seq cursor. */
  loadOlder(channelId: string): Promise<void> {
    return this.enqueue(async () => {
      const store = this.deps.store;
      const channel = store.getChannel(channelId);
      if (!channel || !channel.hasOlder) return;
      const confirmed = store.messages(channelId).filter((m) => m.seq !== null);
      const oldest = confirmed[0]?.seq ?? null;
      const page = await this.deps.api.history(channelId, oldest, this.opts.pageSize);
      for (const message of page.messages) store.upsertMessage(message);
      store.updateChannel(channelId, { hasOlder: page.has_more });
    });
  }

  // --- §9 optimistic send ---------------------------------------------------------------

  send(channelId: string, body: string, clientMsgId?: string): Promise<void> {
    clientMsgId = clientMsgId ?? (this.deps.newId ?? defaultId)();
    const createdAt = (this.deps.now ?? (() => new Date().toISOString()))();
    const me = this.deps.store.me;
    const item: OutboxItem = { client_msg_id: clientMsgId, channel_id: channelId, body, created_at: createdAt };
    this.deps.store.addOutbox(item);
    this.deps.store.putPlaceholder({
      id: LOCAL_PREFIX + clientMsgId,
      channel_id: channelId,
      sender_id: me?.id ?? "",
      seq: null,
      updated_seq: -1,
      client_msg_id: clientMsgId,
      body,
      created_at: createdAt,
      edited_at: null,
      deleted: false,
      pending: true,
    });
    return this.flushOutbox();
  }

  retryFailed(): Promise<void> {
    for (const item of this.deps.store.outbox) {
      if (item.failed) {
        delete item.failed;
        const placeholder = this.deps.store.getMessage(item.channel_id, LOCAL_PREFIX + item.client_msg_id);
        if (placeholder) placeholder.failed = false;
      }
    }
    return this.flushOutbox();
  }

  discardFailed(clientMsgId: string): void {
    const store = this.deps.store;
    const item = store.outbox.find((i) => i.client_msg_id === clientMsgId);
    if (item) store.upsertMessage({ id: LOCAL_PREFIX + clientMsgId, channel_id: item.channel_id, sender_id: "", seq: null, updated_seq: Number.MAX_SAFE_INTEGER, client_msg_id: null, body: "", created_at: "", edited_at: null, deleted: true });
    store.removeOutbox(clientMsgId);
  }

  /** Sends queued messages one at a time, in order (§9). Stops on temporary failures. */
  async flushOutbox(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const item of [...this.deps.store.outbox]) {
        if (item.failed) continue;
        try {
          const result = await this.deps.api.postMessage(item.channel_id, item.client_msg_id, item.body);
          this.deps.store.upsertMessage(result.message);
          this.deps.store.removeOutbox(item.client_msg_id);
        } catch (err) {
          if (isRetryable(err)) return; // resume after reconnect / next send
          const reason = err instanceof ApiError ? err.code : "failed";
          this.deps.store.markOutboxFailed(item.client_msg_id, reason);
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultId(): string {
  return crypto.randomUUID();
}
