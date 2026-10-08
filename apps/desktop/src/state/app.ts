/** Application controller: login, session restore, and the sync engine lifecycle. */
import { ApiClient, type DeviceInfo } from "../api/client";
import { dndActive } from "../ui/dnd";
import { calendarAlarmText } from "../sync/calendar";
import { taskNoticeText } from "../ui/tasks";
import { reactionText } from "../ui/customEmoji";
import { canvasLink, messagePermalink, pageLink } from "../ui/permalink";
import { inviteErrorText } from "../ui/invite";
import { challengeFor, newVerifier, parseSsoDeepLink, saveSsoPending, type SsoPending, ssoErrorText, ssoStartUrl, takeSsoPending, takeSsoReturn } from "../ui/sso";
import { totpErrorText } from "../ui/totp";
import { shareBody } from "../ui/share";
import { conversationTitle, hasUnread, isDmChannel, unreadBadgeTotal } from "../ui/channels";
import { configureAvatars, noteVersions } from "../ui/avatars";
import { setThemeWorkspace } from "../ui/theme";
import { findDmWith } from "../ui/mobileTabs";
import { parseEntryPath } from "../ui/routes";
import { COMMANDS, type ParsedCommand, parseDuration, SHRUG, splitStatus } from "../ui/commands";
import { scheduleLabel } from "../ui/schedule";
import { orderTemplates, readSchedule, scheduleUsage } from "../ui/templates";
import { answersBody, slotsFromEntries, slotToIn } from "../ui/scheduling";
import { localZone } from "../ui/calendarDates";
import { ApiError, describeError, describeFeatureError, NetworkError, UserMessageError } from "../api/errors";
import { hostLabel, isServerInfo, loadWorkspaces, moveWorkspace, normalizeServerUrl, sameServer, saveWorkspaces as persistWorkspaces, signInName, type WorkspaceEntry } from "./workspaces";
import type { AttachmentOut, AuthMethodsOut, CalendarEventOut, PollAnswer, PollAnswersIn, ScheduleSlotIn, CanvasMeta, CanvasOut, CanvasPage, CanvasRevisionMeta, CanvasRevisionOut, CanvasRevisionPage, CanvasTemplateOut, CustomEmojiOut, CustomEmojiUpdate, EmojiPackImportOut, TextEmojiCreate, InvitePreviewOut, LinkPreviewOut, MemberOut, MemberRole, MessageOut, NotificationLevel, PoolCreate, PoolOut, PoolUpdate, PostingPolicy, ReadAllScope, ReminderOut, ScheduledOut, ServerInfoOut, SessionOut, DefaultSectionKey, SidebarSectionOut, SidebarSort, TaskOut, TemplateCreate, TemplateOut, TemplateUpdate, TokenResponse, TotpEnabledOut, TotpSetupOut, TotpStatusOut, UserMe, UserUpdate, MyLabProfileUpdate } from "../api/types";
import { saveDownload } from "../platform/download";
import type { ChannelState, MessageState } from "../sync/types";
import { setTitleBase, setUnreadBadge } from "../platform/badge";
import { listenForDeepLinks } from "../platform/deepLink";
import { isTauri, isWeb } from "../platform/env";
import { openInBrowser } from "../platform/external";
import { resolveDeviceName } from "../platform/deviceName";
import { readerIdle } from "../platform/idle";
import { clearNotifications, notify } from "../platform/notify";
import type { ReportCategory, ReportReason, TestNotificationOut } from "../api/types";
import { secretStore } from "../platform/secrets";
import { SqlitePersistence } from "../platform/sqlite";
import { readFallback, type CloseReadMark } from "../sync/dmCloses";
import { SyncEngine } from "../sync/engine";
import { Store } from "../sync/store";
import { browserConnector } from "../sync/ws";
import { UpdateChecker } from "./updates";
import { attachmentText, plainText } from "../ui/markdown";
import { rememberEmoji } from "../ui/EmojiPicker";
import { decodeMentions, mentionsToNames } from "../ui/mentions";
import { type ComposerMode, composerModeOf, type DocsEditorMode, docsEditorModeOf, readGroupPosts, readSendKey, type SendKey, writeGroupPosts, writeSendKey } from "../ui/prefs";
import type { NavItem } from "../ui/navItems";
import { type Capability, canAdminister as canAdministerWith, hasCapability } from "../ui/roles";
import { setLocalePreference, type UiLocale, t } from "../i18n";

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

/** A notice's button: its label and what it does (the toast closes after). */
export type NoticeAction = { label: string; run: () => void };

export class AppController {
  screen: Screen = "boot";
  error: string | null = null;
  /** A short confirmation (「リンクをコピーしました」); null when nothing to say. */
  notice: string | null = null;
  /** M141: a button on the notice (「元に戻す」 after 「会話を閉じました」); null for a plain one. */
  noticeAction: NoticeAction | null = null;
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
      if (message.parent_id && mine) {
        try {
          for (const reply of await this.api.replies(message.parent_id)) this.store.upsertMessage(reply);
        } catch (error) {
          // A reply whose root is deleted (a stale link or notification): the thread opens saying so (THREADS.md §5).
          if (!(error instanceof ApiError && error.status === 404 && error.code === "message_not_found")) throw error;
          if (this.engine) this.engine.forgetDeletedRoot(message.channel_id, message.parent_id);
          else this.store.forgetThread(message.channel_id, message.parent_id);
        }
      }
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
  /** M121: a `/p/<id>` Docs page opened in the browser. */
  private entryPage: string | null = null;

