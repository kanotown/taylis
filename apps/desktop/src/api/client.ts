import { ApiError, NetworkError } from "./errors";
import type {
  BootstrapOut,
  ChannelOut,
  DeltaOut,
  HistoryOut,
  MemberOut,
  MessageOut,
  TokenResponse,
  UserMe,
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

  async login(username: string, password: string, device: DeviceInfo): Promise<TokenResponse> {
    const tokens = await this.request<TokenResponse>(
      "POST",
      "/api/v1/auth/login",
      { username, password, device },
      { auth: false },
    );
    this.applyTokens(tokens);
    return tokens;
  }

  async refresh(): Promise<TokenResponse> {
    if (this.refreshing) return this.refreshing;
    const token = this.refreshToken;
    if (!token) throw new ApiError(401, "missing_token", "No refresh token");
    this.refreshing = this.request<TokenResponse>(
      "POST",
      "/api/v1/auth/refresh",
      { refresh_token: token },
      { auth: false },
    )
      .then((tokens) => {
        this.applyTokens(tokens);
        return tokens;
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.isAuth) this.signOut();
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

  createChannel(name: string, type: "public" | "private"): Promise<ChannelOut> {
    return this.request("POST", "/api/v1/channels", { name, type });
  }

  joinChannel(channelId: string): Promise<ChannelOut> {
    return this.request("POST", `/api/v1/channels/${channelId}/join`);
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
  ): Promise<{ message: MessageOut; created: boolean }> {
    const { data, status } = await this.requestWithStatus<MessageOut>(
      "POST",
      `/api/v1/channels/${channelId}/messages`,
      { client_msg_id: clientMsgId, body },
    );
    return { message: data, created: status === 201 };
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
