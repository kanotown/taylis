import { ApiError, isRetryable, NetworkError } from "./errors";
import { acceptLanguage } from "../i18n";
import type { ActivityFilter, ActivityListOut, ActivitySummaryOut, AckPendingOut, AckRemindOut, AdminUserCreate, AdminUserCreated, AdminUserOut, AdminUserUpdate, AttachmentOut, AuthMethodsOut, BookmarkListOut, BookmarkStateOut, BootstrapOut, CallOut, CalendarEventCreate, CalendarEventOut, CalendarEventUpdate, CalendarFeedCreated, CalendarFeedOut, CalendarFeedScope, CalendarOccurrenceUpdate, CanvasCreate, CanvasMeta, CanvasOut, CanvasPage, CanvasRevisionMeta, CanvasRevisionOut, CanvasRevisionPage, CanvasSaveIn, CanvasSaveOut, CanvasSearchOut, CanvasTemplateCreate, CanvasTemplateOut, CanvasTemplateUpdate, CanvasUpdate, ChannelLinkOut, ChannelOut, ChannelReadStateOut, ChannelUpdate, CustomEmojiOut, CustomEmojiUpdate, DeltaOut, DmPinStateOut, EmojiPackImportOut, EmojiPackOut, TextEmojiCreate, DraftOut, FavoriteStateOut, FeedBotOut, FeedBotUpdate, FeedCreate, FeedOut, FeedUpdate, FileListOut, GroupCreate, GroupOut, GroupUpdate, HistoryOut, InviteAccept, InviteCreate, InviteCreated, InviteOut, InvitePreviewOut, LabProfileOut, LabProfilePut, LinkPreviewOut, MemberOut, MemberRole, MentionListOut, MessageOut, MessageRevisionOut, MyLabProfileUpdate, NotificationLevel, NotificationPreferenceOut, OccurrenceScope, PollAnswersIn, PollCreate, PoolCreate, PoolOut, PoolUpdate, ReadAllScope, ReadStateOut, RecurringPostCreate, RecurringPostOut, RecurringPostUpdate, RecurringRunOut, ReminderCreate, ReminderOut, RolloverApply, RolloverOut, RolloverPreviewOut, ScheduledCreate, ScheduledOut, SearchOut, ServerInfoOut, SessionOut, DefaultSectionKey, SidebarDefaultOut, SidebarSort, SidebarSectionOut, TemplateCreate, TemplateOut, SubtaskUpdate, TaskColumnCreate, TaskColumnOut, TaskColumnUpdate, TaskCreate, TaskMove, TaskOut, TaskUpdate, TemplateUpdate, TemporaryPasswordOut, ThreadFilter, ThreadListOut, ThreadState, TimesFeedOut, TokenResponse, TotpEnabledOut, TotpSetupOut, TotpStatusOut, UnreadSummaryOut, UserMe, UserPublic, UserUpdate, WebhookCreate, WebhookCreated, WebhookOut, WebhookUpdate, AdminWorkspaceSettingsOut, WorkspaceSettingsUpdate, DefaultChannelsApplyOut, WorkflowCreate, WorkflowOut, WorkflowSubmit, WorkflowTemplateOut, WorkflowUpdate, AdminPageOut, PageCreate, PageItem, PageMeta, PageMove, PageOut, PageRef, PageRevisionMeta, PageRevisionOut, PageRevisionPage, PageSaveIn, PageSaveOut, PageSearchOut, PageUpdate, WikiAccessOut, WikiAccessUpdate, WikiChangesOut, WikiMoveOut, WikiTreeOut } from "./types";
import type { AiAgentCreate, AiAgentOut, AiAgentUpdate, AiAskCreate, AiAskTargetOut, AiProviderOut, AiRunOut, AiStatusOut, AiSummaryCreate, AiSummaryTargetOut, AiUsageOut } from "./ai";
import type { SendOptions } from "../sync/types";
import type { TestNotificationOut } from "./types";
import type { AccountDeletion, AdminReportOut, BlockOut, BlockStateOut, GeneralReportAck, GeneralReportCreate, ReportAck, ReportCreate } from "./types";
import type { AnalyticsMembersOut, AnalyticsMembersQuery, AnalyticsOverviewOut } from "./types";

/**
 * M76 (CANVAS.md §20): the activity kinds this client shows beyond M39's (the server sends canvas_mention items, and
 * counts them in the badge, only to clients that name them; an older server ignores the parameter).
 */
export const ACTIVITY_INCLUDE = ["canvas_mention", "reservation", "page_mention", "page_shared"] as const;
/** M112: ACTIVITY_INCLUDE as repeated query parameters (`include=canvas_mention&include=reservation`). */
const includeQuery = (name: string): string => ACTIVITY_INCLUDE.map((kind) => `${name}=${kind}`).join("&");

/** The refresh token's stand-in in the browser (M12j): the real one is an HttpOnly cookie. */
export const COOKIE_SESSION = "cookie";
/** Sent with cookie refreshes; a cross-site form cannot add it (SECURITY.md §2.3). */
export const REQUESTED_WITH = "ChikuwaChat";

export interface DeviceInfo {
  platform: "desktop" | "ios" | "android" | "web";
  device_name?: string | null;
  app_version?: string | null;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  /** Called when the session is gone (refresh failed); the app returns to the login screen. */
  onSignedOut?: () => void;
  /** Called after login / refresh so the app can persist the new refresh token. */
  onTokens?: (tokens: TokenResponse) => void;
  /** The wait between refresh attempts (tests). */
  sleep?: (ms: number) => Promise<void>;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type RequestOptions = { auth?: boolean; retry401?: boolean; headers?: Record<string, string>; timeoutMs?: number; /** M121: sees the response's headers (an ETag). */ onResponse?: (response: Response) => void };

/** A JSON request that has not answered by then fails like a network error (the phones' limit too). */
export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * §7.2: a refresh rotates the token, and the old one used more than this long after fails for good (reuse detection,
 * SECURITY.md §2.3). A refresh that fails on the network is therefore tried again soon, each attempt short, all of
 * them starting within the grace: the reconnect backoff alone would space them past it and end in a logout.
 */
export const REFRESH_GRACE_MS = 30_000;
export const REFRESH_TIMEOUT_MS = 10_000;
export const REFRESH_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** Thin HTTP client: bearer auth, single-flight refresh on token_expired, structured errors. */
export class ApiClient {
  private sessionVersion = 0;
  accessToken: string | null = null;
  /** When the access token expires (ms since the epoch, from `expires_in`); null when unknown. */
  accessTokenExpiresAt: number | null = null;
  refreshToken: string | null = null;
  private refreshing: Promise<TokenResponse> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(
    public readonly baseUrl: string,
    private readonly options: ApiClientOptions = {},
  ) {
    const base: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    // M115 (docs/I18N.md): every request says the UI language; the server answers errors and writes notices in it.
    this.fetchImpl = (input, init) => base(input, withAcceptLanguage(init));
  }

  get wsUrl(): string {
    return this.baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/api/v1/ws";
  }

  // --- auth -----------------------------------------------------------------------------

  /** `totpCode` (M12i) is the authenticator or recovery code once the server answered 401 totp_required. */
  async login(username: string, password: string, device: DeviceInfo, totpCode?: string): Promise<TokenResponse> {
    const tokens = await this.request<TokenResponse>(
      "POST",
      "/api/v1/auth/login",
      { username, password, device, ...(totpCode ? { totp_code: totpCode } : {}) },
      { auth: false },
    );
    this.applyTokens(tokens);
    return tokens;
  }

  async refresh(): Promise<TokenResponse> {
    if (this.refreshing) return this.refreshing;
    const version = this.sessionVersion;
    const token = this.refreshToken;
    if (!token) throw new ApiError(401, "missing_token", "No refresh token");
    this.refreshing = this.refreshRequest(token === COOKIE_SESSION ? {} : { refresh_token: token }, version)
      .then((tokens) => {
        if (version !== this.sessionVersion) throw new ApiError(401, "session_changed", "Session changed");
        this.applyTokens(tokens);
        return tokens;
      })
      .catch((err: unknown) => {
        if (version === this.sessionVersion && err instanceof ApiError && err.isAuth) this.signOut();
        throw err;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /**
   * The refresh request, tried again at 1, 2, 4 and 8 s while it fails on the network (or a 5xx / 429) and the next
   * attempt still starts within REFRESH_GRACE_MS of the first; a refusal (401, any 4xx) is final at once. Each attempt
   * has its own short timeout, so a hanging one does not eat the grace.
   */
  private async refreshRequest(body: unknown, version: number): Promise<TokenResponse> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<TokenResponse>("POST", "/api/v1/auth/refresh", body, { auth: false, headers: { "X-Requested-With": REQUESTED_WITH }, timeoutMs: REFRESH_TIMEOUT_MS });
      } catch (err) {
        const delay = REFRESH_RETRY_MS[attempt];
        if (delay === undefined || !isRetryable(err) || version !== this.sessionVersion || Date.now() - started + delay > REFRESH_GRACE_MS) throw err;
        await (this.options.sleep ?? defaultSleep)(delay);
      }
    }
  }

  /**
   * Ends the session on the server (§11), then locally. An expired access token is refreshed and the
   * request sent again: otherwise the session (and the browser's HttpOnly refresh cookie) stays valid.
   */
  async logout(): Promise<void> {
    try {
      await this.request<void>("POST", "/api/v1/auth/logout");
    } catch (err) {
      console.warn("logout request failed; signing out locally", err); // offline, or the session is already gone
    }
    this.signOut();
  }

  signOut(): void {
    this.sessionVersion += 1;
    this.accessToken = null;
    this.accessTokenExpiresAt = null;
    this.refreshToken = null;
    this.options.onSignedOut?.();
  }

  /** True when there is no access token or it expires within `ms` (SYNC_PROTOCOL.md §7.2). */
  accessTokenExpiresWithin(ms: number): boolean {
    return !this.accessToken || this.accessTokenExpiresAt === null || this.accessTokenExpiresAt - Date.now() < ms;
  }

  /** GET /auth/methods (M48, no sign-in): which buttons the login screen shows. */
  authMethods(): Promise<AuthMethodsOut> {
    return this.request("GET", "/api/v1/auth/methods", undefined, { auth: false });
  }

