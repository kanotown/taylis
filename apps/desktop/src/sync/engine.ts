/**
 * SyncEngine: the client side of SYNC_PROTOCOL.md (§7 start / catch_up / live, §8 merge,
 * §9 optimistic send, §5 heartbeat and reconnect). Transport is injected so the same code runs
 * in Tauri (WebSocket API) and in tests (fake server).
 */
import { ApiError, isRetryable } from "../api/errors";
import { DraftSync } from "./drafts";
import { CalendarHub, type CalendarApi } from "./calendar";
import { CanvasHub } from "./canvases";
import { CanvasPresenceSender } from "./canvasPresence";
import { type TaskApi, TaskHub, type TaskNotice } from "./tasks";
import { TimesFeedHub } from "./timesFeed";
import { type AiApi, AiHub } from "./ai";
import type { AiRunUpdated } from "../api/ai";
import type { CanvasSaverOptions } from "./canvasSave";
import type { ActivitySummaryOut, BootstrapOut, CalendarEventOut, CanvasMeta, CanvasOut, CanvasSaveIn, CanvasSaveOut, ChannelOut, LabProfileOut, ChannelReadStateOut, CustomEmojiOut, DeltaOut, EmojiPackOut, HistoryOut, MessageOut, ReadAllScope, ReminderOut, ScheduledOut, TemplateOut, ThreadFilter, TimesFeedOut, ThreadListOut, ThreadState, ThreadUpdated, UserMe, UserPublic, ReactionAdded, CanvasMentioned, WorkspaceSettingsOut } from "../api/types";
import type { NotificationTest } from "../api/types";
import { effectiveNotificationLevel, isMutedChannel, notifies, overallLevel, type ReplyKind } from "./notifications";
import { CACHED_MESSAGES_PER_CHANNEL, type Store } from "./store";
import type { ChannelState, EventFrame, GroupOut, MessageState, NotificationLevel, OutboxItem, ParentThread, ReadStateOut, ServerFrame, SidebarSectionOut, DraftOut, DraftUpdated, SendOptions, ChannelLinkOut, PoolOut } from "./types";
import { LOCAL_PREFIX } from "./types";
import { caughtUp, countsAsUnread, covers, JUMP_MAX_PAGES, JUMP_PAGE_SIZE, readRangeReady as rangeReady } from "./readGate";

/** §7.7: a channel nobody looks at is trimmed back to the cap once live rows take it this far past it. */
export const TRIM_MARGIN = 100;

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
  /** GET /users/me: my private settings after another of my devices changed them (M50). Optional (older fakes). */
  me?(): Promise<UserMe>;
  history(channelId: string, beforeSeq: number | null, limit: number): Promise<HistoryOut>;
  delta(channelId: string, sinceSeq: number, limit: number): Promise<DeltaOut>;
  postMessage(channelId: string, clientMsgId: string, body: string, parentId?: string | null, attachmentIds?: string[], options?: SendOptions): Promise<{ message: MessageOut; created: boolean }>;
  replies(messageId: string): Promise<MessageOut[]>;
  /** One message (a thread parent a preview does not hold, §7.6.1). Optional (older fakes). */
  getMessage?(messageId: string): Promise<MessageOut>;
  /** Public channels the user has not joined (for the browse list). Optional. */
  publicChannels?(): Promise<ChannelOut[]>;
  /** M49: one channel as its member sees it (GET /channels/{id}, with `last_message`). Optional (older fakes). */
  channel?(channelId: string): Promise<ChannelOut>;
  markRead(channelId: string, lastReadSeq: number, mode?: "advance" | "set"): Promise<ReadStateOut>;
  /** M12a: every channel read to its end; returns the new states. */
  readAll(scope?: ReadAllScope): Promise<ChannelReadStateOut[]>;
  /** L8: the Times feed (TIMES_FEED.md §3). Optional (older fakes). */
  timesFeed?(cursor?: string | null, limit?: number): Promise<TimesFeedOut>;
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
  /** M99: a channel's reservation pools. Optional (older fakes). */
  reservationPools?(channelId: string): Promise<PoolOut[]>;
  /** M43: canvases (CANVAS.md §4.5). Optional (older fakes). */
  listCanvases?(channelId: string, trashed?: boolean): Promise<CanvasMeta[]>;
  getCanvas?(canvasId: string, knownVersion: number | null): Promise<CanvasOut | null>;
  saveCanvas?(canvasId: string, body: CanvasSaveIn): Promise<CanvasSaveOut>;
  /** M51: the calendar (CALENDAR.md §4). Optional (older fakes). */
  calendarEvents?: CalendarApi["calendarEvents"];
  calendarUpcoming?: CalendarApi["calendarUpcoming"];
  createCalendarEvent?: CalendarApi["createCalendarEvent"];
  updateCalendarEvent?: CalendarApi["updateCalendarEvent"];
  deleteCalendarEvent?: CalendarApi["deleteCalendarEvent"];
  setCalendarAlarm?: CalendarApi["setCalendarAlarm"];
  clearCalendarAlarm?: CalendarApi["clearCalendarAlarm"];
  getCalendarEvent?: CalendarApi["getCalendarEvent"];
  updateCalendarOccurrence?: CalendarApi["updateCalendarOccurrence"];
  deleteCalendarOccurrence?: CalendarApi["deleteCalendarOccurrence"];
  /** M55: tasks (TASKS.md §3). Optional (older fakes). */
  listTasks?: TaskApi["listTasks"];
  myTasks?: TaskApi["myTasks"];
  /** L9 「自分が依頼した」. */
  requestedTasks?: TaskApi["requestedTasks"];
  dueTasks?: TaskApi["dueTasks"];
  /** M85 「締切」. */
  deadlineTasks?: TaskApi["deadlineTasks"];
  getTask?: TaskApi["getTask"];
  createTask?: TaskApi["createTask"];
  updateTask?: TaskApi["updateTask"];
  moveTask?: TaskApi["moveTask"];
  deleteTask?: TaskApi["deleteTask"];
  /** M15d: drafts shared by my devices. Optional (older fakes). */
  saveDraft?(channelId: string, parentId: string | null, body: string): Promise<DraftOut>;
  deleteDraft?(channelId: string, parentId: string | null): Promise<void>;
  /** M39: the activity badge (GET /activity/summary) and read position (PUT /activity/read). Optional (older fakes). */
  activitySummary?(): Promise<ActivitySummaryOut>;
  markActivityRead?(readAt: string): Promise<ActivitySummaryOut>;
  /** M65: the AI status and summaries (docs/AI.md §5). Optional (older fakes). */
  aiStatus?: AiApi["aiStatus"];
  createAiSummary?: AiApi["createAiSummary"];
  getAiRun?: AiApi["getAiRun"];
  aiSummaryTarget?: AiApi["aiSummaryTarget"];
  /** M70 「AI に聞く」. Optional (older fakes). */
  createAiAsk?: AiApi["createAiAsk"];
  aiAskTarget?: AiApi["aiAskTarget"];
  aiRuns?: AiApi["aiRuns"];
}

export interface WsLike {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number) => void): void;
}

export type WsConnector = (token: string) => Promise<WsLike>;

export type EngineStatus = "idle" | "connecting" | "online" | "offline" | "signed_out";

/**
 * §7.6.1: a public channel read before joining. It lives here, in memory only: the store (and its SQLite) never sees
 * these rows, and there is no cursor, read position, unread count or typing. Events go to members only, so it is what
 * GET history said when it opened, plus older pages as the reader scrolls up. Replaced whenever the rows change (the
 * rows themselves never are), dropped when another conversation opens or the channel is joined.
 */
