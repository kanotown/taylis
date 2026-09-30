import { ApiError, isRetryable, NetworkError } from "./errors";
import type { ActivityFilter, ActivityListOut, ActivitySummaryOut, AckPendingOut, AckRemindOut, AdminUserCreate, AdminUserCreated, AdminUserOut, AdminUserUpdate, AttachmentOut, AuthMethodsOut, BookmarkListOut, BookmarkStateOut, BootstrapOut, CanvasCreate, CanvasMeta, CanvasOut, CanvasPage, CanvasRevisionMeta, CanvasRevisionOut, CanvasRevisionPage, CanvasSaveIn, CanvasSaveOut, CanvasSearchOut, CanvasTemplateCreate, CanvasTemplateOut, CanvasTemplateUpdate, CanvasUpdate, ChannelLinkOut, ChannelOut, ChannelReadStateOut, ChannelUpdate, CustomEmojiOut, DeltaOut, DraftOut, FavoriteStateOut, FileListOut, GroupCreate, GroupOut, GroupUpdate, HistoryOut, InviteAccept, InviteCreate, InviteCreated, InviteOut, InvitePreviewOut, LabProfileOut, LabProfilePut, LinkPreviewOut, MemberOut, MemberRole, MentionListOut, MessageOut, MessageRevisionOut, MyLabProfileUpdate, NotificationLevel, NotificationPreferenceOut, PollCreate, ReadStateOut, ReminderCreate, ReminderOut, RolloverApply, RolloverOut, RolloverPreviewOut, ScheduledCreate, ScheduledOut, SearchOut, ServerInfoOut, SessionOut, SidebarSectionOut, TemplateCreate, TemplateOut, TemplateUpdate, TemporaryPasswordOut, ThreadFilter, ThreadListOut, ThreadState, TokenResponse, TotpEnabledOut, TotpSetupOut, TotpStatusOut, UnreadSummaryOut, UserMe, UserPublic, UserUpdate, WebhookCreate, WebhookCreated, WebhookOut, WebhookUpdate } from "./types";
import type { SendOptions } from "../sync/types";

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
type RequestOptions = { auth?: boolean; retry401?: boolean; headers?: Record<string, string>; timeoutMs?: number };

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
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
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
    return this.request("GET", "/api/v1/sync/bootstrap");
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

  /** POST /emoji (multipart): a name and a small image; any member may add one. */
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

  async uploadEmoji(name: string, file: Blob, filename: string): Promise<CustomEmojiOut> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const form = new FormData();
    form.append("name", name);
    form.append("file", file, filename);
    const send = async (): Promise<Response> =>
      this.rawFetch(`${this.baseUrl}/api/v1/emoji`, {
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
    return readJson<CustomEmojiOut>(response);
  }

  deleteEmoji(emojiId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/emoji/${emojiId}`);
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

  // --- favorites and read-all (M12a) ------------------------------------------------------

  favoriteChannel(channelId: string): Promise<FavoriteStateOut> {
    return this.request("PUT", `/api/v1/channels/${channelId}/favorite`);
  }

  unfavoriteChannel(channelId: string): Promise<FavoriteStateOut> {
    return this.request("DELETE", `/api/v1/channels/${channelId}/favorite`);
  }

  /** Every channel I belong to is read to its end; the response carries the new states. */
  readAll(): Promise<ChannelReadStateOut[]> {
    return this.request("POST", "/api/v1/channels/read-all");
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
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request("GET", `/api/v1/activity?${params}`);
  }

  /** The activity badge: items after my read position (at most 99), and whether a mention is among them. */
  activitySummary(): Promise<ActivitySummaryOut> {
    return this.request("GET", "/api/v1/activity/summary");
  }

  /** Everything up to `readAt` is read (the server only moves it forward, never past its own now). */
  markActivityRead(readAt: string): Promise<ActivitySummaryOut> {
    return this.request("PUT", "/api/v1/activity/read", { read_at: readAt });
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
  postPoll(channelId: string, parentId: string | null, poll: Omit<PollCreate, "anonymous"> & { anonymous?: true }): Promise<MessageOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/messages`, { client_msg_id: crypto.randomUUID(), body: "", parent_id: parentId, poll });
  }

  // --- sidebar sections (M14f): every call returns my whole list ---------------------------

  /** M26: with its icon and the conversations to put in it (moved from other sections). */
  createSidebarSection(body: { name: string; emoji?: string | null; channel_ids?: string[] }): Promise<SidebarSectionOut[]> {
    return this.request("POST", "/api/v1/sidebar/sections", body);
  }

  /** Only what is sent changes; `emoji: null` takes the icon off. */
  updateSidebarSection(sectionId: string, patch: { name?: string; emoji?: string | null; collapsed?: boolean; position?: number }): Promise<SidebarSectionOut[]> {
    return this.request("PATCH", `/api/v1/sidebar/sections/${sectionId}`, patch);
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
    if (query.sort) params.set("sort", query.sort);
    params.set("tz_offset_minutes", String(-new Date().getTimezoneOffset()));
    return this.request("GET", `/api/v1/search/messages?${params}`);
  }

  /** GET /server (M16c, no sign-in): which workspace this URL is (WORKSPACES.md §3.1). */
  serverInfo(): Promise<ServerInfoOut> {
    return this.request("GET", "/api/v1/server");
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
