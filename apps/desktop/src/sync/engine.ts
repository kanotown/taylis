/**
 * SyncEngine: the client side of SYNC_PROTOCOL.md (§7 start / catch_up / live, §8 merge,
 * §9 optimistic send, §5 heartbeat and reconnect). Transport is injected so the same code runs
 * in Tauri (WebSocket API) and in tests (fake server).
 */
import { ApiError, isRetryable } from "../api/errors";
import { DraftSync } from "./drafts";
import type { BootstrapOut, ChannelOut, ChannelReadStateOut, CustomEmojiOut, DeltaOut, HistoryOut, MessageOut, ReminderOut, ScheduledOut, ThreadFilter, ThreadListOut, ThreadState, ThreadUpdated, UserPublic } from "../api/types";
import type { Store } from "./store";
import type { ChannelState, EventFrame, GroupOut, MessageState, NotificationLevel, OutboxItem, ParentThread, ReadStateOut, ServerFrame, SidebarSectionOut, DraftOut, DraftUpdated, SendOptions, ChannelLinkOut } from "./types";
import { LOCAL_PREFIX } from "./types";

/**
 * The message mentions me: by name, group or @channel, or by one of my notification keywords (M12g).
 * The server keeps keyword hits private (they would show my keywords to everyone), so they are found
 * here with its rule: case-insensitive, anywhere in the body.
 */
export function mentionsMe(
  message: { body?: string | null; mention_all?: boolean; mentioned_user_ids?: string[] },
  me: { id: string; notify_keywords?: string[] | null },
): boolean {
  if (message.mention_all === true || (message.mentioned_user_ids ?? []).includes(me.id)) return true;
  const body = (message.body ?? "").toLowerCase();
  return (me.notify_keywords ?? []).some((word) => word.length > 0 && body.includes(word.toLowerCase()));
}