export interface ChannelPreview {
  channelId: string;
  /** Top-level rows (and replies also sent to the channel), oldest first. */
  messages: MessageOut[];
  hasOlder: boolean;
  /** The first page arrived. */
  loaded: boolean;
  loading: boolean;
  /** The server would not show it (one before M27 has no previews): joining is the way in. */
  refused: boolean;
  /** Threads opened from the preview: parent id → replies, oldest first. */
  replies: ReadonlyMap<string, MessageOut[]>;
  /** Parents of those threads that are not among `messages` (the thread of a reply also sent to the channel). */
  parents: ReadonlyMap<string, MessageOut>;
}

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
  /**
   * M39: someone reacted to my message and I asked for reaction banners (`notify_reactions`), in a conversation that is
   * not silent or muted and not the one I am looking at.
   */
  onReaction?: (reaction: ReactionAdded, channel: ChannelState) => void;
  /** M12e: a reminder just fired (a nudge in the app while it is open). */
  onReminder?: (reminder: ReminderOut) => void;
  /** M51: one of my calendar alarms just fired (the server pushes to phones; the app shows it while open). */
  onCalendarAlarm?: (event: CalendarEventOut | null, channelId: string | null) => void;
  /** M55: task.assigned / task.due to me (the server pushes to phones; the app shows it while open). */
  onTaskNotice?: (notice: TaskNotice) => void;
  /**
   * M72 (CANVAS.md §18.1): a save of a canvas newly mentions me, in a conversation that is not silent or muted (the
   * server pushes to phones; the app shows it while open).
   */
  onCanvasMention?: (mention: CanvasMentioned, channel: ChannelState) => void;
  /** PUSH_NOTIFICATIONS.md §15: notification.test, a test notification I asked for (here or on another device). */
  onTestNotification?: (test: NotificationTest) => void;
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
  /** M39: the events that may move the activity badge collapse into one GET /activity/summary this long after. */
  activityRefreshMs?: number;
  /** §5.2: typing frames go out at most this often per conversation; indicators expire after typingTtlMs. */
  typingIntervalMs?: number;
  typingTtlMs?: number;
  /** M15d: a draft is saved on the server this long after typing pauses. */
  draftSaveMs?: number;
  /** §9: a temporary send failure is retried after this long, doubling up to sendRetryMaxMs. */
  sendRetryMinMs?: number;
  sendRetryMaxMs?: number;
  /** M43: the canvas save loop's pauses (CANVAS.md §4.4). */
  canvasSave?: CanvasSaverOptions;
}

