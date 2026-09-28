/** Application controller: login, session restore, and the sync engine lifecycle. */
import { ApiClient, type DeviceInfo } from "../api/client";
import { dndActive } from "../ui/dnd";
import { messagePermalink } from "../ui/permalink";
import { inviteErrorText } from "../ui/invite";
import { totpErrorText } from "../ui/totp";
import { shareBody } from "../ui/share";
import { conversationTitle, hasUnread, unreadBadgeTotal } from "../ui/channels";
import { configureAvatars, noteVersions } from "../ui/avatars";
import { parseEntryPath } from "../ui/routes";
import { COMMANDS, type ParsedCommand, parseDuration, SHRUG, splitStatus } from "../ui/commands";
import { scheduleLabel } from "../ui/schedule";
import { ApiError, describeError, NetworkError } from "../api/errors";
import { hostLabel, isServerInfo, loadWorkspaces, normalizeServerUrl, sameServer, saveWorkspaces as persistWorkspaces, type WorkspaceEntry } from "./workspaces";
import type { AttachmentOut, CustomEmojiOut, InvitePreviewOut, LinkPreviewOut, MessageOut, NotificationLevel, PostingPolicy, ReminderOut, ScheduledOut, ServerInfoOut, SidebarSectionOut, TokenResponse, TotpEnabledOut, TotpSetupOut, TotpStatusOut, UserMe, UserUpdate, MyLabProfileUpdate } from "../api/types";
import { saveDownload } from "../platform/download";
import type { ChannelState, MessageState } from "../sync/types";
import { setTitleBase, setUnreadBadge } from "../platform/badge";
import { isTauri, isWeb } from "../platform/env";
import { clearNotifications, notify } from "../platform/notify";
import { secretStore } from "../platform/secrets";
import { SqlitePersistence } from "../platform/sqlite";
import { SyncEngine } from "../sync/engine";
import { Store } from "../sync/store";
import { browserConnector } from "../sync/ws";
import { plainText } from "../ui/markdown";
import { decodeMentions, mentionsToNames } from "../ui/mentions";
import { readSendKey, type SendKey, writeSendKey } from "../ui/prefs";

export type Screen = "boot" | "login" | "change_password" | "main";

/** The browser build before workspaces (M16c) remembered only the user name. */
const USERNAME_KEY = "chikuwa.username";
const APP_VERSION = "0.1.0";

export class AppController {
  screen: Screen = "boot";
  error: string | null = null;
  /** A short confirmation (「リンクをコピーしました」); null when nothing to say. */
  notice: string | null = null;
  /** M12i: the last login was refused for lack of an authenticator code; the form asks for one. */
  totpRequired = false;
  /**
   * M16c: each signed-in workspace (server) has a session; the screen shows the active one. In Tauri the
   * others stay connected for their notifications and badges (WORKSPACES.md §6).
   */
  private active: Session | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly idleStore = new Store();
  /** The registered workspaces in the order added, and the key (server URL) of the one on screen. */
  workspaces: WorkspaceEntry[] = [];
  activeServer: string | null = null;
  /** The login form is adding another workspace; cancelling returns to `returnTo`. */
  addingWorkspace = false;
  private returnTo: string | null = null;

  get api(): ApiClient | null {
    return this.active?.api ?? null;
  }
  /** A client without a workspace behind it (tests; the screen works on it as on the active session). */
  set api(api: ApiClient | null) {
    this.active = api ? { serverUrl: api.baseUrl, username: this.username, api, store: this.store, engine: null, me: null, leaving: false } : null;
  }
  get store(): Store {
    return this.active?.store ?? this.idleStore;
  }
  get engine(): SyncEngine | null {
    return this.active?.engine ?? null;
  }
  get me(): UserMe | null {
    return this.active?.me ?? null;
  }
  set me(me: UserMe | null) {
    if (this.active) this.active.me = me;
  }
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

  /** Human-readable (Japanese) text for an error (dialogs show it inline). */
  describe(error: unknown): string {
    return describe(error);
  }

  /** Surface a problem to the UI (toast on the main screen); a string is shown as is, null clears it. */
  setError(error: unknown): void {
    this.error = error === null ? null : describe(error);
    this.emit();
  }