  private takeEntryPath(): void {
    const entry = parseEntryPath(location.pathname);
    if (!entry) return;
    if (entry.kind === "invite") this.entryInvite = entry.token;
    else if (entry.kind === "canvas") this.entryCanvas = entry.id;
    else if (entry.kind === "page") this.entryPage = entry.id;
    else this.entryMessage = entry.id;
    history.replaceState(null, "", "/");
  }

  private async revealEntry(): Promise<void> {
    const canvasId = this.entryCanvas;
    this.entryCanvas = null;
    if (canvasId) await this.openCanvasLink(canvasId);
    const pageId = this.entryPage;
    this.entryPage = null;
    if (pageId) this.requestOpenPage(pageId);
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
      setThemeWorkspace(this.activeServer); // main.tsx painted the saved one; a browser serves its own origin's
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
      device_name: this.deviceName ?? (isWeb() ? t("device.browser") : t("device.desktop")),
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
      this.setScreen("login", t("app.badServerUrl"));
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
        this.setScreen("login", t("app.notTaylisServer"));
        return null;
      }
      const known = this.workspaces.find((e) => (e.workspaceId !== null && e.workspaceId === info!.workspace_id) || sameServer(e.serverUrl, server));
      if (known && this.sessions.has(known.serverUrl)) {
        await this.switchWorkspace(known.serverUrl);
        this.setNotice(t("app.workspaceKnown", { name: known.name }));
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
    if (!this.api) return { error: t("app.notLoggedIn") };
    try {
      return await this.api.totpSetup(password);
    } catch (error) {
      return { error: totpErrorText(error) };
    }
  }

  async enableTotp(code: string): Promise<TotpEnabledOut | { error: string }> {
    if (!this.api) return { error: t("app.notLoggedIn") };
    try {
      return await this.api.totpEnable(code);
    } catch (error) {
      return { error: totpErrorText(error) };
    }
  }

