/** Application controller: login, session restore, and the sync engine lifecycle. */
import { ApiClient, type DeviceInfo } from "../api/client";
import { dndActive } from "../ui/dnd";
import { messagePermalink } from "../ui/permalink";
import { inviteErrorText } from "../ui/invite";
import { totpErrorText } from "../ui/totp";
import { parseEntryPath } from "../ui/routes";
import { scheduleLabel } from "../ui/schedule";
import { ApiError } from "../api/errors";
import type { AttachmentOut, CustomEmojiOut, InvitePreviewOut, LinkPreviewOut, TotpEnabledOut, TotpSetupOut, TotpStatusOut, MessageOut, NotificationLevel, ReminderOut, ScheduledOut, TokenResponse, UserMe, UserUpdate } from "../api/types";
import { saveDownload } from "../platform/download";
import type { MessageState } from "../sync/types";
import { isTauri, isWeb } from "../platform/env";
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
  /** A short confirmation (「リンクをコピーしました」); null when nothing to say. */
  notice: string | null = null;
  /** M12i: the last login was refused for lack of an authenticator code; the form asks for one. */
  totpRequired = false;
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

  /** In a browser (M12j) the app is served next to the API, so the server is the page's own origin. */
  get serverUrl(): string {
    if (isWeb()) return location.origin;
    return localStorage.getItem(SERVER_KEY) ?? "http://127.0.0.1:8000";
  }

  /** M12j: what the browser URL asked for, consumed once (an invite link, or a message to reveal). */
  entryInvite: string | null = null;
  private entryMessage: string | null = null;

  private takeEntryPath(): void {
    const entry = parseEntryPath(location.pathname);
    if (!entry) return;
    if (entry.kind === "invite") this.entryInvite = entry.token;
    else this.entryMessage = entry.id;
    history.replaceState(null, "", "/");
  }

  private async revealEntry(): Promise<void> {
    const id = this.entryMessage;
    if (!id) return;
    this.entryMessage = null;
    await this.openPermalink(id);
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
    if (isWeb()) this.takeEntryPath();
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

  private deviceInfo(): DeviceInfo {
    return {
      platform: isWeb() ? "web" : "desktop",
      device_name: isWeb() ? "ブラウザ" : navigator.platform || "desktop",
      app_version: APP_VERSION,
    };
  }

  async login(server: string, username: string, password: string, totpCode?: string): Promise<void> {
    server = server.replace(/\/+$/, "");
    const api = this.createApi(server, username);
    try {
      const tokens = await api.login(username, password, this.deviceInfo(), totpCode);
      localStorage.setItem(SERVER_KEY, server);
      localStorage.setItem(USERNAME_KEY, username);
      this.totpRequired = false;
      await this.enterSession(api, username, tokens.user);
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") {
        this.totpRequired = true;
        this.setScreen("login", null);
        return;
      }
      if (err instanceof ApiError && err.code === "invalid_totp") {
        this.totpRequired = true;
        this.setScreen("login", totpErrorText(err));
        return;
      }
      this.totpRequired = false;
      this.setScreen("login", describe(err));
    }
  }

  // --- two-factor authentication (M12i): the settings dialog drives these -----------------

  async totpStatus(): Promise<TotpStatusOut | null> {
    if (!this.api) return null;
    try {
      return await this.api.totpStatus();
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  async beginTotpSetup(password: string): Promise<TotpSetupOut | { error: string }> {
    if (!this.api) return { error: "ログインしていません" };
    try {
      return await this.api.totpSetup(password);
    } catch (error) {
      return { error: totpErrorText(error) };
    }
  }

  async enableTotp(code: string): Promise<TotpEnabledOut | { error: string }> {
    if (!this.api) return { error: "ログインしていません" };
    try {
      return await this.api.totpEnable(code);
    } catch (error) {
      return { error: totpErrorText(error) };
    }
  }

  /** Returns the failure text, if any. */
  async disableTotp(password: string): Promise<string | null> {
    if (!this.api) return "ログインしていません";
    try {
      await this.api.totpDisable(password);
      return null;
    } catch (error) {
      return totpErrorText(error);
    }
  }

  /** M12h: what an invite link offers, before any account exists (throws on a dead link). */
  previewInvite(server: string, token: string): Promise<InvitePreviewOut> {
    return new ApiClient(server.replace(/\/+$/, "")).invitePreview(token);
  }

  /** M12h: create the account the link allows and enter the session; returns the failure text, if any. */
  async acceptInvite(server: string, token: string, form: { username: string; display_name: string; password: string }): Promise<string | null> {
    server = server.replace(/\/+$/, "");
    const api = this.createApi(server, form.username);
    try {
      const tokens = await api.acceptInvite(token, form, this.deviceInfo());
      localStorage.setItem(SERVER_KEY, server);
      localStorage.setItem(USERNAME_KEY, form.username);
      await this.enterSession(api, form.username, tokens.user);
      return null;
    } catch (err) {
      return inviteErrorText(err);
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

  // --- link previews (M11g): one fetch per URL per session ---------------------------------

  readonly linkPreviews = new Map<string, LinkPreviewOut | null>();
  private readonly previewLoads = new Map<string, Promise<void>>();

  /** The cached preview for a URL (null = failed / none); starts a fetch when unknown. */
  linkPreview(url: string): LinkPreviewOut | null | undefined {
    if (this.linkPreviews.has(url)) return this.linkPreviews.get(url);
    if (!this.api || this.previewLoads.has(url)) return undefined;
    const api = this.api;
    const load = api
      .linkPreview(url)
      .then((preview) => {
        this.linkPreviews.set(url, preview.status === "ok" ? preview : null);
      })
      .catch(() => {
        this.linkPreviews.set(url, null); // refused or rate limited: no card for this session
      })
      .finally(() => {
        this.previewLoads.delete(url);
        this.emit();
      });
    this.previewLoads.set(url, load);
    return undefined;
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

  setNotice(text: string | null): void {
    this.notice = text;
    this.emit();
  }

  /** M12f: add a custom emoji; everyone gets emoji.updated, this device applies it at once. */
  async uploadEmoji(name: string, file: File): Promise<boolean> {
    if (!this.api) return false;
    try {
      const row = await this.api.uploadEmoji(name, file, file.name);
      this.store.applyCustomEmoji(row, false);
      this.setNotice(`:${row.name}: を追加しました`);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async deleteEmoji(emojiId: string): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.deleteEmoji(emojiId);
      const row = [...this.store.customEmoji.values()].find((e) => e.id === emojiId);
      if (row) this.store.applyCustomEmoji(row, true);
    } catch (error) {
      this.setError(error);
    }
  }

  /** M12e 「リマインド」: a nudge about the message at `at`. */
  async setReminder(messageId: string, at: Date, note: string | null = null): Promise<boolean> {
    if (!this.api) return false;
    try {
      const row = await this.api.createReminder(messageId, { remind_at: at.toISOString(), note });
      this.store.applyReminder(row);
      this.setNotice(`${scheduleLabel(row.remind_at)} にリマインドします`);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** Cancels a pending reminder or marks a fired one done. */
  async closeReminder(row: ReminderOut): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.closeReminder(row.id);
      this.store.applyReminder({ ...row, status: row.status === "fired" ? "done" : "cancelled" });
    } catch (error) {
      this.setError(error);
    }
  }

  /** M12d 「後で送信」: the server posts the draft at `sendAt`; the row shows up under 下書き. */
  async scheduleMessage(channelId: string, parentId: string | null, body: string, attachmentIds: string[], sendAt: Date): Promise<boolean> {
    if (!this.api) return false;
    try {
      const row = await this.api.scheduleMessage(channelId, {
        client_msg_id: crypto.randomUUID(),
        body,
        parent_id: parentId,
        attachment_ids: attachmentIds,
        send_at: sendAt.toISOString(),
      });
      this.store.applyScheduled(row);
      this.setNotice(`${scheduleLabel(row.send_at)} に送信します`);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** Cancel a scheduled message; its text returns to the conversation's draft so nothing is lost. */
  async cancelScheduled(row: ScheduledOut, restoreDraft = true): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.cancelScheduled(row.id);
      this.store.applyScheduled({ ...row, status: "cancelled" });
      if (restoreDraft && row.body) this.store.setDraft(row.channel_id, row.parent_id ?? null, { text: row.body });
    } catch (error) {
      this.setError(error);
    }
  }

  async sendScheduledNow(row: ScheduledOut): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.sendScheduledNow(row.id);
      this.store.applyScheduled({ ...row, status: "sent" });
    } catch (error) {
      this.setError(error);
    }
  }

  /** M12b: `<server>/m/<id>` for the server we are logged into. */
  permalink(messageId: string): string | null {
    return this.api ? messagePermalink(this.api.baseUrl, messageId) : null;
  }

  async copyPermalink(messageId: string): Promise<void> {
    const url = this.permalink(messageId);
    if (!url) return;
    try {
      await copyText(url);
      this.setNotice("リンクをコピーしました");
    } catch (error) {
      this.setError(error);
    }
  }

  /** A permalink tapped in a body: fetch the message (membership is checked there) and reveal it. */
  async openPermalink(messageId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      return await this.revealMessage(await this.api.getMessage(messageId));
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** M12a: a starred channel; the store flag moves at once, favorite.updated confirms on every device. */
  async toggleFavorite(channelId: string): Promise<void> {
    if (!this.api) return;
    const on = !this.store.isFavorite(channelId);
    this.store.setFavorite(channelId, on);
    try {
      if (on) await this.api.favoriteChannel(channelId);
      else await this.api.unfavoriteChannel(channelId);
    } catch (error) {
      this.store.setFavorite(channelId, !on);
      this.setError(error);
    }
  }

  /** M12a 「すべて既読にする」. */
  async markAllRead(): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.markAllRead();
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

  // --- channel management (M11e) ---------------------------------------------------------

  async renameChannel(channelId: string, name: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertChannel(await this.api.updateChannel(channelId, { name: name.trim() }));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async archiveChannel(channelId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertChannel(await this.api.archiveChannel(channelId));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async leaveChannel(channelId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.leaveChannel(channelId);
      this.store.removeChannel(channelId);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async removeMember(channelId: string, userId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.removeMember(channelId, userId);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

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

  /** M11d: profile card fields (title, custom status). Null clears; omitted fields keep their value. */
  async updateProfile(patch: UserUpdate): Promise<boolean> {
    if (!this.api) return false;
    try {
      const me = await this.api.updateMe(patch);
      this.me = me;
      this.store.setMe(me);
      this.store.upsertUser(me);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** Open (or create) the DM with one user; returns its channel id. */
  async openDmWith(userId: string): Promise<string | null> {
    if (!this.api) return null;
    const existing = [...this.store.channels.values()].find((c) => c.type === "dm" && (c.dm_user_ids ?? []).includes(userId) && (c.dm_user_ids ?? []).length <= 2);
    if (existing) return existing.id;
    try {
      const channel = await this.api.createDm([userId]);
      this.store.upsertChannel(channel, { isMember: true });
      return channel.id;
    } catch (error) {
      this.setError(error);
      return null;
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
      onReminder: (reminder) => {
        if (dndActive(this.store.me ? this.store.users.get(this.store.me.id) ?? this.store.me : null)) return;
        void notify("リマインダー", (reminder.note ? `${reminder.note} — ` : "") + reminder.preview);
      },
      onNotify: (message, channel) => {
        if (dndActive(this.store.me ? this.store.users.get(this.store.me.id) ?? this.store.me : null)) return; // M12c: paused / quiet hours
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
    if (this.entryMessage) {
      // M12j: the browser has no local store; reveal once the first sync has brought the channels.
      const unsubscribe = engine.subscribe(() => {
        if (engine.status !== "online" || this.store.channels.size === 0) return;
        unsubscribe();
        void this.revealEntry();
      });
    }
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

/** The async clipboard first; a hidden textarea + execCommand when a webview refuses it (no permission API). */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("クリップボードに書き込めませんでした");
}