  /** The login form's server: the page's own origin in a browser (M12j), else the active workspace. */
  get serverUrl(): string {
    if (isWeb()) return location.origin;
    if (this.addingWorkspace) return "";
    return this.activeEntry?.serverUrl ?? (this.workspaces.length === 0 ? "http://127.0.0.1:8000" : "");
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

  /** "server|username" of the signed-in account: names this device's per-account data (recent searches). */
  get accountKey(): string | null {
    return this.active ? this.account(this.active.serverUrl, this.active.username) : null;
  }

  get username(): string {
    if (this.addingWorkspace) return "";
    return this.active?.username ?? this.activeEntry?.username ?? "";
  }

  private account(server: string, username: string): string {
    return `${server}|${username}`;
  }

  private createApi(server: string, username: string): ApiClient {
    const account = this.account(server, username);
    const api: ApiClient = new ApiClient(server, {
      onTokens: (tokens: TokenResponse) => void this.secrets.set(account, tokens.refresh_token),
      onSignedOut: () => {
        const session = [...this.sessions.values()].find((s) => s.api === api) ?? (this.active?.api === api ? this.active : null);
        if (session) void this.handleSignedOut(session);
      },
    });
    return api;
  }

  /**
   * Startup: the saved workspaces (M16c), then the active one's session from the credential store
   * (SYNC_PROTOCOL.md §7.2). In Tauri the other workspaces sign in behind it (WORKSPACES.md §6).
   */
  async boot(): Promise<void> {
    try {
      if (isWeb()) this.takeEntryPath();
      const saved = loadWorkspaces();
      // A browser serves one workspace: the page's own origin (§9).
      this.workspaces = isWeb() ? saved.entries.filter((e) => sameServer(e.serverUrl, location.origin)) : saved.entries;
      if (isWeb() && this.workspaces.length === 0) {
        const username = localStorage.getItem(USERNAME_KEY); // a browser session from before M16c
        if (username) this.workspaces = [{ serverUrl: location.origin, workspaceId: null, name: location.host, username, userId: null }];
      }
      this.activeServer = this.workspaces.find((e) => e.serverUrl === saved.active)?.serverUrl ?? this.workspaces[0]?.serverUrl ?? null;
      const entry = this.activeEntry;
      if (!entry) {
        this.setScreen("login");
        return;
      }
      await this.restoreWorkspace(entry, true);
      if (this.multiWorkspace) {
        for (const other of this.workspaces) {
          if (other.serverUrl !== entry.serverUrl && !other.signedOut) void this.restoreWorkspace(other, false).catch((err) => console.error("could not restore a workspace", err));
        }
      }
    } catch (err) {
      // Never stay on 起動中…: an unreadable credential store (or anything else) still leads to the login form.
      console.error("startup failed", err);
      this.setScreen("login", describe(err));
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
    const target = await this.resolveServer(server);
    if (target === null) return;
    const api = this.createApi(target.server, username);
    try {
      const tokens = await api.login(username, password, this.deviceInfo(), totpCode);
      this.totpRequired = false;
      await this.enterNewSession(api, username, tokens.user, target.info);
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

  /**
   * The server a login form names (WORKSPACES.md §5.1): normalized, checked with GET /server when adding a
   * workspace, and an already registered workspace is switched to instead. null = handled (error shown).
   */
  private async resolveServer(input: string): Promise<{ server: string; info: ServerInfoOut | null } | null> {
    const normalized = isWeb() ? location.origin : normalizeServerUrl(input);
    if (!normalized) {
      this.setScreen("login", "サーバ URL が正しくありません");
      return null;
    }
    // A registered address keeps its spelling: it names the saved credential and the local database.
    let server = this.workspaces.find((e) => sameServer(e.serverUrl, normalized))?.serverUrl ?? normalized;
    let info: ServerInfoOut | null = null;
    try {
      const answer: unknown = await new ApiClient(server).serverInfo();
      info = isServerInfo(answer) ? answer : null;
    } catch (err) {
      if (err instanceof NetworkError) {
        this.setScreen("login", describe(err));
        return null;
      }
    }
    if (this.addingWorkspace) {
      if (!info) {
        this.setScreen("login", "ChikuwaChat のサーバーではありません");
        return null;
      }
      const known = this.workspaces.find((e) => (e.workspaceId !== null && e.workspaceId === info!.workspace_id) || sameServer(e.serverUrl, server));
      if (known && this.sessions.has(known.serverUrl)) {
        await this.switchWorkspace(known.serverUrl);
        this.setNotice(`${known.name} は登録済みです`);
        return null;
      }
      if (known) server = known.serverUrl; // registered but signed out: sign in to it again
    }
    return { server, info };
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
    const normalized = isWeb() ? location.origin : normalizeServerUrl(server);
    if (!normalized) return "サーバ URL が正しくありません";
    const target = this.workspaces.find((e) => sameServer(e.serverUrl, normalized))?.serverUrl ?? normalized;
    const api = this.createApi(target, form.username);
    try {
      const tokens = await api.acceptInvite(token, form, this.deviceInfo());
      let info: ServerInfoOut | null = null;
      try {
        const answer: unknown = await api.serverInfo();
        info = isServerInfo(answer) ? answer : null;
      } catch {
        // the name follows when the workspace opens
      }
      await this.enterNewSession(api, form.username, tokens.user, info);
      return null;
    } catch (err) {
      return inviteErrorText(err);
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const session = this.active;
    if (!session) return;
    try {
      await session.api.changePassword(currentPassword, newPassword);
      session.me = await session.api.me();
      await this.startEngine(session);
    } catch (err) {
      this.setScreen("change_password", describe(err));
    }
  }

  /** The role as of the last bootstrap (store.me), which also follows changes made while signed in. */
  get isAdmin(): boolean {
    return (this.store.me ?? this.me)?.role === "admin";
  }

  /** M13e: confined to the channels they were added to; the sidebar hides browsing and creation. */
  get isGuest(): boolean {
    return (this.store.me ?? this.me)?.role === "guest";
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

  /** True once the server took the edit; the editor stays open until then (a failure keeps the text). */
  async editMessage(messageId: string, body: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertMessage(await this.api.editMessage(messageId, body));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
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
  /** The cards waiting for a preview (M21): a preview arriving re-renders them only, not the whole app. */
  private readonly previewListeners = new Set<() => void>();

  subscribeLinkPreviews(listener: () => void): () => void {
    this.previewListeners.add(listener);
    return () => this.previewListeners.delete(listener);
  }

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
        for (const listener of this.previewListeners) listener();
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

  /**
   * M12d 「後で送信」: the server posts the draft at `sendAt`; the row shows up under 下書き. `clientMsgId` stays the same
   * when the reader tries the same schedule again after a failure (a lost response must not make a second row, Codex
   * audit C2).
   */
  async scheduleMessage(channelId: string, parentId: string | null, body: string, attachmentIds: string[], sendAt: Date, clientMsgId: string = crypto.randomUUID()): Promise<boolean> {
    if (!this.api) return false;
    try {
      const row = await this.api.scheduleMessage(channelId, {
        client_msg_id: clientMsgId,
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

  /**
   * Cancel a scheduled message; its text returns to the conversation's draft so nothing is lost: as the
   * composer writes it (`@name`, not `<@id>`), after what is already typed there.
   */
  async cancelScheduled(row: ScheduledOut, restoreDraft = true): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.cancelScheduled(row.id);
      this.store.applyScheduled({ ...row, status: "cancelled" });
      if (restoreDraft && row.body) {
        const parentId = row.parent_id ?? null;
        const text = decodeMentions(row.body, this.store.users, this.store.groups);
        const current = this.store.draft(row.channel_id, parentId).text;
        const joined = current.trim() === "" ? text : `${current}${current.endsWith("\n") ? "" : "\n"}${text}`;
        this.store.setDraft(row.channel_id, parentId, { text: joined });
      }
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
      console.warn("copy failed", error);
      this.setError("クリップボードに書き込めませんでした");
    }
  }

  /** M25: 「テキストをコピー」 from the phone action sheet: the body with mentions as names (as the phone apps copy it). */
  async copyMessageText(body: string): Promise<void> {
    try {
      await copyText(mentionsToNames(body, this.store.users, this.store.groups));
      this.setNotice("テキストをコピーしました");
    } catch (error) {
      console.warn("copy failed", error);
      this.setError("クリップボードに書き込めませんでした");
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

  // --- sidebar sections (M14f) -------------------------------------------------------------

  private async sidebarChange(work: (api: ApiClient) => Promise<SidebarSectionOut[]>): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.replaceSidebar(await work(this.api));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** A new section at the end; with `channelId`, that conversation moves into it. */
  async createSection(name: string, channelId: string | null): Promise<boolean> {
    const before = new Set(this.store.sidebarSections.map((s) => s.id));
    if (!(await this.sidebarChange((api) => api.createSidebarSection(name)))) return false;
    const created = this.store.sidebarSections.find((s) => !before.has(s.id));
    if (channelId && created) return this.moveToSection(channelId, created.id);
    return true;
  }

  renameSection(sectionId: string, name: string): Promise<boolean> {
    return this.sidebarChange((api) => api.updateSidebarSection(sectionId, { name }));
  }

  moveSection(sectionId: string, position: number): Promise<boolean> {
    return this.sidebarChange((api) => api.updateSidebarSection(sectionId, { position }));
  }

  deleteSection(sectionId: string): Promise<boolean> {
    return this.sidebarChange((api) => api.deleteSidebarSection(sectionId));
  }

  /** `sectionId` null puts the conversation back in the default sections. */
  moveToSection(channelId: string, sectionId: string | null): Promise<boolean> {
    return this.sidebarChange((api) => (sectionId ? api.placeInSidebarSection(sectionId, channelId) : api.removeFromSidebarSection(channelId)));
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

  /** M15a: "owners" makes an announcement channel (owners and admins start the posts). */
  async setPostingPolicy(channelId: string, policy: PostingPolicy): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertChannel(await this.api.updateChannel(channelId, { posting_policy: policy }));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** M24 (administrators): mark a channel as someone's times (a Mattermost import's, say), or unmark it with null. */
  async setTimesOwner(channelId: string, ownerId: string | null): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertChannel(await this.api.updateChannel(channelId, { times_owner_id: ownerId }));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** M15b: public → private (owner / admin) or private → public (admin only). */
  async convertChannel(channelId: string, type: "public" | "private"): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertChannel(await this.api.updateChannel(channelId, { type }));
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

  async unarchiveChannel(channelId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertChannel(await this.api.unarchiveChannel(channelId));
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
      // Through the engine, which also forgets the channel's complete threads (SYNC_PROTOCOL.md §10.2).
      if (this.engine) this.engine.removeChannel(channelId);
      else this.store.removeChannel(channelId);
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

  /** M23: my research topic and reading on the lab roster (roster.updated confirms on every device). */
  async updateMyRosterLine(patch: MyLabProfileUpdate): Promise<boolean> {
    if (!this.api || !this.store.me) return false;
    try {
      this.store.applyRoster(this.store.me.id, await this.api.updateMyRosterLine(patch));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** Open (or create) the DM with one user; returns its channel id. */
  /** M24: my times (made on the first call; the supervisors on the roster join it); returns its id. */
  async ensureTimes(): Promise<string | null> {
    if (!this.api) return null;
    try {
      const channel = await this.api.ensureTimes();
      this.store.upsertChannel(channel, { isMember: true });
      return channel.id;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

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

  /** M14a: choose (or drop) my profile picture; the store learns the new version at once. */
  async uploadAvatar(file: File): Promise<boolean> {
    if (!this.api) return false;
    try {
      const updated = await this.api.uploadAvatar(file, file.name || "avatar");
      this.me = updated;
      this.store.setMe(updated);
      this.setNotice("写真を更新しました");
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async deleteAvatar(): Promise<boolean> {
    if (!this.api) return false;
    try {
      const updated = await this.api.deleteAvatar();
      this.me = updated;
      this.store.setMe(updated);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
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
      return describe(error);
    }
  }

  // --- sessions and workspaces (M16c, WORKSPACES.md) ------------------------------------------

  /** Several servers can be registered in the desktop app; a browser serves its own origin only (§9). */
  get multiWorkspace(): boolean {
    return isTauri();
  }

  /** The workspace rail down the left edge: two or more workspaces in the desktop app. */
  get showsRail(): boolean {
    return this.multiWorkspace && this.workspaces.length >= 2;
  }

  get activeEntry(): WorkspaceEntry | null {
    return this.workspaces.find((e) => e.serverUrl === this.activeServer) ?? null;
  }

  /** The workspace name for the search box and the switcher (GET /server). */
  get workspaceName(): string {
    return this.activeEntry?.name ?? "ChikuwaChat";
  }

  /** Whether a workspace has a running session (signed in on this device). */
  isSignedIn(serverUrl: string): boolean {
    return this.sessions.has(serverUrl);
  }

  /** The rail's number and dot for a workspace: the app-icon rules (M13f) over its store. */
  workspaceUnread(serverUrl: string): { badge: number; unread: boolean } {
    const session = this.sessions.get(serverUrl);
    if (!session) return { badge: 0, unread: false };
    const channels = [...session.store.channels.values()];
    const meId = session.store.me?.id ?? null;
    return { badge: unreadBadgeTotal(channels), unread: channels.some((c) => c.isMember && !c.archived && hasUnread(c, meId)) };
  }

  /** ⌘1 … ⌘9: the n-th workspace of the rail. */
  switchToIndex(index: number): void {
    const entry = this.workspaces[index];
    if (entry && entry.serverUrl !== this.activeServer) void this.switchWorkspace(entry.serverUrl);
  }

  async switchWorkspace(serverUrl: string): Promise<void> {
    const entry = this.workspaces.find((e) => e.serverUrl === serverUrl);
    if (!entry) return;
    this.addingWorkspace = false;
    this.returnTo = null;
    const running = this.sessions.get(serverUrl);
    if (running) {
      this.activate(running);
      return;
    }
    this.active = null;
    this.activeServer = serverUrl;
    this.saveWorkspaces();
    this.setScreen("boot");
    await this.restoreWorkspace(entry, true);
  }

  /** 「ワークスペースを追加」: the login form for another server; cancelling returns here (§5.1). */
  beginAddWorkspace(): void {
    this.returnTo = this.activeServer;
    this.addingWorkspace = true;
    this.totpRequired = false;
    this.active = null;
    this.activeServer = null;
    this.setScreen("login");
  }

  cancelAddWorkspace(): void {
    const back = this.returnTo;
    this.addingWorkspace = false;
    this.returnTo = null;
    if (back) void this.switchWorkspace(back);
    else this.setScreen("login");
  }

  private saveWorkspaces(): void {
    persistWorkspaces(this.workspaces, this.activeServer);
  }

  private patchEntry(serverUrl: string, patch: Partial<WorkspaceEntry>): void {
    this.workspaces = this.workspaces.map((e) => (e.serverUrl === serverUrl ? { ...e, ...patch } : e));
    this.saveWorkspaces();
  }

  /** A new sign-in (login form or invite): the workspace joins the list, or its entry is renewed. */
  private async enterNewSession(api: ApiClient, username: string, me: UserMe, info: ServerInfoOut | null): Promise<void> {
    const serverUrl = api.baseUrl;
    const previous = this.sessions.get(serverUrl);
    if (previous) this.dropSession(previous);
    const known = this.workspaces.find((e) => e.serverUrl === serverUrl);
    const entry: WorkspaceEntry = {
      serverUrl,
      workspaceId: info?.workspace_id ?? known?.workspaceId ?? null,
      name: info?.name ?? known?.name ?? hostLabel(serverUrl),
      username,
      userId: me.id,
    };
    this.workspaces = known ? this.workspaces.map((e) => (e.serverUrl === serverUrl ? entry : e)) : [...this.workspaces, entry];
    const session = this.newSession(entry, api);
    session.me = me;
    this.activate(session);
    await this.enterSession(session);
  }

  /** §7.2 for one workspace: its saved refresh token and local store, then a refresh when needed. */
  private async restoreWorkspace(entry: WorkspaceEntry, show: boolean): Promise<void> {
    const refreshToken = await this.secrets.get(this.account(entry.serverUrl, entry.username));
    if (!refreshToken) {
      if (entry.signedOut !== true) this.patchEntry(entry.serverUrl, { signedOut: true });
      if (show) this.showLogin(entry.serverUrl);
      return;
    }
    const api = this.createApi(entry.serverUrl, entry.username);
    api.refreshToken = refreshToken;
    const session = this.newSession(entry, api);
    if (show) this.activate(session);
    if (await this.startEngine(session, true)) return;
    try {
      const tokens = await api.refresh();
      if (this.sessions.get(entry.serverUrl) !== session) return;
      session.me = tokens.user;
      await this.enterSession(session);
    } catch (err) {
      if (this.sessions.get(entry.serverUrl) !== session) return;
      this.dropSession(session);
      if (err instanceof ApiError && err.isAuth) this.patchEntry(entry.serverUrl, { signedOut: true });
      if (this.activeServer === entry.serverUrl) this.showLogin(entry.serverUrl, err instanceof ApiError && err.isAuth ? null : describe(err));
      else this.emit();
    }
  }

  private newSession(entry: WorkspaceEntry, api: ApiClient): Session {
    const session: Session = { serverUrl: entry.serverUrl, username: entry.username, api, store: new Store(), engine: null, me: null, leaving: false };
    this.sessions.set(entry.serverUrl, session);
    return session;
  }

  /** Stop a session that another one replaces or that could not be restored (no data is erased). */
  private dropSession(session: Session): void {
    session.engine?.stop();
    session.engine = null;
    if (this.sessions.get(session.serverUrl) === session) this.sessions.delete(session.serverUrl);
    if (this.active === session) this.active = null;
    this.updateBadge();
  }

  /** The login form for a workspace (prefilled), or for a first server when none is left. */
  private showLogin(serverUrl: string | null, error: string | null = null): void {
    this.active = null;
    this.activeServer = serverUrl;
    this.addingWorkspace = false;
    this.saveWorkspaces();
    this.setScreen("login", error);
  }

  /** Put a session on screen: its store, avatars and the screen it is at. */
  private activate(session: Session): void {
    this.active = session;
    this.activeServer = session.serverUrl;
    this.addingWorkspace = false;
    this.returnTo = null;
    this.messageFocus = null;
    this.editing = null;
    this.openChannelRequest = null;
    this.totpRequired = false;
    configureAvatars((path) => session.api.fetchBlob(path)); // M14a
    noteVersions(session.store.users.values());
    this.saveWorkspaces();
    setTitleBase(this.workspaceName);
    this.setScreen(session.me?.must_change_password ? "change_password" : session.engine ? "main" : "boot");
    void this.refreshServerInfo(session);
  }

  /** The workspace's name and id as the server says now (§4: read again whenever it opens). */
  private async refreshServerInfo(session: Session): Promise<void> {
    try {
      const answer: unknown = await session.api.serverInfo();
      if (!isServerInfo(answer)) return;
      const entry = this.workspaces.find((e) => e.serverUrl === session.serverUrl);
      if (!entry || (entry.name === answer.name && entry.workspaceId === answer.workspace_id)) return;
      this.patchEntry(session.serverUrl, { name: answer.name, workspaceId: answer.workspace_id });
      if (this.active === session) setTitleBase(answer.name);
      this.emit();
    } catch {
      // offline or an older server: keep what we have
    }
  }

  private async enterSession(session: Session): Promise<void> {
    if (session.me) this.patchEntry(session.serverUrl, { userId: session.me.id, signedOut: false });
    if (session.me?.must_change_password) {
      if (this.active === session) this.setScreen("change_password");
      return;
    }
    await this.startEngine(session);
  }

  /** Open the account's local store and start syncing; `restoring` needs a stored user to go offline-first. */
  private async startEngine(session: Session, restoring = false): Promise<boolean> {
    session.engine?.stop();
    session.engine = null;
    const opened = await openStore(this.account(session.serverUrl, session.username));
    if (this.sessions.get(session.serverUrl) !== session && this.active !== session) return true; // replaced meanwhile
    const store = opened.store;
    if (restoring && (!store.me || store.me.must_change_password)) return false;
    session.store = store;
    if (restoring) session.me = store.me;
    else if (session.me) store.setMe(session.me);
    store.subscribe(() => {
      if (session.store !== store) return;
      this.updateBadge();
      if (this.active === session) noteVersions(store.users.values()); // M14a: pictures follow user.updated
      else this.noteRail(session);
    });
    const engine = this.makeEngine(session);
    session.engine = engine;
    if (this.active === session) {
      this.messageFocus = null;
      this.editing = null;
      noteVersions(store.users.values());
      this.setScreen("main");
      if (opened.failure) this.setError("端末に保存したデータを開けませんでした。今回はオフラインでの表示ができません");
    }
    void engine.start();
    if (this.active === session && this.entryMessage) {
      // M12j: the browser has no local store; reveal once the first sync has brought the channels.
      const unsubscribe = engine.subscribe(() => {
        if (engine.status !== "online" || store.channels.size === 0) return;
        unsubscribe();
        void this.revealEntry();
      });
    }
    this.updateBadge();
    return true;
  }

  private makeEngine(session: Session): SyncEngine {
    const { api, store } = session;
    const engine: SyncEngine = new SyncEngine({
      api,
      connect: browserConnector(api.wsUrl),
      store,
      getAccessToken: () => api.accessToken,
      prepareConnection: async ({ refresh }) => {
        // §7.2: a token that is still good is used as is (every refresh rotates the refresh token);
        // refresh when it is missing, expires within 60 s, or the server refused it (close 4001).
        if (!refresh && !api.accessTokenExpiresWithin(60_000)) return;
        const tokens = await api.refresh();
        if (session.engine !== engine) return;
        session.me = tokens.user;
        store.setMe(tokens.user);
        if (tokens.user.must_change_password) {
          engine.stop();
          if (this.active === session) this.setScreen("change_password");
          throw new Error("Password change required");
        }
      },
      onSignedOut: () => { if (session.engine === engine) void this.handleSignedOut(session); },
      onReminder: (reminder) => {
        if (this.quiet(session)) return;
        void notify(this.notificationTitle(session, "リマインダー"), (reminder.note ? `${reminder.note} — ` : "") + reminder.preview);
      },
      onNotify: (message, channel) => {
        if (this.quiet(session)) return; // M12c: paused / quiet hours
        const sender = store.users.get(message.sender_id)?.display_name ?? "メンバー";
        const text = plainText(mentionsToNames(message.body, store.users, store.groups)) || "新しいメッセージ";
        // A DM is titled by its sender; a channel or group DM by the conversation, with the sender before the text.
        if (channel.type === "dm") void notify(this.notificationTitle(session, sender), text);
        else void notify(this.notificationTitle(session, conversationTitle(channel, store.users, store.me?.id ?? null)), `${sender}: ${text}`);
      },
      // A workspace in the background is not being looked at: its server may push to the phone (§6).
      isActive: () => this.active === session && document.hasFocus(),
    });
    engine.subscribe(() => {
      if (this.active === session) this.emit();
    });
    return engine;
  }

  /** M12c: paused notifications or quiet hours of that workspace's account. */
  private quiet(session: Session): boolean {
    const me = session.store.me;
    return dndActive(me ? session.store.users.get(me.id) ?? me : null);
  }

  /** With several workspaces a notification says where it comes from (WORKSPACES.md §6). */
  private notificationTitle(session: Session, title: string): string {
    if (this.workspaces.length < 2) return title;
    const name = this.workspaces.find((e) => e.serverUrl === session.serverUrl)?.name;
    return name ? `${title} · ${name}` : title;
  }

  /** The Dock / taskbar number: every signed-in workspace added up (WORKSPACES.md §6). */
  private updateBadge(): void {
    let total = 0;
    for (const session of this.sessions.values()) total += unreadBadgeTotal(session.store.channels.values());
    void setUnreadBadge(total);
  }

  /** A background store changed: re-render only when its rail number or dot did. */
  private readonly railSeen = new Map<string, string>();
  private noteRail(session: Session): void {
    const unread = this.workspaceUnread(session.serverUrl);
    const key = `${unread.badge}|${unread.unread}`;
    if (this.railSeen.get(session.serverUrl) === key) return;
    this.railSeen.set(session.serverUrl, key);
    this.emit();
  }

  /** M13c: post a quote of `message` and its permalink into another conversation. */
  async shareMessage(message: MessageState, channelId: string, comment: string): Promise<boolean> {
    if (!this.api || !this.engine) return false;
    const body = shareBody(message.body, messagePermalink(this.api.baseUrl, message.id), comment);
    try {
      await this.engine.send(channelId, body, undefined, null, []);
      this.setNotice("共有しました");
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  // --- polls (M14b) ------------------------------------------------------------------------

  async vote(message: MessageState, option: number, present: boolean): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertMessage(await this.api.vote(message.id, option, present));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  // --- channel links (M15f) ----------------------------------------------------------------

  async addChannelLink(channelId: string, title: string, url: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.setChannelLinks(channelId, await this.api.addChannelLink(channelId, title, url));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async updateChannelLink(channelId: string, linkId: string, patch: { title?: string; url?: string; position?: number }): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.setChannelLinks(channelId, await this.api.updateChannelLink(channelId, linkId, patch));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async deleteChannelLink(channelId: string, linkId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.setChannelLinks(channelId, await this.api.deleteChannelLink(channelId, linkId));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  // --- acknowledgements (M15e) ----------------------------------------------------------------

  async toggleAck(message: MessageState): Promise<void> {
    const me = this.store.me;
    if (!this.api || !me) return;
    const mine = (message.acks ?? []).some((a) => a.user_id === me.id);
    try {
      this.store.upsertMessage(await this.api.acknowledge(message.id, !mine));
    } catch (error) {
      this.setError(error);
    }
  }

  async closePoll(message: MessageState): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertMessage(await this.api.closePoll(message.id));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async createPoll(channelId: string, parentId: string | null, question: string, options: string[], multiple: boolean): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertMessage(await this.api.postPoll(channelId, parentId, { question, options, multiple }));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  // --- slash commands (M13b) ---------------------------------------------------------------

  /** A conversation a command asked for (/join, /dm); the main screen opens it and clears this. */
  openChannelRequest: string | null = null;

  requestOpenChannel(channelId: string): void {
    this.openChannelRequest = channelId;
    this.emit();
  }

  /** Runs a command typed in the composer; false when it could not (the reason is in the toast). */
  async runCommand(command: ParsedCommand, channel: ChannelState, parentId: string | null): Promise<boolean> {
    const api = this.api;
    if (!api) return false;
    const isDm = channel.type === "dm" || channel.type === "group_dm";
    const spec = COMMANDS.find((c) => c.name === command.name);
    if (!spec) {
      this.setError(`/${command.name} というコマンドはありません (/help で一覧)`);
      return false;
    }
    if (spec.channelOnly && isDm) {
      this.setError(`/${command.name} はチャンネルでだけ使えます`);
      return false;
    }
    const byHandle = (handle: string) => {
      const name = handle.replace(/^@/, "").toLowerCase();
      return [...this.store.users.values()].find((u) => u.username.toLowerCase() === name);
    };
    const level = channel.notificationLevel ?? (isDm ? "all" : "mentions");
    switch (command.name) {
      case "help":
        this.setNotice(COMMANDS.map((c) => c.usage).join(" · "));
        return true;
      case "status": {
        if (!command.args || command.args === "clear") {
          const cleared = await this.updateProfile({ status_text: null, status_emoji: null, status_expires_at: null });
          if (cleared) this.setNotice("ステータスを消しました");
          return cleared;
        }
        const { emoji, text } = splitStatus(command.args);
        const ok = await this.updateProfile({ status_text: text || null, status_emoji: emoji, status_expires_at: null });
        if (ok) this.setNotice("ステータスを更新しました");
        return ok;
      }
      case "dnd": {
        if (!command.args || command.args === "off") {
          const ok = await this.updateProfile({ dnd_until: null });
          if (ok) this.setNotice("通知の一時停止を解除しました");
          return ok;
        }
        const until = parseDuration(command.args);
        if (!until) {
          this.setError("/dnd 30m | 1h | 2h | 4h | tomorrow | off");
          return false;
        }
        const ok = await this.updateProfile({ dnd_until: until.toISOString() });
        if (ok) this.setNotice(`${scheduleLabel(until.toISOString())} まで通知を止めます`);
        return ok;
      }
      case "topic":
        return this.updateTopic(channel.id, command.args);
      case "leave":
        return this.leaveChannel(channel.id);
      case "invite": {
        const handles = command.args.split(/\s+/).filter(Boolean);
        if (handles.length === 0) {
          this.setError("/invite @名前");
          return false;
        }
        for (const handle of handles) {
          const user = byHandle(handle);
          if (!user) {
            this.setError(`${handle} というユーザーはいません`);
            return false;
          }
          try {
            await api.addMember(channel.id, user.id);
          } catch (error) {
            this.setError(error);
            return false;
          }
        }
        this.setNotice(`${handles.length} 人を追加しました`);
        return true;
      }
      case "join": {
        const name = command.args.replace(/^#/, "").toLowerCase();
        const target = [...this.store.channels.values()].find((c) => c.type === "public" && (c.name ?? "").toLowerCase() === name);
        if (!target) {
          this.setError(`#${name} という公開チャンネルはありません`);
          return false;
        }
        if (!target.isMember) {
          try {
            this.store.upsertChannel(await api.joinChannel(target.id), { isMember: true });
          } catch (error) {
            this.setError(error);
            return false;
          }
        }
        this.requestOpenChannel(target.id);
        return true;
      }
      case "dm": {
        const user = byHandle(command.args.split(/\s+/)[0] ?? "");
        if (!user) {
          this.setError("/dm @名前");
          return false;
        }
        const id = await this.openDmWith(user.id);
        if (id) this.requestOpenChannel(id);
        return id !== null;
      }
      case "mute": {
        const until = command.args ? parseDuration(command.args) : new Date(Date.now() + 8 * 3_600_000);
        if (!until) {
          this.setError("/mute 1h | 8h | tomorrow");
          return false;
        }
        await this.setNotification(channel.id, level, until.toISOString());
        this.setNotice(`${scheduleLabel(until.toISOString())} まで通知を止めます`);
        return true;
      }
      case "unmute":
        await this.setNotification(channel.id, level, null);
        this.setNotice("通知を再開しました");
        return true;
      case "me":
        if (!command.args) return false;
        await this.engine?.send(channel.id, `_${command.args}_`, undefined, parentId, []);
        return true;
      case "shrug":
        await this.engine?.send(channel.id, `${command.args ? command.args + " " : ""}${SHRUG}`, undefined, parentId, []);
        return true;
      case "poll": {
        const parts = command.args.split("|").map((p) => p.trim()).filter(Boolean);
        if (parts.length < 3) {
          this.setError("/poll 質問 | 選択肢 | 選択肢 …");
          return false;
        }
        return this.createPoll(channel.id, parentId, parts[0]!, parts.slice(1), false);
      }
    }
    return false;
  }

  /** Sign out of the workspace on screen; it leaves the list and the next one opens (WORKSPACES.md §5.3). */
  async logout(): Promise<void> {
    if (this.activeServer) await this.signOutWorkspace(this.activeServer);
  }

  /** Sign out of a workspace (on screen or not) and forget it; one already signed out just leaves the list. */
  async signOutWorkspace(serverUrl: string): Promise<void> {
    const session = this.sessions.get(serverUrl) ?? (this.active?.serverUrl === serverUrl ? this.active : null);
    if (session) {
      session.leaving = true;
      session.engine?.stop();
      await session.api.logout(); // → onSignedOut → handleSignedOut
      await this.handleSignedOut(session);
      return;
    }
    this.workspaces = this.workspaces.filter((e) => e.serverUrl !== serverUrl);
    this.saveWorkspaces();
    if (this.activeServer !== serverUrl) {
      this.emit();
      return;
    }
    const next = this.workspaces.find((e) => this.sessions.has(e.serverUrl));
    if (next) this.activate(this.sessions.get(next.serverUrl)!);
    else this.showLogin(this.workspaces[0]?.serverUrl ?? null);
  }

  /**
   * Signed out or the session ended (§11): the account's local store (messages, drafts, send queue) is
   * erased, the notifications on screen are cleared, the credential is forgotten. A workspace the user
   * left goes from the list; one whose session ended stays, signed out, for signing back in.
   */
  private handleSignedOut(session: Session): Promise<void> {
    session.ending ??= this.endSession(session); // the client may report it more than once
    return session.ending;
  }

  private async endSession(session: Session): Promise<void> {
    session.engine?.stop();
    session.engine = null;
    if (this.sessions.get(session.serverUrl) === session) this.sessions.delete(session.serverUrl);
    this.railSeen.delete(session.serverUrl);
    const wasActive = this.active === session;
    if (wasActive) {
      clearNotifications();
      configureAvatars(null);
      this.active = null;
      this.messageFocus = null;
      this.editing = null;
    }
    this.updateBadge();
    try {
      await session.store.wipe();
    } catch (err) {
      console.error("could not erase the local store", err);
    }
    try {
      await this.secrets.delete(this.account(session.serverUrl, session.username));
    } catch (err) {
      console.error("could not remove the saved credential", err);
    }
    if (session.leaving) {
      this.workspaces = this.workspaces.filter((e) => e.serverUrl !== session.serverUrl);
      this.saveWorkspaces();
    } else {
      this.patchEntry(session.serverUrl, { signedOut: true });
    }
    if (!wasActive) {
      this.emit();
      return;
    }
    // The next signed-in workspace takes the screen; else the login form (for the one that ended, if any).
    const next = this.workspaces.find((e) => this.sessions.has(e.serverUrl));
    if (session.leaving && next) this.activate(this.sessions.get(next.serverUrl)!);
    else this.showLogin(session.leaving ? (this.workspaces[0]?.serverUrl ?? null) : session.serverUrl);
  }
}

/** One signed-in workspace (M16c): its API client, local store and sync engine. */
interface Session {
  serverUrl: string;
  username: string;
  api: ApiClient;
  store: Store;
  engine: SyncEngine | null;
  me: UserMe | null;
  /** The user signs out: the workspace leaves the list (an ended session stays, signed out). */
  leaving: boolean;
  /** The sign-out being handled (erasing the store and the credential). */
  ending?: Promise<void>;
}

function describe(err: unknown): string {
  return describeError(err);
}

/**
 * The local database of one account (§11): named by a hash of server URL + user name, so accounts with
 * similar names (t.kano / t_kano) or long server URLs never share one. Memory only in a browser (M12j),
 * and when the database cannot be opened (the app still works online; the caller says so).
 */
async function openStore(account: string): Promise<{ store: Store; failure: unknown }> {
  if (!isTauri()) return { store: new Store(), failure: null };
  try {
    const store = new Store(await SqlitePersistence.open(await profileKey(account)));
    await store.load();
    return { store, failure: null };
  } catch (failure) {
    console.error("could not open the local store", failure);
    return { store: new Store(), failure };
  }
}

/** 128 bits of SHA-256 over "server|username", as hex (the database file name). */
export async function profileKey(account: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(account)));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
