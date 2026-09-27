/**
 * SyncEngine: the client side of SYNC_PROTOCOL.md (§7 start / catch_up / live, §8 merge,
 * §9 optimistic send, §5 heartbeat and reconnect). Transport is injected so the same code runs
 * in Tauri (WebSocket API) and in tests (fake server).
 */
import { ApiError, isRetryable } from "../api/errors";
import type { BootstrapOut, ChannelOut, ChannelReadStateOut, CustomEmojiOut, DeltaOut, HistoryOut, MessageOut, ReminderOut, ScheduledOut, ThreadFilter, ThreadListOut, ThreadState, ThreadUpdated, UserPublic } from "../api/types";
import type { Store } from "./store";
import type { ChannelState, EventFrame, GroupOut, MessageState, NotificationLevel, OutboxItem, ParentThread, ReadStateOut, ServerFrame } from "./types";
import { LOCAL_PREFIX } from "./types";

export interface SyncApi {
  bootstrap(): Promise<BootstrapOut>;
  history(channelId: string, beforeSeq: number | null, limit: number): Promise<HistoryOut>;
  delta(channelId: string, sinceSeq: number, limit: number): Promise<DeltaOut>;
  postMessage(channelId: string, clientMsgId: string, body: string, parentId?: string | null, attachmentIds?: string[]): Promise<{ message: MessageOut; created: boolean }>;
  replies(messageId: string): Promise<MessageOut[]>;
  /** Public channels the user has not joined (for the browse list). Optional. */
  publicChannels?(): Promise<ChannelOut[]>;
  markRead(channelId: string, lastReadSeq: number, mode?: "advance" | "set"): Promise<ReadStateOut>;
  /** M12a: every channel read to its end; returns the new states. */
  readAll(): Promise<ChannelReadStateOut[]>;
  /** M12d: my pending scheduled messages. */
  listScheduled(): Promise<ScheduledOut[]>;
  /** M12e: my open reminders. */
  listReminders(): Promise<ReminderOut[]>;
  /** THREADS.md §3. */
  threads(options: { filter: ThreadFilter; cursor?: string | null; limit?: number }): Promise<ThreadListOut>;
  threadState(messageId: string): Promise<ThreadState>;
  markThreadRead(messageId: string, lastReadSeq: number): Promise<ThreadState>;
  setThreadFollow(messageId: string, following: boolean): Promise<ThreadState>;
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
  prepareConnection?: () => Promise<void>;
  onSignedOut?: () => void;
  onNotify?: (message: MessageOut, channel: ChannelState) => void;
  /** M12e: a reminder just fired (a nudge in the app while it is open). */
  onReminder?: (reminder: ReminderOut) => void;
  /** A channel became fully read (here or on another device). */
  onRead?: (channelId: string) => void;
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
  /** §10: read marks are debounced so scrolling does not spam the server. */
  readDebounceMs?: number;
  threadPageSize?: number;
  /** thread.updated bursts (one per reply) collapse into one list / badge refresh. */
  threadRefreshMs?: number;
  /** §5.2: typing frames go out at most this often per conversation; indicators expire after typingTtlMs. */
  typingIntervalMs?: number;
  typingTtlMs?: number;
}

