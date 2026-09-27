import { ApiError, NetworkError } from "./errors";
import type {
  AdminUserCreate,
  AdminUserCreated,
  AdminUserOut,
  AdminUserUpdate,
  AttachmentOut,
  BookmarkListOut,
  BookmarkStateOut,
  BootstrapOut,
  ChannelOut,
  ChannelReadStateOut,
  FavoriteStateOut,
  CustomEmojiOut,
  FileListOut,
  InviteAccept,
  InviteCreate,
  InviteCreated,
  InviteOut,
  InvitePreviewOut,
  ReminderCreate,
  ReminderOut,
  ScheduledCreate,
  ScheduledOut,
  LinkPreviewOut,
  MentionListOut,
  DeltaOut,
  HistoryOut,
  MemberOut,
  MessageOut,
  NotificationLevel,
  NotificationPreferenceOut,
  ReadStateOut,
  SearchOut,
  TemporaryPasswordOut,
  ThreadFilter,
  ThreadListOut,
  ThreadState,
  TokenResponse,
  TotpEnabledOut,
  TotpSetupOut,
  TotpStatusOut,
  UserMe,
  UserUpdate,
  UserPublic,
} from "./types";

export interface DeviceInfo {
  platform: "desktop" | "ios" | "android";
  device_name?: string | null;
  app_version?: string | null;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  /** Called when the session is gone (refresh failed); the app returns to the login screen. */
  onSignedOut?: () => void;
  /** Called after login / refresh so the app can persist the new refresh token. */
  onTokens?: (tokens: TokenResponse) => void;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Thin HTTP client: bearer auth, single-flight refresh on token_expired, structured errors. */
export class ApiClient {
  private sessionVersion = 0;
  accessToken: string | null = null;
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
    this.refreshing = this.request<TokenResponse>(
      "POST",
      "/api/v1/auth/refresh",
      { refresh_token: token },
      { auth: false },
    )
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

  async logout(): Promise<void> {
    try {
      await this.request<void>("POST", "/api/v1/auth/logout", undefined, { retry401: false });
    } catch {
      // The session may already be gone; local sign-out still happens.
    }
    this.signOut();
  }

  signOut(): void {
    this.sessionVersion += 1;
    this.accessToken = null;
    this.refreshToken = null;
    this.options.onSignedOut?.();
  }

  private applyTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
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

  addMember(channelId: string, userId: string): Promise<MemberOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/members`, { user_id: userId });
  }

  createChannel(name: string, type: "public" | "private"): Promise<ChannelOut> {
    return this.request("POST", "/api/v1/channels", { name, type });
  }

  joinChannel(channelId: string): Promise<ChannelOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/join`);
  }

  updateChannel(channelId: string, patch: { name?: string; topic?: string | null; purpose?: string | null }): Promise<ChannelOut> {
    return this.request("PATCH", `/api/v1/channels/${channelId}`, patch);
  }

  setNotificationPreference(channelId: string, level: NotificationLevel, mutedUntil: string | null): Promise<NotificationPreferenceOut> {
    return this.request("PUT", `/api/v1/channels/${channelId}/notification-preference`, { level, muted_until: mutedUntil });
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
  ): Promise<{ message: MessageOut; created: boolean }> {
    const { data, status } = await this.requestWithStatus<MessageOut>(
      "POST",
      `/api/v1/channels/${channelId}/messages`,
      { client_msg_id: clientMsgId, body, parent_id: parentId, attachment_ids: attachmentIds },
    );
    return { message: data, created: status === 201 };
  }

  // --- custom emoji (M12f) ---------------------------------------------------------------

  listEmoji(): Promise<CustomEmojiOut[]> {
    return this.request("GET", "/api/v1/emoji");
  }

  /** POST /emoji (multipart): a name and a small image; any member may add one. */
  async uploadEmoji(name: string, file: Blob, filename: string): Promise<CustomEmojiOut> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const form = new FormData();
    form.append("name", name);
    form.append("file", file, filename);
    const send = async (): Promise<Response> =>
      this.fetchImpl(`${this.baseUrl}/api/v1/emoji`, {
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
    return (await response.json()) as CustomEmojiOut;
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

  leaveChannel(channelId: string): Promise<void> {
    return this.request("POST", `/api/v1/channels/${channelId}/leave`);
  }

  removeMember(channelId: string, userId: string): Promise<void> {
    return this.request("DELETE", `/api/v1/channels/${channelId}/members/${userId}`);
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

  /** GET /search/messages: full-text search across my channels (the server applies the membership filter). */
  searchMessages(query: string, options: { channelId?: string | null; limit?: number; offset?: number } = {}): Promise<SearchOut> {
    const params = new URLSearchParams({ q: query, limit: String(options.limit ?? 20), offset: String(options.offset ?? 0) });
    if (options.channelId) params.set("channel_id", options.channelId);
    // before: / after: / on: dates are interpreted in the caller's zone (DATA_MODEL.md 検索).
    params.set("tz_offset_minutes", String(-new Date().getTimezoneOffset()));
    return this.request("GET", `/api/v1/search/messages?${params}`);
  }

  /** POST /attachments (multipart): the server sniffs the type; the id is bound when a message is sent. */
  async uploadAttachment(file: Blob, filename: string): Promise<AttachmentOut> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const form = new FormData();
    form.append("file", file, filename);
    const send = async (): Promise<Response> =>
      this.fetchImpl(`${this.baseUrl}/api/v1/attachments`, {
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
    return (await response.json()) as AttachmentOut;
  }

  /** Authenticated GET returning the raw body (thumbnails, downloads). */
  async fetchBlob(path: string): Promise<Blob> {
    if (!this.accessToken && this.refreshToken) await this.refresh();
    const send = async (): Promise<Response> =>
      this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {} });
    let response = await send();
    if (response.status === 401) {
      await this.refresh();
      response = await send();
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    return response.blob();
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
    options: { auth?: boolean; retry401?: boolean } = {},
  ): Promise<T> {
    return (await this.requestWithStatus<T>(method, path, body, options)).data;
  }

  private async requestWithStatus<T>(
    method: Method,
    path: string,
    body?: unknown,
    options: { auth?: boolean; retry401?: boolean } = {},
  ): Promise<{ data: T; status: number }> {
    const auth = options.auth ?? true;
    if (auth && !this.accessToken && this.refreshToken) await this.refresh();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new NetworkError(err);
    }

    if (response.status === 204) return { data: undefined as T, status: 204 };
    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : null;
    if (response.ok) return { data: payload as T, status: response.status };

    const error = toApiError(response.status, payload);
    if (auth && error.status === 401 && error.code === "token_expired" && options.retry401 !== false) {
      await this.refresh();
      return this.requestWithStatus<T>(method, path, body, { ...options, retry401: false });
    }
    if (auth && error.status === 401 && error.code !== "token_expired") this.signOut();
    throw error;
  }
}

function toApiError(status: number, payload: unknown): ApiError {
  if (payload && typeof payload === "object" && "error" in payload) {
    const inner = (payload as { error: { code?: string; message?: string; details?: unknown } }).error;
    return new ApiError(status, inner.code ?? `http_${status}`, inner.message ?? "Request failed", inner.details);
  }
  return new ApiError(status, `http_${status}`, "Request failed");
}