  /**
   * POST /auth/sso/exchange (M48): the one-time ticket and this app's verifier → the same tokens as a login. They are
   * not taken here: the account (and so the client that keeps them) is known only from the answer (`adoptTokens`).
   */
  ssoExchange(ticket: string, verifier: string, device: DeviceInfo): Promise<TokenResponse> {
    return this.request("POST", "/api/v1/auth/sso/exchange", { ticket, verifier, device }, { auth: false });
  }

  /** Use tokens another client obtained (an SSO exchange). */
  adoptTokens(tokens: TokenResponse): void {
    this.applyTokens(tokens);
  }

  private applyTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.access_token;
    this.accessTokenExpiresAt = Date.now() + tokens.expires_in * 1000;
    this.refreshToken = tokens.refresh_token || COOKIE_SESSION; // empty = the server set the cookie
    this.options.onTokens?.(tokens);
  }

  // --- endpoints ------------------------------------------------------------------------

  me(): Promise<UserMe> {
    return this.request("GET", "/api/v1/users/me");
  }

  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.request("PUT", "/api/v1/users/me/password", {
      current_password: currentPassword,
      new_password: newPassword,
    });
  }

  users(): Promise<UserPublic[]> {
    return this.request("GET", "/api/v1/users");
  }

  bootstrap(): Promise<BootstrapOut> {
    return this.request("GET", `/api/v1/sync/bootstrap?${includeQuery("activity_include")}`);
  }

  channels(includePublic: boolean): Promise<ChannelOut[]> {
    const query = includePublic ? "?include=public" : "";
    return this.request("GET", `/api/v1/channels${query}`);
  }

  async publicChannels(): Promise<ChannelOut[]> {
    return (await this.channels(true)).filter((c) => c.membership === null);
  }

  /** M49: one channel; a member's answer carries `last_message` (the DM list's preview). */
  channel(channelId: string): Promise<ChannelOut> {
    return this.request("GET", `/api/v1/channels/${channelId}`);
  }

  addMember(channelId: string, userId: string): Promise<MemberOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/members`, { user_id: userId });
  }

  /**
   * M88: several people in one action, so the channel gets one 「A が B、C を追加しました」 line. A server before M88 has no
   * such route (405: POST is not allowed on /members/{user_id}): one request per person there, as before.
   */
  async addMembers(channelId: string, userIds: string[]): Promise<MemberOut[]> {
    try {
      return await this.request<MemberOut[]>("POST", `/api/v1/channels/${channelId}/members/batch`, { user_ids: userIds });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 405) throw error;
      const added: MemberOut[] = [];
      for (const userId of userIds) added.push(await this.addMember(channelId, userId));
      return added;
    }
  }

  createChannel(name: string, type: "public" | "private"): Promise<ChannelOut> {
    return this.request("POST", "/api/v1/channels", { name, type });
  }

  /** M24: my times, made on the first call (201) and returned afterwards (200). */
  ensureTimes(): Promise<ChannelOut> {
    return this.request("POST", "/api/v1/times");
  }

  joinChannel(channelId: string): Promise<ChannelOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/join`);
  }

  updateChannel(channelId: string, patch: ChannelUpdate): Promise<ChannelOut> {
    return this.request("PATCH", `/api/v1/channels/${channelId}`, patch);
  }

  /**
   * The conversation's own level (null: follow my overall setting, M35) and timed mute; `muted` (until unmuted) is left
   * as it is when omitted.
   */
  setNotificationPreference(channelId: string, level: NotificationLevel | null, mutedUntil: string | null, muted?: boolean): Promise<NotificationPreferenceOut> {
    return this.request("PUT", `/api/v1/channels/${channelId}/notification-preference`, { level, muted_until: mutedUntil, ...(muted === undefined ? {} : { muted }) });
  }

  updateMe(patch: UserUpdate): Promise<UserMe> {
    return this.request("PATCH", "/api/v1/users/me", patch);
  }

  members(channelId: string): Promise<MemberOut[]> {
    return this.request("GET", `/api/v1/channels/${channelId}/members`);
  }

  createDm(userIds: string[]): Promise<ChannelOut> {
    return this.request("POST", "/api/v1/dms", { user_ids: userIds });
  }

  history(channelId: string, beforeSeq: number | null, limit: number): Promise<HistoryOut> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (beforeSeq !== null) params.set("before_seq", String(beforeSeq));
    return this.request("GET", `/api/v1/channels/${channelId}/messages?${params}`);
  }

  delta(channelId: string, sinceSeq: number, limit: number): Promise<DeltaOut> {
    const params = new URLSearchParams({ since_seq: String(sinceSeq), limit: String(limit) });
    return this.request("GET", `/api/v1/channels/${channelId}/sync?${params}`);
  }

  async postMessage(
    channelId: string,
    clientMsgId: string,
    body: string,
    parentId: string | null = null,
    attachmentIds: string[] = [],
    options: SendOptions = {},
  ): Promise<{ message: MessageOut; created: boolean }> {
    const { data, status } = await this.requestWithStatus<MessageOut>(
      "POST",
      `/api/v1/channels/${channelId}/messages`,
      {
        client_msg_id: clientMsgId, body, parent_id: parentId, attachment_ids: attachmentIds,
        ...(options.alsoInChannel ? { also_in_channel: true } : {}),
        ...(options.priority ? { priority: options.priority } : {}),
        ...(options.ackRequested ? { ack_requested: true } : {}),
      },
    );
    return { message: data, created: status === 201 };
  }

  // --- custom emoji (M12f) ---------------------------------------------------------------

  listEmoji(): Promise<CustomEmojiOut[]> {
    return this.request("GET", "/api/v1/emoji");
  }

  /** M14a: my profile picture (any common image; the server stores a 256px PNG). */
  async uploadAvatar(file: Blob, filename: string): Promise<UserMe> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const form = new FormData();
    form.append("file", file, filename);
    const send = async (): Promise<Response> =>
      this.rawFetch(`${this.baseUrl}/api/v1/users/me/avatar`, {
        method: "POST",
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } : { Accept: "application/json" },
        body: form,
      });
    let response = await send();
    if (response.status === 401) {
      await this.refresh();
      response = await send();
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    return readJson<UserMe>(response);
  }

  deleteAvatar(): Promise<UserMe> {
    return this.request("DELETE", "/api/v1/users/me/avatar");
  }

  /** POST /emoji (multipart): a name and a small image; M100: an optional label and keywords. */
  uploadEmoji(name: string, file: Blob, filename: string, extra: { label?: string | null; keywords?: string[] } = {}): Promise<CustomEmojiOut> {
    const form = new FormData();
    form.append("name", name);
    form.append("file", file, filename);
    if (extra.label) form.append("label", extra.label);
    for (const keyword of extra.keywords ?? []) form.append("keywords", keyword);
    return this.postForm<CustomEmojiOut>("/api/v1/emoji", form);
  }

  /** A multipart POST with the bearer token (one retry after refreshing it). */
  private async postForm<T>(path: string, form: FormData): Promise<T> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const send = async (): Promise<Response> =>
      this.rawFetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } : { Accept: "application/json" },
        body: form,
      });
    let response = await send();
    if (response.status === 401) {
      await this.refresh();
      response = await send();
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    return readJson<T>(response);
  }

  deleteEmoji(emojiId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/emoji/${emojiId}`);
  }

  /** M100: a text emoji (`label` drawn as a pill). */
  createTextEmoji(body: TextEmojiCreate): Promise<CustomEmojiOut> {
    return this.request("POST", "/api/v1/emoji/text", body);
  }

  /** M100: label / colour / keywords (creator or admin), pack and order (admin). */
  updateEmoji(emojiId: string, patch: CustomEmojiUpdate): Promise<CustomEmojiOut> {
    return this.request("PATCH", `/api/v1/emoji/${emojiId}`, patch);
  }

  listEmojiPacks(): Promise<EmojiPackOut[]> {
    return this.request("GET", "/api/v1/emoji/packs");
  }

  /** M100 (admin): a pack from a folder's files (pack.json among them) or a ZIP; idempotent by name and shortcode. */
  importEmojiPack(source: { archive: File } | { files: File[] }): Promise<EmojiPackImportOut> {
    const form = new FormData();
    if ("archive" in source) form.append("archive", source.archive, source.archive.name);
    else for (const file of source.files) form.append("files", file, file.name);
    return this.postForm<EmojiPackImportOut>("/api/v1/emoji/packs/import", form);
  }

  updateEmojiPack(packId: string, patch: { name?: string; position?: number }): Promise<EmojiPackOut> {
    return this.request("PATCH", `/api/v1/emoji/packs/${packId}`, patch);
  }

  /** The pack goes; its emoji stay, ungrouped. */
  deleteEmojiPack(packId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/emoji/packs/${packId}`);
  }

  // --- reminders (M12e) ------------------------------------------------------------------

  createReminder(messageId: string, body: ReminderCreate): Promise<ReminderOut> {
    return this.request("POST", `/api/v1/messages/${messageId}/reminders`, body);
  }

  listReminders(): Promise<ReminderOut[]> {
    return this.request("GET", "/api/v1/reminders");
  }

  /** Cancels a pending reminder or marks a fired one done. */
  closeReminder(reminderId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/reminders/${reminderId}`);
  }

  // --- calendar (CALENDAR.md §4, M51) --------------------------------------------------------

  /** Events overlapping [from, to) (ISO with the device's offset: all-day events are matched by its dates), ≤ 100 days. */
  calendarEvents(from: string, to: string, channelId: string | null = null): Promise<CalendarEventOut[]> {
    const params = new URLSearchParams({ from, to, ...(channelId ? { channel_id: channelId } : {}) });
    return this.request("GET", `/api/v1/calendar/events?${params}`);
  }

  /** Today's (and the next days') events not over yet, at most 10 (a channel's header). */
  calendarUpcoming(channelId: string | null, days: number, tz: string): Promise<CalendarEventOut[]> {
    const params = new URLSearchParams({ days: String(days), tz, ...(channelId ? { channel_id: channelId } : {}) });
    return this.request("GET", `/api/v1/calendar/upcoming?${params}`);
  }

  /** A retry with the same client_event_id returns the event made the first time. */
  createCalendarEvent(body: CalendarEventCreate): Promise<CalendarEventOut> {
    return this.request("POST", "/api/v1/calendar/events", body);
  }

  updateCalendarEvent(eventId: string, patch: CalendarEventUpdate): Promise<CalendarEventOut> {
    return this.request("PATCH", `/api/v1/calendar/events/${eventId}`, patch);
  }

  deleteCalendarEvent(eventId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/calendar/events/${eventId}`);
  }

  /** My alarm on an event (only I am notified); `tz` is where 8:00 of an all-day event is read. */
  setCalendarAlarm(eventId: string, minutesBefore: number, tz: string): Promise<CalendarEventOut> {
    return this.request("PUT", `/api/v1/calendar/events/${eventId}/alarm`, { minutes_before: minutesBefore, tz });
  }

  clearCalendarAlarm(eventId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/calendar/events/${eventId}/alarm`);
  }

  getCalendarEvent(eventId: string): Promise<CalendarEventOut> {
    return this.request("GET", `/api/v1/calendar/events/${eventId}`);
  }

  // --- recurring events and iCal feeds (CALENDAR.md §10, M68) ----------------------------------

  /** One occurrence (`this`), it and the later ones (`following`) or the whole series (`all`). */
  updateCalendarOccurrence(seriesId: string, occurrenceStart: string, body: CalendarOccurrenceUpdate): Promise<CalendarEventOut> {
    return this.request("PATCH", `/api/v1/calendar/events/${seriesId}/occurrences/${encodeURIComponent(occurrenceStart)}`, body);
  }

  deleteCalendarOccurrence(seriesId: string, occurrenceStart: string, scope: OccurrenceScope): Promise<void> {
    return this.request("DELETE", `/api/v1/calendar/events/${seriesId}/occurrences/${encodeURIComponent(occurrenceStart)}?scope=${scope}`);
  }

  calendarFeeds(): Promise<CalendarFeedOut[]> {
    return this.request("GET", "/api/v1/calendar/ical-feeds");
  }

  /** A new private feed URL; the URL is in this answer only. */
  createCalendarFeed(scope: CalendarFeedScope): Promise<CalendarFeedCreated> {
    return this.request("POST", "/api/v1/calendar/ical-feeds", { scope });
  }

  deleteCalendarFeed(feedId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/calendar/ical-feeds/${feedId}`);
  }

  // --- tasks (TASKS.md §3, M55) -------------------------------------------------------------

  /** A channel's board: every open task and the 100 most recently completed (`all`: every completed one). */
  listTasks(channelId: string, includeDone: "recent" | "all" = "recent"): Promise<TaskOut[]> {
    const params = new URLSearchParams({ channel_id: channelId, ...(includeDone === "all" ? { include_done: "all" } : {}) });
    return this.request("GET", `/api/v1/tasks?${params}`);
  }

  /** My personal tasks and the shared ones assigned to me (completed: the 50 most recent). */
  myTasks(): Promise<TaskOut[]> {
    return this.request("GET", "/api/v1/tasks/mine");
  }

  /** L9 「自分が依頼した」: the shared tasks I made with someone else assigned (completed: the 50 most recent). */
  requestedTasks(): Promise<TaskOut[]> {
    return this.request("GET", "/api/v1/tasks/requested");
  }

  /** The tasks I can see due in [from, to) (dates, `to` excluded, at most 100 days): the calendar's. */
  dueTasks(from: string, to: string): Promise<TaskOut[]> {
    return this.request("GET", `/api/v1/tasks/due?${new URLSearchParams({ from, to })}`);
  }

  /** M85 「締切」: the deadlines of my channels (or of one) due from 30 days ago on, open and done, by date. */
  deadlineTasks(channelId?: string): Promise<TaskOut[]> {
    return this.request("GET", `/api/v1/tasks/deadlines${channelId ? `?${new URLSearchParams({ channel_id: channelId })}` : ""}`);
  }

  getTask(taskId: string): Promise<TaskOut> {
    return this.request("GET", `/api/v1/tasks/${taskId}`);
  }

  /** A retry with the same client_task_id returns the task made the first time. */
  createTask(body: TaskCreate): Promise<TaskOut> {
    return this.request("POST", "/api/v1/tasks", body);
  }

  updateTask(taskId: string, patch: TaskUpdate): Promise<TaskOut> {
    return this.request("PATCH", `/api/v1/tasks/${taskId}`, patch);
  }

  /** Into a column, between two cards (the server picks the position). */
  moveTask(taskId: string, body: TaskMove): Promise<TaskOut> {
    return this.request("POST", `/api/v1/tasks/${taskId}/move`, body);
  }

  deleteTask(taskId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/tasks/${taskId}`);
  }

  /** M81: one item of a task's checklist (its checkbox, its title). */
  updateSubtask(taskId: string, subtaskId: string, patch: SubtaskUpdate): Promise<TaskOut> {
    return this.request("PATCH", `/api/v1/tasks/${taskId}/subtasks/${subtaskId}`, patch);
  }

  /** M81: a board's columns, left to right (a board never changed: the three built-in ones). */
  listTaskColumns(channelId: string): Promise<TaskColumnOut[]> {
    return this.request("GET", `/api/v1/tasks/columns?${new URLSearchParams({ channel_id: channelId })}`);
  }

  createTaskColumn(body: TaskColumnCreate): Promise<TaskColumnOut> {
    return this.request("POST", "/api/v1/tasks/columns", body);
  }

  updateTaskColumn(columnId: string, patch: TaskColumnUpdate): Promise<TaskColumnOut> {
    return this.request("PATCH", `/api/v1/tasks/columns/${columnId}`, patch);
  }

  /** An added column; its cards go to the built-in column of the same status. */
  deleteTaskColumn(columnId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/tasks/columns/${columnId}`);
  }

  // --- scheduled messages (M12d) ---------------------------------------------------------

  scheduleMessage(channelId: string, body: ScheduledCreate): Promise<ScheduledOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/scheduled`, body);
  }

  // --- channel links (M15f) ----------------------------------------------------------------

  channelLinks(channelId: string): Promise<ChannelLinkOut[]> {
    return this.request("GET", `/api/v1/channels/${channelId}/links`);
  }

  addChannelLink(channelId: string, title: string, url: string): Promise<ChannelLinkOut[]> {
    return this.request("POST", `/api/v1/channels/${channelId}/links`, { title, url });
  }

  updateChannelLink(channelId: string, linkId: string, patch: { title?: string; url?: string; position?: number }): Promise<ChannelLinkOut[]> {
    return this.request("PATCH", `/api/v1/channels/${channelId}/links/${linkId}`, patch);
  }

  deleteChannelLink(channelId: string, linkId: string): Promise<ChannelLinkOut[]> {
    return this.request("DELETE", `/api/v1/channels/${channelId}/links/${linkId}`);
  }

  // --- canvases (CANVAS.md §4.5, M43) ---------------------------------------------------------

  /** The conversation's canvases without bodies, most recently updated first (`trashed`: its trash instead). */
  listCanvases(channelId: string, trashed = false): Promise<CanvasMeta[]> {
    return this.request("GET", `/api/v1/channels/${channelId}/canvases${trashed ? "?trashed=true" : ""}`);
  }

  /** A new canvas (a retry with the same client_save_id returns the first one). */
  createCanvas(channelId: string, body: CanvasCreate): Promise<CanvasOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/canvases`, body);
  }

  /** The canvases of all my conversations (keyset pages). */
  myCanvases(cursor: string | null = null, limit = 50): Promise<CanvasPage> {
    const params = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.request("GET", `/api/v1/canvases?${params}`);
  }

  /** Metadata and body; null when `knownVersion` is still the current one (If-None-Match → 304). */
  async getCanvas(canvasId: string, knownVersion: number | null = null): Promise<CanvasOut | null> {
    try {
      return await this.request<CanvasOut>("GET", `/api/v1/canvases/${canvasId}`, undefined, knownVersion === null ? {} : { headers: { "If-None-Match": `"v${knownVersion}"` } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 304) return null;
      throw err;
    }
  }

  /** §4.4: the whole body written on `base_rev_id`; 409 canvas_conflict / canvas_base_expired carry the head in `details`. */
  saveCanvas(canvasId: string, body: CanvasSaveIn): Promise<CanvasSaveOut> {
    return this.request("PUT", `/api/v1/canvases/${canvasId}/content`, body);
  }

  updateCanvas(canvasId: string, patch: CanvasUpdate): Promise<CanvasOut> {
    return this.request("PATCH", `/api/v1/canvases/${canvasId}`, patch);
  }

  /** To the trash. */
  deleteCanvas(canvasId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/canvases/${canvasId}`);
  }

  restoreCanvas(canvasId: string): Promise<CanvasOut> {
    return this.request("POST", `/api/v1/canvases/${canvasId}/restore`);
  }

  canvasTemplates(): Promise<CanvasTemplateOut[]> {
    return this.request("GET", "/api/v1/canvas-templates");
  }

  /**
   * M44 (web, the tab closing): the same save as `saveCanvas` on a `keepalive` fetch, which the browser finishes after the
   * page is gone. Nothing is read back; the key makes a repeat harmless.
   */
  saveCanvasKeepalive(canvasId: string, body: CanvasSaveIn): void {
    if (!this.accessToken) return;
    try {
      void this.fetchImpl(`${this.baseUrl}/api/v1/canvases/${canvasId}/content`, {
        method: "PUT",
        keepalive: true,
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch {
      /* the page is going away: nothing more can be done */
    }
  }

  /** M44: post the canvas's link to its conversation (nothing new while that message exists); its thread holds the comments. */
  shareCanvas(canvasId: string): Promise<CanvasOut> {
    return this.request("POST", `/api/v1/canvases/${canvasId}/share`);
  }

  /** M44 (§4.9): the history without bodies, newest first (side versions left out). */
  canvasRevisions(canvasId: string, cursor: string | null = null, limit = 50): Promise<CanvasRevisionPage> {
    const params = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.request("GET", `/api/v1/canvases/${canvasId}/revisions?${params}`);
  }

  canvasRevision(canvasId: string, revisionId: string): Promise<CanvasRevisionOut> {
    return this.request("GET", `/api/v1/canvases/${canvasId}/revisions/${revisionId}`);
  }

  /** That version's body as a new version (idempotent on `client_save_id`). */
  restoreCanvasRevision(canvasId: string, revisionId: string, clientSaveId: string): Promise<CanvasOut> {
    return this.request("POST", `/api/v1/canvases/${canvasId}/revisions/${revisionId}/restore`, { client_save_id: clientSaveId });
  }

  /** A name for the version (「提出版」); null removes it. */
  labelCanvasRevision(canvasId: string, revisionId: string, label: string | null): Promise<CanvasRevisionMeta> {
    return this.request("PATCH", `/api/v1/canvases/${canvasId}/revisions/${revisionId}`, { label });
  }

  /** Erase the version's body (owners and administrators; in a DM its creator). */
  eraseCanvasRevision(canvasId: string, revisionId: string): Promise<CanvasRevisionMeta> {
    return this.request("DELETE", `/api/v1/canvases/${canvasId}/revisions/${revisionId}`);
  }

  /** M44 (§4.8): canvases of my conversations; typed modifiers (in:# from:@ before: after: on:) stay in `q`. */
  searchCanvases(query: {
    q: string;
    channel_id?: string | null;
    from_user_id?: string | null;
    after?: string | null;
    before?: string | null;
    sort?: "relevance" | "newest";
    limit?: number;
    offset?: number;
  }): Promise<CanvasSearchOut> {
    const params = new URLSearchParams({ q: query.q, limit: String(query.limit ?? 20), offset: String(query.offset ?? 0) });
    if (query.channel_id) params.set("channel_id", query.channel_id);
    if (query.from_user_id) params.set("from_user_id", query.from_user_id);
    if (query.after) params.set("after", query.after);
    if (query.before) params.set("before", query.before);
    if (query.sort) params.set("sort", query.sort);
    params.set("tz_offset_minutes", String(-new Date().getTimezoneOffset()));
    return this.request("GET", `/api/v1/search/canvases?${params}`);
  }

  /** M44 (§4.12): every template, hidden ones too (administrators). */
  adminCanvasTemplates(): Promise<CanvasTemplateOut[]> {
    return this.request("GET", "/api/v1/admin/canvas-templates");
  }

  adminCreateCanvasTemplate(body: CanvasTemplateCreate): Promise<CanvasTemplateOut> {
    return this.request("POST", "/api/v1/admin/canvas-templates", body);
  }

  /** Edit, reorder or hide (built-in ones are hidden, not deleted). */
  adminUpdateCanvasTemplate(templateId: string, patch: CanvasTemplateUpdate): Promise<CanvasTemplateOut> {
    return this.request("PATCH", `/api/v1/admin/canvas-templates/${templateId}`, patch);
  }

  adminDeleteCanvasTemplate(templateId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/admin/canvas-templates/${templateId}`);
  }

  /** M44: an attachment's metadata (a canvas's image: its name, type and shape). */
  getAttachment(attachmentId: string): Promise<AttachmentOut> {
    return this.request("GET", `/api/v1/attachments/${attachmentId}`);
  }

  // --- 「ドキュメント」 (wiki, WIKI.md §14.2, M121) ------------------------------------------------

  /** Every page I can read (not database rows) and the change feed's cursor; null when `etag` is still current (304). */
  async wikiTree(etag: string | null = null): Promise<{ tree: WikiTreeOut; etag: string | null } | null> {
    let seen: string | null = null;
    try {
      const tree = await this.request<WikiTreeOut>("GET", "/api/v1/wiki/tree", undefined, {
        headers: etag ? { "If-None-Match": etag } : {},
        onResponse: (response) => { seen = response.headers.get("ETag"); },
      });
      return { tree, etag: seen };
    } catch (err) {
      if (err instanceof ApiError && err.status === 304) return null;
      throw err;
    }
  }

  /** The tree's change feed after `since` (WIKI.md §10, §14.4). */
  wikiChanges(since: number): Promise<WikiChangesOut> {
    return this.request("GET", `/api/v1/wiki/changes?since=${since}`);
  }

  /** A page with its body, breadcrumbs and child pages; null when `etag` (`"v{version}-{level}"`) is still current. */
  async wikiPage(pageId: string, etag: string | null = null): Promise<PageOut | null> {
    try {
      return await this.request<PageOut>("GET", `/api/v1/wiki/pages/${pageId}`, undefined, etag ? { headers: { "If-None-Match": etag } } : {});
    } catch (err) {
      if (err instanceof ApiError && err.status === 304) return null;
      throw err;
    }
  }

  /** A new page (a retry with the same client_save_id answers the first one). */
  createWikiPage(body: PageCreate): Promise<PageOut> {
    return this.request("POST", "/api/v1/wiki/pages", body);
  }

  /** The whole body written on `base_rev_id` (CANVAS.md §4.4); 409 page_conflict / page_base_expired carry the head. */
  saveWikiPage(pageId: string, body: PageSaveIn): Promise<PageSaveOut> {
    return this.request("PUT", `/api/v1/wiki/pages/${pageId}/content`, body);
  }

  /** The web page closing: the same save on a keepalive fetch (as saveCanvasKeepalive). */
  saveWikiPageKeepalive(pageId: string, body: PageSaveIn): void {
    if (!this.accessToken) return;
    try {
      void this.fetchImpl(`${this.baseUrl}/api/v1/wiki/pages/${pageId}/content`, {
        method: "PUT",
        keepalive: true,
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch {
      /* the page is going away */
    }
  }

  /** Title and icon (`icon: ""` removes it). */
  updateWikiPage(pageId: string, patch: PageUpdate): Promise<PageOut> {
    return this.request("PATCH", `/api/v1/wiki/pages/${pageId}`, patch);
  }

  /** Move (or with `dry_run` only say who would gain or lose access). */
  moveWikiPage(pageId: string, body: PageMove): Promise<WikiMoveOut> {
    return this.request("POST", `/api/v1/wiki/pages/${pageId}/move`, body);
  }

  /** The page and the pages below it to the trash. */
  trashWikiPage(pageId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/wiki/pages/${pageId}`);
  }

  restoreWikiPage(pageId: string): Promise<PageOut> {
    return this.request("POST", `/api/v1/wiki/pages/${pageId}/restore`);
  }

  /** The roots of the trash I have full access to. */
  wikiTrash(): Promise<PageMeta[]> {
    return this.request("GET", "/api/v1/wiki/trash");
  }

  wikiAccess(pageId: string): Promise<WikiAccessOut> {
    return this.request("GET", `/api/v1/wiki/pages/${pageId}/access`);
  }

  setWikiAccess(pageId: string, body: WikiAccessUpdate): Promise<WikiAccessOut> {
    return this.request("PUT", `/api/v1/wiki/pages/${pageId}/access`, body);
  }

  wikiBacklinks(pageId: string): Promise<PageItem[]> {
    return this.request("GET", `/api/v1/wiki/pages/${pageId}/backlinks`);
  }

  /** The titles of the pages I can read among `ids` (the others are left out). */
  resolveWikiPages(ids: string[]): Promise<PageRef[]> {
    return this.request("POST", "/api/v1/wiki/pages/resolve", { ids });
  }

  /** The `[[` suggestions. */
  lookupWikiPages(q: string, limit = 8): Promise<PageRef[]> {
    return this.request("GET", `/api/v1/wiki/pages/lookup?${new URLSearchParams({ q, limit: String(limit) })}`);
  }

  wikiRevisions(pageId: string, cursor: string | null = null, limit = 50): Promise<PageRevisionPage> {
    const params = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.request("GET", `/api/v1/wiki/pages/${pageId}/revisions?${params}`);
  }

  wikiRevision(pageId: string, revisionId: string): Promise<PageRevisionOut> {
    return this.request("GET", `/api/v1/wiki/pages/${pageId}/revisions/${revisionId}`);
  }

  restoreWikiRevision(pageId: string, revisionId: string, clientSaveId: string): Promise<PageOut> {
    return this.request("POST", `/api/v1/wiki/pages/${pageId}/revisions/${revisionId}/restore`, { client_save_id: clientSaveId });
  }

  labelWikiRevision(pageId: string, revisionId: string, label: string | null): Promise<PageRevisionMeta> {
    return this.request("PATCH", `/api/v1/wiki/pages/${pageId}/revisions/${revisionId}`, { label });
  }

  eraseWikiRevision(pageId: string, revisionId: string): Promise<PageRevisionMeta> {
    return this.request("DELETE", `/api/v1/wiki/pages/${pageId}/revisions/${revisionId}`);
  }

  /** The page as Markdown (text). */
  async exportWikiPage(pageId: string): Promise<string> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const response = await this.rawFetch(`${this.baseUrl}/api/v1/wiki/pages/${pageId}/export`, { headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {} });
    if (!response.ok) throw toApiError(response.status, parseJson(await response.text().catch(() => "")));
    return response.text();
  }

  /** Pages I can read whose title or body matches (WIKI.md §8.1). */
  searchWikiPages(query: { q: string; in_page?: string | null; from_user_id?: string | null; after?: string | null; before?: string | null; sort?: "relevance" | "newest"; limit?: number; offset?: number }): Promise<PageSearchOut> {
    const params = new URLSearchParams({ q: query.q, tz_offset_minutes: String(-new Date().getTimezoneOffset()) });
    for (const key of ["in_page", "from_user_id", "after", "before", "sort", "limit", "offset"] as const) {
      const value = query[key];
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    return this.request("GET", `/api/v1/search/pages?${params}`);
  }

  /** Administrators: every page's title and who has access (no bodies). */
  adminWikiPages(): Promise<AdminPageOut[]> {
    return this.request("GET", "/api/v1/admin/wiki/pages");
  }

  /** Administrators: full access to the page for me (audited). null: a page in the trash. */
  adminTakeOverWikiPage(pageId: string): Promise<PageOut | null> {
    return this.request("POST", `/api/v1/admin/wiki/pages/${pageId}/takeover`);
  }

  /** Administrators: a page in the trash deleted for good now (audited). */
  adminPurgeWikiPage(pageId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/admin/wiki/pages/${pageId}`);
  }

  // --- drafts (M15d) ------------------------------------------------------------------------

  saveDraft(channelId: string, parentId: string | null, body: string): Promise<DraftOut> {
    return this.request("PUT", "/api/v1/drafts", { channel_id: channelId, parent_id: parentId, body });
  }

  deleteDraft(channelId: string, parentId: string | null): Promise<void> {
    const params = new URLSearchParams({ channel_id: channelId, ...(parentId ? { parent_id: parentId } : {}) });
    return this.request("DELETE", `/api/v1/drafts?${params}`);
  }

  listScheduled(): Promise<ScheduledOut[]> {
    return this.request("GET", "/api/v1/scheduled");
  }

  cancelScheduled(scheduledId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/scheduled/${scheduledId}`);
  }

  sendScheduledNow(scheduledId: string): Promise<MessageOut> {
    return this.request("POST", `/api/v1/scheduled/${scheduledId}/send-now`);
  }

  // --- calls (M117, docs/CALLS.md) --------------------------------------------------------

  /**
   * 「通話を始める」: the server makes a new meeting room and posts its link as a message. `clientMsgId` is the message's
   * idempotency key: a retry with the same id gets the same call back (200 instead of 201).
   */
  async startCall(channelId: string, clientMsgId: string): Promise<{ call: CallOut; created: boolean }> {
    const { data, status } = await this.requestWithStatus<CallOut>("POST", `/api/v1/channels/${channelId}/calls`, { client_msg_id: clientMsgId });
    return { call: data, created: status === 201 };
  }

  // --- favorites and read-all (M12a) ------------------------------------------------------

  favoriteChannel(channelId: string): Promise<FavoriteStateOut> {
    return this.request("PUT", `/api/v1/channels/${channelId}/favorite`);
  }

  unfavoriteChannel(channelId: string): Promise<FavoriteStateOut> {
    return this.request("DELETE", `/api/v1/channels/${channelId}/favorite`);
  }

  // --- DM pins (M118) ----------------------------------------------------------------------

  pinDm(channelId: string): Promise<DmPinStateOut> {
    return this.request("PUT", `/api/v1/channels/${channelId}/dm-pin`);
  }

  unpinDm(channelId: string): Promise<DmPinStateOut> {
    return this.request("DELETE", `/api/v1/channels/${channelId}/dm-pin`);
  }

  /**
   * Every channel I belong to is read to its end; the response carries the new states. L8: scope "times" reads only the
   * Times feed's channels (TIMES_FEED.md §4); without a scope the request has no body, as before.
   */
  readAll(scope?: ReadAllScope): Promise<ChannelReadStateOut[]> {
    return scope ? this.request("POST", "/api/v1/channels/read-all", { scope }) : this.request("POST", "/api/v1/channels/read-all");
  }

  // --- Times feed (L8, TIMES_FEED.md §3) ---------------------------------------------------

  /** GET /times/feed: the top-level posts of my unmuted times, newest first; `cursor` is the previous page's next_cursor. */
  timesFeed(cursor: string | null = null, limit = 50): Promise<TimesFeedOut> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return this.request("GET", `/api/v1/times/feed?${params}`);
  }

  // --- recent mentions (M11h) ------------------------------------------------------------

  listMentions(options: { cursor?: string | null; limit?: number } = {}): Promise<MentionListOut> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request("GET", `/api/v1/mentions?${params}`);
  }

  // --- activity (M39) --------------------------------------------------------------------

  /** Mentions, reactions to my messages and replies in threads I follow, newest first; `cursor` is `next_cursor`. */
  listActivity(options: { filter?: ActivityFilter; cursor?: string | null; limit?: number } = {}): Promise<ActivityListOut> {
    const params = new URLSearchParams({ filter: options.filter ?? "all", limit: String(options.limit ?? 50) });
    for (const kind of ACTIVITY_INCLUDE) params.append("include", kind);
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request("GET", `/api/v1/activity?${params}`);
  }

  /** The activity badge: items after my read position (at most 99), and whether a mention is among them. */
  activitySummary(): Promise<ActivitySummaryOut> {
    return this.request("GET", `/api/v1/activity/summary?${includeQuery("include")}`);
  }

  /** Everything up to `readAt` is read (the server only moves it forward, never past its own now). */
  markActivityRead(readAt: string): Promise<ActivitySummaryOut> {
    return this.request("PUT", `/api/v1/activity/read?${includeQuery("include")}`, { read_at: readAt });
  }

  // --- files (M11i) ----------------------------------------------------------------------

  listFiles(options: { channelId?: string | null; q?: string | null; cursor?: string | null; limit?: number } = {}): Promise<FileListOut> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.channelId) params.set("channel_id", options.channelId);
    if (options.q) params.set("q", options.q);
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request("GET", `/api/v1/files?${params}`);
  }

  // --- link previews (M11g) --------------------------------------------------------------

  linkPreview(url: string): Promise<LinkPreviewOut> {
    return this.request("GET", `/api/v1/link-previews?${new URLSearchParams({ url })}`);
  }

  // --- channel management (M11e) ---------------------------------------------------------

  archiveChannel(channelId: string): Promise<ChannelOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/archive`);
  }

  /** M13d: owner or administrator; the channel becomes writable again. */
  unarchiveChannel(channelId: string): Promise<ChannelOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/unarchive`);
  }

  leaveChannel(channelId: string): Promise<void> {
    return this.request("POST", `/api/v1/channels/${channelId}/leave`);
  }

  removeMember(channelId: string, userId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/channels/${channelId}/members/${userId}`);
  }

  /** L4 (M31): make a member an owner or take it back (owner / admin; 409 last_owner, 403 owner_not_allowed). */
  setMemberRole(channelId: string, userId: string, role: MemberRole): Promise<MemberOut> {
    return this.request("PATCH", `/api/v1/channels/${channelId}/members/${userId}`, { role });
  }

  // --- administration (M11e): admin role only ---------------------------------------------

  adminListUsers(): Promise<AdminUserOut[]> {
    return this.request("GET", "/api/v1/admin/users");
  }

  adminCreateUser(body: AdminUserCreate): Promise<AdminUserCreated> {
    return this.request("POST", "/api/v1/admin/users", body);
  }

  adminUpdateUser(userId: string, patch: AdminUserUpdate): Promise<AdminUserOut> {
    return this.request("PATCH", `/api/v1/admin/users/${userId}`, patch);
  }

  adminResetPassword(userId: string): Promise<TemporaryPasswordOut> {
    return this.request("POST", `/api/v1/admin/users/${userId}/reset-password`);
  }

  adminRevokeSessions(userId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/admin/users/${userId}/sessions`);
  }

  adminAnonymizeUser(userId: string): Promise<AdminUserOut> {
    return this.request("POST", `/api/v1/admin/users/${userId}/anonymize`);
  }

  // --- analytics (M116, docs/ANALYTICS.md §4): admin role only --------------------------------

  /** The last `days` days (1-90) in the IANA time zone `tz` (the device's own). */
  adminAnalyticsOverview(days: number, tz: string): Promise<AnalyticsOverviewOut> {
    const params = new URLSearchParams({ days: String(days), tz });
    return this.request("GET", `/api/v1/admin/analytics/overview?${params}`);
  }

  adminAnalyticsMembers(query: AnalyticsMembersQuery): Promise<AnalyticsMembersOut> {
    return this.request("GET", `/api/v1/admin/analytics/members?${analyticsParams(query)}`);
  }

  /** The members table with the same filters, all rows, as CSV (UTF-8 with a BOM). */
  adminAnalyticsMembersCsv(query: AnalyticsMembersQuery): Promise<Blob> {
    const { limit: _limit, offset: _offset, ...rest } = query;
    return this.fetchBlob(`/api/v1/admin/analytics/members.csv?${analyticsParams(rest)}`);
  }

  // --- moderation (M104, docs/MODERATION.md) ------------------------------------------------

  blockUser(userId: string): Promise<BlockStateOut> {
    return this.request("PUT", `/api/v1/users/${userId}/block`);
  }

  unblockUser(userId: string): Promise<BlockStateOut> {
    return this.request("DELETE", `/api/v1/users/${userId}/block`);
  }

  listBlocks(): Promise<BlockOut[]> {
    return this.request("GET", "/api/v1/users/me/blocks");
  }

  reportMessage(messageId: string, body: ReportCreate): Promise<ReportAck> {
    return this.request("POST", `/api/v1/messages/${messageId}/report`, body);
  }

  /** My password, or my username for an account without one (Google sign-in). 422 invalid_password / invalid_confirmation, 409 last_admin. */
  deleteAccount(body: AccountDeletion): Promise<void> {
    return this.request("POST", "/api/v1/users/me/delete-account", body);
  }

  /** M119: a report of a person (`user_id`) or of anything else, or feedback; a retry with the same client_report_id returns the first. */
  submitReport(body: GeneralReportCreate): Promise<GeneralReportAck> {
    return this.request("POST", "/api/v1/reports", body);
  }

  adminListReports(status: "open" | "resolved" | "all" = "open"): Promise<AdminReportOut[]> {
    return this.request("GET", `/api/v1/admin/reports?status=${status}`);
  }

  adminResolveReport(reportId: string): Promise<AdminReportOut> {
    return this.request("POST", `/api/v1/admin/reports/${reportId}/resolve`);
  }

  adminReopenReport(reportId: string): Promise<AdminReportOut> {
    return this.request("POST", `/api/v1/admin/reports/${reportId}/reopen`);
  }

  // --- two-factor authentication (M12i) ----------------------------------------------------

  totpStatus(): Promise<TotpStatusOut> {
    return this.request("GET", "/api/v1/auth/totp");
  }

  /** Needs my password; the secret and QR come back once. A wrong password is 422 invalid_password. */
  totpSetup(password: string): Promise<TotpSetupOut> {
    return this.request("POST", "/api/v1/auth/totp/setup", { password });
  }

  /** Confirms the setup with an app code; returns the recovery codes once. */
  totpEnable(code: string): Promise<TotpEnabledOut> {
    return this.request("POST", "/api/v1/auth/totp/enable", { code });
  }

  totpDisable(password: string): Promise<void> {
    return this.request("POST", "/api/v1/auth/totp/disable", { password });
  }

  adminResetTotp(userId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/admin/users/${userId}/totp`);
  }

  // --- my sessions (M40 「ログイン中の端末」) ---------------------------------------------------

  /** Every signed-in device of mine, newest sign-in first; `current` marks this one. */
  sessions(): Promise<SessionOut[]> {
    return this.request("GET", "/api/v1/auth/sessions");
  }

  /**
   * PUT /devices/current: this device's name and app version, sent again each time a session starts so that an update or
   * a better name (not "MacIntel") reaches 「ログイン中の端末」 without signing in again. The push token stays as it is.
   */
  updateDevice(device: Pick<DeviceInfo, "device_name" | "app_version">): Promise<unknown> {
    return this.request("PUT", "/api/v1/devices/current", device);
  }

  /** PUSH_NOTIFICATIONS.md §15: a test push to every device of mine (and notification.test to my open apps). */
  sendTestNotification(): Promise<TestNotificationOut> {
    return this.request("POST", "/api/v1/users/me/test-notification");
  }

  /** Signs another device of mine out (its refresh token stops working, its sockets get session.revoked). */
  revokeSession(sessionId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/auth/sessions/${sessionId}`);
  }

  // --- user groups (M12k) -------------------------------------------------------------------

  listGroups(): Promise<GroupOut[]> {
    return this.request("GET", "/api/v1/groups");
  }

  adminCreateGroup(body: GroupCreate): Promise<GroupOut> {
    return this.request("POST", "/api/v1/admin/groups", body);
  }

  adminUpdateGroup(groupId: string, patch: GroupUpdate): Promise<GroupOut> {
    return this.request("PATCH", `/api/v1/admin/groups/${groupId}`, patch);
  }

  adminDeleteGroup(groupId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/admin/groups/${groupId}`);
  }

  // --- post templates (M30) -------------------------------------------------------------------

  listTemplates(): Promise<TemplateOut[]> {
    return this.request("GET", "/api/v1/templates");
  }

  createTemplate(body: TemplateCreate): Promise<TemplateOut> {
    return this.request("POST", "/api/v1/templates", body);
  }

  updateTemplate(templateId: string, patch: TemplateUpdate): Promise<TemplateOut> {
    return this.request("PATCH", `/api/v1/templates/${templateId}`, patch);
  }

  deleteTemplate(templateId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/templates/${templateId}`);
  }

  // --- lab roster (M23) -----------------------------------------------------------------------

  roster(): Promise<LabProfileOut[]> {
    return this.request("GET", "/api/v1/lab/roster");
  }

  /** Administrators: put someone on the roster or change their line (topic and reading kept unless sent). */
  adminPutRosterLine(userId: string, body: LabProfilePut): Promise<LabProfileOut> {
    return this.request("PUT", `/api/v1/lab/roster/${userId}`, body);
  }

  adminDeleteRosterLine(userId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/lab/roster/${userId}`);
  }

  /** My research topic and reading (404 roster_entry_not_found while I am not on the roster). */
  updateMyRosterLine(body: MyLabProfileUpdate): Promise<LabProfileOut> {
    return this.request("PATCH", "/api/v1/lab/roster/me", body);
  }

  // --- the yearly rollover (L7 / M32, administrators) -------------------------------------------

  /** Every student with the proposed step and the channels a graduate would leave; `applied_at` while the year is in force. */
  rolloverPreview(academicYear: number): Promise<RolloverPreviewOut> {
    return this.request("POST", "/api/v1/lab/rollover/preview", { academic_year: academicYear });
  }

  /** One transaction for the year (409 rollover_applied while it is in force). */
  applyRollover(body: RolloverApply): Promise<RolloverOut> {
    return this.request("POST", "/api/v1/lab/rollovers", body);
  }

  /** Newest year first. */
  rollovers(): Promise<RolloverOut[]> {
    return this.request("GET", "/api/v1/lab/rollovers");
  }

  undoRollover(academicYear: number): Promise<RolloverOut> {
    return this.request("POST", `/api/v1/lab/rollovers/${academicYear}/undo`);
  }

  // --- incoming webhooks (M13a) --------------------------------------------------------------

  adminListWebhooks(): Promise<WebhookOut[]> {
    return this.request("GET", "/api/v1/admin/webhooks");
  }

  /** The token comes back once; the URL is `webhookUrl(baseUrl, token)`. */
  adminCreateWebhook(body: WebhookCreate): Promise<WebhookCreated> {
    return this.request("POST", "/api/v1/admin/webhooks", body);
  }

  adminUpdateWebhook(webhookId: string, patch: WebhookUpdate): Promise<WebhookOut> {
    return this.request("PATCH", `/api/v1/admin/webhooks/${webhookId}`, patch);
  }

  adminDeleteWebhook(webhookId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/admin/webhooks/${webhookId}`);
  }

  // --- AI (M65, docs/AI.md §5) -----------------------------------------------------------------

  /** 404 on a server before M65: the caller hides every AI entry point. */
  aiStatus(): Promise<AiStatusOut> {
    return this.request("GET", "/api/v1/ai/status");
  }

  /** 202 with the run still `pending`; its progress comes as ai.run_updated (or GET /ai/runs/{id}). */
  createAiSummary(body: AiSummaryCreate): Promise<AiRunOut> {
    return this.request("POST", "/api/v1/ai/summaries", body);
  }

  /** Review v0.1.18 #2: where a summary of the conversation would go (404 on an older server). */
  aiSummaryTarget(channelId: string): Promise<AiSummaryTargetOut> {
    return this.request("GET", `/api/v1/ai/summaries/target?channel_id=${encodeURIComponent(channelId)}`);
  }

  getAiRun(runId: string): Promise<AiRunOut> {
    return this.request("GET", `/api/v1/ai/runs/${runId}`);
  }

  /** M70 (docs/AI.md §13): 202 with the question's run (`kind = "ask"`); done at once when nothing was found. */
  createAiAsk(body: AiAskCreate): Promise<AiRunOut> {
    return this.request("POST", "/api/v1/ai/ask", body);
  }

  /** M70: where the question would go (404 on an older server). */
  aiAskTarget(q: string, channelId: string | null): Promise<AiAskTargetOut> {
    const params = new URLSearchParams({ q });
    if (channelId) params.set("channel_id", channelId);
    return this.request("GET", `/api/v1/ai/ask/target?${params.toString()}`);
  }

  /** My newest 20 runs. */
  aiRuns(kind: "summary" | "mention" | "ask" = "summary"): Promise<AiRunOut[]> {
    return this.request("GET", `/api/v1/ai/runs?kind=${kind}`);
  }

  adminAiAgents(): Promise<AiAgentOut[]> {
    return this.request("GET", "/api/v1/admin/ai/agents");
  }

  adminCreateAiAgent(body: AiAgentCreate): Promise<AiAgentOut> {
    return this.request("POST", "/api/v1/admin/ai/agents", body);
  }

  adminUpdateAiAgent(agentId: string, patch: AiAgentUpdate): Promise<AiAgentOut> {
    return this.request("PATCH", `/api/v1/admin/ai/agents/${agentId}`, patch);
  }

  adminDeleteAiAgent(agentId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/admin/ai/agents/${agentId}`);
  }

  /** `month` "YYYY-MM"; this month when left out. */
  adminAiUsage(month?: string): Promise<AiUsageOut> {
    return this.request("GET", `/api/v1/admin/ai/usage${month ? `?month=${encodeURIComponent(month)}` : ""}`);
  }

  /** M88 (docs/MEMBERSHIP.md §3): 「参加・退出の表示」 and 「参加前にチャンネルの中を見られる」 (404 on a server before it). */
  adminWorkspaceSettings(): Promise<AdminWorkspaceSettingsOut> {
    return this.request("GET", "/api/v1/admin/workspace-settings");
  }

  adminUpdateWorkspaceSettings(patch: WorkspaceSettingsUpdate): Promise<AdminWorkspaceSettingsOut> {
    return this.request("PATCH", "/api/v1/admin/workspace-settings", patch);
  }

  /** M93 (WORKSPACES.md §3.4): the workspace icon (PNG / JPEG / WebP; the server crops it square, 256 px). */
  async adminUploadWorkspaceIcon(file: Blob, filename: string): Promise<AdminWorkspaceSettingsOut> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const form = new FormData();
    form.append("file", file, filename);
    const send = async (): Promise<Response> =>
      this.rawFetch(`${this.baseUrl}/api/v1/admin/workspace-settings/icon`, {
        method: "POST",
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } : { Accept: "application/json" },
        body: form,
      });
    let response = await send();
    if (response.status === 401) {
      await this.refresh();
      response = await send();
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    return readJson<AdminWorkspaceSettingsOut>(response);
  }

  /** M93: back to the letter tile. */
  adminDeleteWorkspaceIcon(): Promise<AdminWorkspaceSettingsOut> {
    return this.request("DELETE", "/api/v1/admin/workspace-settings/icon");
  }

  /** M90 (docs/MEMBERSHIP.md §6): everyone (not guests or bots) into the default channels; `dryRun` only counts. */
  adminApplyDefaultChannels(dryRun: boolean): Promise<DefaultChannelsApplyOut> {
    return this.request("POST", "/api/v1/admin/workspace-settings/apply-default-channels", { dry_run: dryRun });
  }

  /** docs/AI.md §12: the providers and whether each has its API key (404 on a server before it). */
  adminAiProviders(): Promise<AiProviderOut[]> {
    return this.request("GET", "/api/v1/admin/ai/providers");
  }

  // --- polls (M14b) ------------------------------------------------------------------------

  vote(messageId: string, option: number, present: boolean): Promise<MessageOut> {
    return present
      ? this.request("PUT", `/api/v1/messages/${messageId}/poll/votes/${option}`, {})
      : this.request("DELETE", `/api/v1/messages/${messageId}/poll/votes/${option}`);
  }

  /** M15e: 「確認しました」 on a message that asks for it, or take it back. */
  acknowledge(messageId: string, present: boolean): Promise<MessageOut> {
    return present ? this.request("PUT", `/api/v1/messages/${messageId}/ack`, {}) : this.request("DELETE", `/api/v1/messages/${messageId}/ack`);
  }

  /** L4 (M31): the members who have not acknowledged yet, by display name. */
  ackPending(messageId: string): Promise<AckPendingOut> {
    return this.request("GET", `/api/v1/messages/${messageId}/ack/pending`);
  }

  /** L4 (M31): the author or an admin reminds them (once an hour: 429 ack_remind_too_soon). */
  ackRemind(messageId: string): Promise<AckRemindOut> {
    return this.request("POST", `/api/v1/messages/${messageId}/ack/remind`, {});
  }

  closePoll(messageId: string): Promise<MessageOut> {
    return this.request("POST", `/api/v1/messages/${messageId}/poll/close`, {});
  }

  /**
   * A message that carries a poll; posted directly (not through the offline queue). `anonymous` (M27) goes only when
   * true: a server before M27 refuses fields it does not know, and a named poll still works there.
   */
  postPoll(channelId: string, parentId: string | null, poll: Omit<PollCreate, "anonymous" | "kind" | "multiple"> & { anonymous?: true; kind?: "schedule"; multiple?: boolean }): Promise<MessageOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/messages`, { client_msg_id: crypto.randomUUID(), body: "", parent_id: parentId, poll });
  }

  /** M53: my ○ / △ / × on a scheduling poll, all at once (left-out candidates become unanswered); `comment` left out keeps mine. */
  answerPoll(messageId: string, body: PollAnswersIn): Promise<MessageOut> {
    return this.request("PUT", `/api/v1/messages/${messageId}/poll/answers`, body);
  }

  /** M53: decide a candidate (the author, the channel's owners, administrators): the calendar event and the thread reply. */
  decidePoll(messageId: string, index: number, createEvent = true): Promise<MessageOut> {
    return this.request("POST", `/api/v1/messages/${messageId}/poll/decide`, { index, create_event: createEvent });
  }

  /** M53: take the decision back (answers open again; the event stays). */
  undecidePoll(messageId: string): Promise<MessageOut> {
    return this.request("DELETE", `/api/v1/messages/${messageId}/poll/decide`);
  }

  // --- sidebar sections (M14f): every call returns my whole list ---------------------------

  /** M26: with its icon and the conversations to put in it (moved from other sections). */
  createSidebarSection(body: { name: string; emoji?: string | null; channel_ids?: string[] }): Promise<SidebarSectionOut[]> {
    return this.request("POST", "/api/v1/sidebar/sections", body);
  }

  /** Only what is sent changes; `emoji: null` takes the icon off. */
  updateSidebarSection(
    sectionId: string,
    patch: { name?: string; emoji?: string | null; collapsed?: boolean; position?: number; sort?: SidebarSort; manual_order?: string[] },
  ): Promise<SidebarSectionOut[]> {
    return this.request("PATCH", `/api/v1/sidebar/sections/${sectionId}`, patch);
  }

  /** A default section's sort or hand-made order (DATA_MODEL.md sidebar_sections 「並べ替え」); all three come back. */
  updateSidebarDefault(key: DefaultSectionKey, patch: { sort?: SidebarSort; manual_order?: string[] }): Promise<SidebarDefaultOut[]> {
    return this.request("PATCH", `/api/v1/sidebar/defaults/${key}`, patch);
  }

  deleteSidebarSection(sectionId: string): Promise<SidebarSectionOut[]> {
    return this.request("DELETE", `/api/v1/sidebar/sections/${sectionId}`);
  }

  placeInSidebarSection(sectionId: string, channelId: string): Promise<SidebarSectionOut[]> {
    return this.request("PUT", `/api/v1/sidebar/sections/${sectionId}/channels/${channelId}`);
  }

  removeFromSidebarSection(channelId: string): Promise<SidebarSectionOut[]> {
    return this.request("DELETE", `/api/v1/sidebar/channels/${channelId}`);
  }

  // --- invite links (M12h) ------------------------------------------------------------------

  adminListInvites(): Promise<InviteOut[]> {
    return this.request("GET", "/api/v1/admin/invites");
  }

  /** The token comes back once; the link is `inviteLink(baseUrl, token)`. */
  adminCreateInvite(body: InviteCreate): Promise<InviteCreated> {
    return this.request("POST", "/api/v1/admin/invites", body);
  }

  adminRevokeInvite(inviteId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/admin/invites/${inviteId}`);
  }

  /** No login: what the link offers. 404 = unknown, 410 = expired / used up / revoked. */
  invitePreview(token: string): Promise<InvitePreviewOut> {
    return this.request("GET", `/api/v1/invites/${encodeURIComponent(token)}`, undefined, { auth: false });
  }

  /** Creates the account and logs it in (the response is the same as a login). */
  async acceptInvite(token: string, form: Omit<InviteAccept, "device">, device: DeviceInfo): Promise<TokenResponse> {
    const tokens = await this.request<TokenResponse>(
      "POST",
      `/api/v1/invites/${encodeURIComponent(token)}/accept`,
      { ...form, device },
      { auth: false },
    );
    this.applyTokens(tokens);
    return tokens;
  }

  // --- pins and bookmarks (M11c) ---------------------------------------------------------

  listPins(channelId: string): Promise<MessageOut[]> {
    return this.request("GET", `/api/v1/channels/${channelId}/pins`);
  }

  pinMessage(messageId: string): Promise<MessageOut> {
    return this.request("PUT", `/api/v1/messages/${messageId}/pin`);
  }

  unpinMessage(messageId: string): Promise<MessageOut> {
    return this.request("DELETE", `/api/v1/messages/${messageId}/pin`);
  }

  listBookmarks(options: { cursor?: string | null; limit?: number } = {}): Promise<BookmarkListOut> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request("GET", `/api/v1/bookmarks?${params}`);
  }

  bookmarkMessage(messageId: string): Promise<BookmarkStateOut> {
    return this.request("PUT", `/api/v1/messages/${messageId}/bookmark`);
  }

  unbookmarkMessage(messageId: string): Promise<BookmarkStateOut> {
    return this.request("DELETE", `/api/v1/messages/${messageId}/bookmark`);
  }

  // --- threads (THREADS.md §3) -----------------------------------------------------------

  /** GET /threads: the threads I follow, newest reply first; `cursor` is the previous page's next_cursor. */
  threads(options: { filter?: ThreadFilter; cursor?: string | null; limit?: number } = {}): Promise<ThreadListOut> {
    const params = new URLSearchParams({ filter: options.filter ?? "all", limit: String(options.limit ?? 50) });
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request("GET", `/api/v1/threads?${params}`);
  }

  threadState(messageId: string): Promise<ThreadState> {
    return this.request("GET", `/api/v1/messages/${messageId}/thread`);
  }

  markThreadRead(messageId: string, lastReadSeq: number): Promise<ThreadState> {
    return this.request("PUT", `/api/v1/messages/${messageId}/thread/read`, { last_read_seq: lastReadSeq });
  }

  setThreadFollow(messageId: string, following: boolean): Promise<ThreadState> {
    return this.request("PUT", `/api/v1/messages/${messageId}/thread/follow`, { following });
  }

  /**
   * GET /search/messages (M16b): words and / or filters (the server applies the membership filter).
   * `has` repeats; typed before: / after: / on: dates are read in the caller's zone (DATA_MODEL.md 検索).
   */
  search(query: {
    q: string;
    channel_id?: string | null;
    from_user_id?: string | null;
    after?: string | null;
    before?: string | null;
    has?: readonly string[];
    is_thread?: boolean;
    /** L8: only times (TIMES_FEED.md §6), as `is:times` in the words. */
    is_times?: boolean;
    sort?: "relevance" | "newest";
    limit?: number;
    offset?: number;
  }): Promise<SearchOut> {
    const params = new URLSearchParams({ q: query.q, limit: String(query.limit ?? 20), offset: String(query.offset ?? 0) });
    if (query.channel_id) params.set("channel_id", query.channel_id);
    if (query.from_user_id) params.set("from_user_id", query.from_user_id);
    if (query.after) params.set("after", query.after);
    if (query.before) params.set("before", query.before);
    for (const flag of query.has ?? []) params.append("has", flag);
    if (query.is_thread) params.set("is_thread", "true");
    if (query.is_times) params.set("is_times", "true");
    if (query.sort) params.set("sort", query.sort);
    params.set("tz_offset_minutes", String(-new Date().getTimezoneOffset()));
    return this.request("GET", `/api/v1/search/messages?${params}`);
  }

  /** GET /server (M16c, no sign-in): which workspace this URL is (WORKSPACES.md §3.1). */
  serverInfo(): Promise<ServerInfoOut> {
    return this.request("GET", "/api/v1/server");
  }

  /** GET /server/icon (M93, no sign-in): the workspace icon of `version` (GET /server's `icon_version`). */
  async serverIcon(version: string): Promise<Blob> {
    const response = await this.rawFetch(`${this.baseUrl}/api/v1/server/icon?v=${encodeURIComponent(version)}`, {});
    if (!response.ok) throw await this.errorFromResponse(response);
    try {
      return await response.blob();
    } catch (err) {
      throw new NetworkError(err);
    }
  }

  /** GET /sync/summary (M16c): the switcher badge of a workspace that is not open. */
  unreadSummary(): Promise<UnreadSummaryOut> {
    return this.request("GET", "/api/v1/sync/summary");
  }

  /** POST /attachments (multipart): the server sniffs the type; the id is bound when a message is sent. */
  async uploadAttachment(file: Blob, filename: string): Promise<AttachmentOut> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const form = new FormData();
    form.append("file", file, filename);
    const send = async (): Promise<Response> =>
      this.rawFetch(`${this.baseUrl}/api/v1/attachments`, {
        method: "POST",
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } : { Accept: "application/json" },
        body: form,
      });
    let response = await send();
    if (response.status === 401) {
      await this.refresh();
      response = await send();
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    return readJson<AttachmentOut>(response);
  }

  /** Authenticated GET returning the raw body (thumbnails, downloads). */
  async fetchBlob(path: string): Promise<Blob> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const send = async (): Promise<Response> =>
      this.rawFetch(`${this.baseUrl}${path}`, { headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {} });
    let response = await send();
    if (response.status === 401) {
      await this.refresh();
      response = await send();
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    try {
      return await response.blob();
    } catch (err) {
      throw new NetworkError(err);
    }
  }

  /** fetch, with "no response" reported as a NetworkError (retryable, shown as the network text). */
  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new NetworkError(err);
    }
  }

  private async errorFromResponse(response: Response): Promise<ApiError> {
    let code = `http_${response.status}`;
    let message = "Request failed";
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // not JSON
    }
    return new ApiError(response.status, code, message);
  }

  getMessage(messageId: string): Promise<MessageOut> {
    return this.request("GET", `/api/v1/messages/${messageId}`);
  }

  /** M14c: the bodies earlier edits replaced, oldest first (author only; 403 for others). */
  messageRevisions(messageId: string): Promise<MessageRevisionOut[]> {
    return this.request("GET", `/api/v1/messages/${messageId}/revisions`);
  }

  messageContext(messageId: string): Promise<MessageOut[]> {
    return this.request("GET", `/api/v1/messages/${messageId}/context`);
  }

  replies(messageId: string): Promise<MessageOut[]> {
    return this.request("GET", `/api/v1/messages/${messageId}/replies`);
  }

  markRead(channelId: string, lastReadSeq: number, mode: "advance" | "set" = "advance"): Promise<ReadStateOut> {
    return this.request("PUT", `/api/v1/channels/${channelId}/read`, mode === "set" ? { last_read_seq: lastReadSeq, mode } : { last_read_seq: lastReadSeq });
  }

  editMessage(messageId: string, body: string): Promise<MessageOut> {
    return this.request("PATCH", `/api/v1/messages/${messageId}`, { body });
  }

  /** Returns the tombstone (deleted = true) so the caller can apply it locally. */
  deleteMessage(messageId: string): Promise<MessageOut> {
    return this.request("DELETE", `/api/v1/messages/${messageId}`);
  }

  addReaction(messageId: string, emoji: string): Promise<MessageOut> {
    return this.request("PUT", `/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {});
  }

  removeReaction(messageId: string, emoji: string): Promise<MessageOut> {
    return this.request("DELETE", `/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  // --- recurring posts (L6, M59, RECURRING.md §3) ---------------------------------------

  /** The channel's recurring posts (whoever reads the channel), oldest first. */
  recurringPosts(channelId: string): Promise<RecurringPostOut[]> {
    return this.request("GET", `/api/v1/channels/${channelId}/recurring-posts`);
  }

  /** The channel's owners and the administrators among its members (403 recurring_manage_restricted). */
  createRecurringPost(channelId: string, body: RecurringPostCreate): Promise<RecurringPostOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/recurring-posts`, body);
  }

  updateRecurringPost(postId: string, body: RecurringPostUpdate): Promise<RecurringPostOut> {
    return this.request("PATCH", `/api/v1/recurring-posts/${postId}`, body);
  }

  deleteRecurringPost(postId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/recurring-posts/${postId}`);
  }

  /** 今すぐ投稿: the next scheduled time stays. */
  runRecurringPost(postId: string): Promise<RecurringRunOut> {
    return this.request("POST", `/api/v1/recurring-posts/${postId}/run`, {});
  }

  // --- channel feeds (M97, docs/FEEDS.md §3) ---------------------------------------------

  /** The channel's feeds (whoever reads the channel), oldest first, with the last fetch's outcome. */
  channelFeeds(channelId: string): Promise<FeedOut[]> {
    return this.request("GET", `/api/v1/channels/${channelId}/feeds`);
  }

  /** Any member adds one; it is fetched once (422 feed_invalid with details.reason when it is not a feed). */
  createFeed(channelId: string, body: FeedCreate): Promise<FeedOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/feeds`, body);
  }

  /** Pause / resume: its owner, the channel's owners, administrators (403 feed_manage_restricted). */
  updateFeed(feedId: string, body: FeedUpdate): Promise<FeedOut> {
    return this.request("PATCH", `/api/v1/feeds/${feedId}`, body);
  }

  deleteFeed(feedId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/feeds/${feedId}`);
  }

  /** M98: the channel's feed bot (null before the first feed); administrators also get the bots they may adopt. */
  channelFeedBot(channelId: string): Promise<FeedBotOut> {
    return this.request("GET", `/api/v1/channels/${channelId}/feed-bot`);
  }

  /** M98: rename it (channel owners, admins) and / or adopt one of `candidates` as it (admins). */
  updateChannelFeedBot(channelId: string, body: FeedBotUpdate): Promise<FeedBotOut> {
    return this.request("PATCH", `/api/v1/channels/${channelId}/feed-bot`, body);
  }

  // --- reservation pools (M99, M112, docs/RESERVATIONS.md §3) ---------------------------------

  /** The pools I see, with today's and the coming bookings, the queue, the holders and (operators) the to-do. */
  reservationPools(): Promise<PoolOut[]> {
    return this.request("GET", "/api/v1/reservation-pools");
  }

  /** Administrators (403 reservation_manage_restricted). */
  createReservationPool(body: PoolCreate): Promise<PoolOut> {
    return this.request("POST", "/api/v1/reservation-pools", body);
  }

  /** A booking: on the hour, 1 h to the pool's max_hours, up to 14 days ahead (409 reservation_slot_full …). */
  bookReservation(poolId: string, startAt: string, hours: number): Promise<PoolOut> {
    return this.request("POST", `/api/v1/reservation-pools/${poolId}/bookings`, { start_at: startAt, hours });
  }

  /** 「延長」: a booking grows by `hours` if they have a seat. */
  extendReservation(reservationId: string, hours = 1): Promise<PoolOut> {
    return this.request("POST", `/api/v1/reservations/${reservationId}/extend`, { hours });
  }

  updateReservationPool(poolId: string, body: PoolUpdate): Promise<PoolOut> {
    return this.request("PATCH", `/api/v1/reservation-pools/${poolId}`, body);
  }

  deleteReservationPool(poolId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/reservation-pools/${poolId}`);
  }

  /** 「今すぐ (順番待ち)」: join the walk-in queue (pressing again changes nothing). */
  reserve(poolId: string): Promise<PoolOut> {
    return this.request("POST", `/api/v1/reservation-pools/${poolId}/reserve`);
  }

  /** 「入れ替えた」 (operators): `removeId` out, `assignId` in. */
  swapReservations(poolId: string, removeId: string, assignId: string): Promise<PoolOut> {
    return this.request("POST", `/api/v1/reservation-pools/${poolId}/swap`, { remove_id: removeId, assign_id: assignId });
  }

  /** cancel (取り消す) / return (返却する) / assign (割り当てた) / remove (外した). */
  reservationAction(reservationId: string, action: "cancel" | "return" | "assign" | "remove"): Promise<PoolOut> {
    return this.request("POST", `/api/v1/reservations/${reservationId}/${action}`);
  }

  // --- workflows (M94, docs/WORKFLOWS.md §4) ---------------------------------------------

  /** 「テンプレートから作成」: the editor's starting points. */
  workflowTemplates(): Promise<WorkflowTemplateOut[]> {
    return this.request("GET", "/api/v1/workflow-templates");
  }

  /** The workflows I may manage (paused ones too), by name. */
  workflows(): Promise<WorkflowOut[]> {
    return this.request("GET", "/api/v1/workflows");
  }

  /** The workflows offered in a channel whose target I can read (the menu and `/`), by name. */
  channelWorkflows(channelId: string): Promise<WorkflowOut[]> {
    return this.request("GET", `/api/v1/channels/${channelId}/workflows`);
  }

  getWorkflow(workflowId: string): Promise<WorkflowOut> {
    return this.request("GET", `/api/v1/workflows/${workflowId}`);
  }

  createWorkflow(body: WorkflowCreate): Promise<WorkflowOut> {
    return this.request("POST", "/api/v1/workflows", body);
  }

  updateWorkflow(workflowId: string, body: WorkflowUpdate): Promise<WorkflowOut> {
    return this.request("PATCH", `/api/v1/workflows/${workflowId}`, body);
  }

  deleteWorkflow(workflowId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/workflows/${workflowId}`);
  }

  /** Posts the filled form as me (201 new, 200 the same message for a retry with the same client_msg_id). */
  submitWorkflow(workflowId: string, body: WorkflowSubmit): Promise<MessageOut> {
    return this.request("POST", `/api/v1/workflows/${workflowId}/submit`, body);
  }

  // --- transport ------------------------------------------------------------------------

  async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    return (await this.requestWithStatus<T>(method, path, body, options)).data;
  }

  private async requestWithStatus<T>(
    method: Method,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ data: T; status: number }> {
    const auth = options.auth ?? true;
    if (auth && !this.accessToken && this.refreshToken) await this.refresh();
    const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;

    // A request that hangs (a half-open connection) fails after the timeout like a network error, and is retried
    // where that is right, instead of waiting for ever; the body counts too.
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS) : null;
    try {
      const response = await this.rawFetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(abort ? { signal: abort.signal } : {}),
      });
      options.onResponse?.(response);

      if (response.status === 204) return { data: undefined as T, status: 204 };
      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        throw new NetworkError(err); // the connection dropped while the body was arriving
      }
      const payload = parseJson(text);
      if (response.ok) {
        // A 2xx that is not JSON (a captive portal's page, a misrouted proxy, a server this client does not
        // understand): retrying cannot fix it, so it is refused for good and shown, as on iOS and Android.
        if (payload === NOT_JSON) throw decodeError(response.status, `${method} ${path}: the response was not JSON`);
        return { data: payload as T, status: response.status };
      }

      // A non-JSON error body (a proxy's HTML 502 page) is classified by its status alone (ARCHITECTURE.md §9).
      const error = toApiError(response.status, payload === NOT_JSON ? null : payload);
      if (auth && error.status === 401 && error.code === "token_expired" && options.retry401 !== false) {
        await this.refresh();
        return this.requestWithStatus<T>(method, path, body, { ...options, retry401: false });
      }
      if (auth && error.status === 401 && error.code !== "token_expired") this.signOut();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** M116: the members table's query string (unset values left out). */
