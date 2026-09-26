/** Application controller: login, session restore, and the sync engine lifecycle. */
import { ApiClient } from "../api/client";
import { ApiError } from "../api/errors";
import type { TokenResponse, UserMe } from "../api/types";
import { isTauri } from "../platform/env";
import { notify } from "../platform/notify";
import { secretStore } from "../platform/secrets";
import { SqlitePersistence } from "../platform/sqlite";
import { SyncEngine } from "../sync/engine";
import { Store } from "../sync/store";
import { browserConnector } from "../sync/ws";

export type Screen = "boot" | "login" | "change_password" | "main";

const SERVER_KEY = "chikuwa.server";
const USERNAME_KEY = "chikuwa.username";
const APP_VERSION = "0.1.0";

export class AppController {
  screen: Screen = "boot";
  error: string | null = null;
  api: ApiClient | null = null;
  store: Store = new Store();
  engine: SyncEngine | null = null;
  me: UserMe | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly secrets = secretStore();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setScreen(screen: Screen, error: string | null = null): void {
    this.screen = screen;
    this.error = error;
    this.emit();
  }

  get serverUrl(): string {
    return localStorage.getItem(SERVER_KEY) ?? "http://127.0.0.1:8000";
  }

  get username(): string {
    return localStorage.getItem(USERNAME_KEY) ?? "";
  }

  private account(server: string, username: string): string {
    return `${server}|${username}`;
  }

  private createApi(server: string, username: string): ApiClient {
    const account = this.account(server, username);
    return new ApiClient(server, {
      onTokens: (tokens: TokenResponse) => void this.secrets.set(account, tokens.refresh_token),
      onSignedOut: () => void this.handleSignedOut(account),
    });
  }

  /** Startup: restore the previous session from the credential store (SYNC_PROTOCOL.md §7.2). */
  async boot(): Promise<void> {
    const server = this.serverUrl;
    const username = this.username;
    if (!username) {
      this.setScreen("login");
      return;
    }
    const refreshToken = await this.secrets.get(this.account(server, username));
    if (!refreshToken) {
      this.setScreen("login");
      return;
    }
    const api = this.createApi(server, username);
    api.refreshToken = refreshToken;
    try {
      const tokens = await api.refresh();
      await this.enterSession(api, username, tokens.user);
    } catch (err) {
      this.setScreen("login", err instanceof ApiError && err.isAuth ? null : describe(err));
    }
  }

  async login(server: string, username: string, password: string): Promise<void> {
    server = server.replace(/\/+$/, "");
    const api = this.createApi(server, username);
    try {
      const tokens = await api.login(username, password, {
        platform: "desktop",
        device_name: navigator.platform || "desktop",
        app_version: APP_VERSION,
      });
      localStorage.setItem(SERVER_KEY, server);
      localStorage.setItem(USERNAME_KEY, username);
      await this.enterSession(api, username, tokens.user);
    } catch (err) {
      this.setScreen("login", describe(err));
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.changePassword(currentPassword, newPassword);
      this.me = await this.api.me();
      await this.startEngine();
    } catch (err) {
      this.setScreen("change_password", describe(err));
    }
  }

  private async enterSession(api: ApiClient, username: string, me: UserMe): Promise<void> {
    this.api = api;
    this.me = me;
    if (me.must_change_password) {
      this.setScreen("change_password");
      return;
    }
    await this.startEngine();
  }

  private async startEngine(): Promise<void> {
    const api = this.api;
    if (!api) return;
    this.engine?.stop();
    const profile = safeProfile(this.account(api.baseUrl, this.username));
    this.store = new Store(isTauri() ? await SqlitePersistence.open(profile) : null);
    await this.store.load();
    const engine = new SyncEngine({
      api,
      connect: browserConnector(api.wsUrl),
      store: this.store,
      getAccessToken: () => api.accessToken,
      onSignedOut: () => void this.handleSignedOut(this.account(api.baseUrl, this.username)),
      onNotify: (message, channel) => {
        const sender = this.store.users.get(message.sender_id)?.display_name ?? "Someone";
        const title = channel.type === "dm" ? sender : `${sender} (group DM)`;
        void notify(title, message.body.slice(0, 200));
      },
      isActive: () => document.hasFocus(),
    });
    this.engine = engine;
    engine.subscribe(() => this.emit());
    this.setScreen("main");
    await engine.start();
  }

  async logout(): Promise<void> {
    this.engine?.stop();
    this.engine = null;
    await this.api?.logout();
  }

  private async handleSignedOut(account: string): Promise<void> {
    this.engine?.stop();
    this.engine = null;
    this.api = null;
    this.me = null;
    await this.secrets.delete(account);
    this.setScreen("login");
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function safeProfile(account: string): string {
  return account.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 80);
}