  /** Returns the failure text, if any. */
  async disableTotp(password: string): Promise<string | null> {
    if (!this.api) return t("app.notLoggedIn");
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
    if (!normalized) return t("app.badServerUrl");
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
      this.setScreen("login", t("app.ssoStorageBlocked"));
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
      this.setScreen("login", t("app.browserOpenFailed"));
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

  /**
   * M142 (docs/ROLES.md §2.1): whether my role lets me do this, from `me.capabilities` (bootstrap, and /users/me again
   * when user.updated says my account changed). Administration screens use this, not the role name.
   */
  can(capability: Capability): boolean {
    return hasCapability(this.store.me ?? this.me, capability);
  }

  /** Whether 「管理」 shows at all (any of its tabs is mine): administrators and managers. */
  get canAdminister(): boolean {
    return canAdministerWith((capability) => this.can(capability));
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

  /**
   * `fromThread`: deleted from a thread pane's own rows. When that is the thread's root, the pane closes without
   * 「元のメッセージが削除されたため、スレッドを閉じました」 (THREADS.md §5): I closed it myself.
   */
  async deleteMessage(messageId: string, options: { fromThread?: boolean } = {}): Promise<void> {
    if (!this.api) return;
    if (options.fromThread) this.threadDeletes.add(messageId);
    try {
      this.store.upsertMessage(await this.api.deleteMessage(messageId));
    } catch (error) {
      this.threadDeletes.delete(messageId);
      this.setError(error);
    }
  }

  private readonly threadDeletes = new Set<string>();

  /** True (once) when the message was deleted from a thread pane on this screen (deleteMessage's `fromThread`). */
  takeThreadDelete(messageId: string): boolean {
    return this.threadDeletes.delete(messageId);
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

  setNotice(text: string | null, action: NoticeAction | null = null): void {
    this.notice = text;
    this.noticeAction = text === null ? null : action;
    this.emit();
  }

  /** M12f: add a custom emoji; everyone gets emoji.updated, this device applies it at once. */
  async uploadEmoji(name: string, file: File, extra: { label?: string | null; keywords?: string[] } = {}): Promise<boolean> {
    if (!this.api) return false;
    try {
      const row = await this.api.uploadEmoji(name, file, file.name, extra);
      this.store.applyCustomEmoji(row, false);
      this.setNotice(t("app.emojiAdded", { name: row.name }));
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
      this.setNotice(t("app.emojiAdded", { name: row.name }));
      return true;
    } catch (error) {
      this.setError(describeFeatureError(error, t("feature.textEmoji")));
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
      this.setError(describeFeatureError(error, t("feature.emojiEdit")));
      return false;
    }
  }

  /** M100 (admin): import a pack from a folder's files or a ZIP; returns what happened, or why not (the dialog shows it). */
  async importEmojiPack(source: { archive: File } | { files: File[] }): Promise<EmojiPackImportOut | string> {
    if (!this.api) return t("app.notLoggedIn");
    try {
      const result = await this.api.importEmojiPack(source);
      this.store.applyEmojiPack(result.pack, false);
      // The emoji themselves arrive as emoji.updated; fetch them now too so this window shows them at once.
      this.store.replaceCustomEmoji(await this.api.listEmoji());
      return result;
    } catch (error) {
      return describeFeatureError(error, t("feature.packImport"));
    }
  }

  async updateEmojiPack(packId: string, patch: { name?: string; position?: number }): Promise<boolean> {
    if (!this.api) return false;
    try {
      this.store.applyEmojiPack(await this.api.updateEmojiPack(packId, patch), false);
      return true;
    } catch (error) {
      this.setError(describeFeatureError(error, t("feature.emojiPacks")));
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
      this.setError(describeFeatureError(error, t("feature.emojiPacks")));
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
      this.setNotice(t("app.reminderSet", { when: scheduleLabel(row.remind_at) }));
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
      this.setNotice(t("app.scheduledSet", { when: scheduleLabel(row.send_at) }));
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

  /**
   * 2026-10-08: what every copy button does. The text to the clipboard, then a short toast (「コピーしました」, or `notice`
   * such as 「仮パスワードをコピーしました」); when the clipboard refuses (a browser without the permission), the error toast.
   * Resolves whether it was copied, for a button that also shows its own 「コピーしました」 mark.
   */
  async copyToClipboard(text: string, notice: string = t("app.copied")): Promise<boolean> {
    try {
      await copyText(text);
      if (this.error === t("app.clipboardFailed")) this.setError(null); // an earlier refusal, now out of date
      this.setNotice(notice);
      return true;
    } catch (error) {
      console.warn("copy failed", error);
      this.setError(t("app.clipboardFailed"));
      return false;
    }
  }

  async copyPermalink(messageId: string): Promise<void> {
    const url = this.permalink(messageId);
    if (!url) return;
    await this.copyToClipboard(url, t("app.linkCopied"));
  }

  /** M121: `<server>/p/<id>` of a Docs page (WIKI.md §9.3). */
  async copyPageLink(pageId: string): Promise<void> {
    if (!this.api) return;
    await this.copyToClipboard(pageLink(this.api.baseUrl, pageId), t("app.linkCopied"));
  }

  /** M44: `<server>/c/<id>` of a canvas (CANVAS.md §4.13). */
  async copyCanvasLink(canvasId: string): Promise<void> {
    if (!this.api) return;
    await this.copyToClipboard(canvasLink(this.api.baseUrl, canvasId), t("app.linkCopied"));
  }

  /** M25: 「テキストをコピー」 from the phone action sheet: the body with mentions as names (as the phone apps copy it). */
  async copyMessageText(body: string): Promise<void> {
    await this.copyToClipboard(mentionsToNames(body, this.store.users, this.store.groups), t("app.textCopied"));
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
  async createSection(name: string, emoji: string | null, channelIds: string[]): Promise<boolean> {
    const ok = await this.sidebarChange((api) =>
      api.createSidebarSection({ name, ...(emoji ? { emoji } : {}), ...(channelIds.length ? { channel_ids: channelIds } : {}) }),
    );
    if (ok) this.leaveFavorites(channelIds);
    return ok;
  }

  /**
   * DATA_MODEL.md sidebar_sections 「1 つの会話は 1 か所」: a conversation put in one of my sections is no longer starred.
   * The server unstarred it in the same change (favorite.updated confirms); the row moves here at once, not only when
   * the event comes.
   */
  private leaveFavorites(channelIds: Iterable<string>): void {
    for (const id of channelIds) this.store.setFavorite(id, false);
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

  /**
   * A section to another place among mine (the menu's 上へ / 下へ, or dragging its header). Moves at once here; the server's
   * list (sidebar.updated on my other devices) confirms, and a failure puts the old order back.
   */
  async moveSection(sectionId: string, position: number): Promise<boolean> {
    const before = this.store.sidebarSections;
    const moved = before.find((s) => s.id === sectionId);
    if (!moved) return false;
    const rows = before.filter((s) => s.id !== sectionId);
    rows.splice(Math.max(0, Math.min(position, rows.length)), 0, moved);
    this.store.replaceSidebar(rows.map((s, index) => ({ ...s, position: index })));
    const ok = await this.sidebarChange((api) => api.updateSidebarSection(sectionId, { position }));
    if (!ok) this.store.replaceSidebar(before);
    return ok;
  }

  /**
   * DATA_MODEL.md sidebar_sections 「並べ替え」: a section's sort (one of mine by id, or a default one by key). Choosing
   * 「手動」 keeps the order shown now (`shownIds`), so nothing jumps. Moves at once here; a failure puts it back.
   */
  setSectionSort(target: SortTarget, sort: SidebarSort, shownIds: string[]): Promise<boolean> {
    return this.applySort(target, sort === "manual" ? { sort, manual_order: shownIds } : { sort });
  }

  /** A conversation dragged within a section by hand: the section's new order (it stays 「手動」). */
  reorderSection(target: SortTarget, ids: string[]): Promise<boolean> {
    return this.applySort(target, { sort: "manual", manual_order: ids });
  }

  private async applySort(target: SortTarget, patch: { sort: SidebarSort; manual_order?: string[] }): Promise<boolean> {
    const store = this.store;
    if ("section" in target) {
      const before = store.sidebarSections;
      store.replaceSidebar(before.map((s) => (s.id === target.section ? { ...s, ...patch } : s)));
      const ok = await this.sidebarChange((api) => api.updateSidebarSection(target.section, patch));
      if (!ok) store.replaceSidebar(before);
      return ok;
    }
    const before = store.sidebarDefaults;
    const rest = before.filter((row) => row.key !== target.default);
    const old = before.find((row) => row.key === target.default);
    store.replaceSidebarDefaults([...rest, { key: target.default, sort: patch.sort, manual_order: patch.manual_order ?? old?.manual_order ?? [] }]);
    if (!this.api) return false;
    try {
      store.replaceSidebarDefaults(await this.api.updateSidebarDefault(target.default, patch));
      return true;
    } catch (error) {
      store.replaceSidebarDefaults(before);
      this.setError(error);
      return false;
    }
  }

  deleteSection(sectionId: string): Promise<boolean> {
    return this.sidebarChange((api) => api.deleteSidebarSection(sectionId));
  }

  /** `sectionId` null puts the conversation back in the default sections. Into a section it leaves お気に入り too. */
  async moveToSection(channelId: string, sectionId: string | null): Promise<boolean> {
    const ok = await this.sidebarChange((api) => (sectionId ? api.placeInSidebarSection(sectionId, channelId) : api.removeFromSidebarSection(channelId)));
    if (ok && sectionId) this.leaveFavorites([channelId]);
    return ok;
  }

  /**
   * M117 「通話を始める」 (docs/CALLS.md §7): posts the call and returns the room's URL, or null when refused (the error
   * shown). The caller keeps `clientMsgId` for a retry, so a lost answer never starts a second call. 409 calls_disabled
   * (turned off while this device missed the event) hides 📞 at once; the next settings event or bootstrap confirms.
   */
  async startCall(channelId: string, clientMsgId: string): Promise<string | null> {
    if (!this.api) return null;
    try {
      const { call, created } = await this.api.startCall(channelId, clientMsgId);
      if (created && this.engine) this.engine.postedFromHere(call.message);
      else this.store.upsertMessage(call.message);
      return call.url;
    } catch (error) {
      if (error instanceof ApiError && error.code === "calls_disabled") this.store.setWorkspaceSettings({ ...this.store.workspaceSettings, calls_enabled: false });
      this.setError(error);
      return null;
    }
  }

  /**
   * M12a: a starred channel; the store flag moves at once, favorite.updated confirms on every device. Starring takes
   * it out of my section (「1 つの会話は 1 か所」; the server does the same, sidebar.updated confirms); a refusal puts
   * both back.
   */
  async toggleFavorite(channelId: string): Promise<void> {
    if (!this.api) return;
    const on = !this.store.isFavorite(channelId);
    const sections = this.store.sidebarSections;
    this.store.setFavorite(channelId, on);
    if (on && this.store.sectionOf(channelId)) {
      this.store.replaceSidebar(sections.map((s) => (s.channel_ids.includes(channelId) ? { ...s, channel_ids: s.channel_ids.filter((id) => id !== channelId) } : s)));
    }
    try {
      if (on) await this.api.favoriteChannel(channelId);
      else await this.api.unfavoriteChannel(channelId);
    } catch (error) {
      this.store.setFavorite(channelId, !on);
      if (on) this.store.replaceSidebar(sections);
      this.setError(error);
    }
  }

  /**
   * M118 「上に固定」/「固定を外す」 on a DM or group DM: the order moves at once and is put back as it was when refused;
   * dm_pin.updated brings my other devices along.
   */
  async toggleDmPin(channelId: string): Promise<void> {
    if (!this.api || this.store.dmPins === null) return;
    const before = this.store.dmPins;
    const on = !this.store.isDmPinned(channelId);
    this.store.setDmPinned(channelId, on);
    try {
      if (on) await this.api.pinDm(channelId);
      else await this.api.unpinDm(channelId);
    } catch (error) {
      this.store.replaceDmPins(before);
      this.setError(error);
    }
  }

  /**
   * M141 「会話を閉じる」 (SYNC_PROTOCOL.md §7.9): the DM leaves every list at once, unpinned and read; all three are put
   * back when refused. The main screen leaves it when it is the one open (`closedChannelRequest`), and a toast offers
   * 「元に戻す」. dm_close.updated brings my other devices along.
   *
   * Review v0.1.43 #7: the rollback puts back only what the close touched (apps/shared/dm-close-rules.json): its own pin
   * in its place (pins changed meanwhile stay), and the read state as the server has it (asked again; the snapshot only
   * when that fails too and nothing changed it since), so a message or another device's read that came meanwhile stays.
   */
  async closeDm(channelId: string): Promise<boolean> {
    const channel = this.store.getChannel(channelId);
    const api = this.api;
    if (!api || this.store.closedDms === null || !channel || !isDmChannel(channel) || this.store.isDmClosed(channelId)) return false;
    const pins = this.store.dmPins ?? [];
    const wasPinned = this.store.isDmPinned(channelId);
    const pinPlace = wasPinned ? pins.indexOf(channelId) : null;
    const read = { lastReadSeq: channel.lastReadSeq, unreadCount: channel.unreadCount, mentionCount: channel.mentionCount, firstUnreadAt: channel.firstUnreadAt };
    const optimistic = { lastSeq: channel.lastSeq, lastReadSeq: Math.max(channel.lastReadSeq, channel.lastSeq), unreadCount: 0, mentionCount: 0 };
    this.store.setDmClosed(channelId, true);
    if (wasPinned) this.store.setDmPinned(channelId, false);
    this.store.updateChannel(channelId, { lastReadSeq: optimistic.lastReadSeq, unreadCount: 0, mentionCount: 0, firstUnreadAt: null });
    this.closedChannelRequest = channelId;
    this.emit();
    try {
      await api.closeDm(channelId);
    } catch (error) {
      this.store.setDmClosed(channelId, false);
      if (wasPinned) this.store.restoreDmPin(channelId, pinPlace);
      this.setError(error);
      await this.restoreReadAfterRefusedClose(api, channelId, read, optimistic);
      return false;
    }
    this.setNotice(t("dmClose.closed"), { label: t("dmClose.undo"), run: () => void this.undoCloseDm(channelId, wasPinned) });
    return true;
  }

  /**
   * Review v0.1.43 #7: after a refused close, the read state as the server has it (PUT read with 0: an advance that moves
   * nothing and answers the state), taken as it is. Unreachable too: the snapshot goes back only if nothing changed the
   * read state since the close set it; otherwise what came meanwhile stays until the next bootstrap.
   */
  private async restoreReadAfterRefusedClose(
    api: ApiClient,
    channelId: string,
    snapshot: Pick<ChannelState, "lastReadSeq" | "unreadCount" | "mentionCount" | "firstUnreadAt">,
    optimistic: CloseReadMark,
  ): Promise<void> {
    try {
      const state = await api.markRead(channelId, 0);
      this.store.updateChannel(channelId, { lastReadSeq: state.last_read_seq, unreadCount: state.unread_count, mentionCount: state.mention_count, firstUnreadAt: state.first_unread_at ?? null });
      return;
    } catch (error) {
      console.warn("could not read the read state back after a refused close", error);
    }
    const now = this.store.getChannel(channelId);
    if (now && readFallback(optimistic, now) === "snapshot") this.store.updateChannel(channelId, snapshot);
  }

  /** M141 「元に戻す」: opens it again (DELETE) and pins it again (last) when it was pinned; the read position stays. */
  async undoCloseDm(channelId: string, repin: boolean): Promise<void> {
    if (!this.api) return;
    this.store.setDmClosed(channelId, false);
    if (repin) this.store.setDmPinned(channelId, true);
    try {
      await this.api.reopenDm(channelId);
      if (repin) await this.api.pinDm(channelId);
    } catch (error) {
      this.setError(error);
    }
  }

  /**
   * M141: a closed DM opened on purpose (search, ⌘K, a profile's 「メッセージを送る」, a link, a notification) shows in the
   * lists again at once; a refused DELETE is only logged (the next bootstrap closes it again).
   */
  reopenIfClosed(channelId: string): void {
    if (!this.store.isDmClosed(channelId)) return;
    this.store.setDmClosed(channelId, false);
    void this.api?.reopenDm(channelId).catch((error: unknown) => console.warn("could not reopen a closed DM", error));
  }

  /** M141: the DM just closed here; the main screen leaves it if it is the one on screen, and clears this. */
  closedChannelRequest: string | null = null;

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
      this.setNotice(on ? t("app.blocked") : t("app.unblocked"));
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
      this.setNotice(t("app.reported"));
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    }
  }

  /**
   * M119 「問題を報告・ご意見」 / a profile's 「報告する」 (docs/MODERATION.md §3.1): sent to the administrators. The dialog
   * keeps `clientReportId` until this succeeds, so a retry after a lost answer does not make a second report.
   */
  async submitReport(report: { category: ReportCategory; note: string; userId?: string | null; clientReportId: string }): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.submitReport({
        category: report.category,
        note: report.note.trim(),
        client_report_id: report.clientReportId,
        ...(report.userId ? { user_id: report.userId } : {}),
      });
      this.setNotice(t("problemReport.sent"));
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
    if (!this.api || !this.activeServer) return t("app.notLoggedIn");
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
   * M111: 「サイドバーの項目」 (users.nav_items, apps/shared/nav-items.json), null = back to the defaults. Shown at once; a
   * refused or failed save puts the previous list back. My other devices follow as with the quick reactions (user.updated).
   */
  async setNavItems(list: NavItem[] | null): Promise<boolean> {
    const before = this.store.me;
    if (!this.api || !before) return false;
    this.store.setMe({ ...before, nav_items: list });
    const ok = await this.updateProfile({ nav_items: list });
    if (!ok && this.store.me?.nav_items === list) this.store.setMe({ ...this.store.me, nav_items: before.nav_items ?? null });
    return ok;
  }

  /**
   * The composer's mode (users.composer_mode): "rich" (WYSIWYG, writes the same Markdown) or "markdown". Shown at once
   * in every composer; a refused or failed save puts the previous choice back. My other devices follow (user.updated).
   */
  private composerModeLocal = false;
  async setComposerMode(mode: ComposerMode): Promise<boolean> {
    const before = this.store.me;
    if (!this.api || !before) return false;
    // A server without the setting: this session only (PATCH would refuse the field).
    if (before.composer_mode === undefined) this.composerModeLocal = true;
    this.store.setMe({ ...before, composer_mode: mode });
    if (this.composerModeLocal) return true;
    const ok = await this.updateProfile({ composer_mode: mode });
    if (!ok && this.store.me?.composer_mode === mode) this.store.setMe({ ...this.store.me, composer_mode: before.composer_mode ?? null });
    return ok;
  }

  /** The composer's mode now: what I chose, else rich (the default for new users and for those who never chose). */
  get composerMode(): ComposerMode {
    return composerModeOf(this.store.me);
  }

  /**
   * M150 (WIKI.md §22.6): how Docs pages are edited (users.docs_editor_mode): "wysiwyg" (見たまま, writes the same
   * Markdown) or "markdown". Shown at once; a refused or failed save puts the previous choice back. My other devices
   * follow (user.updated). A server without the setting: this session only.
   */
  private docsEditorModeLocal = false;
  async setDocsEditorMode(mode: DocsEditorMode): Promise<boolean> {
    const before = this.store.me;
    if (!before) return false;
    if (!this.api || before.docs_editor_mode === undefined) this.docsEditorModeLocal = true;
    this.store.setMe({ ...before, docs_editor_mode: mode });
    if (this.docsEditorModeLocal) return true;
    const ok = await this.updateProfile({ docs_editor_mode: mode });
    if (!ok && this.store.me?.docs_editor_mode === mode) this.store.setMe({ ...this.store.me, docs_editor_mode: before.docs_editor_mode ?? null });
    return ok;
  }

  /** How Docs pages are edited now: what I chose, else 見たまま (WIKI.md §22.8 R1). */
  get docsEditorMode(): DocsEditorMode {
    return docsEditorModeOf(this.store.me);
  }

  /**
   * M115 (docs/I18N.md): my UI language (users.locale), null = follow the device / browser. Applied at once (the app
   * redraws in it); a refused or failed save puts the previous choice back. My other devices follow (user.updated).
   */
  async setUiLocale(locale: UiLocale | null): Promise<boolean> {
    const before = this.store.me;
    if (!this.api || !before) {
      setLocalePreference(locale);
      return false;
    }
    this.store.setMe({ ...before, locale });
    setLocalePreference(locale);
    const ok = await this.updateProfile({ locale });
    if (!ok && this.store.me?.locale === locale) {
      this.store.setMe({ ...this.store.me, locale: before.locale ?? null });
      setLocalePreference(before.locale ?? null);
    }
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

  /**
   * 2026-10-07 (MOBILE_UI.md §6.4): the activity items opened (a row clicked): read until they happen again. Their dots
   * go at once; the badge takes the server's answer; my other devices follow through activity.items_read. Items without
   * an `id` (a server before it) are left to the read position.
   */
  async markActivityItemsRead(items: readonly { id?: string | null; at: string }[]): Promise<boolean> {
    const engine = this.engine;
    const opened = items.filter((item): item is { id: string; at: string } => !!item.id);
    if (!engine || opened.length === 0) return false;
    try {
      return await engine.markActivityItemsRead(opened);
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
      this.setNotice(t("app.photoUpdated"));
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
    if (!this.api) return t("app.notLoggedIn");
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
    if (!session) throw new Error(t("app.notLoggedIn"));
    session.testShownAt = Date.now();
    void notify(this.notificationTitle(session, TEST_NOTIFICATION_TITLE), testNotificationBody());
    return session.api.sendTestNotification();
  }

  /** M40 「ログイン中の端末」: GET /auth/sessions (throws; the account screen says why inline). */
  async listSessions(): Promise<SessionOut[]> {
    if (!this.api) throw new Error(t("app.notLoggedIn"));
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
    if (!this.api) return t("app.notLoggedIn");
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

  /** Every change of the active workspace comes through here: its colours go on screen at once (per-workspace themes). */
  private saveWorkspaces(): void {
    persistWorkspaces(this.workspaces, this.activeServer);
    setThemeWorkspace(this.activeServer);
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
      if (opened.failure) this.setError(t("app.localDbFailed"));
    }
    void engine.start();
    this.reportDeviceOnce(session, engine);
    if (this.active === session && (this.entryMessage || this.entryCanvas || this.entryPage)) {
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
        void notify(this.notificationTitle(session, t("notification.reminder")), (reminder.note ? `${reminder.note} — ` : "") + reminder.preview);
      },
      // M51: my calendar alarm (phones get the server's push; the open app says it too), worded like that push.
      // Review v0.1.22 #9: null when the occurrence it is for is not known here: a neutral line, never another occurrence's.
      onCalendarAlarm: (event, channelId) => {
        if (this.quiet(session)) return;
        void notify(this.notificationTitle(session, t("notification.calendar")), calendarAlarmText(event, channelId ? store.getChannel(channelId)?.name ?? null : null));
      },
      // M55: assigned to me / due today (TASKS.md §5), worded like the server's push; off with 「タスク」 in the settings.
      onTaskNotice: (notice) => {
        if (this.quiet(session) || (store.me ?? session.me)?.notify_tasks === false) return;
        const { body, taskId, channelId } = taskNoticeText(notice, (id) => store.users.get(id)?.display_name ?? null);
        void notify(this.notificationTitle(session, t("notification.task")), body, () => {
          void this.openFromNotification(session.serverUrl, () => this.requestOpenTask(taskId, channelId));
        });
      },
      // M72 (CANVAS.md §18.1): a canvas newly mentions me (the engine checks the conversation's level and mute), worded
      // like the server's push; a click opens the canvas.
      onCanvasMention: (mention, channel) => {
        if (this.quiet(session) || store.isBlocked(mention.by_user_id)) return;
        const who = store.users.get(mention.by_user_id)?.display_name ?? t("common.member");
        const where = channel.type === "public" || channel.type === "private" ? ` (#${channel.name})` : "";
        void notify(this.notificationTitle(session, t("notification.canvas")), t("notification.canvasMention", { who, title: mention.title }) + where, () => {
          void this.openFromNotification(session.serverUrl, () => this.requestOpenCanvas(mention.channel_id, mention.canvas_id));
        });
      },
      // M121 (WIKI.md §9.3): a Docs page newly mentions me, or was shared with me by name; a click opens the page.
      onWikiNotice: (notice) => {
        if (this.quiet(session) || store.isBlocked(notice.data.by_user_id)) return;
        const who = store.users.get(notice.data.by_user_id)?.display_name ?? t("common.member");
        const title = notice.data.title || t("docs.untitled");
        const text = notice.kind === "mentioned" ? t("notification.pageMention", { who, title }) : t("notification.pageShared", { who, title });
        void notify(this.notificationTitle(session, t("nav.docs")), text, () => {
          void this.openFromNotification(session.serverUrl, () => this.requestOpenPage(notice.data.page_id));
        });
      },
      // M112: a reservation notice (a to-do as an operator, or news of my own booking); a click opens 「予約」.
      onReservationNotice: (notice) => {
        if (this.quiet(session)) return;
        void notify(this.notificationTitle(session, t("notification.reservation")), notice.text, () => {
          void this.openFromNotification(session.serverUrl, () => this.requestOpenReservations());
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
        const sender = store.users.get(message.sender_id)?.display_name ?? t("common.member");
        const text = plainText(mentionsToNames(message.body, store.users, store.groups)) || attachmentText(message.attachments) || t("notification.newMessage");
        // A DM is titled by its sender; a channel or group DM by the conversation, with the sender before the text. A
        // click shows the message in its conversation (a reply: in its thread), in its own workspace.
        const open = () => void this.openFromNotification(session.serverUrl, () => this.revealMessage(message));
        const conversation = channel.type === "dm" ? null : conversationTitle(channel, store.users, store.me?.id ?? null);
        // PUSH_NOTIFICATIONS.md §9.1 (2026-10-08): the sender's picture (or initials avatar) on the notification, as on
        // the phones (§16), fetched with this workspace's session.
        const from = (alone: string) => ({
          sender: {
            scope: session.serverUrl,
            userId: message.sender_id,
            name: sender,
            version: store.users.get(message.sender_id)?.avatar_updated_at ?? null,
            fetchBlob: (path: string) => session.api.fetchBlob(path),
            conversationId: channel.id,
            groupName: conversation,
            text: alone,
          },
        });
        // M117 (docs/CALLS.md §6): a call reads like the server's push, the name in the text (the room is not in it).
        if (message.call) {
          const call = `📞 ${t("call.started", { name: sender })}`;
          void notify(this.notificationTitle(session, conversation ?? sender), call, open, from(call));
          return;
        }
        if (conversation === null) void notify(this.notificationTitle(session, sender), text, open, from(text));
        else void notify(this.notificationTitle(session, conversation), `${sender}: ${text}`, open, from(text));
      },
      // M39: a reaction to my message, only when I asked for reaction banners (the engine checks that and the
      // conversation's level and mute; the activity lists it either way). Titled like the server's push.
      onReaction: (reaction, channel) => {
        if (this.quiet(session) || store.isBlocked(reaction.user_id)) return;
        const actor = store.users.get(reaction.user_id)?.display_name ?? t("common.member");
        const message = store.getMessage(channel.id, reaction.message_id);
        const excerpt = message && !message.deleted ? plainText(mentionsToNames(message.body, store.users, store.groups), 80) : "";
        const where = channel.type === "dm" ? "" : ` · ${conversationTitle(channel, store.users, store.me?.id ?? null)}`;
        void notify(this.notificationTitle(session, t("notification.reacted", { who: actor }) + where), excerpt ? t("notification.reactionQuote", { emoji: reactionText(reaction.emoji, store.customEmoji), excerpt }) : reactionText(reaction.emoji, store.customEmoji), () => {
          void this.openFromNotification(session.serverUrl, () => this.openPermalink(reaction.message_id));
        });
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

  /**
   * A click on a notification (WORKSPACES.md §7): its workspace comes on screen first, then `open` runs there, as a
   * click in the open workspace does. Before, a click on another workspace's notification did nothing (2026-10-06). The
   * switch mounts that workspace's main screen; `open` waits a task for it, so its request is not taken as an old one.
   */
  async openFromNotification(serverUrl: string, open: () => unknown): Promise<void> {
    const session = this.sessions.get(serverUrl);
    if (!session || session.leaving) return; // signed out since
    if (this.active !== session) {
      await this.switchWorkspace(serverUrl);
      if (this.active !== session) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.active !== session) return;
    }
    await open();
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
      this.setNotice(t("app.shared"));
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

  // --- reservation pools (M99, M112, docs/RESERVATIONS.md) ------------------------------------

  /** M121: the Docs page the main screen should open (a `page:` link, a /p/ permalink, a notification, an activity item). */
  openPageRequest: { pageId: string } | null = null;

  requestOpenPage(pageId: string): void {
    this.openPageRequest = { pageId: pageId.toLowerCase() };
    this.emit();
  }

  /** M112: the main screen should open 「予約」 (a notification, an activity item). */
  openReservationsRequest = 0;

  requestOpenReservations(): void {
    this.openReservationsRequest += 1;
    this.emit();
  }

  /** A booking (start on the hour, `hours` long). */
  bookReservation(poolId: string, startAt: string, hours: number): Promise<PoolOut | null> {
    return this.withPool((api) => api.bookReservation(poolId, startAt, hours));
  }

  /** 「延長」 by an hour. */
  extendReservation(reservationId: string, hours = 1): Promise<PoolOut | null> {
    return this.withPool((api) => api.extendReservation(reservationId, hours));
  }

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

  /** 「今すぐ (順番待ち)」. */
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

  createReservationPool(body: PoolCreate): Promise<PoolOut | null> {
    return this.withPool((api) => api.createReservationPool(body));
  }

  updateReservationPool(poolId: string, body: PoolUpdate): Promise<PoolOut | null> {
    return this.withPool((api) => api.updateReservationPool(poolId, body));
  }

  async deleteReservationPool(poolId: string): Promise<boolean> {
    if (!this.api) return false;
    try {
      await this.api.deleteReservationPool(poolId);
      this.store.dropReservationPool(poolId);
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
    this.setError(link.state === "forbidden" ? t("app.canvasForbidden") : link.state === "missing" ? t("app.canvasMissing") : t("app.canvasOpenFailed"));
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

  /**
   * L4 (M31): who has not acknowledged yet (members only); null when it could not be loaded (the toast says why, unless
   * `quiet`: the count in the message's own 確認 row, loaded unasked, then just leaves the total out).
   */
  async ackPending(message: MessageState, { quiet = false }: { quiet?: boolean } = {}): Promise<string[] | null> {
    if (!this.api) return null;
    try {
      return (await this.api.ackPending(message.id)).user_ids;
    } catch (error) {
      if (!quiet) this.setError(error);
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
      return { ok: true, text: reminded > 0 ? t("app.ackReminded", { count: reminded }) : t("app.ackAlreadyReminded") };
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
      this.setNotice(t("app.scheduleDecided"));
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
      this.setError(t("command.unknown", { name: command.name }));
      return false;
    }
    if (spec.channelOnly && isDm) {
      this.setError(t("command.channelOnly", { name: command.name }));
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
        this.setNotice(COMMANDS.map((c) => c.usage).join(" · ") + (names.length > 0 ? t("command.helpTemplates", { names: names.join(" ") }) : ""));
        return true;
      }
      case "status": {
        if (!command.args || command.args === "clear") {
          const cleared = await this.updateProfile({ status_text: null, status_emoji: null, status_expires_at: null });
          if (cleared) this.setNotice(t("command.statusCleared"));
          return cleared;
        }
        const { emoji, text } = splitStatus(command.args);
        const ok = await this.updateProfile({ status_text: text || null, status_emoji: emoji, status_expires_at: null });
        if (ok) this.setNotice(t("command.statusUpdated"));
        return ok;
      }
      case "dnd": {
        if (!command.args || command.args === "off") {
          const ok = await this.updateProfile({ dnd_until: null });
          if (ok) this.setNotice(t("command.pauseCleared"));
          return ok;
        }
        const until = parseDuration(command.args);
        if (!until) {
          this.setError("/dnd 30m | 1h | 2h | 4h | tomorrow | off");
          return false;
        }
        const ok = await this.updateProfile({ dnd_until: until.toISOString() });
        if (ok) this.setNotice(t("command.pausedUntil", { when: scheduleLabel(until.toISOString()) }));
        return ok;
      }
      case "topic":
        return this.updateTopic(channel.id, command.args);
      case "leave":
        return this.leaveChannel(channel.id);
      case "invite": {
        const handles = command.args.split(/\s+/).filter(Boolean);
        if (handles.length === 0) {
          this.setError(t("command.inviteUsage"));
          return false;
        }
        const ids: string[] = [];
        for (const handle of handles) {
          const user = byHandle(handle);
          if (!user) {
            this.setError(t("command.noSuchUser", { handle }));
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
        this.setNotice(t("command.added", { count: handles.length }));
        return true;
      }
      case "join": {
        const name = command.args.replace(/^#/, "").toLowerCase();
        const target = [...this.store.channels.values()].find((c) => c.type === "public" && (c.name ?? "").toLowerCase() === name);
        if (!target) {
          this.setError(t("command.noSuchChannel", { name }));
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
          this.setError(t("command.dmUsage"));
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
        this.setNotice(t("command.pausedUntil", { when: scheduleLabel(until.toISOString()) }));
        return true;
      }
      case "unmute":
        // Ends both mutes: the timed one and the one until unmuted (M35).
        await this.setNotification(channel.id, level, null, false);
        this.setNotice(t("command.resumed"));
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
          this.setError(t("command.pollUsage"));
          return false;
        }
        return this.createPoll(channel.id, parentId, parts[0]!, parts.slice(1), false);
      }
      case "日程": {
        // M53: a scheduling poll of the dates read (the composer opens the form with them instead, to check first).
        const read = readSchedule(command.args);
        const slots = read ? slotsFromEntries(read.entries) : [];
        if (!read || slots.length < 2 || slots.length > 20) {
          this.setError(scheduleUsage());
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
      throw new UserMessageError(t("app.updateAbortedDrafts"), { cause: error });
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
export function testNotificationBody(): string {
  return t("notification.testBody");
}
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

/**
 * The async clipboard first; a hidden textarea + execCommand when a webview refuses it (no permission API). Use
 * `AppController.copyToClipboard` from a button: it also shows 「コピーしました」 or the error.
 */
export async function copyText(text: string): Promise<void> {
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
  if (!ok) throw new Error(t("app.clipboardFailed"));
}

/** Which section a sort belongs to: one of mine by id, or a default one (お気に入り / チャンネル / ダイレクトメッセージ). */
export type SortTarget = { section: string } | { default: DefaultSectionKey };