export function analyticsParams(query: AnalyticsMembersQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A 2xx whose body is not what the API says: final (not retryable), named as the phones name it. */
function decodeError(status: number, message: string): ApiError {
  return new ApiError(status, "decode_error", message);
}

const NOT_JSON = Symbol("not JSON");

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new NetworkError(err);
  }
  const payload = parseJson(text);
  if (payload === NOT_JSON) throw decodeError(response.status, "the response was not JSON");
  return payload as T;
}

function toApiError(status: number, payload: unknown): ApiError {
  if (payload && typeof payload === "object" && "error" in payload) {
    const inner = (payload as { error: { code?: string; message?: string; details?: unknown } }).error;
    return new ApiError(status, inner.code ?? `http_${status}`, inner.message ?? "Request failed", inner.details);
  }
  return new ApiError(status, `http_${status}`, "Request failed");
}

/** `init` with an Accept-Language header (the UI language) unless it has one. */
function withAcceptLanguage(init: RequestInit | undefined): RequestInit {
  const given = init?.headers;
  if (given instanceof Headers || Array.isArray(given)) {
    const headers = new Headers(given);
    if (!headers.has("Accept-Language")) headers.set("Accept-Language", acceptLanguage());
    return { ...init, headers };
  }
  return { ...init, headers: { "Accept-Language": acceptLanguage(), ...given } };
}