export class SyncEngine {
  status: EngineStatus = "idle";
  currentChannelId: string | null = null;
  /** Channels marked unread by hand: visible-range marking pauses until the reader leaves them (§10). */
  readonly unreadHold = new Map<string, number>();
  readonly stats = { catchUps: 0, reloads: 0, reconnects: 0 };
  private readonly pendingReads = new Map<string, Promise<void>>();
  private readonly readCancels = new Map<string, () => void>();
  /** Thread read positions sent (or about to be) while the thread's state is not loaded yet. */
  private readonly threadReadFloor = new Map<string, number>();
  private threadRefreshCancel: (() => void) | null = null;
  private threadRefresh: Promise<void> | null = null;
  /** "channel[:parent]" → when the last typing frame went out. */
  private readonly typingSent = new Map<string, number>();
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
      readDebounceMs: options.readDebounceMs ?? 1_000,
      threadPageSize: options.threadPageSize ?? 50,
      threadRefreshMs: options.threadRefreshMs ?? 300,
      typingIntervalMs: options.typingIntervalMs ?? 3_000,
      typingTtlMs: options.typingTtlMs ?? 5_000,
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
    if (this.stopped || ["connecting", "online"].includes(this.status)) return;
    this.setStatus("connecting");
    try { await this.deps.prepareConnection?.(); } catch (error) {
      if (error instanceof ApiError && error.isAuth) this.signOut();
      else await this.scheduleReconnect();
      return;
    }
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
    else if (frame.type === "typing") {
      // Volatile (SYNC_PROTOCOL.md §5.2): shown for a few seconds, never stored.
      if (frame.user_id !== this.deps.store.me?.id) {
        this.deps.store.noteTyping(frame.channel_id, frame.parent_id ?? null, frame.user_id, (this.deps.now ? Date.parse(this.deps.now()) : Date.now()) + this.opts.typingTtlMs);
      }
    } else if (frame.type === "presence") this.deps.store.setPresence(frame.user_id, frame.status);
  }

  /** The composer changed: tell the other members, at most once per typingIntervalMs per conversation. */
  sendTyping(channelId: string, parentId: string | null = null): void {
    const ws = this.ws;
    if (!ws || this.status !== "online") return;
    const key = parentId ? `${channelId}:${parentId}` : channelId;
    const now = Date.now();
    const last = this.typingSent.get(key) ?? 0;
    if (now - last < this.opts.typingIntervalMs) return;
    this.typingSent.set(key, now);
    ws.send(JSON.stringify(parentId ? { type: "typing", channel_id: channelId, parent_id: parentId } : { type: "typing", channel_id: channelId }));
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
    if (bootstrap.threads) store.setThreadSummary(bootstrap.threads);
    if (store.threadsLoaded) this.scheduleThreadRefresh(); // the list may have moved while we were away
    store.replacePresence(bootstrap.presence ?? []);
    store.replaceBookmarks(bootstrap.bookmarks ?? []);
    store.replaceFavorites(bootstrap.favorites ?? []);
    store.replaceCustomEmoji(bootstrap.custom_emoji ?? []);
    store.replaceGroups(bootstrap.groups ?? []);
    void this.loadScheduled();
    void this.loadReminders();
  }

  /** M12e: open reminders; refreshed after every bootstrap. */
  async loadReminders(): Promise<void> {
    try {
      this.deps.store.replaceReminders(await this.deps.api.listReminders());
    } catch (err) {
      console.warn("could not load reminders", err);
    }
  }

  /** M12d: the pending scheduled messages; refreshed after every bootstrap (a reconnect may have missed events). */
  async loadScheduled(): Promise<void> {
    try {
      this.deps.store.replaceScheduled(await this.deps.api.listScheduled());
    } catch (err) {
      console.warn("could not load scheduled messages", err);
    }
  }

  /** 「すべて既読にする」 (M12a): the server moves every channel; the states apply like read.updated. */
  async markAllRead(): Promise<void> {
    const states = await this.deps.api.readAll();
    await this.enqueue(async () => {
      for (const state of states) this.applyReadState(state.channel_id, state, false);
    });
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
      case "channel.member_added": {
        // M11h: keep the intro's member count current; the member list itself is loaded on demand.
        const data = frame.data as { channel_id: string; user_id: string };
        const channel = store.getChannel(data.channel_id);
        if (channel && channel.member_count != null) store.updateChannel(data.channel_id, { member_count: channel.member_count + 1 });
        return;
      }
      case "channel.member_removed": {
        const data = frame.data as { channel_id: string; user_id: string };
        if (store.me && data.user_id === store.me.id) {
          store.removeChannel(data.channel_id);
          return;
        }
        const channel = store.getChannel(data.channel_id);
        if (channel && channel.member_count != null) store.updateChannel(data.channel_id, { member_count: Math.max(0, channel.member_count - 1) });
        return;
      }
      case "user.created":
      case "user.updated":
      case "user.deactivated": {
        const data = frame.data as { user: UserPublic };
        store.upsertUser(data.user);
        return;
      }
      case "notification_preference.updated": {
        const data = frame.data as { channel_id: string; level: NotificationLevel; muted_until: string | null };
        store.setNotification(data.channel_id, data.level, data.muted_until ?? null);
        return;
      }
      case "read.updated": {
        const data = frame.data as { channel_id: string } & ReadStateOut;
        this.applyReadState(data.channel_id, data, (data as { reason?: string }).reason === "set");
        return;
      }
      case "emoji.updated": {
        const data = frame.data as { emoji: CustomEmojiOut; deleted: boolean };
        store.applyCustomEmoji(data.emoji, data.deleted);
        return;
      }
      case "group.updated": {
        const data = frame.data as { group: GroupOut; deleted: boolean };
        store.applyGroup(data.group, data.deleted);
        return;
      }
      case "reminder.updated": {
        const data = frame.data as { reminder: ReminderOut };
        const before = store.reminders.get(data.reminder.id)?.status;
        store.applyReminder(data.reminder);
        if (data.reminder.status === "fired" && before !== "fired") this.deps.onReminder?.(data.reminder);
        return;
      }
      case "scheduled.updated": {
        const data = frame.data as { scheduled: ScheduledOut };
        store.applyScheduled(data.scheduled);
        return;
      }
      case "favorite.updated": {
        const data = frame.data as { channel_id: string; favorite: boolean };
        store.setFavorite(data.channel_id, data.favorite);
        return;
      }
      case "bookmark.updated": {
        const data = frame.data as { message_id: string; bookmarked: boolean };
        store.setBookmarked(data.message_id, data.bookmarked);
        return;
      }
      case "thread.updated": {
        // THREADS.md §4: the row (if loaded) takes the new state now; the badge and the list are
        // refreshed from the server shortly after, which also covers threads we do not hold.
        const data = frame.data as ThreadUpdated;
        store.applyThreadState(data);
        this.scheduleThreadRefresh();
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
    const thread = (frame.data["parent_thread"] as ParentThread | null | undefined) ?? null;
    const isNew = frame.event === "message.created";

    if (channel.syncedSeq === null) {
      store.updateChannel(channel.id, { lastSeq: Math.max(channel.lastSeq, seq) });
      if (isNew) {
        this.countUnread(message);
        this.maybeNotify(message, channel, thread);
      }
      return;
    }
    if (isNew) store.clearTyping(channel.id, message.parent_id ?? null, message.sender_id);
    if (seq === channel.syncedSeq + 1) {
      store.upsertMessage(message);
      if (thread) store.applyParentThread(channel.id, thread);
      store.updateChannel(channel.id, { syncedSeq: seq, lastSeq: Math.max(channel.lastSeq, seq) });
      if (isNew) {
        this.countUnread(message);
        this.maybeNotify(message, channel, thread);
      }
      return;
    }
    if (seq > channel.syncedSeq + 1) {
      store.updateChannel(channel.id, { lastSeq: Math.max(channel.lastSeq, seq) });
      await this.catchUp(channel.id);
      if (isNew) {
        this.countUnread(message);
        this.maybeNotify(message, channel, thread);
      }
    }
    // seq <= syncedSeq: already applied.
  }

  /** §7.4 / §10: my own message is read; someone else's is unread until read.updated says otherwise. */
  private countUnread(message: MessageOut): void {
    const store = this.deps.store;
    const me = store.me;
    const channel = store.getChannel(message.channel_id);
    if (!me || !channel) return;
    if (message.sender_id === me.id) {
      this.unreadHold.delete(channel.id); // sending reads the conversation (server does the same)
      store.updateChannel(channel.id, { lastReadSeq: Math.max(channel.lastReadSeq, message.seq), unreadCount: 0, mentionCount: 0 });
      return;
    }
    if (message.parent_id) return; // replies are not unread items (DATA_MODEL.md read_states)
    if (message.seq <= channel.lastReadSeq) return;
    const mentioned = message.mention_all === true || (message.mentioned_user_ids ?? []).includes(me.id);
    store.updateChannel(channel.id, { unreadCount: channel.unreadCount + 1, mentionCount: channel.mentionCount + (mentioned ? 1 : 0) });
  }

  private applyReadState(channelId: string, state: ReadStateOut, allowDecrease = false): void {
    const channel = this.deps.store.getChannel(channelId);
    if (!channel) return;
    // Advances merge with max (an event for an older PUT may arrive after a newer local mark);
    // a mark-as-unread (reason "set") moves the position down as well.
    this.deps.store.updateChannel(channelId, {
      lastReadSeq: allowDecrease ? state.last_read_seq : Math.max(channel.lastReadSeq, state.last_read_seq),
      unreadCount: state.unread_count,
      mentionCount: state.mention_count,
    });
    if (state.unread_count === 0) this.deps.onRead?.(channelId);
  }

  /** DMs always notify; channels when I am mentioned or take part in the thread (PUSH_NOTIFICATIONS.md §4). */
  private maybeNotify(message: MessageOut, channel: ChannelState, thread: ParentThread | null = null): void {
    const me = this.deps.store.me;
    if (!me || message.sender_id === me.id) return;
    const isDm = channel.type === "dm" || channel.type === "group_dm";
    // Same rule as the server's PushPlanner: the per-channel level, "none" or a timed mute silences everything.
    const level = channel.notificationLevel ?? (isDm ? "all" : "mentions");
    const mutedUntil = channel.mutedUntil ? new Date(channel.mutedUntil).getTime() : 0;
    if (level === "none" || mutedUntil > Date.now()) return;
    const mentioned = message.mention_all === true || (message.mentioned_user_ids ?? []).includes(me.id);
    const involved = mentioned || (thread?.participant_ids ?? []).includes(me.id);
    if (level === "mentions" && !involved) return;
    if (this.deps.isActive?.() && this.currentChannelId === channel.id) return;
    this.deps.onNotify?.(message, channel);
  }

  // --- §7.3 catch_up ----------------------------------------------------------------------

  openChannel(channelId: string): Promise<void> {
    this.currentChannelId = channelId;
    for (const held of [...this.unreadHold.keys()]) if (held !== channelId) this.unreadHold.delete(held);
    if (this.status !== "online") return Promise.resolve();
    return this.enqueue(async () => {
      const channel = this.deps.store.getChannel(channelId);
      if (!channel) return;
      if (channel.syncedSeq === null || channel.syncedSeq < channel.lastSeq) await this.catchUp(channelId);
      // Read position is owned by the visible timeline, not navigation or sync.
    });
  }

  /**
   * 「ここから未読にする」: the position becomes seq - 1 at once and on the server (mode=set), and the
   * visible-range marking stays paused for this channel until the reader opens another one.
   */
  markUnread(channelId: string, seq: number): void {
    if (this.status !== "online") return;
    const store = this.deps.store;
    const channel = store.getChannel(channelId);
    if (!channel || !channel.isMember || seq < 1) return;
    const target = seq - 1;
    this.unreadHold.set(channelId, target);
    this.readCancels.get(channelId)?.();
    const me = store.me?.id;
    const later = store.messages(channelId).filter((m) => m.seq !== null && m.seq > target && m.sender_id !== me);
    store.updateChannel(channelId, {
      lastReadSeq: target,
      unreadCount: later.length,
      mentionCount: later.filter((m) => m.mention_all === true || (m.mentioned_user_ids ?? []).includes(me ?? "")).length,
    });
    const pending = (async () => {
      try {
        const state = await this.deps.api.markRead(channelId, target, "set");
        await this.enqueue(async () => this.applyReadState(channelId, state, true));
      } catch {
        // the position moved locally; bootstrap or the next mark reconciles
      }
    })();
    this.pendingReads.set(channelId, pending);
    void pending.finally(() => {
      if (this.pendingReads.get(channelId) === pending) this.pendingReads.delete(channelId);
    });
  }

  /** §10: move the local position at once (monotonic), then PUT after a debounce; the server's answer wins. */
  markRead(channelId: string, seq: number, options: { force?: boolean } = {}): void {
    if (this.status !== "online" || this.deps.isActive?.() === false) return;
    if (options.force) this.unreadHold.delete(channelId);
    else if (this.unreadHold.has(channelId)) return;
    const store = this.deps.store;
    const channel = store.getChannel(channelId);
    if (!channel || !channel.isMember || seq <= channel.lastReadSeq) return;
    store.updateChannel(channelId, seq >= channel.lastSeq ? { lastReadSeq: seq, unreadCount: 0, mentionCount: 0 } : { lastReadSeq: seq });
    this.readCancels.get(channelId)?.(); // a newer mark supersedes the pending one
    let cancelled = false;
    this.readCancels.set(channelId, () => {
      cancelled = true;
    });
    const pending = (async () => {
      await (this.deps.sleep ?? defaultSleep)(this.opts.readDebounceMs);
      if (cancelled) return;
      this.readCancels.delete(channelId);
      const target = store.getChannel(channelId)?.lastReadSeq ?? seq;
      try {
        const state = await this.deps.api.markRead(channelId, target);
        await this.enqueue(async () => this.applyReadState(channelId, state));
      } catch {
        // the next mark (or bootstrap) retries; the local position already moved
      }
    })();
    this.pendingReads.set(channelId, pending);
    void pending.finally(() => {
      if (this.pendingReads.get(channelId) === pending) this.pendingReads.delete(channelId);
    });
  }

  /** Waits for debounced read marks (tests). */
  async flushReads(): Promise<void> {
    await Promise.all([...this.pendingReads.values()]);
    await this.idle();
  }

  // --- followed threads (THREADS.md §5) ---------------------------------------------------

  /** The threads view opens (or switches filter): fetch the first page; `more` appends the next one. */
  loadThreads(filter: ThreadFilter, options: { more?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      if (this.status !== "online") return;
      const store = this.deps.store;
      const cursor = options.more && store.threadsFilter === filter ? store.threadsCursor : null;
      if (options.more && !cursor) return;
      const page = await this.deps.api.threads({ filter, cursor, limit: this.opts.threadPageSize });
      store.setThreadPage(filter, page.items, page.next_cursor ?? null, { append: cursor !== null, pageSize: this.opts.threadPageSize });
      store.setThreadSummary(page.summary);
    });
  }

  /** A thread opened from a channel: fetch my relation to it (follow flag, read position). */
  loadThreadState(parentId: string, parent?: MessageOut): Promise<void> {
    return this.enqueue(async () => {
      if (this.status !== "online") return;
      const state = await this.deps.api.threadState(parentId);
      const floor = this.threadReadFloor.get(parentId) ?? 0;
      this.deps.store.applyThreadState(floor > state.last_read_seq ? { ...state, last_read_seq: floor } : state, parent);
    });
  }

  /** The reply with `seq` was shown: the thread position moves now (monotonic) and is sent after a debounce. */
  markThreadRead(parentId: string, seq: number): void {
    if (this.status !== "online" || this.deps.isActive?.() === false) return;
    const store = this.deps.store;
    const entry = store.threads.get(parentId);
    const current = Math.max(entry?.state.last_read_seq ?? 0, this.threadReadFloor.get(parentId) ?? 0);
    if (seq <= current) return;
    this.threadReadFloor.set(parentId, seq);
    if (entry) {
      const newest = Math.max(0, ...store.replies(entry.state.channel_id, parentId).map((r) => r.seq ?? 0));
      store.applyThreadState(seq >= newest ? { ...entry.state, last_read_seq: seq, unread_count: 0, mention_count: 0 } : { ...entry.state, last_read_seq: seq });
    }
    const key = "thread:" + parentId;
    this.readCancels.get(key)?.();
    let cancelled = false;
    this.readCancels.set(key, () => {
      cancelled = true;
    });
    const pending = (async () => {
      await (this.deps.sleep ?? defaultSleep)(this.opts.readDebounceMs);
      if (cancelled) return;
      this.readCancels.delete(key);
      const target = this.threadReadFloor.get(parentId) ?? seq;
      try {
        const state = await this.deps.api.markThreadRead(parentId, target);
        await this.enqueue(async () => store.applyThreadState(state));
      } catch {
        // the next mark (or the refresh) retries; the local position already moved
      }
    })();
    this.pendingReads.set(key, pending);
    void pending.finally(() => {
      if (this.pendingReads.get(key) === pending) this.pendingReads.delete(key);
    });
  }

  setThreadFollow(parentId: string, following: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.status !== "online") return;
      const state = await this.deps.api.setThreadFollow(parentId, following);
      this.deps.store.applyThreadState(state);
    });
  }

  private scheduleThreadRefresh(): void {
    this.threadRefreshCancel?.();
    let cancelled = false;
    this.threadRefreshCancel = () => {
      cancelled = true;
    };
    this.threadRefresh = (async () => {
      await (this.deps.sleep ?? defaultSleep)(this.opts.threadRefreshMs);
      if (cancelled || this.status !== "online") return;
      this.threadRefreshCancel = null;
      await this.refreshThreads();
    })();
  }

  /** Re-read the badge (and the open list) from the server; cheap, and always consistent. */
  async refreshThreads(): Promise<void> {
    const store = this.deps.store;
    try {
      if (store.threadsLoaded) {
        await this.loadThreads(store.threadsFilter);
      } else {
        const page = await this.deps.api.threads({ filter: "unread", limit: 1 });
        store.setThreadSummary(page.summary);
      }
    } catch {
      // bootstrap (next reconnect) or the next event refreshes again
    }
  }

  /** Waits for the debounced thread refresh (tests). */
  async flushThreads(): Promise<void> {
    await this.threadRefresh;
    await this.flushReads();
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
      if (this.status !== "online") return;
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

  send(channelId: string, body: string, clientMsgId?: string, parentId: string | null = null, attachmentIds: string[] = []): Promise<void> {
    clientMsgId = clientMsgId ?? (this.deps.newId ?? defaultId)();
    const createdAt = (this.deps.now ?? (() => new Date().toISOString()))();
    const me = this.deps.store.me;
    const item: OutboxItem = { client_msg_id: clientMsgId, channel_id: channelId, body, created_at: createdAt, parent_id: parentId, attachment_ids: attachmentIds };
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
      parent_id: parentId,
    });
    return this.flushOutbox();
  }

  /** Opening a thread: fetch its replies (live ones keep arriving as timeline events). */
  loadReplies(_channelId: string, parentId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.status !== "online") return;
      for (const reply of await this.deps.api.replies(parentId)) this.deps.store.upsertMessage(reply);
    });
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
    if (this.flushing || this.status !== "online") return;
    this.flushing = true;
    try {
      for (const item of [...this.deps.store.outbox]) {
        if (item.failed) continue;
        try {
          const result = await this.deps.api.postMessage(item.channel_id, item.client_msg_id, item.body, item.parent_id ?? null, item.attachment_ids ?? []);
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