export interface SyncApi {
  bootstrap(): Promise<BootstrapOut>;
  history(channelId: string, beforeSeq: number | null, limit: number): Promise<HistoryOut>;
  delta(channelId: string, sinceSeq: number, limit: number): Promise<DeltaOut>;
  postMessage(channelId: string, clientMsgId: string, body: string, parentId?: string | null, attachmentIds?: string[], options?: SendOptions): Promise<{ message: MessageOut; created: boolean }>;
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
  /** M15f: a conversation's link bar. Optional (older fakes). */
  channelLinks?(channelId: string): Promise<ChannelLinkOut[]>;
  /** M15d: drafts shared by my devices. Optional (older fakes). */
  saveDraft?(channelId: string, parentId: string | null, body: string): Promise<DraftOut>;
  deleteDraft?(channelId: string, parentId: string | null): Promise<void>;
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
  /**
   * Runs before every connection attempt (§7.2): make the access token usable. `refresh` asks for a
   * new token even when the current one looks valid (the server closed the socket with 4001).
   */
  prepareConnection?: (options: { refresh: boolean }) => Promise<void>;
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
  /** M15d: a draft is saved on the server this long after typing pauses. */
  draftSaveMs?: number;
  /** §9: a temporary send failure is retried after this long, doubling up to sendRetryMaxMs. */
  sendRetryMinMs?: number;
  sendRetryMaxMs?: number;
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
  /** §10: thread read marks the server has not taken (a failed PUT); sent again after reconnecting. */
  private readonly unsentThreadReads = new Map<string, number>();
  /** Threads whose replies were loaded here: their live replies are kept even without a timeline (§7.4). */
  private readonly loadedThreads = new Set<string>();
  private threadRefreshCancel: (() => void) | null = null;
  private threadRefresh: Promise<void> | null = null;
  /** "channel[:parent]" → when the last typing frame went out. */
  private readonly typingSent = new Map<string, number>();
  private ws: WsLike | null = null;
  /** Bumped by every connection attempt, stop and sign-out: the work of an older attempt is dropped (§5.3). */
  private connection = 0;
  /** Close code 4001: the next attempt gets a new access token first. */
  private refreshBeforeConnect = false;
  private chain: Promise<void> = Promise.resolve();
  private helloResolve: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current socket last received anything (ms); the §5.3 deadline counts from here. */
  private lastFrameAt = 0;
  private stopped = false;
  private flushRun: Promise<void> | null = null;
  private flushAgain = false;
  private sendRetry: ReturnType<typeof setTimeout> | null = null;
  private sendAttempt = 0;
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
      draftSaveMs: options.draftSaveMs ?? 1_000,
      sendRetryMinMs: options.sendRetryMinMs ?? 2_000,
      sendRetryMaxMs: options.sendRetryMaxMs ?? 30_000,
    };
    const api = deps.api;
    this.drafts = new DraftSync({
      api: api.saveDraft && api.deleteDraft ? { saveDraft: (c, p, b) => api.saveDraft!(c, p, b), deleteDraft: (c, p) => api.deleteDraft!(c, p) } : null,
      store: deps.store,
      isOnline: () => this.status === "online",
      delayMs: this.opts.draftSaveMs,
    });
    deps.store.onDraftEdited = (channelId, parentId) => this.drafts.edited(channelId, parentId);
  }

  /** M15d: my drafts across devices. */
  readonly drafts: DraftSync;

  /** Save edited drafts now instead of after the typing pause (tests, sign-out). */
  flushDrafts(): Promise<void> {
    return this.drafts.flush();
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

  /** Resolves once all queued frames / steps and a running outbox flush have been processed (tests). */
  async idle(): Promise<void> {
    await this.chain;
    if (this.flushRun) {
      await this.flushRun;
      await this.chain; // events the sends caused
    }
  }

  // --- §7.2 start, §7.5 reconnect ------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connection += 1;
    this.cancelSendRetry();
    this.dropSocket();
    this.setStatus("idle");
  }

  private async connect(): Promise<void> {
    // "online" without a socket means that connection died: connect again (§5.3).
    if (this.stopped || this.status === "connecting" || (this.status === "online" && this.ws)) return;
    const attempt = ++this.connection;
    const current = (): boolean => attempt === this.connection;
    this.setStatus("connecting");
    const refresh = this.refreshBeforeConnect;
    try {
      await this.deps.prepareConnection?.({ refresh });
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.isAuth) this.signOut();
      else await this.scheduleReconnect();
      return;
    }
    if (!current()) return;
    if (refresh) this.refreshBeforeConnect = false;
    const token = this.deps.getAccessToken();
    if (!token) {
      this.signOut();
      return;
    }
    let ws: WsLike;
    try {
      ws = await this.deps.connect(token);
    } catch {
      if (current()) await this.scheduleReconnect();
      return;
    }
    if (!current()) {
      ws.close(); // stopped or superseded while the socket was opening
      return;
    }
    this.ws = ws;
    // This attempt still owns the socket: once it is closed or dropped, nothing here may report "online".
    const live = (): boolean => current() && this.ws === ws;
    const hello = new Promise<void>((resolve) => {
      this.helloResolve = resolve;
    });
    ws.onMessage((raw) => {
      if (this.ws === ws) this.onRaw(ws, raw); // a dropped socket's late frames are ignored
    });
    ws.onClose((code) => void this.handleClose(ws, code));
    ws.send(JSON.stringify({ type: "auth", token }));

    await this.enqueue(async () => {
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), this.opts.helloTimeoutMs),
      );
      if ((await Promise.race([hello, timeout])) === "timeout") throw new Error("hello timeout");
      // Closed or dropped meanwhile (its close handling already scheduled the one reconnect).
      if (!live()) return;
      // Frames that arrive from here on are queued behind this step (= buffered, §7.2).
      const bootstrap = await this.deps.api.bootstrap();
      if (!live()) return;
      this.applyBootstrap(bootstrap);
      await this.loadBrowsableChannels();
      if (this.currentChannelId) await this.catchUp(this.currentChannelId);
      if (!live()) return;
      this.reconnectAttempt = 0;
      this.setStatus("online");
    }).catch(async (err: unknown) => {
      if (!live()) return;
      if (err instanceof ApiError && err.isAuth) {
        this.signOut();
        return;
      }
      this.dropSocket(ws);
      await this.scheduleReconnect();
    });
    if (this.status === "online" && live()) {
      void this.flushOutbox();
      void this.drafts.flush(); // edited while offline (M15d)
      this.resendReads(); // §10: marks that did not reach the server
      // Open the conversation again: its links may have changed while away (M15f), and one opened while this
      // connection was starting (a tap during start-up) skipped its catch-up then; a synced one costs nothing.
      if (this.currentChannelId) void this.openChannel(this.currentChannelId);
    }
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

  /** §5.3 close codes: 4003 signs out; 4001 gets a new access token before reconnecting; the rest reconnect. */
  private async handleClose(ws: WsLike, code: number): Promise<void> {
    if (!this.detach(ws)) return; // an older socket, or one dropped on purpose
    if (code === 4003) {
      this.signOut();
      return;
    }
    // The auth frame came late or the token was refused: only a refused refresh signs out.
    if (code === 4001) this.refreshBeforeConnect = true;
    if (!this.stopped) await this.scheduleReconnect();
  }

  /** Forget the current socket: its timers stop and a step waiting for its hello wakes up (and sees it is gone). */
  private detach(ws: WsLike): boolean {
    if (this.ws !== ws) return false;
    this.ws = null;
    this.clearTimers();
    this.helloResolve?.();
    this.helloResolve = null;
    return true;
  }

  /** Detach and close the socket (the current one by default); its own close event is then ignored. */
  private dropSocket(ws: WsLike | null = this.ws): boolean {
    if (!ws || !this.detach(ws)) return false;
    ws.close();
    return true;
  }

  private signOut(): void {
    this.connection += 1;
    this.cancelSendRetry();
    this.dropSocket();
    this.setStatus("signed_out");
    this.deps.onSignedOut?.();
  }

  /** The app calls this after a successful refresh / network change to skip the backoff. */
  reconnectNow(): void {
    if (this.status === "offline" && !this.ws) void this.connect();
  }

  // --- frames ---------------------------------------------------------------------------

  private onRaw(ws: WsLike, raw: string): void {
    this.lastFrameAt = Date.now(); // anything received proves the connection alive (§5.3)
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    if (frame.type === "hello") {
      this.helloResolve?.();
      this.helloResolve = null;
      this.startHeartbeat(ws, (frame.heartbeat_interval_sec || 30) * 1000);
      return;
    }
    if (frame.type === "pong") return; // its arrival already moved the deadline
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

  private startHeartbeat(ws: WsLike, intervalMs: number): void {
    this.clearTimers();
    const tick = (): void => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ type: "ping", active: this.deps.isActive?.() ?? true }));
      this.heartbeat = setTimeout(tick, intervalMs);
    };
    this.heartbeat = setTimeout(tick, intervalMs);
    this.watchSilence(ws, intervalMs * 2);
  }

  /**
   * §5.3: the connection counts as lost once nothing (a pong or any other frame) has arrived for
   * `limitMs`. The deadline runs from the last frame received; sending a ping never extends it, or a
   * half-open connection would go unnoticed for ever. The dead socket is dropped at once (a close
   * handshake on it may never finish) and one reconnect is scheduled.
   */
  private watchSilence(ws: WsLike, limitMs: number): void {
    const left = this.lastFrameAt + limitMs - Date.now();
    if (left > 0) {
      this.silenceTimer = setTimeout(() => this.watchSilence(ws, limitMs), left);
      return;
    }
    if (this.dropSocket(ws)) void this.scheduleReconnect();
  }

  private clearTimers(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.heartbeat = null;
    this.silenceTimer = null;
  }

  private applyBootstrap(bootstrap: BootstrapOut): void {
    const store = this.deps.store;
    store.setMe(bootstrap.me);
    for (const user of bootstrap.users) store.upsertUser(user);
    const seen = new Set<string>();
    for (const channel of bootstrap.channels) {
      seen.add(channel.id);
      // §10: the server's read position is authoritative here (no max merge); marks this device could
      // not send are applied again below and sent once online.
      store.upsertChannel(channel, channel.read_state ? { isMember: true, lastReadSeq: channel.read_state.last_read_seq } : { isMember: true });
    }
    for (const channel of [...store.channels.values()]) {
      if (channel.isMember && !seen.has(channel.id)) store.removeChannel(channel.id); // no longer a member
    }
    this.reapplyUnsentReads();
    if (bootstrap.threads) store.setThreadSummary(bootstrap.threads);
    if (store.threadsLoaded) this.scheduleThreadRefresh(); // the list may have moved while we were away
    store.replacePresence(bootstrap.presence ?? []);
    store.replaceBookmarks(bootstrap.bookmarks ?? []);
    store.replaceFavorites(bootstrap.favorites ?? []);
    store.replaceCustomEmoji(bootstrap.custom_emoji ?? []);
    store.replaceGroups(bootstrap.groups ?? []);
    store.replaceSidebar(bootstrap.sidebar_sections ?? []);
    this.drafts.applyBootstrap(bootstrap.drafts ?? []);
    void this.loadScheduled();
    void this.loadReminders();
  }

  /** M15f: the conversation's link bar; loaded when it opens and after reconnecting (not in bootstrap). */
  async loadLinks(channelId: string): Promise<void> {
    if (!this.deps.api.channelLinks) return;
    try {
      this.deps.store.setChannelLinks(channelId, await this.deps.api.channelLinks(channelId));
    } catch (err) {
      console.warn("could not load channel links", err);
    }
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
        else if (store.getChannel(data.channel.id)) store.removeChannel(data.channel.id); // made private (M15b)
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
      case "channel.links_updated": {
        const data = frame.data as { channel_id: string; links: ChannelLinkOut[] };
        store.setChannelLinks(data.channel_id, data.links);
        return;
      }
      case "draft.updated":
        this.drafts.applyEvent(frame.data as unknown as DraftUpdated);
        return;
      case "sidebar.updated": {
        const data = frame.data as { sections: SidebarSectionOut[] };
        store.replaceSidebar(data.sections);
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
    if (isNew) {
      store.clearTyping(channel.id, message.parent_id ?? null, message.sender_id);
      this.noteLastMessage(channel.id, message);
    }

    if (channel.syncedSeq === null) {
      // No timeline here: the channel list moves, and rows this device already holds take the event
      // (a thread opened from the threads view shows its new replies, §7.4).
      if (this.holds(channel.id, message)) store.upsertMessage(message);
      if (thread) store.applyParentThread(channel.id, thread); // only when the parent is held
      store.updateChannel(channel.id, { lastSeq: Math.max(channel.lastSeq, seq) });
      if (isNew) {
        this.countUnread(message);
        this.maybeNotify(message, channel, thread);
      }
      return;
    }
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

  /** Rows this device already holds, or a reply in a thread it opened: kept current without a timeline (§7.4). */
  private holds(channelId: string, message: MessageOut): boolean {
    const store = this.deps.store;
    if (store.message(channelId, message.id)) return true;
    const parentId = message.parent_id;
    return !!parentId && (this.loadedThreads.has(parentId) || store.message(channelId, parentId) !== undefined);
  }

  /** §7.4: a new message in the timeline (top-level, or a reply also sent to the channel) moves the conversation up the DM list. */
  private noteLastMessage(channelId: string, message: MessageOut): void {
    if (message.parent_id && !message.also_in_channel) return;
    const channel = this.deps.store.getChannel(channelId);
    if (!channel || (channel.last_message_at && Date.parse(channel.last_message_at) >= Date.parse(message.created_at))) return;
    this.deps.store.updateChannel(channelId, { last_message_at: message.created_at });
  }

  /** §7.4 / §10: someone else's timeline message is unread until read.updated says otherwise; my own post reads the channel. */
  private countUnread(message: MessageOut): void {
    const store = this.deps.store;
    const me = store.me;
    const channel = store.getChannel(message.channel_id);
    if (!me || !channel) return;
    if (message.parent_id && !message.also_in_channel) return; // replies are not unread items unless also in the channel (M15c)
    if (message.sender_id === me.id) {
      // A top-level post reads the conversation (the server does the same); my replies, even those also
      // sent to the channel, leave the channel's read position alone (§10).
      if (!message.parent_id) {
        this.unreadHold.delete(channel.id);
        store.updateChannel(channel.id, { lastReadSeq: Math.max(channel.lastReadSeq, message.seq), unreadCount: 0, mentionCount: 0 });
      }
      return;
    }
    if (message.seq <= channel.lastReadSeq) return;
    const mentioned = mentionsMe(message, me);
    store.updateChannel(channel.id, { unreadCount: channel.unreadCount + 1, mentionCount: channel.mentionCount + (mentioned ? 1 : 0) });
  }

  private applyReadState(channelId: string, state: ReadStateOut, allowDecrease = false): void {
    const channel = this.deps.store.getChannel(channelId);
    if (!channel) return;
    // Advances merge with max (an event for an older PUT may arrive after a newer local mark);
    // a mark-as-unread (reason "set") moves the position down as well.
    const reached = channel.pendingReadSeq !== null && state.last_read_seq >= channel.pendingReadSeq;
    this.deps.store.updateChannel(channelId, {
      lastReadSeq: allowDecrease ? state.last_read_seq : Math.max(channel.lastReadSeq, state.last_read_seq),
      unreadCount: state.unread_count,
      mentionCount: state.mention_count,
      ...(reached ? { pendingReadSeq: null } : {}),
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
    const involved = mentionsMe(message, me) || (thread?.participant_ids ?? []).includes(me.id);
    if (level === "mentions" && !involved) return;
    if (this.deps.isActive?.() && this.currentChannelId === channel.id) return;
    this.deps.onNotify?.(message, channel);
  }

  // --- §7.3 catch_up ----------------------------------------------------------------------

  openChannel(channelId: string): Promise<void> {
    this.currentChannelId = channelId;
    for (const held of [...this.unreadHold.keys()]) if (held !== channelId) this.unreadHold.delete(held);
    if (this.status !== "online") return Promise.resolve();
    void this.loadLinks(channelId);
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
    const me = store.me;
    const later = store.messages(channelId).filter((m) => m.seq !== null && m.seq > target && m.sender_id !== me?.id);
    store.updateChannel(channelId, {
      pendingReadSeq: null, // an unsent advance must not undo this
      lastReadSeq: target,
      unreadCount: later.length,
      mentionCount: me ? later.filter((m) => mentionsMe(m, me)).length : 0,
    });
    this.trackRead(channelId, (async () => {
      try {
        const state = await this.deps.api.markRead(channelId, target, "set");
        await this.enqueue(async () => this.applyReadState(channelId, state, true));
      } catch (err) {
        console.warn("mark as unread not sent; the next bootstrap restores the server's position", err);
      }
    })());
  }

  /**
   * §10: move the local position at once (monotonic), then PUT after a debounce; the server's answer
   * wins. Until the server confirms it the mark stays in `pendingReadSeq` (persisted), so a failed PUT
   * or quitting during the debounce is sent again after reconnecting.
   */
  markRead(channelId: string, seq: number, options: { force?: boolean } = {}): void {
    if (this.status !== "online" || this.deps.isActive?.() === false) return;
    if (options.force) this.unreadHold.delete(channelId);
    else if (this.unreadHold.has(channelId)) return;
    const store = this.deps.store;
    const channel = store.getChannel(channelId);
    if (!channel || !channel.isMember || seq <= channel.lastReadSeq) return;
    store.updateChannel(channelId, seq >= channel.lastSeq ? { lastReadSeq: seq, pendingReadSeq: seq, unreadCount: 0, mentionCount: 0 } : { lastReadSeq: seq, pendingReadSeq: seq });
    this.debounceRead(channelId, () => this.sendRead(channelId));
  }

  /** One PUT per key after the debounce; a newer mark supersedes the waiting one. */
  private debounceRead(key: string, send: () => Promise<void>): void {
    this.readCancels.get(key)?.();
    let cancelled = false;
    this.readCancels.set(key, () => {
      cancelled = true;
    });
    this.trackRead(key, (async () => {
      await (this.deps.sleep ?? defaultSleep)(this.opts.readDebounceMs);
      if (cancelled) return;
      this.readCancels.delete(key);
      await send();
    })());
  }

  /** Read PUTs in flight, so flushReads() can wait for them. */
  private trackRead(key: string, pending: Promise<void>): void {
    this.pendingReads.set(key, pending);
    void pending.finally(() => {
      if (this.pendingReads.get(key) === pending) this.pendingReads.delete(key);
    });
  }

  /** PUT the channel's unsent mark. Kept for after reconnecting when it does not go through; dropped when refused for good. */
  private async sendRead(channelId: string): Promise<void> {
    const store = this.deps.store;
    const target = store.getChannel(channelId)?.pendingReadSeq ?? null;
    if (target === null || this.status !== "online") return;
    try {
      const state = await this.deps.api.markRead(channelId, target);
      await this.enqueue(async () => {
        if (store.getChannel(channelId)?.pendingReadSeq === target) store.updateChannel(channelId, { pendingReadSeq: null });
        this.applyReadState(channelId, state);
      });
    } catch (err) {
      if (isRetryable(err) || (err instanceof ApiError && err.isAuth)) {
        console.warn("read mark not sent; retried after reconnecting", err);
        return;
      }
      if (store.getChannel(channelId)?.pendingReadSeq === target) store.updateChannel(channelId, { pendingReadSeq: null }); // e.g. no longer a member
    }
  }

  /** After bootstrap (authoritative): marks the server has not taken move the local position again (§10). */
  private reapplyUnsentReads(): void {
    const store = this.deps.store;
    for (const channel of [...store.channels.values()]) {
      const pending = channel.pendingReadSeq;
      if (pending === null) continue;
      if (!channel.isMember || pending <= channel.lastReadSeq) store.updateChannel(channel.id, { pendingReadSeq: null });
      else store.updateChannel(channel.id, pending >= channel.lastSeq ? { lastReadSeq: pending, unreadCount: 0, mentionCount: 0 } : { lastReadSeq: pending });
    }
  }

  /** Once online again: every read mark (channel or thread) that did not reach the server goes out now. */
  private resendReads(): void {
    for (const channel of [...this.deps.store.channels.values()]) if (channel.pendingReadSeq !== null) this.trackRead(channel.id, this.sendRead(channel.id));
    for (const parentId of [...this.unsentThreadReads.keys()]) this.trackRead("thread:" + parentId, this.sendThreadRead(parentId));
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
    const floor = this.threadReadFloor.get(parentId) ?? 0;
    // A mark the server has not taken is sent again when the thread is read again (§10).
    if (seq <= Math.max(entry?.state.last_read_seq ?? 0, floor) && !this.unsentThreadReads.has(parentId)) return;
    const target = Math.max(seq, floor);
    this.threadReadFloor.set(parentId, target);
    if (entry && target > entry.state.last_read_seq) {
      const newest = Math.max(0, ...store.replies(entry.state.channel_id, parentId).map((r) => r.seq ?? 0));
      store.applyThreadState(target >= newest ? { ...entry.state, last_read_seq: target, unread_count: 0, mention_count: 0 } : { ...entry.state, last_read_seq: target });
    }
    this.debounceRead("thread:" + parentId, () => this.sendThreadRead(parentId));
  }

  /** PUT the thread's newest mark; remembered for after reconnecting when it does not go through (§10). */
  private async sendThreadRead(parentId: string): Promise<void> {
    const target = this.threadReadFloor.get(parentId);
    if (target === undefined) return;
    if (this.status !== "online") {
      this.unsentThreadReads.set(parentId, target);
      return;
    }
    try {
      const state = await this.deps.api.markThreadRead(parentId, target);
      if ((this.unsentThreadReads.get(parentId) ?? 0) <= target) this.unsentThreadReads.delete(parentId);
      await this.enqueue(async () => this.deps.store.applyThreadState(state));
    } catch (err) {
      if (isRetryable(err) || (err instanceof ApiError && err.isAuth)) {
        console.warn("thread read mark not sent; retried after reconnecting", err);
        this.unsentThreadReads.set(parentId, target);
      } else {
        this.unsentThreadReads.delete(parentId); // refused for good (the thread is gone …)
      }
    }
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
      channel = store.updateChannel(channelId, { syncedSeq: null, oldestLoadedSeq: null, hasOlder: true }) ?? channel;
      this.stats.reloads += 1;
    }
    if (channel.syncedSeq === null) {
      const page = await this.deps.api.history(channelId, null, this.opts.pageSize);
      for (const message of page.messages) store.upsertMessage(message);
      store.updateChannel(channelId, {
        syncedSeq: page.channel_last_seq,
        lastSeq: Math.max(channel.lastSeq, page.channel_last_seq),
        ...loadedRange(page),
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

  /**
   * Scroll-up pagination (§7.3): the page before the loaded range. Never from the lowest seq present:
   * an old row that arrived on its own (a reaction, a thread parent) would leave a gap no page fills.
   */
  loadOlder(channelId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.status !== "online") return;
      const store = this.deps.store;
      const channel = store.getChannel(channelId);
      if (!channel || channel.syncedSeq === null || !channel.oldestLoadedSeq) return; // nothing loaded yet, or all of it
      const page = await this.deps.api.history(channelId, channel.oldestLoadedSeq, this.opts.pageSize);
      for (const message of page.messages) store.upsertMessage(message);
      store.updateChannel(channelId, loadedRange(page));
    });
  }

  // --- §9 optimistic send ---------------------------------------------------------------

  send(channelId: string, body: string, clientMsgId?: string, parentId: string | null = null, attachmentIds: string[] = [], options: SendOptions = {}): Promise<void> {
    clientMsgId = clientMsgId ?? (this.deps.newId ?? defaultId)();
    const createdAt = (this.deps.now ?? (() => new Date().toISOString()))();
    const me = this.deps.store.me;
    const shared = options.alsoInChannel === true && parentId !== null; // M15c: only replies can also go to the channel
    const priority = parentId === null ? (options.priority ?? null) : null; // M15e: top-level posts only
    const ackRequested = parentId === null && options.ackRequested === true;
    const item: OutboxItem = {
      client_msg_id: clientMsgId, channel_id: channelId, body, created_at: createdAt, parent_id: parentId, attachment_ids: attachmentIds,
      ...(shared ? { also_in_channel: true } : {}), ...(priority ? { priority } : {}), ...(ackRequested ? { ack_requested: true } : {}),
    };
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
      also_in_channel: shared,
      priority,
      ack_requested: ackRequested,
    });
    return this.flushOutbox();
  }

  /** Opening a thread: fetch its replies (live ones keep arriving as timeline events, §7.4). */
  loadReplies(_channelId: string, parentId: string): Promise<void> {
    this.loadedThreads.add(parentId);
    return this.enqueue(async () => {
      if (this.status !== "online") return;
      for (const reply of await this.deps.api.replies(parentId)) this.deps.store.upsertMessage(reply);
    });
  }

  retryFailed(): Promise<void> {
    for (const item of this.deps.store.outbox) if (item.failed) this.deps.store.clearOutboxFailed(item.client_msg_id);
    return this.flushOutbox();
  }

  discardFailed(clientMsgId: string): void {
    const store = this.deps.store;
    const item = store.outbox.find((i) => i.client_msg_id === clientMsgId);
    if (item) store.upsertMessage({ id: LOCAL_PREFIX + clientMsgId, channel_id: item.channel_id, sender_id: "", seq: null, updated_seq: Number.MAX_SAFE_INTEGER, client_msg_id: null, body: "", created_at: "", edited_at: null, deleted: true });
    store.removeOutbox(clientMsgId);
  }

  /**
   * §9: sends queued messages one at a time, in order. Each round reads the next unsent item again, so
   * a message queued while another is in flight goes out in the same run ("again" covers one queued
   * after the loop's last look). A refusal (4xx) marks the item failed and moves on; a temporary
   * failure stops the run and, while online, retries after 2 s, 4 s … 30 s (reconnecting also resumes).
   */
  flushOutbox(): Promise<void> {
    if (this.flushRun) {
      this.flushAgain = true;
      return this.flushRun;
    }
    if (this.status !== "online") return Promise.resolve();
    const run = (async () => {
      try {
        do {
          this.flushAgain = false;
          await this.flushPass();
        } while (this.flushAgain && this.status === "online");
      } finally {
        this.flushRun = null;
      }
    })();
    this.flushRun = run;
    return run;
  }

  private async flushPass(): Promise<void> {
    this.cancelSendRetry();
    const store = this.deps.store;
    for (;;) {
      if (this.status !== "online") return; // resumed after reconnecting
      const item = store.outbox.find((i) => !i.failed);
      if (!item) {
        this.sendAttempt = 0;
        return;
      }
      try {
        const result = await this.deps.api.postMessage(item.channel_id, item.client_msg_id, item.body, item.parent_id ?? null, item.attachment_ids ?? [], {
          alsoInChannel: item.also_in_channel ?? false,
          priority: item.priority ?? null,
          ackRequested: item.ack_requested ?? false,
        });
        store.upsertMessage(result.message);
        store.removeOutbox(item.client_msg_id);
        this.sendAttempt = 0;
      } catch (err) {
        if (isRetryable(err)) {
          this.scheduleSendRetry();
          return;
        }
        // The client already refreshed an expired token once; sign-out or the next connection follows.
        if (err instanceof ApiError && err.isAuth) return;
        store.markOutboxFailed(item.client_msg_id, err instanceof ApiError ? err.code : "failed");
      }
    }
  }

  private scheduleSendRetry(): void {
    if (this.stopped || this.status !== "online") return; // reconnecting flushes again
    this.sendAttempt += 1;
    const delay = Math.min(this.opts.sendRetryMinMs * 2 ** (this.sendAttempt - 1), this.opts.sendRetryMaxMs);
    this.sendRetry = setTimeout(() => {
      this.sendRetry = null;
      void this.flushOutbox();
    }, delay);
  }

  private cancelSendRetry(): void {
    if (this.sendRetry) clearTimeout(this.sendRetry);
    this.sendRetry = null;
  }
}

/** §7.3: the loaded range after a history page: its oldest seq, or 0 once the start is reached. */
function loadedRange(page: HistoryOut): Pick<ChannelState, "oldestLoadedSeq" | "hasOlder"> {
  if (!page.has_more || page.messages.length === 0) return { oldestLoadedSeq: 0, hasOlder: false };
  return { oldestLoadedSeq: Math.min(...page.messages.map((m) => m.seq)), hasOlder: true };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultId(): string {
  return crypto.randomUUID();
}
