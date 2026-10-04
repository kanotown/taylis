/** Application controller: login, session restore, and the sync engine lifecycle. */
import { ApiClient, type DeviceInfo } from "../api/client";
import { dndActive } from "../ui/dnd";
import { calendarAlarmText } from "../sync/calendar";
import { taskNoticeText } from "../ui/tasks";
import { reactionText } from "../ui/customEmoji";
import { canvasLink, messagePermalink } from "../ui/permalink";
import { inviteErrorText } from "../ui/invite";
import { challengeFor, newVerifier, parseSsoDeepLink, saveSsoPending, type SsoPending, ssoErrorText, ssoStartUrl, takeSsoPending, takeSsoReturn } from "../ui/sso";
import { totpErrorText } from "../ui/totp";
import { shareBody } from "../ui/share";
import { conversationTitle, hasUnread, unreadBadgeTotal } from "../ui/channels";
import { configureAvatars, noteVersions } from "../ui/avatars";
import { findDmWith } from "../ui/mobileTabs";
import { parseEntryPath } from "../ui/routes";
import { COMMANDS, type ParsedCommand, parseDuration, SHRUG, splitStatus } from "../ui/commands";
import { scheduleLabel } from "../ui/schedule";
import { orderTemplates, readSchedule, SCHEDULE_USAGE } from "../ui/templates";
import { answersBody, slotsFromEntries, slotToIn } from "../ui/scheduling";
import { localZone } from "../ui/calendarDates";
import { ApiError, describeError, NetworkError, UserMessageError } from "../api/errors";
import { hostLabel, isServerInfo, loadWorkspaces, moveWorkspace, normalizeServerUrl, sameServer, saveWorkspaces as persistWorkspaces, signInName, type WorkspaceEntry } from "./workspaces";
import type { AttachmentOut, AuthMethodsOut, CalendarEventOut, PollAnswer, PollAnswersIn, ScheduleSlotIn, CanvasMeta, CanvasOut, CanvasPage, CanvasRevisionMeta, CanvasRevisionOut, CanvasRevisionPage, CanvasTemplateOut, CustomEmojiOut, CustomEmojiUpdate, EmojiPackImportOut, TextEmojiCreate, InvitePreviewOut, LinkPreviewOut, MemberOut, MemberRole, MessageOut, NotificationLevel, PoolCreate, PoolOut, PoolUpdate, PostingPolicy, ReadAllScope, ReminderOut, ScheduledOut, ServerInfoOut, SessionOut, SidebarSectionOut, TaskOut, TemplateCreate, TemplateOut, TemplateUpdate, TokenResponse, TotpEnabledOut, TotpSetupOut, TotpStatusOut, UserMe, UserUpdate, MyLabProfileUpdate } from "../api/types";
import { saveDownload } from "../platform/download";
import type { ChannelState, MessageState } from "../sync/types";
import { setTitleBase, setUnreadBadge } from "../platform/badge";
import { listenForDeepLinks } from "../platform/deepLink";
import { isTauri, isWeb } from "../platform/env";
import { openInBrowser } from "../platform/external";
import { resolveDeviceName } from "../platform/deviceName";
import { readerIdle } from "../platform/idle";
import { clearNotifications, notify } from "../platform/notify";
import type { ReportReason, TestNotificationOut } from "../api/types";
import { secretStore } from "../platform/secrets";
import { SqlitePersistence } from "../platform/sqlite";
import { SyncEngine } from "../sync/engine";
import { Store } from "../sync/store";
import { browserConnector } from "../sync/ws";
import { UpdateChecker } from "./updates";
import { attachmentText, plainText } from "../ui/markdown";
import { rememberEmoji } from "../ui/EmojiPicker";
import { decodeMentions, mentionsToNames } from "../ui/mentions";
import { readGroupPosts, readSendKey, type SendKey, writeGroupPosts, writeSendKey } from "../ui/prefs";

export type Screen = "boot" | "login" | "change_password" | "main";

/** M44: what a `/c/<id>` link stands for (its card, CANVAS.md §4.13). */
export type CanvasLinkState =
  | { state: "ok"; canvas: CanvasMeta }
  | { state: "forbidden" }
  | { state: "missing" }
  | { state: "error" };

/** The browser build before workspaces (M16c) remembered only the user name. */
const USERNAME_KEY = "chikuwa.username";
/** The web build's version, and the desktop app's until Tauri says (tauri.conf.json, set from the release tag). */
const FALLBACK_APP_VERSION = "0.1.0";

