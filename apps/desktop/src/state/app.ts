/** Application controller: login, session restore, and the sync engine lifecycle. */
import { ApiClient } from "../api/client";
import { ApiError } from "../api/errors";
import type { AttachmentOut, MessageOut, NotificationLevel, TokenResponse, UserMe } from "../api/types";
import { saveDownload } from "../platform/download";
import type { MessageState } from "../sync/types";
import { isTauri } from "../platform/env";
import { notify } from "../platform/notify";
import { secretStore } from "../platform/secrets";
import { SqlitePersistence } from "../platform/sqlite";
import { SyncEngine } from "../sync/engine";
import { Store } from "../sync/store";
import { browserConnector } from "../sync/ws";
import { plainText } from "../ui/markdown";
import { mentionsToNames } from "../ui/mentions";
import { readSendKey, type SendKey, writeSendKey } from "../ui/prefs";

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
  messageFocus: { channelId: string; messageId: string; parentId: string | null; context: MessageOut[] } | null = null;

  /** Which key sends a message; the other inserts a newline. Stored per device. */
  sendKey: SendKey = readSendKey();
  setSendKey(value: SendKey): void {
    this.sendKey = value;
    writeSendKey(value);
    this.emit();
  }
  /** Message in inline edit mode (Timeline / ThreadPane); ↑ in an empty composer sets it. */
  editing: string | null = null;
  setEditing(id: string | null): void { this.editing = id; this.emit(); }
  clearMessageFocus(): void { this.messageFocus = null; this.emit(); }
  async revealMessage(message: MessageOut): Promise<boolean> {
    if (!this.api) return false;
    try {
      const context = await this.api.messageContext(message.id);
      if (message.parent_id) for (const reply of await this.api.replies(message.parent_id)) this.store.upsertMessage(reply);
      this.messageFocus = { channelId: message.channel_id, messageId: message.id, parentId: message.parent_id ?? null, context };
      this.emit();
      return true;
    } catch (error) { this.setError(error); return false; }
  }
  private readonly listeners = new Set<() => void>();
  private readonly secrets = secretStore();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Bumped on every emit so useSyncExternalStore sees controller-only changes (editing, error, focus). */
  version = 0;

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private setScreen(screen: Screen, error: string | null = null): void {
    this.screen = screen;
    this.error = error;
    this.emit();
  }

  /** Human-readable text for an error (dialogs show it inline). */
  describe(error: unknown): string {
    return describe(error);
  }

  /** Surface a problem to the UI (toast on the main screen); null clears it. */
  setError(error: unknown): void {
    this.error = error === null ? null : error instanceof Error ? error.message : String(error);
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
    const api = new ApiClient(server, {
      onTokens: (tokens: TokenResponse) => void this.secrets.set(account, tokens.refresh_token),
      onSignedOut: () => { if (this.api === api) void this.handleSignedOut(account); },
    });
    return api;
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
    this.api = api;
    if (await this.startEngine(true)) return;
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

  get isAdmin(): boolean {
    return this.me?.role === "admin";
  }

  /** Fetch the bytes with the bearer token and hand them to the platform save dialog. */
  async downloadAttachment(attachment: AttachmentOut): Promise<void> {
    if (!this.api) return;
    try {
      const blob = await this.api.fetchBlob(`/api/v1/attachments/${attachment.id}/content`);
      await saveDownload(attachment.filename, blob);
    } catch (error) {
      this.setError(error);
    }
  }

  // --- message actions (M8a): apply the server's answer at once; the WS event is deduplicated ---

  async editMessage(messageId: string, body: string): Promise<void> {
    if (!this.api) return;
    try {
      this.store.upsertMessage(await this.api.editMessage(messageId, body));
    } catch (error) {
      this.setError(error);
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!this.api) return;
    try {
      this.store.upsertMessage(await this.api.deleteMessage(messageId));
    } catch (error) {
      this.setError(error);
    }
  }

  /** M11c: any member pins / unpins; the updated message (with pinned_at) replaces the row. */
  async togglePin(message: MessageState): Promise<void> {
    if (!this.api) return;
    try {
      this.store.upsertMessage(message.pinned_at ? await this.api.unpinMessage(message.id) : await this.api.pinMessage(message.id));
    } catch (error) {
      this.setError(error);
    }
  }

  /** M11c: saved for me only; the store flag moves at once, bookmark.updated confirms on every device. */
  async toggleBookmark(message: MessageState): Promise<void> {
    if (!this.api) return;
    const on = !this.store.isBookmarked(message.id);
    this.store.setBookmarked(message.id, on);
    try {
      if (on) await this.api.bookmarkMessage(message.id);
      else await this.api.unbookmarkMessage(message.id);
    } catch (error) {
      this.store.setBookmarked(message.id, !on);
      this.setError(error);
    }
  }

  async toggleReaction(message: MessageState, emoji: string): Promise<void> {
    const me = this.store.me;
    if (!this.api || !me) return;
    const mine = (message.reactions ?? []).some((r) => r.emoji === emoji && r.user_ids.includes(me.id));
    try {
      const updated = mine ? await this.api.removeReaction(message.id, emoji) : await this.api.addReaction(message.id, emoji);
      this.store.upsertMessage(updated);
    } catch (error) {
      this.setError(error);
    }
  }

  // --- channel and profile settings (UI brush-up) -------------------------------------------------------

  async updateTopic(channelId: string, topic: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      const channel = await this.api.updateChannel(channelId, { topic: topic.trim() || null });
      this.store.upsertChannel(channel);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async setNotification(channelId: string, level: NotificationLevel, mutedUntil: string | null = null): Promise<void> {
    if (!this.api) return;
    try {
      const out = await this.api.setNotificationPreference(channelId, level, mutedUntil);
      this.store.setNotification(channelId, out.level, out.muted_until ?? null);
    } catch (error) {
      this.setError(error);
    }
  }

  async updateDisplayName(displayName: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      const me = await this.api.updateMe({ display_name: displayName.trim() });
      this.me = me;
      this.store.setMe(me);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** Password change from the settings dialog (the forced first-login flow is `changePassword`). */
  async changePasswordInSession(current: string, next: string): Promise<string | null> {
    if (!this.api) return "ログインしていません";
    try {
      await this.api.changePassword(current, next);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
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

  private async startEngine(restoring = false): Promise<boolean> {
    const api = this.api;
    if (!api) return false;
    this.engine?.stop();
    this.messageFocus = null;
    this.editing = null;
    const profile = safeProfile(this.account(api.baseUrl, this.username));
    this.store = new Store(isTauri() ? await SqlitePersistence.open(profile) : null);
    await this.store.load();
    if (restoring && (!this.store.me || this.store.me.must_change_password)) return false;
    if (restoring) this.me = this.store.me;
    else if (this.me) this.store.setMe(this.me);
    const engine = new SyncEngine({
      api,
      connect: browserConnector(api.wsUrl),
      store: this.store,
      getAccessToken: () => api.accessToken,
      prepareConnection: async () => {
        const tokens = await api.refresh();
        if (this.api !== api || this.engine !== engine) return;
        this.me = tokens.user;
        this.store.setMe(tokens.user);
        if (tokens.user.must_change_password) {
          this.engine?.stop();
          this.setScreen("change_password");
          throw new Error("Password change required");
        }
      },
      onSignedOut: () => { if (this.engine === engine) void this.handleSignedOut(this.account(api.baseUrl, this.username)); },
      onNotify: (message, channel) => {
        const sender = this.store.users.get(message.sender_id)?.display_name ?? "Someone";
        const title = channel.type === "dm" ? sender : `${sender} (group DM)`;
        void notify(title, plainText(mentionsToNames(message.body, this.store.users)) || "新しいメッセージ");
      },
      isActive: () => document.hasFocus(),
    });
    this.engine = engine;
    engine.subscribe(() => this.emit());
    this.setScreen("main");
    void engine.start();
    return true;
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