export class SyncEngine {
  status: EngineStatus = "idle";
  /** The open conversation of mine; null while a preview (§7.6.1) or nothing is open. */
  currentChannelId: string | null = null;
  /** §7.6.1: the channel read before joining, if one is open. */
  preview: ChannelPreview | null = null;
  /**
   * Review v0.1.22 #6: the preview's load generation. Bumped when a preview opens or closes, when
   * 「参加前にチャンネルの中を見られる」 turns off and when the server refuses it: a page or thread asked for before
   * then writes nothing back when it arrives (no rows, no `refused: false`, no toast).
   */
  private previewGen = 0;
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
  /**
   * §10.2: parent → channel of the threads whose GET replies succeeded, so every older reply is held. Visible-range
   * thread marks wait for it; dropped when the channel's local messages are (a §7.3 reload, leaving it, sign-out).
   */
  private readonly completeThreads = new Map<string, string>();
  /** §7.3 reloads per channel: an open view drops its anchor when its rows were replaced (§10.1 2.). */
  private readonly reloads = new Map<string, number>();
  /** §7.7: views of a channel's rows besides the open conversation (a thread pane); the channel is not trimmed meanwhile. */
  private readonly views = new Map<string, number>();
  private threadRefreshCancel: (() => void) | null = null;
  private activityRefreshCancel: (() => void) | null = null;
  private activityRefresh: Promise<void> | null = null;
  private threadRefresh: Promise<void> | null = null;
  /** "channel[:parent]" → when the last typing frame went out. */
  private readonly typingSent = new Map<string, number>();
  /** M72: what this device last said of the canvases it edits (`canvas_presence`, CANVAS.md §18.2). */
  private readonly canvasPresence = new CanvasPresenceSender();
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
      activityRefreshMs: options.activityRefreshMs ?? 1_000,
      typingIntervalMs: options.typingIntervalMs ?? 3_000,
      typingTtlMs: options.typingTtlMs ?? 5_000,
      draftSaveMs: options.draftSaveMs ?? 1_000,
      sendRetryMinMs: options.sendRetryMinMs ?? 2_000,
      sendRetryMaxMs: options.sendRetryMaxMs ?? 30_000,
      canvasSave: options.canvasSave ?? {},
    };
    const api = deps.api;
    this.canvases = new CanvasHub({
      api: api.listCanvases && api.getCanvas && api.saveCanvas
        ? { listCanvases: (c, t) => api.listCanvases!(c, t), getCanvas: (id, v) => api.getCanvas!(id, v), saveCanvas: (id, body) => api.saveCanvas!(id, body) }
        : null,
      store: deps.store,
      options: this.opts.canvasSave,
    });
    this.calendar = new CalendarHub({
      api: api.calendarEvents && api.calendarUpcoming && api.createCalendarEvent && api.updateCalendarEvent && api.deleteCalendarEvent && api.setCalendarAlarm && api.clearCalendarAlarm && api.getCalendarEvent && api.updateCalendarOccurrence && api.deleteCalendarOccurrence
        ? (api as unknown as CalendarApi)
        : null,
      me: () => deps.store.me?.id ?? null,
      onAlarm: (event, channelId) => deps.onCalendarAlarm?.(event, channelId),
    });
    this.tasks = new TaskHub({
      api: api.listTasks && api.myTasks && api.dueTasks && api.getTask && api.createTask && api.updateTask && api.moveTask && api.deleteTask
        ? (api as unknown as TaskApi)
        : null,
      me: () => deps.store.me?.id ?? null,
      onNotice: (notice) => deps.onTaskNotice?.(notice),
    });
    this.drafts = new DraftSync({
      api: api.saveDraft && api.deleteDraft ? { saveDraft: (c, p, b) => api.saveDraft!(c, p, b), deleteDraft: (c, p) => api.deleteDraft!(c, p) } : null,
      store: deps.store,
      isOnline: () => this.status === "online",
      delayMs: this.opts.draftSaveMs,
    });
    deps.store.onDraftEdited = (channelId, parentId) => this.drafts.edited(channelId, parentId);
    deps.store.onStalePreview = (channelId) => void this.refreshLastMessage(channelId);
    this.timesFeed = new TimesFeedHub({
      api: api.timesFeed ? { timesFeed: (cursor, limit) => api.timesFeed!(cursor, limit) } : null,
      channel: (id) => deps.store.getChannel(id),
      subscribeChannels: (listener) => deps.store.subscribe(listener),
      isOnline: () => this.status === "online",
    });
    // Review v0.1.15 #4: whatever reaches the store (a catch-up recovering lost events, the answers to my own actions)
    // reaches the feed the same way, new rows included.
    deps.store.onMessageStored = (message, created) => this.timesFeed.applyMessage(message, created);
    deps.store.onMyVotes = (message) => this.timesFeed.applyMyVotes(message);
    this.ai = new AiHub({
      api: api.aiStatus && api.createAiSummary && api.getAiRun
        ? {
            aiStatus: () => api.aiStatus!(),
            createAiSummary: (body) => api.createAiSummary!(body),
            getAiRun: (id) => api.getAiRun!(id),
            aiSummaryTarget: api.aiSummaryTarget ? (channelId) => api.aiSummaryTarget!(channelId) : undefined,
            createAiAsk: api.createAiAsk ? (body) => api.createAiAsk!(body) : undefined,
            aiAskTarget: api.aiAskTarget ? (q, channelId) => api.aiAskTarget!(q, channelId) : undefined,
            aiRuns: api.aiRuns ? (kind) => api.aiRuns!(kind) : undefined,
          }
        : null,
      setStatus: (status) => deps.store.setAiStatus(status),
    });
  }

  /**
   * M49 (SYNC_PROTOCOL.md §7.8): the preview's message was deleted and the rows held do not say which one is last now:
   * the server's answer (GET /channels/{id}). A failure leaves it empty until the next bootstrap.
   */
  async refreshLastMessage(channelId: string): Promise<void> {
    const api = this.deps.api;
    if (!api.channel) return;
    try {
      const channel = await api.channel(channelId);
      this.deps.store.setFetchedLastMessage(channelId, channel.last_message ?? null);
    } catch (err) {
      console.warn("could not refresh the conversation's last message", err);
    }
  }

  /** M15d: my drafts across devices. */
  readonly drafts: DraftSync;
  /** M43: the conversations' canvases and the save loops of the open ones (CANVAS.md §4.4 / §4.6). */
  readonly canvases: CanvasHub;
  /** M51: the ranges of the calendar on screen and the channels' counts (CALENDAR.md §5). */
  readonly calendar: CalendarHub;
  /** M55: the boards, 「自分のタスク」 and calendar ranges on screen (TASKS.md §4). */
  readonly tasks: TaskHub;
  /** L8: the Times feed's rows, read while it is on screen (TIMES_FEED.md §5). */
  readonly timesFeed: TimesFeedHub;
  /** M65: the AI status and the summary on screen (docs/AI.md §5). */
  readonly ai: AiHub;

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
    this.notify();
  }

  /** Engine state the store does not carry changed (the status, a hold): views re-render. */
  private notify(): void {
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
      this.canvases.online(); // M43: canvas saves that failed, open canvases read again
      this.calendar.online(); // M51: the ranges on screen read again (CALENDAR.md §5)
      this.tasks.online(); // M55: the boards and lists on screen read again (TASKS.md §4)
      this.timesFeed.online(); // L8: a feed on screen reads its first page again (TIMES_FEED.md §5)
      this.ai.online(); // M65: the AI status, and an unfinished summary on screen read again (docs/AI.md §5)
      this.resendReads(); // §10: marks that did not reach the server
      // Open the conversation again: its links may have changed while away (M15f), and one opened while this
      // connection was starting (a tap during start-up) skipped its catch-up then; a synced one costs nothing.
      if (this.currentChannelId) void this.openChannel(this.currentChannelId);
      // A preview gets no events (§7.6.1): its latest page is read again, and one opened while offline (or whose first
      // page failed) loads now. Rows read before stay when the page reaches them (loadPreview).
      else if (this.preview && !this.preview.loading && this.deps.store.workspaceSettings.preview_before_join) void this.loadPreview(this.preview.channelId, null).catch((err: unknown) => console.warn("could not load the preview", err));
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
    this.completeThreads.clear();
    this.cancelSendRetry();
    this.canvases.stop();
    this.calendar.stop();
    this.tasks.stop();
    this.timesFeed.stop();
    this.dropSocket();
    this.setStatus("signed_out");
    this.deps.onSignedOut?.();
  }

  /** The app calls this after a successful refresh / network change to skip the backoff. */
  reconnectNow(): void {
    if (this.status === "offline" && !this.ws) void this.connect();
  }

  /**
   * M37 「再読み込み」 (pull to refresh): what a reconnect does over the live connection — bootstrap again, then catch the
   * open conversation up (SYNC_PROTOCOL.md §7.5). Offline, it skips the backoff instead. Correctness never depends on it.
   */
  async resync(): Promise<void> {
    if (this.status !== "online" || !this.ws) {
      this.reconnectNow();
      return;
    }
    const connection = this.connection;
    const live = () => this.connection === connection && this.status === "online";
    await this.enqueue(async () => {
      if (!live()) return;
      const bootstrap = await this.deps.api.bootstrap();
      if (!live()) return;
      this.applyBootstrap(bootstrap);
      await this.loadBrowsableChannels();
      if (this.currentChannelId && live()) await this.catchUp(this.currentChannelId);
    });
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
      this.canvasPresence.reset(); // a new connection knows nothing of what the last one said
      this.helloResolve?.();
      this.helloResolve = null;
      this.startHeartbeat(ws, (frame.heartbeat_interval_sec || 30) * 1000);
      // The server counts a new connection as in use (PUSH_NOTIFICATIONS.md §4.1): one that is not (a window in the
      // background reconnecting after sleep) says so at once, not a heartbeat later (the phone's pushes waited).
      if (this.deps.isActive && !this.deps.isActive()) ws.send(JSON.stringify({ type: "ping", active: false }));
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
    else if (frame.type === "canvas_presence") {
      // M72: volatile 「編集中」 (CANVAS.md §18.2), dropped after 45 s without a refresh.
      if (frame.user_id !== this.deps.store.me?.id) {
        this.deps.store.noteCanvasEditing(frame.canvas_id, frame.user_id, frame.editing, frame.section ?? null, this.deps.now ? Date.parse(this.deps.now()) : Date.now());
      }
    }
  }

  /**
   * M72 (CANVAS.md §18.2): I edit this canvas (the editor has the focus and is used; `section` is the caret's heading) or
   * stopped. Repeats go out at most every 20 s, changes at once; a stop only after a start went out.
   */
  setCanvasEditing(canvasId: string, editing: boolean, section: string | null = null): void {
    const ws = this.ws;
    if (!ws || this.status !== "online") return;
    const frame = this.canvasPresence.next(canvasId, editing, section, Date.now());
    if (!frame) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* volatile: the receivers drop it after 45 s anyway */
    }
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

  /**
   * Tells the server now whether the reader is using this device (the window lost or got focus, the tab was hidden),
   * not at the next heartbeat: the reader's phone gets its pushes at once (PUSH_NOTIFICATIONS.md §4.1).
   */
  reportActivity(): void {
    if (this.status !== "online" || !this.ws) return;
    try {
      this.ws.send(JSON.stringify({ type: "ping", active: this.deps.isActive?.() ?? true }));
    } catch {
      /* the next heartbeat carries it */
    }
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
      // M49: the preview too (null here does mean "no message yet", unlike other responses').
      const last_message = channel.last_message ?? null;
      store.upsertChannel(channel, channel.read_state ? { isMember: true, lastReadSeq: channel.read_state.last_read_seq, last_message } : { isMember: true, last_message });
    }
    for (const channel of [...store.channels.values()]) {
      if (channel.isMember && !seen.has(channel.id)) this.removeChannel(channel.id); // no longer a member
    }
    this.reapplyUnsentReads();
    if (bootstrap.threads) store.setThreadSummary(bootstrap.threads);
    // M39: the server's count after every (re)connect (SYNC_PROTOCOL.md §7.5); none from a server before M39.
    this.activityRefreshCancel?.();
    store.setActivity(bootstrap.activity ?? null);
    if (store.threadsLoaded) this.scheduleThreadRefresh(); // the list may have moved while we were away
    store.replacePresence(bootstrap.presence ?? []);
    store.replaceBookmarks(bootstrap.bookmarks ?? []);
    store.replaceFavorites(bootstrap.favorites ?? []);
    store.replaceCustomEmoji(bootstrap.custom_emoji ?? []);
    store.replaceEmojiPacks(bootstrap.emoji_packs ?? []);
    store.replaceRoster(bootstrap.roster ?? []);
    store.replaceGroups(bootstrap.groups ?? []);
    store.replaceTemplates(bootstrap.templates ?? []);
    store.replaceSidebar(bootstrap.sidebar_sections ?? []);
    this.drafts.applyBootstrap(bootstrap.drafts ?? []);
    this.applyWorkspaceSettings(bootstrap.workspace_settings);
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

  /**
   * M99 (docs/RESERVATIONS.md §6): the conversation's reservation pools; loaded when it opens, after reconnecting
   * (openChannel again) and on reservation.updated (the event carries no card: it differs per person).
   */
  async loadReservationPools(channelId: string): Promise<void> {
    if (!this.deps.api.reservationPools) return;
    try {
      this.deps.store.setReservationPools(channelId, await this.deps.api.reservationPools(channelId));
    } catch (err) {
      console.warn("could not load reservation pools", err);
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
  async markAllRead(scope?: ReadAllScope): Promise<void> {
    // L8: the Times feed's button reads only its channels (scope "times"); the request has no body otherwise.
    const states = scope ? await this.deps.api.readAll(scope) : await this.deps.api.readAll();
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
        if (!channel.isMember && !listedIds.has(channel.id)) this.removeChannel(channel.id);
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
        // A channel I made on another device: events carry no membership, but its creator is its owner, so the
        // owner-only actions show before the next bootstrap (the same rule on every client).
        const madeByMe =
          frame.event === "channel.created" &&
          isMember &&
          data.channel.type !== "dm" &&
          data.channel.type !== "group_dm" &&
          data.channel.created_by === store.me?.id &&
          !data.channel.membership &&
          !store.getChannel(data.channel.id)?.membership;
        if (madeByMe) store.upsertChannel(data.channel, { isMember, membership: { role: "owner", joined_at: data.channel.created_at } });
        else if (isMember || data.channel.type === "public") store.upsertChannel(data.channel, { isMember });
        else if (store.getChannel(data.channel.id)) this.removeChannel(data.channel.id); // made private (M15b)
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
        store.membersChanged(data.channel_id);
        return;
      }
      case "channel.member_updated": {
        // L4 (M31): an owner made or taken back. Mine moves the owner-only menus at once; open member lists load again.
        const data = frame.data as { channel_id: string; user_id: string; role: string };
        if (store.me && data.user_id === store.me.id) store.setMyRole(data.channel_id, data.role);
        store.membersChanged(data.channel_id);
        return;
      }
      case "channel.member_removed": {
        const data = frame.data as { channel_id: string; user_id: string };
        if (store.me && data.user_id === store.me.id) {
          this.removeChannel(data.channel_id);
          return;
        }
        const channel = store.getChannel(data.channel_id);
        if (channel && channel.member_count != null) store.updateChannel(data.channel_id, { member_count: Math.max(0, channel.member_count - 1) });
        store.membersChanged(data.channel_id);
        return;
      }
      case "user.created":
      case "user.updated":
      case "user.deactivated": {
        const data = frame.data as { user: UserPublic };
        store.upsertUser(data.user);
        // M50: about me and newer than what I hold: another of my devices changed my settings. The event carries only the
        // public fields, so the private ones (quick reactions, notification settings, keywords …) are read again.
        const me = store.me;
        if (me && data.user.id === me.id && Date.parse(data.user.updated_at) > Date.parse(me.updated_at)) void this.refreshMe();
        return;
      }
      case "notification_preference.updated": {
        // M35: `level` is resolved; follows_default / muted say what is the conversation's own (older servers: neither).
        const data = frame.data as { channel_id: string; level: NotificationLevel; muted_until?: string | null; follows_default?: boolean; muted?: boolean };
        store.applyNotificationPreference(data);
        return;
      }
      case "read.updated": {
        const data = frame.data as { channel_id: string } & ReadStateOut;
        this.applyReadState(data.channel_id, data, (data as { reason?: string }).reason === "set");
        return;
      }
      case "roster.updated": {
        const data = frame.data as { user_id: string; profile: LabProfileOut | null };
        store.applyRoster(data.user_id, data.profile);
        return;
      }
      case "emoji_pack.updated": {
        const data = frame.data as { pack: EmojiPackOut; deleted: boolean };
        store.applyEmojiPack(data.pack, data.deleted);
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
      case "reservation.updated": {
        // M99: read the pools again where they are held (a conversation opened so far).
        const data = frame.data as { channel_id: string; pool_id: string; deleted?: boolean };
        if (data.deleted) store.dropReservationPool(data.channel_id, data.pool_id);
        if (store.reservationPools.has(data.channel_id) || data.channel_id === this.currentChannelId) void this.loadReservationPools(data.channel_id);
        return;
      }
      case "draft.updated":
        this.drafts.applyEvent(frame.data as unknown as DraftUpdated);
        return;
      case "canvas.created":
      case "canvas.updated":
      case "canvas.deleted":
        this.canvases.applyEvent(frame.event, frame.data);
        return;
      case "calendar.event.updated":
      case "calendar.event.deleted":
      case "calendar.alarm.updated":
        this.calendar.applyEvent(frame.event, frame.data);
        return;
      case "task.updated":
      case "task.deleted":
      case "task.assigned":
      case "task.due":
      case "task.review_done":
      case "task.columns.updated":
        this.tasks.applyEvent(frame.event, frame.data);
        return;
      case "sidebar.updated": {
        const data = frame.data as { sections: SidebarSectionOut[] };
        store.replaceSidebar(data.sections);
        return;
      }
      case "template.updated": {
        const data = frame.data as { template: TemplateOut; deleted: boolean };
        store.applyTemplate(data.template, data.deleted);
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
        store.applyThreadState(this.withFloor(data));
        this.scheduleThreadRefresh();
        return;
      }
      case "activity.read": {
        // M39: my read position moved on another device (or by this one's PUT): the dots and the badge follow.
        const data = frame.data as { read_at: string };
        const current = store.activity;
        if (current && Date.parse(data.read_at) > Date.parse(current.read_at)) store.setActivity({ ...current, read_at: data.read_at });
        this.scheduleActivityRefresh();
        return;
      }
      case "reaction.added": {
        const data = frame.data as unknown as ReactionAdded;
        this.scheduleActivityRefresh();
        this.maybeNotifyReaction(data);
        return;
      }
      case "activity.updated": {
        // Review v0.1.22 #3: an erased canvas revision blanked these items' excerpts; the open list drops them now.
        const data = frame.data as { item_ids?: string[] };
        store.eraseActivityExcerpts(data.item_ids ?? []);
        return;
      }
      case "canvas.mentioned":
        // M76: an activity item too (the badge comes from the server, like a message's mention).
        this.scheduleActivityRefresh();
        this.maybeNotifyCanvasMention(frame.data as unknown as CanvasMentioned);
        return;
      case "notification.test":
        this.deps.onTestNotification?.(frame.data as unknown as NotificationTest);
        return;
      case "ai.run_updated":
        this.ai.applyEvent(frame.data as unknown as AiRunUpdated);
        return;
      case "session.revoked":
        this.signOut();
        return;
      case "workspace.settings_updated":
        this.applyWorkspaceSettings((frame.data as { settings: WorkspaceSettingsOut }).settings);
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
    // L8 (TIMES_FEED.md §5): whatever the timeline does with it, the feed takes it (a new row only while on screen).
    this.timesFeed.applyMessage(message, isNew);
    if (thread) this.timesFeed.applyParentThread(thread);
    if (isNew) {
      store.clearTyping(channel.id, message.parent_id ?? null, message.sender_id);
      this.noteLastMessage(channel.id, message);
      this.noteActivity(message, thread);
    }

    if (channel.syncedSeq === null) {
      // No timeline here: the channel list moves, and rows this device already holds take the event
      // (a thread opened from the threads view shows its new replies, §7.4).
      if (this.holds(channel.id, message)) store.upsertMessage(message);
      else store.applyLastMessage(message); // M49: the DM list's preview moves without a timeline too (§7.8)
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
      this.trimIfFull(channel.id);
      return;
    }
    if (seq > channel.syncedSeq + 1) {
      // A gap: the catch-up brings the rows lost with it and counts every one past what was counted so far (this one
      // too; §7.4 — before, only this one was counted and the lost ones waited for the next bootstrap).
      const countedTo = channel.lastSeq;
      store.updateChannel(channel.id, { lastSeq: Math.max(channel.lastSeq, seq) });
      await this.catchUp(channel.id, countedTo);
      this.trimIfFull(channel.id);
      if (isNew) this.maybeNotify(message, channel, thread);
    }
    // seq <= syncedSeq: already applied.
  }

  /**
   * The channel and its messages leave this device; its threads are no longer complete (§10.2). Callers outside
   * the engine (leaving a channel) use this rather than the store, or the threads would stay complete.
   */
  removeChannel(channelId: string): void {
    this.forgetThreads(channelId);
    // Nothing of it stays open: a conversation of mine (I was removed, bootstrap dropped it) or its preview (made
    // private while I read it). The screen drops the channel too, and a dead current id would keep suppressing its
    // notifications should I be added again.
    if (this.currentChannelId === channelId) this.currentChannelId = null;
    if (this.preview?.channelId === channelId) this.closePreview();
    this.canvases.removeChannel(channelId);
    this.calendar.removeChannel(channelId);
    this.tasks.removeChannel(channelId);
    this.timesFeed.removeChannel(channelId);
    this.deps.store.removeChannel(channelId);
  }

  private forgetThreads(channelId: string): void {
    for (const [parentId, owner] of [...this.completeThreads]) if (owner === channelId) this.completeThreads.delete(parentId);
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

  /**
   * §7.4 / §10.1 12.: a row the server counts is unread until read.updated says otherwise. My own rows never are, and
   * their events leave the read position alone (11.): this device's POST moves it, another device's post brings a
   * read.updated, and a scheduled send (M12d) reads nothing on the server either.
   */
  private countUnread(message: MessageOut): void {
    const store = this.deps.store;
    const me = store.me;
    const channel = store.getChannel(message.channel_id);
    if (!me || !channel || !countsAsUnread(message, me.id) || message.seq <= channel.lastReadSeq) return;
    const mentioned = mentionsMe(message, me);
    store.updateChannel(channel.id, {
      unreadCount: channel.unreadCount + 1,
      mentionCount: channel.mentionCount + (mentioned ? 1 : 0),
      // §10.1: the first unread message starts the banner's 「… 以降」; later ones leave it.
      ...(channel.unreadCount === 0 ? { firstUnreadAt: message.created_at } : {}),
    });
  }

  private applyReadState(channelId: string, state: ReadStateOut, allowDecrease = false): void {
    const channel = this.deps.store.getChannel(channelId);
    if (!channel) return;
    // Advances merge with max (an event for an older PUT may arrive after a newer local mark);
    // a mark-as-unread (reason "set") moves the position down as well.
    const reached = channel.pendingReadSeq !== null && state.last_read_seq >= channel.pendingReadSeq;
    // §10: a set below an advance this device has not sent yet drops that advance and its waiting PUT: sent, it would
    // move the position the other device just lowered back up (iOS and Android drop it the same way).
    const undone = allowDecrease && channel.pendingReadSeq !== null && state.last_read_seq < channel.pendingReadSeq;
    if (undone) this.readCancels.get(channelId)?.();
    this.deps.store.updateChannel(channelId, {
      lastReadSeq: allowDecrease ? state.last_read_seq : Math.max(channel.lastReadSeq, state.last_read_seq),
      unreadCount: state.unread_count,
      mentionCount: state.mention_count,
      firstUnreadAt: state.first_unread_at ?? null,
      ...(reached || undone ? { pendingReadSeq: null } : {}),
    });
    if (state.unread_count === 0) this.deps.onRead?.(channelId);
  }

  /**
   * Same rule as the server's PushPlanner (PUSH_NOTIFICATIONS.md §4): the conversation's own level, else my overall
   * setting (M35: DMs every message unless it is "none", someone else's times mentions); "none", a mute until unmuted or
   * a timed mute silence everything; "mentions" when I am mentioned or take part in the thread. A reply only in its
   * thread notifies its followers and the people it mentions only, and never one who unfollowed it by hand (notifies()).
   */
  private maybeNotify(message: MessageOut, channel: ChannelState, thread: ParentThread | null = null): void {
    const store = this.deps.store;
    const me = store.me;
    if (!me || message.sender_id === me.id) return;
    const parentId = message.parent_id ?? null;
    const reply: ReplyKind = !parentId ? "none" : message.also_in_channel ? "also_in_channel" : "thread_only";
    const participants = thread?.participant_ids;
    const mentioned = (message.mentioned_user_ids ?? []).includes(me.id);
    const keyword = mentionsMe({ body: message.body }, me);
    // The event's followers; without them (no parent_thread, an older server) what the store knows of the thread.
    const follower = participants ? participants.includes(me.id) : !!parentId && store.threads.get(parentId)?.state.following === true;
    // The server makes everyone a mention or keyword hit names a follower unless they unfollowed by hand: such a hit
    // that left me out of the followers means I did (keyword hits of others are private, so only mine can tell).
    const unfollowed = reply === "thread_only" && !!participants && (mentioned || keyword) && !participants.includes(me.id);
    const ok = notifies({
      level: effectiveNotificationLevel(channel, me.id, overallLevel(me)),
      muted: isMutedChannel(channel),
      reply,
      follower,
      unfollowed,
      mentioned,
      mentionAll: message.mention_all === true,
      keyword,
      type: message.type,
    });
    if (!ok) return;
    if (this.deps.isActive?.() && this.currentChannelId === channel.id) return;
    this.deps.onNotify?.(message, channel);
  }

  /**
   * M39: a new message that is activity of mine (it mentions me, or it is someone's reply in a thread I follow) moves the
   * badge: the count is the server's (GET /activity/summary, debounced), never guessed here.
   */
  private noteActivity(message: MessageOut, thread: ParentThread | null): void {
    const store = this.deps.store;
    const me = store.me;
    if (!me || store.activity === null || message.sender_id === me.id) return;
    const parentId = message.parent_id;
    const following = !!parentId && ((thread?.participant_ids ?? []).includes(me.id) || store.threads.get(parentId)?.state.following === true);
    if (following || mentionsMe(message, me)) this.scheduleActivityRefresh();
  }

  /**
   * M39, the reaction banner (PUSH_NOTIFICATIONS.md §4, `reaction.added`): only with `notify_reactions` on, never in a
   * conversation whose level comes to "none" or that is muted, nor in the one I am looking at.
   */
  private maybeNotifyReaction(reaction: ReactionAdded): void {
    const me = this.deps.store.me;
    if (!me || me.notify_reactions !== true || reaction.user_id === me.id) return;
    const channel = this.deps.store.getChannel(reaction.channel_id);
    if (!channel || !channel.isMember) return;
    if (effectiveNotificationLevel(channel, me.id, overallLevel(me)) === "none" || isMutedChannel(channel)) return;
    if (this.deps.isActive?.() && this.currentChannelId === channel.id) return;
    this.deps.onReaction?.(reaction, channel);
  }

  /**
   * M72 (CANVAS.md §18.1): a canvas newly mentions me. Like a message's mention: never in a conversation whose level comes
   * to "none" or that is muted (the level "mentions" lets it through: it is one).
   */
  private maybeNotifyCanvasMention(mention: CanvasMentioned): void {
    const me = this.deps.store.me;
    if (!me || mention.by_user_id === me.id) return;
    const channel = this.deps.store.getChannel(mention.channel_id);
    if (!channel || !channel.isMember) return;
    if (effectiveNotificationLevel(channel, me.id, overallLevel(me)) === "none" || isMutedChannel(channel)) return;
    this.deps.onCanvasMention?.(mention, channel);
  }

  private scheduleActivityRefresh(): void {
    if (!this.deps.api.activitySummary || this.deps.store.activity === null) return;
    this.activityRefreshCancel?.();
    let cancelled = false;
    this.activityRefreshCancel = () => {
      cancelled = true;
    };
    this.activityRefresh = (async () => {
      await (this.deps.sleep ?? defaultSleep)(this.opts.activityRefreshMs);
      if (cancelled || this.status !== "online") return;
      this.activityRefreshCancel = null;
      await this.refreshActivity();
    })();
  }

  /** M50: my own settings again (GET /users/me), kept only when still newer than what the store holds. */
  async refreshMe(): Promise<void> {
    const api = this.deps.api;
    if (!api.me) return;
    try {
      const fresh = await api.me();
      const held = this.deps.store.me;
      if (held && held.id === fresh.id && Date.parse(fresh.updated_at) >= Date.parse(held.updated_at)) this.deps.store.setMe(fresh);
    } catch {
      // the next bootstrap brings them
    }
  }

  /** M39: the activity badge from the server (a server before M39 has none: nothing to refresh). */
  async refreshActivity(): Promise<void> {
    const api = this.deps.api;
    if (!api.activitySummary || this.deps.store.activity === null) return;
    try {
      this.deps.store.setActivity(await api.activitySummary());
    } catch {
      // the next event or bootstrap refreshes again
    }
  }

  /** Waits for the debounced activity refresh (tests). */
  async flushActivity(): Promise<void> {
    await this.activityRefresh;
  }

  /**
   * M39: everything in the activity up to `readAt` is read (「すべて既読」, or the newest item the view showed). The server
   * only moves it forward; its answer is the new badge, and my other devices get activity.read.
   */
  async markActivityRead(readAt: string): Promise<void> {
    const api = this.deps.api;
    if (!api.markActivityRead) return;
    this.activityRefreshCancel?.();
    this.deps.store.setActivity(await api.markActivityRead(readAt));
  }

  // --- §7.3 catch_up ----------------------------------------------------------------------

  openChannel(channelId: string): Promise<void> {
    const previous = this.currentChannelId;
    this.currentChannelId = channelId;
    if (previous !== null && previous !== channelId) this.trimLater(previous);
    for (const held of [...this.unreadHold.keys()]) if (held !== channelId) this.unreadHold.delete(held);
    this.closePreview(); // another conversation, or the previewed one just joined (§7.6.1)
    if (this.status !== "online") return Promise.resolve();
    void this.loadLinks(channelId);
    void this.loadReservationPools(channelId);
    if (this.deps.store.getChannel(channelId)?.isMember) void this.canvases.loadList(channelId); // M43 (CANVAS.md §4.6)
    return this.enqueue(async () => {
      const channel = this.deps.store.getChannel(channelId);
      // Only a channel of mine: one I have not joined is read through openPreview, never into the store.
      if (!channel || !channel.isMember) return;
      if (channel.syncedSeq === null || channel.syncedSeq < channel.lastSeq) await this.catchUp(channelId);
      // Read position is owned by the visible timeline, not navigation or sync.
    });
  }

  /**
   * M34: no conversation is on screen (a phone's list, or a tab's root): none is open, so its new messages notify
   * again and its rows may be trimmed. A "mark unread" hold stays for when it opens again.
   */
  closeChannel(): void {
    const previous = this.currentChannelId;
    this.currentChannelId = null;
    if (previous !== null) this.trimLater(previous);
    this.closePreview();
  }

  /**
   * M88 (docs/MEMBERSHIP.md §3): the workspace settings. A preview open when 「参加前にチャンネルの中を見られる」 changes
   * follows at once: off, its rows go and the 「参加するとメッセージを読めます」 panel shows; on, its page loads.
   */
  private applyWorkspaceSettings(settings: WorkspaceSettingsOut | null | undefined): void {
    const store = this.deps.store;
    const before = store.workspaceSettings.preview_before_join;
    store.setWorkspaceSettings(settings);
    const after = store.workspaceSettings.preview_before_join;
    const preview = this.preview;
    if (!preview || before === after) return;
    if (!after) {
      this.previewGen += 1; // pages and threads still on their way are stale now (Review v0.1.22 #6)
      this.setPreview({ ...preview, messages: [], hasOlder: false, loaded: false, loading: false, refused: true, replies: new Map(), parents: new Map() });
    } else if (this.status === "online") void this.loadPreview(preview.channelId, null).catch((err: unknown) => console.warn("could not load the preview", err));
  }

  // --- §7.6.1 preview before joining -----------------------------------------------------

  /**
   * Open a public channel I have not joined, read-only: its latest page in memory (ChannelPreview), nothing in the
   * store. No conversation of mine is open meanwhile (no catch-up, read marks or links for it). Offline, the page loads
   * once the connection is back.
   */
  openPreview(channelId: string): Promise<void> {
    const previous = this.currentChannelId;
    this.currentChannelId = null;
    if (previous !== null) this.trimLater(previous);
    this.unreadHold.clear();
    if (this.preview?.channelId === channelId) return Promise.resolve(); // already open (a re-render, a reconnect)
    // M88: with the preview off nothing is asked for; the panel says to join (the server would answer 403 anyway).
    const refused = !this.deps.store.workspaceSettings.preview_before_join;
    this.previewGen += 1;
    this.setPreview({ channelId, messages: [], hasOlder: false, loaded: false, loading: false, refused, replies: new Map(), parents: new Map() });
    if (refused || this.status !== "online") return Promise.resolve();
    return this.loadPreview(channelId, null);
  }

  /** Scroll-up paging of the preview: the page before its oldest row. */
  loadPreviewOlder(): Promise<void> {
    const preview = this.preview;
    const oldest = preview?.messages[0]?.seq;
    if (!preview || !preview.loaded || !preview.hasOlder || preview.loading || oldest === undefined) return Promise.resolve();
    return this.loadPreview(preview.channelId, oldest);
  }

  /** 「再読み込み」 after the first page failed. */
  retryPreview(): Promise<void> {
    const preview = this.preview;
    if (!preview || preview.loading || this.status !== "online") return Promise.resolve();
    return this.loadPreview(preview.channelId, null);
  }

  /** The preview goes (another conversation opened, it was joined, or it closed). */
  closePreview(): void {
    if (!this.preview) return;
    this.previewGen += 1;
    this.setPreview(null);
  }

  /**
   * Review v0.1.22 #6: a response for the preview of `channelId` asked for at generation `gen` may still be written:
   * the same preview is open, nothing made it stale since, and the setting still allows previews.
   */
  private previewCurrent(channelId: string, gen: number): ChannelPreview | null {
    const current = this.preview;
    if (gen !== this.previewGen || current?.channelId !== channelId || !this.deps.store.workspaceSettings.preview_before_join) return null;
    return current;
  }

  /** The server refused the preview (403): the panel says to join, and anything else on its way is stale. */
  private refusePreview(channelId: string): void {
    this.previewGen += 1;
    this.patchPreview(channelId, { loading: false, refused: true });
  }

  /** A thread opened from the preview: its replies, and its parent when the preview does not hold it. */
  async loadPreviewThread(parentId: string): Promise<void> {
    const preview = this.preview;
    if (!preview || preview.refused || !this.deps.store.workspaceSettings.preview_before_join) return;
    const gen = this.previewGen;
    const held = preview.messages.some((m) => m.id === parentId) || preview.parents.has(parentId);
    let replies: MessageOut[];
    let parent: MessageOut | null;
    try {
      [replies, parent] = await Promise.all([
        this.deps.api.replies(parentId),
        held || !this.deps.api.getMessage ? Promise.resolve(null) : this.deps.api.getMessage(parentId),
      ]);
    } catch (error) {
      if (!this.previewCurrent(preview.channelId, gen)) return; // stale: closed, turned off or refused meanwhile
      if (error instanceof ApiError && error.status === 403) return this.refusePreview(preview.channelId);
      throw error;
    }
    // Another conversation opened, the setting turned off or the server refused meanwhile: nothing is written back.
    const current = this.previewCurrent(preview.channelId, gen);
    if (!current) return;
    const threads = new Map(current.replies);
    threads.set(parentId, replies.filter((m) => !m.deleted).sort((a, b) => a.seq - b.seq));
    const parents = parent && !parent.deleted ? new Map(current.parents).set(parentId, parent) : current.parents;
    this.setPreview({ ...current, replies: threads, parents });
  }

  /**
   * A page of the preview: an older one (`beforeSeq`) goes before the rows. The latest one replaces them, except after a
   * reconnect when it reaches a row already read: the rows before it stay (nothing between was missed, the page is
   * contiguous), only what is newer is added. Missing more than a page (no overlap) starts over from the page.
   */
  private async loadPreview(channelId: string, beforeSeq: number | null): Promise<void> {
    if (!this.deps.store.workspaceSettings.preview_before_join) return; // off: the panel says to join, nothing is asked
    const gen = this.previewGen;
    this.patchPreview(channelId, { loading: true });
    let page: HistoryOut;
    try {
      page = await this.deps.api.history(channelId, beforeSeq, this.opts.pageSize);
    } catch (error) {
      // Closed, turned off or refused meanwhile: nobody is looking at these rows, no toast (Review v0.1.22 #6).
      if (!this.previewCurrent(channelId, gen)) return;
      if (error instanceof ApiError && error.status === 403) return this.refusePreview(channelId);
      this.patchPreview(channelId, { loading: false, refused: false });
      throw error;
    }
    const current = this.previewCurrent(channelId, gen);
    if (!current) return;
    const rows = page.messages.filter((m) => !m.deleted).sort((a, b) => a.seq - b.seq);
    const newest = current.messages[current.messages.length - 1];
    const joins = beforeSeq === null && current.loaded && rows.length > 0 && newest !== undefined && rows[0]!.seq <= newest.seq;
    const messages = joins ? [...current.messages.filter((m) => m.seq < rows[0]!.seq), ...rows] : beforeSeq === null ? rows : [...rows, ...current.messages];
    this.setPreview({ ...current, messages, hasOlder: joins ? current.hasOlder && page.has_more : page.has_more, loaded: true, loading: false, refused: false });
  }

  private setPreview(preview: ChannelPreview | null): void {
    this.preview = preview;
    this.notify();
  }

  private patchPreview(channelId: string, patch: Partial<ChannelPreview>): void {
    if (this.preview?.channelId === channelId) this.setPreview({ ...this.preview, ...patch });
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
    // §10.1 10.: forward only while every unread row in between is held, or it would read all of them unseen on every
    // device. Otherwise the position stays and only the hold (no visible-range reads) takes effect.
    if (target > channel.lastReadSeq && !rangeReady(channel)) {
      this.unreadHold.set(channelId, channel.lastReadSeq);
      this.notify();
      return;
    }
    this.unreadHold.set(channelId, target);
    this.readCancels.get(channelId)?.();
    const me = store.me;
    const later = store.messages(channelId).filter((m) => m.seq !== null && m.seq > target && countsAsUnread(m, me?.id));
    store.updateChannel(channelId, {
      pendingReadSeq: null, // an unsent advance must not undo this
      lastReadSeq: target,
      unreadCount: later.length,
      mentionCount: me ? later.filter((m) => mentionsMe(m, me)).length : 0,
      firstUnreadAt: later[0]?.created_at ?? null,
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
   * §10.1: a visible-range mark does nothing while the unread rows are not all held, older or newer (it would skip
   * unread messages never shown); `force` (Esc, the banner's 「既読にする」) reads regardless.
   */
  markRead(channelId: string, seq: number, options: { force?: boolean } = {}): void {
    if (this.status !== "online" || this.deps.isActive?.() === false) return;
    if (options.force) this.unreadHold.delete(channelId);
    else if (this.unreadHold.has(channelId)) return;
    const store = this.deps.store;
    const channel = store.getChannel(channelId);
    if (!channel || !channel.isMember || seq <= channel.lastReadSeq) return;
    if (!options.force && !rangeReady(channel)) return;
    store.updateChannel(channelId, seq >= channel.lastSeq ? { lastReadSeq: seq, pendingReadSeq: seq, unreadCount: 0, mentionCount: 0, firstUnreadAt: null } : { lastReadSeq: seq, pendingReadSeq: seq });
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
      else store.updateChannel(channel.id, pending >= channel.lastSeq ? { lastReadSeq: pending, unreadCount: 0, mentionCount: 0, firstUnreadAt: null } : { lastReadSeq: pending });
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
      const items = page.items.map((item) => ({ ...item, state: this.withFloor(item.state) }));
      store.setThreadPage(filter, items, page.next_cursor ?? null, { append: cursor !== null, pageSize: this.opts.threadPageSize });
      store.setThreadSummary(page.summary);
    });
  }

  /** A thread opened from a channel: fetch my relation to it (follow flag, read position). */
  loadThreadState(parentId: string, parent?: MessageOut): Promise<void> {
    return this.enqueue(async () => {
      if (this.status !== "online") return;
      this.deps.store.applyThreadState(this.withFloor(await this.deps.api.threadState(parentId)), parent);
    });
  }

  /**
   * §10.2: a server state, but never behind what this device has read in the thread (the PUT may be debounced, in
   * flight or waiting to be resent). Lowering it would put the first unread reply above the screen again.
   */
  private withFloor<T extends ThreadState>(state: T): T {
    const floor = this.threadReadFloor.get(state.parent_id) ?? 0;
    return floor > state.last_read_seq ? { ...state, last_read_seq: floor } : state;
  }

  /**
   * The reply with `seq` was shown: the thread position moves now (monotonic) and is sent after a debounce.
   * §10.2: ignored until the whole thread was fetched here, or it could skip older unread replies never loaded.
   */
  markThreadRead(parentId: string, seq: number): void {
    if (this.status !== "online" || this.deps.isActive?.() === false) return;
    if (!this.completeThreads.has(parentId)) return;
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
      await this.enqueue(async () => this.deps.store.applyThreadState(this.withFloor(state)));
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
      this.deps.store.applyThreadState(this.withFloor(state));
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

  /**
   * §7.3, and §7.4 for the count: the unread count covers the rows up to `countedTo` (the bootstrap's and the live
   * events'); what the catch-up brings past it, up to the new synced seq, is counted here — their events were lost, and
   * nothing else counts them until the next bootstrap. The channel's last seq when not given (a reconnect's catch-up
   * after the bootstrap counted everything).
   */
  async catchUp(channelId: string, countedTo?: number): Promise<void> {
    const store = this.deps.store;
    const before = store.getChannel(channelId);
    if (!before || !before.isMember) return;
    const counted = countedTo ?? before.lastSeq;
    const brought = new Map<string, MessageOut>(); // by id: a row changed between two pages counts once, as it is now
    await this.catchUpRows(channelId, brought);
    const synced = store.getChannel(channelId)?.syncedSeq ?? counted;
    for (const message of [...brought.values()].filter((m) => m.seq > counted && m.seq <= synced).sort((a, b) => a.seq - b.seq)) this.countUnread(message);
  }

  private async catchUpRows(channelId: string, brought: Map<string, MessageOut>): Promise<void> {
    const store = this.deps.store;
    this.stats.catchUps += 1;
    let channel = store.getChannel(channelId);
    // The member path only: a channel I have not joined is never loaded into the store (§7.6.1, its preview is apart).
    if (!channel || !channel.isMember) return;
    if (channel.syncedSeq !== null && channel.lastSeq - channel.syncedSeq > this.opts.gapLimit) {
      this.reloads.set(channelId, this.reloadCount(channelId) + 1);
      this.forgetThreads(channelId);
      store.clearMessages(channelId);
      channel = store.updateChannel(channelId, { syncedSeq: null, oldestLoadedSeq: null, hasOlder: true }) ?? channel;
      this.stats.reloads += 1;
    }
    if (channel.syncedSeq === null) {
      const page = await this.deps.api.history(channelId, null, this.opts.pageSize);
      for (const message of page.messages) {
        store.upsertMessage(message);
        brought.set(message.id, message);
      }
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
      for (const message of delta.messages) {
        store.upsertMessage(message);
        brought.set(message.id, message);
      }
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

  /**
   * §7.7: a view of the channel's rows other than the open conversation (a thread pane) keeps them whole until the
   * returned function releases it.
   */
  viewing(channelId: string): () => void {
    this.views.set(channelId, (this.views.get(channelId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.views.get(channelId) ?? 1) - 1;
      if (left > 0) this.views.set(channelId, left);
      else {
        this.views.delete(channelId);
        this.trimLater(channelId);
      }
    };
  }

  private shown(channelId: string): boolean {
    return channelId === this.currentChannelId || this.views.has(channelId);
  }

  /** §7.7, in the queue: after any page still loading for the channel (a page landing after the trim would leave a gap). */
  private trimLater(channelId: string): void {
    void this.enqueue(async () => this.trim(channelId));
  }

  /** Live rows piling up in a channel nobody looks at: trimmed once they pass the cap by a margin (not on every row). */
  private trimIfFull(channelId: string): void {
    if (this.deps.store.heldCount(channelId) > CACHED_MESSAGES_PER_CHANNEL + TRIM_MARGIN) this.trim(channelId);
  }

  private trim(channelId: string): void {
    if (this.shown(channelId)) return;
    // A thread whose older replies went is no longer complete (§10.2): opening it fetches them again.
    if (this.deps.store.trimMessages(channelId)) this.forgetThreads(channelId);
  }

  /** How many §7.3 reloads replaced the channel's rows since start-up (an open view compares it, §10.1 2.). */
  reloadCount(channelId: string): number {
    return this.reloads.get(channelId) ?? 0;
  }

  /** §10.1: visible rows may move the read position (nothing unread, or every unread row is held). */
  readRangeReady(channelId: string): boolean {
    const channel = this.deps.store.getChannel(channelId);
    return !!channel && rangeReady(channel);
  }

  /**
   * 「最初の未読へ」 (§10.1): pages backwards from the loaded range, like loadOlder, until it reaches the read
   * position as it was when pressed (at most JUMP_MAX_PAGES pages of JUMP_PAGE_SIZE). The range stays one
   * contiguous block, so nothing else changes. True once the first unread row is held; a false result leaves
   * the banner, and pressing again goes on from there. Errors reach the caller.
   */
  async loadFirstUnread(channelId: string): Promise<boolean> {
    const target = this.deps.store.getChannel(channelId)?.lastReadSeq ?? 0;
    let reached = false;
    await this.enqueue(async () => {
      const store = this.deps.store;
      let channel = store.getChannel(channelId);
      if (!channel || channel.oldestLoadedSeq === null) return; // the first page has not arrived
      let pages = 0;
      while (
        !covers(channel.oldestLoadedSeq, target) && channel.hasOlder && (channel.oldestLoadedSeq ?? 0) > 0 &&
        pages < JUMP_MAX_PAGES && this.status === "online" && this.currentChannelId === channelId
      ) {
        const page = await this.deps.api.history(channelId, channel.oldestLoadedSeq, JUMP_PAGE_SIZE);
        for (const message of page.messages) store.upsertMessage(message);
        channel = store.updateChannel(channelId, loadedRange(page)) ?? channel;
        pages += 1;
      }
      reached = covers(channel.oldestLoadedSeq, target);
    });
    return reached;
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

  /**
   * Opening a thread: fetch its replies (live ones keep arriving as timeline events, §7.4). True only when
   * the GET succeeded: the thread is then complete (§10.2); offline gives false, errors reach the caller.
   */
  async loadReplies(channelId: string, parentId: string): Promise<boolean> {
    this.loadedThreads.add(parentId);
    let loaded = false;
    await this.enqueue(async () => {
      if (this.status !== "online") return;
      for (const reply of await this.deps.api.replies(parentId)) this.deps.store.upsertMessage(reply);
      this.completeThreads.set(parentId, channelId);
      loaded = true;
    });
    return loaded;
  }

  /** §10.2: every reply of the thread is held (GET replies succeeded and nothing cleared them since). */
  threadComplete(parentId: string): boolean {
    return this.completeThreads.has(parentId);
  }

  /**
   * A thread whose parent this device does not hold: one opened from the preview and kept open after joining (§7.6.1),
   * when the parent is older than the page the conversation loaded. Fetched into the store, so the pane shows it and its
   * events apply (§7.4). False offline, when the server has no such message, or when it is not this channel's.
   */
  async loadParent(channelId: string, parentId: string): Promise<boolean> {
    if (this.status !== "online" || !this.deps.api.getMessage) return false;
    let message: MessageOut;
    try {
      message = await this.deps.api.getMessage(parentId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return false; // deleted meanwhile: the pane says so
      throw error;
    }
    if (message.channel_id !== channelId || message.deleted) return false;
    this.deps.store.upsertMessage(message);
    return true;
  }

  /** 「再送」 on one failed message: that message only (others stay failed until their own 再送). */
  retryFailed(clientMsgId: string): Promise<void> {
    const item = this.deps.store.outbox.find((i) => i.client_msg_id === clientMsgId);
    if (item?.failed) this.deps.store.clearOutboxFailed(clientMsgId);
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
        if (!item.parent_id && result.created) this.readOwnPost(item.channel_id, result.message.seq);
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

  /**
   * §10.1 11.: a top-level post this device made through an endpoint of its own rather than the outbox (a poll, M14b)
   * reads the channel like a send: the server read it up to the post in the same transaction. Before, the position
   * waited for read.updated, as for a post from another device.
   */
  postedFromHere(message: MessageOut): void {
    this.deps.store.upsertMessage(message);
    if (!message.parent_id) this.readOwnPost(message.channel_id, message.seq);
  }

  /**
   * §10.1 11.: my top-level post went through, and the server read the channel up to it in the same transaction. Only
   * here, never on my own message.created: a scheduled send (M12d) does not read, and a position moved by its event
   * would let the next visible row skip unread rows never shown. Replies leave the channel's position alone.
   * Only for a post created by this POST (the caller checks): a replay whose first answer was lost reads nothing, and
   * bootstrap or read.updated already brought what the first one read. Zeroing the count there would let the view
   * anchor with unread rows never shown.
   */
  private readOwnPost(channelId: string, seq: number): void {
    const store = this.deps.store;
    const channel = store.getChannel(channelId);
    if (!channel) return;
    this.unreadHold.delete(channelId);
    const position = Math.max(channel.lastReadSeq, seq);
    if (seq >= channel.lastSeq) {
      store.updateChannel(channelId, { lastReadSeq: position, unreadCount: 0, mentionCount: 0, firstUnreadAt: null });
      return;
    }
    // Rows from others came after my post, before its answer: they stay unread. Counted again here only when every one
    // of them is held; otherwise the count is left to the server's values (read.updated, bootstrap).
    if (!covers(channel.oldestLoadedSeq, position) || !caughtUp(channel)) {
      store.updateChannel(channelId, { lastReadSeq: position });
      return;
    }
    const me = store.me;
    const later = store.messages(channelId).filter((m) => m.seq !== null && m.seq > position && countsAsUnread(m, me?.id));
    store.updateChannel(channelId, {
      lastReadSeq: position,
      unreadCount: later.length,
      mentionCount: me ? later.filter((m) => mentionsMe(m, me)).length : 0,
      firstUnreadAt: later[0]?.created_at ?? null,
    });
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