/** Waits for `work` at most `ms`; past that `onTimeout` decides (it may throw). A rejection of `work` is passed on. */
async function withDeadline(work: Promise<unknown>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = Symbol("late");
  const deadline = new Promise<typeof late>((resolve) => { timer = setTimeout(() => resolve(late), ms); });
  try {
    if ((await Promise.race([work, deadline])) === late) onTimeout();
  } finally {
    clearTimeout(timer);
  }
}

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
  /**
   * M47 「連続した投稿をまとめる」: consecutive posts from one person grouped in the timelines and threads. Stored per
   * device; kept here too, so the open views follow a change at once (and it holds without storage).
   */
  groupPosts: boolean = readGroupPosts();
  setGroupPosts(value: boolean): void {
    this.groupPosts = value;
    writeGroupPosts(value);
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
      // A channel I have not joined is read without the store (its preview, SYNC_PROTOCOL.md §7.6.1): the thread pane
      // fetches the replies itself there.
      const mine = this.store.getChannel(message.channel_id)?.isMember === true;
      if (message.parent_id && mine) for (const reply of await this.api.replies(message.parent_id)) this.store.upsertMessage(reply);
      this.messageFocus = { channelId: message.channel_id, messageId: message.id, parentId: message.parent_id ?? null, context };
      this.emit();
      return true;
    } catch (error) { this.setError(error); return false; }
  }
  private readonly listeners = new Set<() => void>();
  private readonly secrets = secretStore();
  /** 「更新して再起動」 (desktop only): the update banner and the settings' 「アップデートを確認」; errors go to the toast. */
  readonly updates = new UpdateChecker(undefined, (err) => this.setError(err));
  /** This device's name for the server (platform/deviceName.ts), read at boot; null until then. */
  private deviceName: string | null = null;

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
  /** M44: a `/c/<id>` canvas link opened in the browser. */
  private entryCanvas: string | null = null;

  private takeEntryPath(): void {
    const entry = parseEntryPath(location.pathname);
    if (!entry) return;
    if (entry.kind === "invite") this.entryInvite = entry.token;
    else if (entry.kind === "canvas") this.entryCanvas = entry.id;
    else this.entryMessage = entry.id;
    history.replaceState(null, "", "/");
  }

  private async revealEntry(): Promise<void> {
    const canvasId = this.entryCanvas;
    this.entryCanvas = null;
    if (canvasId) await this.openCanvasLink(canvasId);
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

  /** M96: what the login form starts with: the account's username now (it may have changed since signing in). */
  get loginName(): string {
    if (this.addingWorkspace) return "";
    return this.active?.me?.username ?? (this.activeEntry ? signInName(this.activeEntry) : "");
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
    if (isTauri()) void this.watchSsoLinks();
    await this.updates.readCurrentVersion(); // the device's app_version on sign-in (Tauri; null in a browser)
    this.deviceName = await resolveDeviceName();
    try {
      // M48: back from Google sign-in (`/#sso_ticket=` / `#sso_error=`); the fragment is removed at once.
      const sso = isWeb() ? takeSsoReturn() : null;
      if (isWeb()) this.takeEntryPath();
      const saved = loadWorkspaces();
      // A browser serves one workspace: the page's own origin (§9).
      this.workspaces = isWeb() ? saved.entries.filter((e) => sameServer(e.serverUrl, location.origin)) : saved.entries;
      if (isWeb() && this.workspaces.length === 0) {
        const username = localStorage.getItem(USERNAME_KEY); // a browser session from before M16c
        if (username) this.workspaces = [{ serverUrl: location.origin, workspaceId: null, name: location.host, username, userId: null }];
      }
      this.activeServer = this.workspaces.find((e) => e.serverUrl === saved.active)?.serverUrl ?? this.workspaces[0]?.serverUrl ?? null;
      if (sso?.kind === "ticket") {
        const failure = await this.completeSso(sso.ticket, takeSsoPending());
        if (failure !== null) this.setScreen("login", failure);
        return;
      }
      const ssoError = sso?.kind === "error" ? ssoErrorText(sso.code) : null;
      const entry = this.activeEntry;
      if (!entry) {
        this.setScreen("login", ssoError);
        return;
      }
      await this.restoreWorkspace(entry, true);
      if (ssoError !== null && this.screen === "login") this.setScreen("login", ssoError);
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
      device_name: this.deviceName ?? (isWeb() ? "ブラウザ" : "デスクトップ"),
      app_version: this.updates.currentVersion ?? FALLBACK_APP_VERSION,
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
        this.setScreen("login", "Taylis のサーバーではありません");
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

  // --- Google sign-in (M48, docs/SSO.md §6): the browser build leaves the tab; the Tauri app opens the system browser
  // and gets the ticket back through the `chikuwachat://sso` deep link.

  /** GET /auth/methods of the login form's server; null when it cannot tell (an older server, offline). */
  async authMethods(server: string): Promise<AuthMethodsOut | null> {
    const normalized = isWeb() ? location.origin : normalizeServerUrl(server);
    if (!normalized) return null;
    try {
      return await new ApiClient(normalized).authMethods();
    } catch {
      return null;
    }
  }

  /** Where 「Google でログイン」 sends the tab (tests replace it). */
  navigate: (url: string) => void = (url) => location.assign(url);

  /** Tauri: opens the start page in the system browser (tests replace it). */
  openBrowser: (url: string) => Promise<void> = openInBrowser;

  /**
   * Tauri: "waiting" while the sign-in is open in the browser (the login screen says so and offers キャンセル),
   * "exchanging" once its ticket came back. Always "idle" in a browser, whose tab leaves instead.
   */
  ssoState: "idle" | "waiting" | "exchanging" = "idle";
  /** Tauri: the server and verifier of the sign-in open in the browser; only memory holds the verifier. */
  private ssoFlow: SsoPending | null = null;

  /** 「Google でログイン」: a fresh verifier kept here, and off to the server's start URL with its challenge. */
  async startGoogleSignIn(server: string): Promise<void> {
    if (!isWeb()) {
      await this.startGoogleSignInInBrowser(server);
      return;
    }
    const serverUrl = location.origin;
    const verifier = newVerifier();
    if (!saveSsoPending({ serverUrl, verifier })) {
      this.setScreen("login", "このブラウザの設定では Google でログインできません (サイトのデータの保存を許可してください)");
      return;
    }
    this.navigate(ssoStartUrl(serverUrl, this.deviceInfo().platform, await challengeFor(verifier)));
  }

  /** The Tauri app: the server as a password login would take it (§5.1), then the start page in the system browser. */
  private async startGoogleSignInInBrowser(server: string): Promise<void> {
    const target = await this.resolveServer(server);
    if (target === null) return;
    const verifier = newVerifier();
    const url = ssoStartUrl(target.server, this.deviceInfo().platform, await challengeFor(verifier));
    // A second start replaces the first: its ticket, if it still comes back, no longer matches the verifier.
    this.ssoFlow = { serverUrl: target.server, verifier };
    this.ssoState = "waiting";
    this.totpRequired = false;
    this.setScreen("login", null);
    try {
      await this.openBrowser(url);
    } catch (err) {
      console.error("could not open the browser for Google sign-in", err);
      this.ssoFlow = null;
      this.ssoState = "idle";
      this.setScreen("login", "ブラウザを開けませんでした。もう一度お試しください");
    }
  }

  /** 「キャンセル」 while the browser is open: a ticket that still comes back is ignored. */
  cancelGoogleSignIn(): void {
    if (this.ssoState !== "waiting") return;
    this.ssoFlow = null;
    this.ssoState = "idle";
    this.emit();
  }

  /** Tauri: listens for `chikuwachat://` links (and takes the one that launched the app), from startup on. */
  async watchSsoLinks(): Promise<void> {
    try {
      await listenForDeepLinks((url) => void this.handleSsoLink(url));
    } catch (err) {
      console.error("could not listen for sign-in links", err);
    }
  }

  /**
   * A deep link came in. Only a `chikuwachat://sso` link while a sign-in waits counts; anything else (a link from
   * elsewhere, one that launched the app, a second copy) is ignored, and the ticket is useless without the verifier.
   */
  async handleSsoLink(url: string): Promise<void> {
    const found = parseSsoDeepLink(url);
    if (!found) return;
    const flow = this.ssoFlow;
    if (!flow || this.ssoState !== "waiting") {
      console.info("ignored a sign-in link: no Google sign-in is waiting");
      return;
    }
    this.ssoFlow = null;
    if (found.kind === "error") {
      this.ssoState = "idle";
      this.setScreen("login", ssoErrorText(found.code));
      return;
    }
    this.ssoState = "exchanging";
    this.emit();
    const failure = await this.completeSso(found.ticket, flow);
    this.ssoState = "idle";
    if (failure !== null) this.setScreen("login", failure);
    else this.emit();
  }

  /** The ticket Google sign-in returned → a session, as after a password login; returns the failure text, if any. */
  private async completeSso(ticket: string, pending: SsoPending | null): Promise<string | null> {
    if (!pending) return ssoErrorText("invalid_ticket"); // started in another tab, or storage was cleared
    const normalized = isWeb() ? location.origin : pending.serverUrl;
    const server = this.workspaces.find((e) => sameServer(e.serverUrl, normalized))?.serverUrl ?? normalized;
    try {
      const tokens = await new ApiClient(server).ssoExchange(ticket, pending.verifier, this.deviceInfo());
      const username = tokens.user.username;
      const api = this.createApi(server, username);
      api.adoptTokens(tokens);
      let info: ServerInfoOut | null = null;
      try {
        const answer: unknown = await api.serverInfo();
        info = isServerInfo(answer) ? answer : null;
      } catch {
        // the name follows when the workspace opens
      }
      this.totpRequired = false;
      await this.enterNewSession(api, username, tokens.user, info);
      return null;
    } catch (err) {
      return describe(err);
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
  async uploadEmoji(name: string, file: File, extra: { label?: string | null; keywords?: string[] } = {}): Promise<boolean> {
    if (!this.api) return false;
    try {
      const row = await this.api.uploadEmoji(name, file, file.name, extra);
      this.store.applyCustomEmoji(row, false);
      this.setNotice(`:${row.name}: を追加しました`);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** M100: a text emoji (a label drawn as a pill). */
  async createTextEmoji(body: TextEmojiCreate): Promise<boolean> {
    if (!this.api) return false;
    try {
      const row = await this.api.createTextEmoji(body);
      this.store.applyCustomEmoji(row, false);
      this.setNotice(`:${row.name}: を追加しました`);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** M100: label / colour / keywords (creator or admin), pack and order (admin). */
  async updateEmoji(emojiId: string, patch: CustomEmojiUpdate): Promise<boolean> {
    if (!this.api) return false;
    try {
      const row = await this.api.updateEmoji(emojiId, patch);
      this.store.applyCustomEmoji(row, false);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** M100 (admin): import a pack from a folder's files or a ZIP; returns what happened, null on an error (shown). */
  async importEmojiPack(source: { archive: File } | { files: File[] }): Promise<EmojiPackImportOut | null> {
    if (!this.api) return null;
    try {
      const result = await this.api.importEmojiPack(source);
      this.store.applyEmojiPack(result.pack, false);
      // The emoji themselves arrive as emoji.updated; fetch them now too so this window shows them at once.
      this.store.replaceCustomEmoji(await this.api.listEmoji());
      return result;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  async updateEmojiPack(packId: string, patch: { name?: string; position?: number }): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.applyEmojiPack(await this.api.updateEmojiPack(packId, patch), false);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** The pack goes, its emoji stay (ungrouped). */
  async deleteEmojiPack(packId: string): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.deleteEmojiPack(packId);
      const row = this.store.emojiPacks.get(packId);
      if (row) this.store.applyEmojiPack(row, true);
    } catch (error) {
      this.setError(error);
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

  /** M44: `<server>/c/<id>` of a canvas (CANVAS.md §4.13). */
  async copyCanvasLink(canvasId: string): Promise<void> {
    if (!this.api) return;
    try {
      await copyText(canvasLink(this.api.baseUrl, canvasId));
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

  /**
   * A new section at the end (M26: with its icon), and the conversations that move into it. The M26 fields go only
   * when set: a server before M26 refuses fields it does not know, and a plain section still works there.
   */
  createSection(name: string, emoji: string | null, channelIds: string[]): Promise<boolean> {
    return this.sidebarChange((api) =>
      api.createSidebarSection({ name, ...(emoji ? { emoji } : {}), ...(channelIds.length ? { channel_ids: channelIds } : {}) }),
    );
  }

  /** M26: the name and the icon (null: none). */
  editSection(sectionId: string, name: string, emoji: string | null): Promise<boolean> {
    return this.sidebarChange((api) => api.updateSidebarSection(sectionId, { name, emoji }));
  }

  /** M26: folds a section up (or opens it) at once here; sidebar.updated brings it to my other devices. */
  setSectionCollapsed(sectionId: string, collapsed: boolean): Promise<boolean> {
    this.store.replaceSidebar(this.store.sidebarSections.map((s) => (s.id === sectionId ? { ...s, collapsed } : s)));
    return this.sidebarChange((api) => api.updateSidebarSection(sectionId, { collapsed }));
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

  /**
   * M104 「ブロック」/「ブロックを解除」 (docs/MODERATION.md §4): the store flag moves at once, block.updated brings my other
   * devices along. The blocked person is not told.
   */
  async setUserBlocked(userId: string, on: boolean): Promise<boolean> {
    if (!this.api) return false;
    const before = this.store.isBlocked(userId);
    this.store.setBlocked(userId, on);
    try {
      if (on) await this.api.blockUser(userId);
      else await this.api.unblockUser(userId);
      this.setNotice(on ? "ブロックしました" : "ブロックを解除しました");
      return true;
    } catch (error) {
      this.store.setBlocked(userId, before);
      this.setError(error);
      return false;
    }
  }

  /** M104 「報告する」: the administrators are told; the reporter learns nothing about other reports. */
  async reportMessage(messageId: string, reason: ReportReason, note: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.reportMessage(messageId, { reason, note: note.trim() || null });
      this.setNotice("報告しました。管理者が確認します");
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /**
   * M104 「アカウントを削除」 (docs/MODERATION.md §2): my password, or my username for an account without one. On success the
   * server has ended every session; this workspace is signed out here. Returns the error to show in the dialog, or null.
   */
  async deleteAccount(secret: string): Promise<string | null> {
    if (!this.api || !this.activeServer) return "ログインしていません";
    const hasPassword = this.store.me?.has_password !== false;
    try {
      await this.api.deleteAccount(hasPassword ? { password: secret } : { confirm_username: secret });
    } catch (error) {
      return describe(error);
    }
    await this.signOutWorkspace(this.activeServer);
    return null;
  }

  /** M12a 「すべて既読にする」. */
  async markAllRead(scope?: ReadAllScope): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.markAllRead(scope);
    } catch (error) {
      this.setError(error);
    }
  }

  /** M37 「再読み込み」: the engine syncs again (bootstrap and the open conversation's catch-up). */
  async resync(): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.resync();
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
    if (!mine) rememberEmoji(emoji); // the quick reactions put what I use first (M25)
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

  /**
   * Join a public channel (the preview's 「#name に参加する」, SYNC_PROTOCOL.md §7.6.1): from here on it is a conversation of
   * mine, and opening it again loads it into the store like any other (the preview is dropped then).
   */
  async joinChannel(channelId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.upsertChannel(await this.api.joinChannel(channelId), { isMember: true });
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

  /**
   * L4 (M31): make a member an owner or take it back (owner / admin). My own role changes here at once, so owner-only
   * menus follow without waiting for channel.member_updated. Null when it failed (the toast says why).
   */
  async setMemberRole(channelId: string, userId: string, role: MemberRole): Promise<MemberOut | null> {
    if (!this.api) return null;
    try {
      const member = await this.api.setMemberRole(channelId, userId, role);
      if (userId === this.store.me?.id) this.store.setMyRole(channelId, member.role);
      return member;
    } catch (error) {
      this.setError(error);
      return null;
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

  /** M11h: what the channel is for (the channel details, M29). An empty text clears it. */
  async updatePurpose(channelId: string, purpose: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      const channel = await this.api.updateChannel(channelId, { purpose: purpose.trim() });
      this.store.upsertChannel(channel);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /**
   * A conversation's notifications (PUSH_NOTIFICATIONS.md §4): its own level (null: follow my overall setting, M35),
   * the timed mute, and the mute until unmuted (`muted`; omitted = unchanged).
   */
  async setNotification(channelId: string, level: NotificationLevel | null, mutedUntil: string | null = null, muted?: boolean): Promise<void> {
    if (!this.api) return;
    try {
      const out = await this.api.setNotificationPreference(channelId, level, mutedUntil, muted);
      // An older server's answer lacks follows_default: what was asked for tells whether the level is the channel's own.
      this.store.applyNotificationPreference({ ...out, channel_id: channelId, follows_default: out.follows_default ?? level === null });
    } catch (error) {
      this.setError(error);
    }
  }

  /** M35: my overall notification setting (「通知」 in the settings); other devices learn it on their next bootstrap. */
  setNotificationDefault(level: NotificationLevel): Promise<boolean> {
    return this.updateProfile({ notification_default: level });
  }

  /** M39: 「リアクションのバナー」 (users.notify_reactions); the activity lists reactions either way. */
  setNotifyReactions(on: boolean): Promise<boolean> {
    return this.updateProfile({ notify_reactions: on });
  }

  /** M55: 「タスク (割り当て・期限)」 (users.notify_tasks). */
  setNotifyTasks(on: boolean): Promise<boolean> {
    return this.updateProfile({ notify_tasks: on });
  }

  /**
   * M50: 「リアクションの候補」 (users.quick_reactions), null = back to the recent-first rule. Shown at once; a refused or
   * failed save puts the previous list back (and says why). My other devices read it on their next bootstrap, or at once
   * when they hear user.updated about me (SyncEngine).
   */
  async setQuickReactions(list: string[] | null): Promise<boolean> {
    const before = this.store.me;
    if (!this.api || !before) return false;
    this.store.setMe({ ...before, quick_reactions: list });
    const ok = await this.updateProfile({ quick_reactions: list });
    if (!ok && this.store.me?.quick_reactions === list) this.store.setMe({ ...this.store.me, quick_reactions: before.quick_reactions ?? null });
    return ok;
  }

  /**
   * M39: the activity is read up to `readAt` (「すべて既読」: now; the view on screen: its newest item). The badge takes
   * the server's answer; my other devices follow through activity.read.
   */
  async markActivityRead(readAt: string): Promise<boolean> {
    const engine = this.engine;
    if (!engine) return false;
    try {
      await engine.markActivityRead(readAt);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
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

  /**
   * Open (or create) the DM with one user; returns its channel id. The existing one has exactly that user and me as its
   * members, so my own id finds my own DM (made on the first call), not one of my 1:1 DMs.
   */
  async openDmWith(userId: string): Promise<string | null> {
    if (!this.api) return null;
    const existing = findDmWith(this.store.channels.values(), userId, this.store.me?.id ?? this.me?.id ?? null);
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

  /**
   * M96: rename myself (PATCH /users/me {username}); null when done, else the reason to show under the field (taken,
   * reserved, 3 times in 24 hours, offline …). The saved workspace entry follows through the store (followUsername).
   */
  async renameMe(username: string): Promise<string | null> {
    if (!this.api) return "ログインしていません";
    try {
      const me = await this.api.updateMe({ username });
      this.me = me;
      if (this.active) this.active.me = me;
      this.store.setMe(me);
      this.store.upsertUser(me);
      return null;
    } catch (error) {
      return describeError(error);
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

  /**
   * 「テスト通知を送る」 (PUSH_NOTIFICATIONS.md §15): shows this device's OS notification at once (even while paused: the
   * reader asked for it), then asks the server to push to my phones. The notification.test that comes back over the WS
   * is not shown again here. Throws; the settings say why inline.
   */
  async sendTestNotification(): Promise<TestNotificationOut> {
    const session = this.active;
    if (!session) throw new Error("ログインしていません");
    session.testShownAt = Date.now();
    void notify(this.notificationTitle(session, TEST_NOTIFICATION_TITLE), TEST_NOTIFICATION_BODY);
    return session.api.sendTestNotification();
  }

  /** M40 「ログイン中の端末」: GET /auth/sessions (throws; the account screen says why inline). */
  async listSessions(): Promise<SessionOut[]> {
    if (!this.api) throw new Error("ログインしていません");
    return this.api.sessions();
  }

  /** M40: signs another device of mine out (DELETE /auth/sessions/{id}); false when refused (the toast says why). */
  async revokeSession(sessionId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.revokeSession(sessionId);
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
    return this.activeEntry?.name ?? "Taylis";
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
    // WORKSPACES.md §3.2: the dot also for unread replies in threads I follow (the threads badge, THREADS.md §5).
    const unreadThreads = session.store.threadSummary.unread_count > 0;
    return { badge: unreadBadgeTotal(channels), unread: unreadThreads || channels.some((c) => c.isMember && !c.archived && hasUnread(c, meId)) };
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

  /** M93: drag (or Alt+↑/↓) a workspace to another place on the rail; the order is saved on this device. */
  moveWorkspace(serverUrl: string, toIndex: number): void {
    const next = moveWorkspace(this.workspaces, serverUrl, toIndex);
    if (next === this.workspaces) return;
    this.workspaces = next;
    this.saveWorkspaces();
    this.emit();
  }

  /** M93: the admin's icon for a workspace (its version, for GET /server/icon), or null for the letter tile. */
  workspaceIconVersion(serverUrl: string): string | null {
    return this.workspaces.find((e) => e.serverUrl === serverUrl)?.iconVersion ?? null;
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
      iconVersion: info?.icon_version !== undefined ? info.icon_version : (known?.iconVersion ?? null),
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
    configureAvatars((path) => session.api.fetchBlob(path), session.serverUrl); // M14a: another workspace starts an empty cache
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
      // M93: a server before it has no `icon_version` (keep what we have: none).
      const iconVersion = answer.icon_version !== undefined ? answer.icon_version : (entry?.iconVersion ?? null);
      if (!entry || (entry.name === answer.name && entry.workspaceId === answer.workspace_id && (entry.iconVersion ?? null) === iconVersion)) return;
      this.patchEntry(session.serverUrl, { name: answer.name, workspaceId: answer.workspace_id, iconVersion });
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

  /**
   * M93: bootstrap's and workspace.settings_updated's `icon_version` (an admin changed the icon) reach the saved entry, so
   * the rail and the switcher follow at once and keep it across restarts. Missing (a server before M93): no change.
   */
  /**
   * M96: a rename (mine here, on another device or by an administrator) reaches the saved entry as `loginName`, so the
   * workspace list and the next login form show the new name. `username` stays: it names the credential and the store.
   */
  private followUsername(session: Session, store: Store): void {
    const live = store.me?.username;
    const entry = this.workspaces.find((e) => e.serverUrl === session.serverUrl);
    if (!live || !entry || signInName(entry) === live) return;
    this.patchEntry(session.serverUrl, { loginName: live === entry.username ? undefined : live });
    this.emit();
  }

  private followIcon(session: Session, store: Store): void {
    const live = store.workspaceSettings.icon_version;
    if (live === undefined) return;
    const entry = this.workspaces.find((e) => e.serverUrl === session.serverUrl);
    if (!entry || (entry.iconVersion ?? null) === live) return;
    this.patchEntry(session.serverUrl, { iconVersion: live });
    this.emit();
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
      this.followIcon(session, store);
      this.followUsername(session, store);
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
    this.reportDeviceOnce(session, engine);
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

  /**
   * Once the engine is first online (a fresh access token): PUT /devices/current with this device's name and app version,
   * so a device signed in earlier (named "MacIntel" before, or an older version) shows what it is now. Best effort.
   */
  private reportDeviceOnce(session: Session, engine: SyncEngine): void {
    const unsubscribe = engine.subscribe(() => {
      if (engine.status !== "online") return;
      unsubscribe();
      if (session.engine !== engine) return;
      const { device_name, app_version } = this.deviceInfo();
      void Promise.resolve()
        .then(() => session.api.updateDevice({ device_name, app_version }))
        .catch((err: unknown) => console.warn("could not update this device's name", err));
    });
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
      // M51: my calendar alarm (phones get the server's push; the open app says it too), worded like that push.
      // Review v0.1.22 #9: null when the occurrence it is for is not known here: a neutral line, never another occurrence's.
      onCalendarAlarm: (event, channelId) => {
        if (this.quiet(session)) return;
        void notify(this.notificationTitle(session, "予定"), calendarAlarmText(event, channelId ? store.getChannel(channelId)?.name ?? null : null));
      },
      // M55: assigned to me / due today (TASKS.md §5), worded like the server's push; off with 「タスク」 in the settings.
      onTaskNotice: (notice) => {
        if (this.quiet(session) || (store.me ?? session.me)?.notify_tasks === false) return;
        const { body, taskId, channelId } = taskNoticeText(notice, (id) => store.users.get(id)?.display_name ?? null);
        void notify(this.notificationTitle(session, "タスク"), body, () => {
          if (this.active === session) this.requestOpenTask(taskId, channelId);
        });
      },
      // M72 (CANVAS.md §18.1): a canvas newly mentions me (the engine checks the conversation's level and mute), worded
      // like the server's push; a click opens the canvas.
      onCanvasMention: (mention, channel) => {
        if (this.quiet(session) || store.isBlocked(mention.by_user_id)) return;
        const who = store.users.get(mention.by_user_id)?.display_name ?? "メンバー";
        const where = channel.type === "public" || channel.type === "private" ? ` (#${channel.name})` : "";
        void notify(this.notificationTitle(session, "キャンバス"), `${who} が「${mention.title}」であなたをメンションしました${where}`, () => {
          if (this.active === session) this.requestOpenCanvas(mention.channel_id, mention.canvas_id);
        });
      },
      // §15: a test notification asked for on another device of mine (this one showed its own when the button was pressed).
      onTestNotification: (test) => {
        if (session.testShownAt !== undefined && Date.now() - session.testShownAt < TEST_ECHO_MS) return;
        void notify(this.notificationTitle(session, test.title), test.body);
      },
      onNotify: (message, channel) => {
        if (this.quiet(session)) return; // M12c: paused / quiet hours
        if (store.isBlocked(message.sender_id)) return; // M104: nothing from someone I blocked
        const sender = store.users.get(message.sender_id)?.display_name ?? "メンバー";
        const text = plainText(mentionsToNames(message.body, store.users, store.groups)) || attachmentText(message.attachments) || "新しいメッセージ";
        // A DM is titled by its sender; a channel or group DM by the conversation, with the sender before the text.
        if (channel.type === "dm") void notify(this.notificationTitle(session, sender), text);
        else void notify(this.notificationTitle(session, conversationTitle(channel, store.users, store.me?.id ?? null)), `${sender}: ${text}`);
      },
      // M39: a reaction to my message, only when I asked for reaction banners (the engine checks that and the
      // conversation's level and mute; the activity lists it either way). Titled like the server's push.
      onReaction: (reaction, channel) => {
        if (this.quiet(session) || store.isBlocked(reaction.user_id)) return;
        const actor = store.users.get(reaction.user_id)?.display_name ?? "メンバー";
        const message = store.getMessage(channel.id, reaction.message_id);
        const excerpt = message && !message.deleted ? plainText(mentionsToNames(message.body, store.users, store.groups), 80) : "";
        const where = channel.type === "dm" ? "" : ` · ${conversationTitle(channel, store.users, store.me?.id ?? null)}`;
        void notify(this.notificationTitle(session, `${actor} がリアクションしました${where}`), excerpt ? `${reactionText(reaction.emoji, store.customEmoji)} 「${excerpt}」` : reactionText(reaction.emoji, store.customEmoji));
      },
      // A workspace in the background is not being looked at: its server may push to the phone (§6).
      // In use: the open workspace, its window focused, and touched within the last minutes (platform/idle.ts).
      isActive: () => this.active === session && document.hasFocus() && !readerIdle(),
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
      const answer = await this.api.vote(message.id, option, present);
      this.store.upsertMessage(answer);
      this.store.setMyVotes(answer); // also when another vote's event came first (§8)
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

  // --- reservation pools (M99, docs/RESERVATIONS.md) ------------------------------------------

  /** Runs one call that answers with the pool, and puts the answer in the store; errors go to the banner. */
  private async withPool(call: (api: ApiClient) => Promise<PoolOut>): Promise<PoolOut | null> {
    if (!this.api) return null;
    try {
      const pool = await call(this.api);
      this.store.putReservationPool(pool);
      return pool;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  /** 「予約する」. */
  reservePool(poolId: string): Promise<PoolOut | null> {
    return this.withPool((api) => api.reserve(poolId));
  }

  /** 取り消す / 返却する / 割り当てた / 外した. */
  reservationAction(reservationId: string, action: "cancel" | "return" | "assign" | "remove"): Promise<PoolOut | null> {
    return this.withPool((api) => api.reservationAction(reservationId, action));
  }

  /** 「入れ替えた」. */
  swapReservations(poolId: string, removeId: string, assignId: string): Promise<PoolOut | null> {
    return this.withPool((api) => api.swapReservations(poolId, removeId, assignId));
  }

  createReservationPool(channelId: string, body: PoolCreate): Promise<PoolOut | null> {
    return this.withPool((api) => api.createReservationPool(channelId, body));
  }

  updateReservationPool(poolId: string, body: PoolUpdate): Promise<PoolOut | null> {
    return this.withPool((api) => api.updateReservationPool(poolId, body));
  }

  async deleteReservationPool(channelId: string, poolId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.deleteReservationPool(poolId);
      this.store.dropReservationPool(channelId, poolId);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  // --- canvases (M43, CANVAS.md §4.5) ---------------------------------------------------------

  /** The templates to start a canvas from (read each time the picker opens: they send no events, §11). */
  async canvasTemplates(): Promise<CanvasTemplateOut[] | null> {
    if (!this.api) return null;
    try {
      return await this.api.canvasTemplates();
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  /**
   * A new canvas in the conversation, empty or from a template (the server puts in {{date}} and the rest in my zone). A
   * failure on the network is retried with the same key, so a retry never makes a second canvas.
   */
  async createCanvas(channelId: string, options: { templateKey?: string | null; title?: string | null; asTab?: boolean }): Promise<CanvasOut | null> {
    const api = this.api;
    if (!api) return null;
    const body = {
      client_save_id: crypto.randomUUID(),
      as_tab: options.asTab ?? false,
      share_to_channel: false, // M42: posting it to the conversation is its own action
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      ...(options.templateKey ? { template_key: options.templateKey } : {}),
      ...(options.title ? { title: options.title } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const canvas = await api.createCanvas(channelId, body);
        this.store.applyCanvasMeta(canvas);
        return canvas;
      } catch (error) {
        if (attempt < 2 && error instanceof NetworkError) continue;
        this.setError(error);
        return null;
      }
    }
  }

  /** Title, who may edit, the conversation's tab (§4.7: the creator, owners and administrators; anyone in a DM). */
  async updateCanvas(canvasId: string, patch: { title?: string; edit_policy?: "members" | "owners"; is_channel_tab?: boolean }): Promise<CanvasOut | null> {
    if (!this.api) return null;
    try {
      const canvas = await this.api.updateCanvas(canvasId, patch);
      this.store.applyCanvasMeta(canvas);
      this.engine?.canvases.current(canvasId)?.applyMeta(canvas);
      return canvas;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  /** To the trash (restorable from the conversation's canvas list). */
  async trashCanvas(canvasId: string, channelId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.deleteCanvas(canvasId);
      this.engine?.canvases.applyEvent("canvas.deleted", { canvas_id: canvasId, channel_id: channelId });
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async trashedCanvases(channelId: string): Promise<CanvasMeta[] | null> {
    if (!this.api) return null;
    try {
      return await this.api.listCanvases(channelId, true);
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  async restoreCanvas(canvasId: string): Promise<CanvasOut | null> {
    if (!this.api) return null;
    try {
      const canvas = await this.api.restoreCanvas(canvasId);
      this.store.applyCanvasMeta(canvas);
      return canvas;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  // --- canvases: history, sharing, links, images (M44, CANVAS.md §4.9 / §4.10 / §4.13) ------------

  /** A canvas the main screen should open in its conversation (a search hit, ⌘K, a /c/ link, 「キャンバス」). */
  openCanvasRequest: { channelId: string; canvasId: string } | null = null;

  requestOpenCanvas(channelId: string, canvasId: string): void {
    this.openCanvasRequest = { channelId, canvasId };
    this.emit();
  }

  private readonly canvasLinks = new Map<string, Promise<CanvasLinkState>>();

  /**
   * What a `/c/<id>` link stands for, for its card (§4.13): the canvas's metadata, or why it cannot be shown — not a
   * member of its conversation (403) or no such canvas / in the trash (404). Asked once per canvas and session; a canvas
   * this device already lists is answered from the store (kept current by events).
   */
  canvasLink(canvasId: string): Promise<CanvasLinkState> {
    const known = this.store.canvasMeta(canvasId);
    if (known) return Promise.resolve({ state: "ok", canvas: known });
    const api = this.api;
    if (!api) return Promise.resolve({ state: "error" });
    let pending = this.canvasLinks.get(canvasId);
    if (!pending) {
      pending = api.getCanvas(canvasId).then(
        (canvas): CanvasLinkState => {
          if (!canvas) return { state: "error" };
          const { body: _body, ...meta } = canvas;
          return { state: "ok", canvas: meta };
        },
        (error: unknown): CanvasLinkState => {
          this.canvasLinks.delete(canvasId); // a network failure is asked again next time
          if (error instanceof ApiError && error.status === 403) return { state: "forbidden" };
          if (error instanceof ApiError && error.status === 404) return { state: "missing" };
          return { state: "error" };
        },
      );
      this.canvasLinks.set(canvasId, pending);
    }
    return pending;
  }

  /** A `/c/<id>` link tapped (or a browser URL): open it in its conversation, or say why not. */
  async openCanvasLink(canvasId: string): Promise<boolean> {
    this.canvasLinks.delete(canvasId); // a tap asks again (joined since, restored from the trash)
    const link = await this.canvasLink(canvasId);
    if (link.state === "ok") {
      this.requestOpenCanvas(link.canvas.channel_id, canvasId);
      return true;
    }
    this.setError(link.state === "forbidden" ? "このキャンバスの会話のメンバーではありません" : link.state === "missing" ? "キャンバスが見つかりません (ゴミ箱に移されたか、削除されました)" : "キャンバスを開けませんでした");
    return false;
  }

  /** The canvases of all my conversations (the sidebar's 「キャンバス」, ⌘K), most recently updated first. */
  async myCanvases(cursor: string | null = null, limit = 50): Promise<CanvasPage | null> {
    if (!this.api) return null;
    try {
      return await this.api.myCanvases(cursor, limit);
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  /**
   * 「会話に共有」 (§4.13): the canvas's link posted to its conversation as an ordinary message (nothing new while that
   * message exists). The answer names the message, whose thread holds the comments.
   */
  async shareCanvas(canvasId: string): Promise<CanvasOut | null> {
    if (!this.api) return null;
    try {
      const canvas = await this.api.shareCanvas(canvasId);
      this.store.applyCanvasMeta(canvas);
      this.engine?.canvases.current(canvasId)?.applyMeta(canvas);
      return canvas;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  /** 「コメント」: the shared message's thread, sharing the canvas first when it never was (or its message is gone). */
  async canvasCommentsMessage(canvas: CanvasMeta): Promise<string | null> {
    if (canvas.share_message_id) {
      const known = this.store.messages(canvas.channel_id).find((m) => m.id === canvas.share_message_id);
      if (known && !known.deleted) return known.id;
    }
    const shared = await this.shareCanvas(canvas.id);
    return shared?.share_message_id ?? null;
  }

  async canvasRevisions(canvasId: string, cursor: string | null = null): Promise<CanvasRevisionPage | null> {
    if (!this.api) return null;
    try {
      return await this.api.canvasRevisions(canvasId, cursor);
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  async canvasRevision(canvasId: string, revisionId: string): Promise<CanvasRevisionOut | null> {
    if (!this.api) return null;
    try {
      return await this.api.canvasRevision(canvasId, revisionId);
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  /**
   * That version's body as a new version (§4.9). What is typed here is saved first, so it stays in the history; a failure
   * on the network is sent again with the same key, so a retry never makes a second version.
   */
  async restoreCanvasRevision(canvasId: string, revisionId: string): Promise<CanvasOut | null> {
    const api = this.api;
    if (!api) return null;
    const saver = this.engine?.canvases.current(canvasId);
    await saver?.flush();
    const key = crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        const canvas = await api.restoreCanvasRevision(canvasId, revisionId, key);
        this.store.applyCanvasMeta(canvas);
        saver?.remoteVersion(canvas.version);
        return canvas;
      } catch (error) {
        if (attempt < 2 && error instanceof NetworkError) continue;
        this.setError(error);
        return null;
      }
    }
  }

  async labelCanvasRevision(canvasId: string, revisionId: string, label: string | null): Promise<CanvasRevisionMeta | null> {
    if (!this.api) return null;
    try {
      return await this.api.labelCanvasRevision(canvasId, revisionId, label);
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  /** Erase a version's body (§4.7: owners and administrators; in a DM its creator). The server audits it. */
  async eraseCanvasRevision(canvasId: string, revisionId: string): Promise<CanvasRevisionMeta | null> {
    if (!this.api) return null;
    try {
      return await this.api.eraseCanvasRevision(canvasId, revisionId);
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  private readonly attachmentMetas = new Map<string, Promise<AttachmentOut | null>>();

  /** A canvas image's metadata (name, type, shape), asked once per session; null when it cannot be read. */
  attachmentMeta(attachmentId: string): Promise<AttachmentOut | null> {
    const api = this.api;
    if (!api) return Promise.resolve(null);
    let pending = this.attachmentMetas.get(attachmentId);
    if (!pending) {
      pending = api.getAttachment(attachmentId).catch((error: unknown) => {
        if (!(error instanceof ApiError)) this.attachmentMetas.delete(attachmentId); // network: ask again later
        return null;
      });
      this.attachmentMetas.set(attachmentId, pending);
    }
    return pending;
  }

  /** An image pasted or dropped into a canvas: uploaded as pending; the save that names it binds it (§4.10). */
  async uploadCanvasImage(file: File): Promise<AttachmentOut | null> {
    if (!this.api) return null;
    try {
      const uploaded = await this.api.uploadAttachment(file, file.name || "image.png");
      this.attachmentMetas.set(uploaded.id, Promise.resolve(uploaded));
      return uploaded;
    } catch (error) {
      this.setError(error);
      return null;
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

  /** L4 (M31): who has not acknowledged yet (members only); null when it could not be loaded (the toast says why). */
  async ackPending(message: MessageState): Promise<string[] | null> {
    if (!this.api) return null;
    try {
      return (await this.api.ackPending(message.id)).user_ids;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  /**
   * L4 (M31): 「未確認の人にリマインド」 (the author or an admin). The outcome comes back as a line for the list itself, not a
   * toast: the app's toasts sit under an open dialog. `ok: false` with the error's text (429: once an hour).
   */
  async remindAck(message: MessageState): Promise<{ ok: boolean; text: string }> {
    if (!this.api) return { ok: false, text: describe(new NetworkError("no session")) };
    try {
      const { reminded } = await this.api.ackRemind(message.id);
      return { ok: true, text: reminded > 0 ? `${reminded} 人にリマインドしました` : "リマインド済みの人だけです" };
    } catch (error) {
      return { ok: false, text: describe(error) };
    }
  }

  async closePoll(message: MessageState): Promise<boolean> {
    if (!this.api) return false;
    try {
      const answer = await this.api.closePoll(message.id);
      this.store.upsertMessage(answer);
      this.store.setMyVotes(answer);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /**
   * The last message this device posted outside the send queue (a poll): the timeline follows it to the bottom like a
   * post from the composer (§10.1 11.; the server reads the channel for it too). Testers: after a poll the view stayed
   * put, or jumped up.
   */
  postedHere: string | null = null;

  /** `anonymous` (M27) is sent only when set, so a server before M27 (extra fields refused) still takes a named poll. */
  async createPoll(channelId: string, parentId: string | null, question: string, options: string[], multiple: boolean, anonymous = false): Promise<boolean> {
    if (!this.api) return false;
    try {
      const message = await this.api.postPoll(channelId, parentId, { question, options, multiple, ...(anonymous ? { anonymous: true as const } : {}) });
      this.postedHere = message.id;
      if (this.engine) this.engine.postedFromHere(message);
      else this.store.upsertMessage(message);
      // The row may have landed already (its event before this answer): the timeline follows it now (§10.1 11.), and
      // nothing else re-renders it when the store already held the row.
      this.emit();
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  // --- workflows (M94, docs/WORKFLOWS.md) -----------------------------------------------------

  /**
   * Posts a workflow's filled form as me (the server renders the message). The same `clientMsgId` for a retry of the same
   * form returns the message already posted. The error is returned, not toasted: the form stays open to show it.
   */
  async submitWorkflow(workflowId: string, values: Record<string, unknown>, clientMsgId: string): Promise<{ ok: true; message: MessageOut } | { ok: false; error: unknown }> {
    if (!this.api) return { ok: false, error: new NetworkError("offline") };
    try {
      const message = await this.api.submitWorkflow(workflowId, { client_msg_id: clientMsgId, values });
      this.postedHere = message.id;
      if (this.engine) this.engine.postedFromHere(message);
      else this.store.upsertMessage(message);
      this.emit();
      return { ok: true, message };
    } catch (error) {
      return { ok: false, error };
    }
  }

  // --- scheduling polls (M53, SCHEDULING.md) -------------------------------------------------

  /** A scheduling poll: the candidates as UTC instants (or dates) and the device's zone, in which the server labels them. */
  async createSchedulePoll(channelId: string, parentId: string | null, question: string, slots: ScheduleSlotIn[], tz: string, anonymous = false): Promise<boolean> {
    if (!this.api) return false;
    try {
      const message = await this.api.postPoll(channelId, parentId, { kind: "schedule", question, slots, tz, ...(anonymous ? { anonymous: true as const } : {}) });
      this.postedHere = message.id;
      if (this.engine) this.engine.postedFromHere(message);
      else this.store.upsertMessage(message);
      this.emit();
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** The answer to my own change: the store takes it, and its own parts (my answers) whatever the order (§8). */
  private applyMyPoll(answer: MessageState): void {
    this.store.upsertMessage(answer);
    this.store.setMyVotes(answer);
  }

  /** My ○ / △ / × for every candidate at once (null = unanswered); `comment` undefined keeps mine, "" removes it. */
  async answerSchedule(message: MessageState, answers: readonly (PollAnswer | null)[], comment?: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      const body: PollAnswersIn = { answers: answersBody(answers) };
      if (comment !== undefined) body.comment = comment.trim() || null;
      this.applyMyPoll(await this.api.answerPoll(message.id, body));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** Decide a candidate: the server makes the channel's event (not in a DM) and replies in the thread. */
  async decideSchedule(message: MessageState, index: number): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.applyMyPoll(await this.api.decidePoll(message.id, index));
      this.setNotice("日程を決定しました");
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  async undecideSchedule(message: MessageState): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.applyMyPoll(await this.api.undecidePoll(message.id));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /** The event a decision made (the card's 「予定を開く」); null when it is gone or cannot be seen (the toast says so). */
  async loadCalendarEvent(eventId: string): Promise<CalendarEventOut | null> {
    const known = this.engine?.calendar?.find(eventId);
    if (known) return known;
    if (!this.api) return null;
    try {
      return await this.api.getCalendarEvent(eventId);
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  // --- tasks (M55, TASKS.md) ----------------------------------------------------------------

  /** A task the main screen should open (a notification): its board's tab (or 「自分のタスク」), then its dialog. */
  openTaskRequest: { taskId: string; channelId: string | null } | null = null;

  requestOpenTask(taskId: string, channelId: string | null): void {
    this.openTaskRequest = { taskId, channelId };
    this.emit();
  }

  /** A task to show (held, else read); null when it is gone or cannot be seen (the toast says so). */
  async loadTask(taskId: string): Promise<TaskOut | null> {
    const hub = this.engine?.tasks;
    try {
      if (hub?.available) return await hub.load(taskId);
      return this.api ? await this.api.getTask(taskId) : null;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  // --- post templates (M30) -----------------------------------------------------------------

  /** Adds a template (mine, or the workspace's for an admin); the row, or null when refused (the toast says why). */
  async createTemplate(body: TemplateCreate): Promise<TemplateOut | null> {
    if (!this.api) return null;
    try {
      const row = await this.api.createTemplate(body);
      this.store.applyTemplate(row, false); // template.updated confirms on every device
      return row;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  async updateTemplate(templateId: string, patch: TemplateUpdate): Promise<TemplateOut | null> {
    if (!this.api) return null;
    try {
      const row = await this.api.updateTemplate(templateId, patch);
      this.store.applyTemplate(row, false);
      return row;
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  async deleteTemplate(templateId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.deleteTemplate(templateId);
      const row = this.store.templates.get(templateId);
      if (row) this.store.applyTemplate(row, true);
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /**
   * Moves a template one place up or down among `rows` (one scope, in their order): every row whose position is not
   * its place yet gets it, so rows that shared a position (all 0) end up in a clear order.
   */
  async moveTemplate(rows: readonly TemplateOut[], templateId: string, step: -1 | 1): Promise<boolean> {
    const from = rows.findIndex((row) => row.id === templateId);
    const to = from + step;
    if (from < 0 || to < 0 || to >= rows.length) return false;
    const order = [...rows];
    [order[from], order[to]] = [order[to]!, order[from]!];
    for (const [index, row] of order.entries()) {
      if (row.position !== index && !(await this.updateTemplate(row.id, { position: index }))) return false;
    }
    return true;
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
    // M35: /mute and /unmute keep the conversation's own level (null while it follows the overall setting).
    const level = channel.notificationLevel;
    switch (command.name) {
      case "help": {
        // M30: the templates too, after the commands.
        const templates = orderTemplates(this.store.templates.values()).map((t) => `/${t.name}`);
        const names = [...new Set(templates)];
        this.setNotice(COMMANDS.map((c) => c.usage).join(" · ") + (names.length > 0 ? ` · テンプレート: ${names.join(" ")}` : ""));
        return true;
      }
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
        const ids: string[] = [];
        for (const handle of handles) {
          const user = byHandle(handle);
          if (!user) {
            this.setError(`${handle} というユーザーはいません`);
            return false;
          }
          ids.push(user.id);
        }
        try {
          await api.addMembers(channel.id, ids); // M88: one 「追加しました」 line for them all
        } catch (error) {
          this.setError(error);
          return false;
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
        // Ends both mutes: the timed one and the one until unmuted (M35).
        await this.setNotification(channel.id, level, null, false);
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
      case "日程": {
        // M53: a scheduling poll of the dates read (the composer opens the form with them instead, to check first).
        const read = readSchedule(command.args);
        const slots = read ? slotsFromEntries(read.entries) : [];
        if (!read || slots.length < 2 || slots.length > 20) {
          this.setError(SCHEDULE_USAGE);
          return false;
        }
        return this.createSchedulePoll(channel.id, parentId, read.question, slots.map(slotToIn), localZone());
      }
    }
    return false;
  }

  /**
   * Before 「更新して再起動」 installs and relaunches: every workspace's drafts and canvases typed in the last seconds go
   * to the server, waiting messages are sent while online (what stays queued is kept in the local store and goes out
   * after the restart), and the local store's writes finish.
   *
   * Review v0.1.30 #3: the two waits are apart. The server gets at most `networkMs` (a slow server does not hold up
   * the update: what it did not take is in the local store). The local writes of every workspace, the ones not on
   * screen too, are always waited for, after the network part (which may queue more of them); when one failed or
   * they do not finish within `localMs`, this rejects and the update stops with the error. What is typed after this
   * resolves (while the installer runs) goes through the same local queue; on Windows the installer quits the app
   * at once, so the last seconds' typing there may not be kept.
   */
  async prepareForRestart(networkMs = 8000, localMs = 30_000): Promise<void> {
    const sessions = new Set<Session>(this.sessions.values());
    if (this.active) sessions.add(this.active);
    const network = Promise.all([...sessions].map((session) => {
      const engine = session.engine;
      return Promise.allSettled([
        engine?.flushDrafts(),
        engine?.canvases.flushAll(),
        engine?.flushOutbox(),
      ]);
    }));
    await withDeadline(network, networkMs, () => { console.warn("restart: the server took too long; what it did not take stays on this device"); });
    const local = Promise.all([...sessions].map((session) => session.store.flushPersistence()));
    try {
      await withDeadline(local, localMs, () => { throw new Error("timeout"); });
    } catch (error) {
      console.error("restart: the local store could not save", error);
      throw new UserMessageError("下書きや送信待ちのメッセージをこの端末に保存できなかったため、更新を中止しました。", { cause: error });
    }
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
      // A draft typed in the last second (before its save after the typing pause, M15d) reaches my other devices
      // before the connection goes; the local copy is erased below.
      await session.engine?.flushDrafts();
      await session.engine?.canvases.flushAll().catch(() => {}); // M43: a canvas typed in the last seconds too
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
  /** When 「テスト通知を送る」 was last pressed here (its notification.test echo is not shown twice). */
  testShownAt?: number;
}

/** The test notification's words (the server's push says the same, PUSH_NOTIFICATIONS.md §15). */
export const TEST_NOTIFICATION_TITLE = "Taylis";
export const TEST_NOTIFICATION_BODY = "テスト通知です。この端末に通知が届いています。";
const TEST_ECHO_MS = 30_000;

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
