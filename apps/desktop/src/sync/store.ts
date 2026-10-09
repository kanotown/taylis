import type { AiAgentPublic, AiStatusOut } from "../api/ai";
import type { AttachmentOut, ChannelLinkOut, PoolOut, ChannelOut, ChannelState, CustomEmojiOut, EmojiPackOut, GroupOut, MessageOut, SidebarDefaultOut, SidebarSectionOut, MessageState, NotificationLevel, OutboxItem, ParentThread, PresenceEntry, PresenceLook, PresenceStatus, ReminderOut, ScheduledOut, ThreadEntry, ThreadFilter, ThreadItem, ThreadState, ThreadSummary, UserMe, UserPublic } from "./types";
import type { ActionListOut, ActionStatusListOut, ActionStatusOut, ActivitySummaryOut, AttendanceBoardOut, AttendanceEntryOut, CanvasMeta, LabProfileOut, LastMessageOut, NotificationPreferenceOut, PageItem, PageOut, PollOut, TemplateOut, WorkspaceSettingsOut } from "../api/types";
import { statusKey } from "../ui/actions";
// M49: the preview's rule is plain text work shared with the rows that show it (no React, no store).
import { lastMessageOf, type PreviewSource, sameLastMessage } from "../ui/dmPreview";
import { type CanvasEditor, CanvasEditors } from "./canvasPresence";
import type { CanvasPendingState } from "./canvasSave";
import { restoredDmPins } from "./dmCloses";
import { ownNotification } from "./notifications";
import { isIndefiniteDnd } from "../ui/dnd";
import { presenceLook } from "../ui/presence";
import { LOCAL_PREFIX } from "./types";

/** Write-through persistence (SQLite in Tauri). Everything is also kept in memory. */
/** What the threads list's optimistic 「すべて既読にする」 changed (THREADS.md §3.2), to put back on failure. */
export interface ThreadsReadUndo {
  rows: Map<string, { before: ThreadState; after: ThreadState }>;
  summary: ThreadSummary;
}

export interface Persistence {
  loadAll(): Promise<Snapshot>;
  saveMeta(key: string, value: string | null): Promise<void>;
  saveUser(user: UserPublic): Promise<void>;
  saveChannel(channel: ChannelState): Promise<void>;
  deleteChannel(channelId: string): Promise<void>;
  saveMessage(message: MessageState): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  clearMessages(channelId: string): Promise<void>;
  saveOutbox(item: OutboxItem): Promise<void>;
  deleteOutbox(clientMsgId: string): Promise<void>;
  /** Confirmed rows of the channel with seq < beforeSeq (pending ones stay). */
  deleteOlderMessages(channelId: string, beforeSeq: number): Promise<void>;
  /** Sign-out (§11): every table emptied. */
  clearAll(): Promise<void>;
}

export interface Snapshot {
  meta: Record<string, string>;
  users: UserPublic[];
  channels: ChannelState[];
  messages: MessageState[];
  outbox: OutboxItem[];
}

/** M121: the Docs tree as last read (WIKI.md §10). */
export interface WikiTreeSnapshot {
  pages: PageItem[];
  cursor: number;
  etag: string | null;
}

export function emptySnapshot(): Snapshot {
  return { meta: {}, users: [], channels: [], messages: [], outbox: [] };
}

/**
 * At most this many messages are kept per channel (M22, SYNC_PROTOCOL.md §7.7): the newest ones (pending sends always
 * stay). Older history is paged in again when the reader scrolls up.
 */
export const CACHED_MESSAGES_PER_CHANNEL = 500;
/** How many newest replies a threads-list card shows (the server's LATEST_REPLIES, THREADS.md §5). */
export const THREAD_PREVIEW_REPLIES = 2;

/**
 * M88: the workspace settings a server before M88 (or an offline start) stands for: both on, as before. M117: calls are
 * off until the server says otherwise (a server before M117 has no calls endpoint).
 */
export const DEFAULT_WORKSPACE_SETTINGS: Readonly<WorkspaceSettingsOut> = { show_membership_messages: true, preview_before_join: true, calls_enabled: false, meeting_base_url: null };

export interface Draft {
  text: string;
  attachments: AttachmentOut[];
  /** M15d: edited here and not yet saved on the server (an emptied draft stays until its delete is saved). */
  dirty?: boolean;
  /** M15d: the server's `updated_at` of the version this device last matched. */
  syncedAt?: string | null;
}

/** The single source of truth for the UI (ARCHITECTURE.md §11). */
export class Store {
  me: UserMe | null = null;
  readonly users = new Map<string, UserPublic>();
  readonly channels = new Map<string, ChannelState>();
  readonly outbox: OutboxItem[] = [];
  /** Followed threads (THREADS.md §5): fetched when the view opens, replaced by thread.updated; not persisted. */
  readonly threads = new Map<string, ThreadEntry>();
  threadSummary: ThreadSummary = { unread_count: 0, mention_count: 0 };
  /**
   * Messages seen deleted in this session (an event, a catch-up page, my own delete's answer, a thread whose replies the
   * server no longer has). A deleted row leaves the store, so an open thread asks here whether its root is gone
   * (THREADS.md §5 「元のメッセージの削除」). Not persisted.
   */
  private readonly deletedIds = new Set<string>();
  /**
   * M39: the activity badge and read position; null while the server has sent none (before M39). Kept with `me`, so an
   * offline start shows the last badge; bootstrap replaces it.
   */
  activity: ActivitySummaryOut | null = null;
  /** Review v0.1.22 #3: activity items whose excerpt the server blanked (an erased canvas revision), and a counter the
   *  open list watches to drop those excerpts at once. */
  erasedActivityItems: ReadonlySet<string> = new Set();
  activityEdits = 0;
  /**
   * 2026-10-06 (MOBILE_UI.md §6.4): my read position in each thread as far as this device knows (ThreadState from any
   * source, and this device's own marks), kept even for a thread not held in `threads`: an activity reply at or below
   * it was read in its thread. Positions in threads never go down.
   */
  readonly threadReadSeqs = new Map<string, number>();
  /** Bumped when a conversation's read position went back (`read.updated` "set"): the activity list loads again. */
  activityReloads = 0;
  /**
   * M88 (docs/MEMBERSHIP.md §3): the workspace settings from bootstrap and workspace.settings_updated. Not persisted: an
   * offline start reads the defaults (today's behaviour), and the next bootstrap says what they are.
   */
  workspaceSettings: WorkspaceSettingsOut = { ...DEFAULT_WORKSPACE_SETTINGS };
  threadsFilter: ThreadFilter = "all";
  threadsLoaded = false;
  threadsCursor: string | null = null;
  threadsHasMore = false;
  /** Who is connected right now (SYNC_PROTOCOL.md §5.2); absent = offline. Replaced by bootstrap. */
  readonly presence = new Map<string, PresenceStatus>();
  /** "channel[:parent]" → user id → expiry (ms); volatile typing indicators. */
  readonly typing = new Map<string, Map<string, number>>();
  /** M72: who edits which canvas (volatile `canvas_presence` frames, CANVAS.md §18.2). */
  readonly canvasEditing = new CanvasEditors();
  /** My saved message ids (M11c); from bookmark and bookmark.updated, not persisted. */
  readonly bookmarks = new Set<string>();
  /** My starred channel ids (M12a); from bootstrap and favorite.updated, not persisted. */
  readonly favorites = new Set<string>();
  /**
   * M118: the DMs and group DMs I pinned to the top, oldest pin first (DATA_MODEL.md conversation_pins); from bootstrap
   * and dm_pin.updated, not persisted. Null until a server that has them says so (before M118: no pin actions).
   */
  dmPins: readonly string[] | null = null;
  /**
   * M141 (SYNC_PROTOCOL.md §7.9): the DMs and group DMs I closed (「会話を閉じる」) and nobody wrote in since; hidden from
   * every DM list. From bootstrap, dm_close.updated and a timeline message.created; not persisted. Null until a server
   * that has them says so (before M141: nothing closed, and no close action).
   */
  closedDms: ReadonlySet<string> | null = null;
  /** M104: the people I blocked (docs/MODERATION.md §4); from bootstrap and block.updated, not persisted. */
  readonly blockedUsers = new Set<string>();
  /** My pending scheduled messages (M12d); from GET /scheduled and scheduled.updated, not persisted. */
  readonly scheduled = new Map<string, ScheduledOut>();
  /** My open reminders (M12e): fired ones wait for 完了, pending ones for their time. */
  readonly reminders = new Map<string, ReminderOut>();
  /** Custom emoji by name (M12f); from bootstrap and emoji.updated, not persisted. */
  readonly customEmoji = new Map<string, CustomEmojiOut>();
  /** Emoji packs by id (M100), each a picker tab; from bootstrap and emoji_pack.updated. */
  readonly emojiPacks = new Map<string, EmojiPackOut>();
  /** User groups by id (M12k); from bootstrap and group.updated. `@name` expands on the server. */
  readonly groups = new Map<string, GroupOut>();
  /** Post templates by id (M30): the workspace's and mine; from bootstrap and template.updated. */
  readonly templates = new Map<string, TemplateOut>();
  /** The lab roster (M23) by user id; the order is ui/roster.ts's. */
  readonly roster = new Map<string, LabProfileOut>();
  /** M15f: link bars of the conversations opened so far (not persisted). */
  readonly channelLinks = new Map<string, ChannelLinkOut[]>();
  setChannelLinks(channelId: string, links: ChannelLinkOut[]): void {
    this.channelLinks.set(channelId, links);
    this.emit();
  }
  linksOf(channelId: string): ChannelLinkOut[] {
    return this.channelLinks.get(channelId) ?? [];
  }
  /**
   * M112 (docs/RESERVATIONS.md §6): the workspace's reservation pools as the server answered me (not persisted); null
   * until first read (after connecting, then on reservation.updated).
   */
  reservationPools: PoolOut[] | null = null;
  setReservationPools(pools: PoolOut[] | null): void {
    this.reservationPools = pools;
    this.emit();
  }
  /** One pool as an action answered it (replaced in place, or added at the end). */
  putReservationPool(pool: PoolOut): void {
    const list = this.reservationPools ?? [];
    const index = list.findIndex((p) => p.id === pool.id);
    this.setReservationPools(index === -1 ? [...list, pool] : list.map((p) => (p.id === pool.id ? pool : p)));
  }
  dropReservationPool(poolId: string): void {
    if (this.reservationPools) this.setReservationPools(this.reservationPools.filter((p) => p.id !== poolId));
  }
  /**
   * M140 (docs/PRESENCE.md §4): the 在室状況 board (not persisted); null for guests, while it is off, and on a server
   * before M140. From the bootstrap, attendance.updated (one row) and GET /attendance (attendance.config_updated).
   */
  attendance: AttendanceBoardOut | null = null;
  setAttendance(board: AttendanceBoardOut | null): void {
    this.attendance = board && board.enabled ? board : null;
    this.emit();
  }
  /**
   * M143 (docs/ACTIONS.md §7.1): the 操作ボタン I may press (not persisted); null for guests, while the feature is off, and
   * on a server before M143. From the bootstrap and GET /actions (actions.updated).
   */
  actions: ActionListOut | null = null;
  setActions(list: ActionListOut | null): void {
    this.actions = list && list.enabled ? list : null;
    if (!this.actions) this.actionStatuses = new Map();
    this.emit();
  }
  /**
   * M143 (docs/ACTIONS.md §12): the state of each group's devices, by group key (`statusKey`: "g:<label>", or "a:<id>"
   * for a button without a group). From GET /actions/status and actions.status_updated; not persisted.
   */
  actionStatuses: ReadonlyMap<string, ActionStatusOut> = new Map();
  /** A whole answer of GET /actions/status (groups no longer in it are dropped). */
  setActionStatuses(list: ActionStatusListOut): void {
    this.actionStatuses = new Map(list.enabled ? list.statuses.map((s) => [statusKey(s.group_label, s.action_id), s] as const) : []);
    this.emit();
  }
  /** One group's state (actions.status_updated): an older answer than the one held is ignored. */
  applyActionStatus(status: ActionStatusOut): void {
    const key = statusKey(status.group_label, status.action_id);
    const held = this.actionStatuses.get(key);
    if (held && held.fetched_at > status.fetched_at) return;
    this.actionStatuses = new Map(this.actionStatuses).set(key, status);
    this.emit();
  }
  /** One person's row (attendance.updated, or my own change). False when the state is not known here (read again). */
  applyAttendanceEntry(entry: AttendanceEntryOut): boolean {
    const board = this.attendance;
    if (!board) return true;
    const entries = board.entries.filter((e) => e.user_id !== entry.user_id);
    this.attendance = { ...board, entries: [...entries, entry] };
    this.emit();
    return board.states.some((s) => s.id === entry.state_id);
  }
  /** M112: reservation activity items marked done since the list was read (activity.updated). */
  doneActivityItems: ReadonlySet<string> = new Set();
  /**
   * 2026-10-07 (MOBILE_UI.md §6.4): activity items I opened since the list was read (here, or on another device:
   * activity.items_read), by id: when. An item is read while its `at` is not after that time.
   */
  openedActivityItems: ReadonlyMap<string, string> = new Map();
  /**
   * M43 (CANVAS.md §4.6): the canvases of the conversations opened so far, without bodies, most recently updated first.
   * Loaded when a conversation opens and after reconnecting; canvas.* events keep them current (the larger version wins).
   * Not persisted.
   */
  private readonly canvasLists = new Map<string, CanvasMeta[]>();
  /** null: not loaded yet. */
  canvasesOf(channelId: string): CanvasMeta[] | null {
    return this.canvasLists.get(channelId) ?? null;
  }
  canvasMeta(canvasId: string): CanvasMeta | undefined {
    for (const list of this.canvasLists.values()) {
      const found = list.find((c) => c.id === canvasId);
      if (found) return found;
    }
    return undefined;
  }
  setCanvases(channelId: string, list: CanvasMeta[]): void {
    const known = this.canvasLists.get(channelId) ?? [];
    // A newer version from an event that overtook the list keeps its place.
    const merged = list.map((meta) => {
      const mine = known.find((c) => c.id === meta.id);
      return mine && mine.version > meta.version ? mine : meta;
    });
    this.canvasLists.set(channelId, sortCanvases(merged));
    this.canvasListFailures.delete(channelId);
    this.emit();
  }
  /**
   * Why a conversation's list could not be loaded, until it loads: "unsupported" (404, a server from before M41),
   * "failed" (anything else). Without it the pane waited on 「読み込み中…」 for ever (tester, 2026-09-30).
   */
  private readonly canvasListFailures = new Map<string, "unsupported" | "failed">();
  canvasListFailure(channelId: string): "unsupported" | "failed" | null {
    return this.canvasListFailures.get(channelId) ?? null;
  }
  setCanvasListFailure(channelId: string, failure: "unsupported" | "failed" | null): void {
    if ((this.canvasListFailures.get(channelId) ?? null) === failure) return;
    if (failure) this.canvasListFailures.set(channelId, failure);
    else this.canvasListFailures.delete(channelId);
    this.emit();
  }
  /** canvas.created / canvas.updated, or an answer of mine: the larger version wins. */
  applyCanvasMeta(meta: CanvasMeta): void {
    const list = this.canvasLists.get(meta.channel_id);
    if (!list) return; // loaded with the list when the conversation opens
    const existing = list.find((c) => c.id === meta.id);
    if (existing && existing.version >= meta.version) return;
    // Answers carry the body too (CanvasOut): the list keeps the metadata only.
    const { deleted_at: _trashed, body: _body, ...live } = meta as CanvasMeta & { body?: string };
    this.canvasLists.set(meta.channel_id, sortCanvases([...list.filter((c) => c.id !== meta.id), live]));
    this.emit();
  }
  removeCanvas(channelId: string, canvasId: string): void {
    const list = this.canvasLists.get(channelId);
    if (!list || !list.some((c) => c.id === canvasId)) return;
    this.canvasLists.set(channelId, list.filter((c) => c.id !== canvasId));
    this.emit();
  }
  /** Unsaved canvas edits (M43): kept in SQLite under "canvas:<id>" in Tauri, so a restart sends them (same key). */
  private readonly canvasPending = new Map<string, CanvasPendingState>();
  pendingCanvas(canvasId: string): CanvasPendingState | null {
    return this.canvasPending.get(canvasId) ?? null;
  }
  pendingCanvases(): Array<[string, CanvasPendingState]> {
    return [...this.canvasPending.entries()];
  }
  setPendingCanvas(canvasId: string, state: CanvasPendingState | null): void {
    if (state) this.canvasPending.set(canvasId, state);
    else if (!this.canvasPending.delete(canvasId)) return;
    this.persist((p) => p.saveMeta(`canvas:${canvasId}`, state ? JSON.stringify(state) : null));
  }
  /**
   * M121 (WIKI.md §9.1, §10): 「ドキュメント」 kept on this device — the tree as last read (with the feed's cursor and the
   * tree's ETag), the pages opened lately (to read them offline) and edits not saved yet (as a canvas's). SQLite in
   * Tauri under "wiki:tree", "wikipage:<id>" and "wikipending:<id>"; the browser keeps them in memory only.
   */
  private wikiTree: WikiTreeSnapshot | null = null;
  private readonly pageCache = new Map<string, PageOut>();
  private readonly pagePending = new Map<string, CanvasPendingState>();
  wikiTreeSnapshot(): WikiTreeSnapshot | null {
    return this.wikiTree;
  }
  setWikiTreeSnapshot(snapshot: WikiTreeSnapshot | null): void {
    this.wikiTree = snapshot;
    this.persist((p) => p.saveMeta("wiki:tree", snapshot ? JSON.stringify(snapshot) : null));
  }
  cachedPages(): Array<[string, PageOut]> {
    return [...this.pageCache.entries()];
  }
  cachedPage(pageId: string): PageOut | null {
    return this.pageCache.get(pageId) ?? null;
  }
  setCachedPage(pageId: string, page: PageOut | null): void {
    if (page) this.pageCache.set(pageId, page);
    else if (!this.pageCache.delete(pageId)) return;
    this.persist((p) => p.saveMeta(`wikipage:${pageId}`, page ? JSON.stringify(page) : null));
  }
  pendingPage(pageId: string): CanvasPendingState | null {
    return this.pagePending.get(pageId) ?? null;
  }
  pendingPages(): Array<[string, CanvasPendingState]> {
    return [...this.pagePending.entries()];
  }
  setPendingPage(pageId: string, state: CanvasPendingState | null): void {
    if (state) this.pagePending.set(pageId, state);
    else if (!this.pagePending.delete(pageId)) return;
    this.persist((p) => p.saveMeta(`wikipending:${pageId}`, state ? JSON.stringify(state) : null));
  }
  /**
   * L4 (M31): bumped per conversation when its members change (added, removed, an owner made or taken back), so an open
   * member list loads again. Not persisted: a list opened later loads anyway.
   */
  private readonly memberRevisions = new Map<string, number>();
  membersRevision(channelId: string): number {
    return this.memberRevisions.get(channelId) ?? 0;
  }
  membersChanged(channelId: string): void {
    this.memberRevisions.set(channelId, this.membersRevision(channelId) + 1);
    this.emit();
  }
  /**
   * M11c: bumped per conversation when a message's pin may have moved where pinned() cannot see it: a held row pinned,
   * unpinned or deleted (a deleted row leaves the store, its pin with it), or an update / tombstone of a row not held
   * (an old pinned message, or one read in a search context). An open pins list loads again. Not persisted.
   */
  private readonly pinRevisions = new Map<string, number>();
  pinsRevision(channelId: string): number {
    return this.pinRevisions.get(channelId) ?? 0;
  }
  pinsMayHaveMoved(channelId: string): void {
    this.pinRevisions.set(channelId, this.pinsRevision(channelId) + 1);
    this.emit();
  }
  /** L4 (M31): my role in a conversation changed (channel.member_updated, or my own PATCH). */
  setMyRole(channelId: string, role: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.updateChannel(channelId, { membership: { joined_at: channel.membership?.joined_at ?? new Date().toISOString(), role } });
  }
  /** My sidebar sections (M14f), in order; from bootstrap and sidebar.updated. */
  sidebarSections: SidebarSectionOut[] = [];
  /** The default sections' sorts (DATA_MODEL.md sidebar_sections 「並べ替え」); empty from a server before it = the defaults. */
  sidebarDefaults: SidebarDefaultOut[] = [];
  version = 0;
  /**
   * Moves with what every message row may show besides its own message (M21): me, the users, the groups, the custom
   * emoji. The rows are memoized on it (ui/Timeline.tsx): a change elsewhere (typing, a draft, another channel's
   * unread count) re-renders none of them.
   */
  rowsVersion = 0;
  private readonly drafts = new Map<string, Draft>();
  private readonly uploads = new Map<string, number>();
  private writeQueue = Promise.resolve();

  private draftKey(channelId: string, parentId: string | null): string { return `draft:${channelId}:${parentId ?? ""}`; }
  /** Every draft with text or attachments (M11h 「下書き」), in the order they were started. */
  listDrafts(): Array<{ channelId: string; parentId: string | null; draft: Draft }> {
    return [...this.drafts.entries()]
      .filter(([, draft]) => draft.text.trim() !== "" || draft.attachments.length > 0)
      .map(([key, draft]) => {
        const [, channelId = "", parentId = ""] = key.split(":");
        return { channelId, parentId: parentId || null, draft };
      });
  }

  draft(channelId: string, parentId: string | null = null): Draft {
    return this.drafts.get(this.draftKey(channelId, parentId)) ?? { text: "", attachments: [] };
  }
  /** M15d: told about every local text change (the engine saves it on the server a moment later). */
  onDraftEdited: ((channelId: string, parentId: string | null) => void) | null = null;

  setDraft(channelId: string, parentId: string | null, patch: Partial<Draft>): void {
    const previous = this.draft(channelId, parentId);
    const draft: Draft = { ...previous, ...patch };
    const edited = patch.text !== undefined && patch.text !== previous.text;
    if (edited) draft.dirty = true;
    this.writeDraft(this.draftKey(channelId, parentId), draft);
    if (edited) this.onDraftEdited?.(channelId, parentId);
  }

  /**
   * 「下書き」's 削除 (2026-10-09): the conversation's draft goes, as when its composer is emptied after sending — the engine
   * deletes it on the server at once, so my other devices drop it too (M15d).
   */
  discardDraft(channelId: string, parentId: string | null): void {
    this.setDraft(channelId, parentId, { text: "", attachments: [] });
  }

  private writeDraft(key: string, draft: Draft): void {
    const keep = draft.text !== "" || draft.attachments.length > 0 || draft.dirty === true;
    if (keep) this.drafts.set(key, draft);
    else this.drafts.delete(key);
    this.persist((p) => p.saveMeta(key, keep ? JSON.stringify(draft) : null));
    this.emit();
  }

  /** M15d: every stored draft, including emptied ones whose delete is not saved yet. */
  draftEntries(): Array<{ channelId: string; parentId: string | null; draft: Draft }> {
    return [...this.drafts.entries()].map(([key, draft]) => {
      const [, channelId = "", parentId = ""] = key.split(":");
      return { channelId, parentId: parentId || null, draft };
    });
  }

  /** M15d: a version from my other devices (`body` null = deleted there); ignored while this device has unsaved edits. */
  applyRemoteDraft(channelId: string, parentId: string | null, body: string | null, updatedAt: string | null): void {
    const key = this.draftKey(channelId, parentId);
    const current = this.drafts.get(key);
    if (current?.dirty) return;
    const next: Draft = { text: body ?? "", attachments: current?.attachments ?? [], syncedAt: body === null ? null : updatedAt };
    if (current && current.text === next.text && (current.syncedAt ?? null) === next.syncedAt) return;
    if (!current && next.text === "") return;
    this.writeDraft(key, next);
  }

  /** M15d: the server now holds `text` (no draft when `updatedAt` is null), unless it was edited again meanwhile. */
  markDraftSaved(channelId: string, parentId: string | null, text: string, updatedAt: string | null): void {
    const key = this.draftKey(channelId, parentId);
    const current = this.drafts.get(key);
    if (!current || current.text !== text) return;
    this.writeDraft(key, { ...current, dirty: false, syncedAt: updatedAt });
  }

  markDraftDirty(channelId: string, parentId: string | null): void {
    const key = this.draftKey(channelId, parentId);
    const current = this.drafts.get(key);
    if (current && !current.dirty) this.writeDraft(key, { ...current, dirty: true });
  }
  uploading(channelId: string, parentId: string | null = null): number { return this.uploads.get(this.draftKey(channelId, parentId)) ?? 0; }
  trackUpload(channelId: string, parentId: string | null, delta: number): void {
    const key = this.draftKey(channelId, parentId);
    this.uploads.set(key, Math.max(0, (this.uploads.get(key) ?? 0) + delta));
    this.emit();
  }
  private loadDrafts(meta: Record<string, string>): void {
    for (const [key, value] of Object.entries(meta)) if (key.startsWith("draft:")) {
      try { this.drafts.set(key, JSON.parse(value) as Draft); } catch { /* Ignore a corrupt local draft. */ }
    } else if (key.startsWith("canvas:")) {
      try { this.canvasPending.set(key.slice("canvas:".length), JSON.parse(value) as CanvasPendingState); } catch { /* Ignore a corrupt row. */ }
    } else if (key.startsWith("wikipending:")) {
      try { this.pagePending.set(key.slice("wikipending:".length), JSON.parse(value) as CanvasPendingState); } catch { /* Ignore a corrupt row. */ }
    } else if (key.startsWith("wikipage:")) {
      try { this.pageCache.set(key.slice("wikipage:".length), JSON.parse(value) as PageOut); } catch { /* Ignore a corrupt row. */ }
    } else if (key === "wiki:tree") {
      try { this.wikiTree = JSON.parse(value) as WikiTreeSnapshot; } catch { /* Read again from the server. */ }
    }
  }
  /**
   * Waits for the local writes queued so far. Rejects when one of them failed since the last call (review v0.1.30 #3:
   * 「更新して再起動」 stops then instead of relaunching over input the device did not keep); the error is reported once.
   */
  async flushPersistence(): Promise<void> {
    await this.writeQueue;
    const failed = this.persistError;
    if (failed === undefined) return;
    this.persistError = undefined;
    throw failed;
  }
  /** The first local write that failed since flushPersistence last reported one (undefined: none). */
  private persistError: unknown = undefined;
  private readonly messagesByChannel = new Map<string, Map<string, MessageState>>();
  /** The sorted timeline of each channel, rebuilt only after its rows or its range change. */
  private readonly timelines = new Map<string, MessageState[]>();
  private readonly listeners = new Set<() => void>();
  /** Set by wipe(): nothing is written any more. */
  private closed = false;
  /** M49: a preview emptied by a deletion the rows held could not replace; the engine fetches the server's. */
  onStalePreview: ((channelId: string) => void) | null = null;
  /**
   * L8: every message taken in (events, catch-up pages, the answers to my posts, edits, reactions, pins and deletes): the
   * Times feed keeps its rows, held apart from the store, current with it (TIMES_FEED.md §5). `created`: the store did
   * not hold it, so it may be a row the feed lacks too (one a gap's catch-up recovered, review v0.1.15 #4).
   */
  onMessageStored: ((message: MessageState, created: boolean) => void) | null = null;
  /** L8: the answer to my own vote / answer / close (setMyVotes), for the Times feed's copy of the row (§8). */
  onMyVotes: ((message: MessageState) => void) | null = null;

  constructor(private readonly persistence: Persistence | null = null) {}

  async load(): Promise<void> {
    if (!this.persistence) return;
    this.restore(await this.persistence.loadAll());
    this.emitRows();
  }

  /** Rows as persisted: older rows are normalised, the cache is trimmed (a corrupt `me` is dropped). */
  private restore(snapshot: Snapshot): void {
    this.loadDrafts(snapshot.meta);
    try {
      const me = snapshot.meta["me"];
      this.me = me ? (JSON.parse(me) as UserMe) : null;
    } catch {
      this.me = null; // corrupt: the next sign-in writes it again
    }
    try {
      const activity = snapshot.meta["activity"];
      this.activity = activity ? (JSON.parse(activity) as ActivitySummaryOut) : null;
    } catch {
      this.activity = null; // corrupt: the next bootstrap brings it
    }
    for (const user of snapshot.users) {
      this.users.set(user.id, user);
      this.noteDndEnd(user.dnd_until);
    }
    for (const channel of snapshot.channels) this.channels.set(channel.id, restoredChannel(channel));
    for (const message of snapshot.messages) this.bucket(message.channel_id).set(message.id, { ...message });
    this.outbox.push(...snapshot.outbox.map((i) => ({ ...i })));
    for (const item of this.outbox) {
      // Written before the placeholder kept its flag: a failed send shows its retry / discard buttons.
      const placeholder = item.failed ? this.bucket(item.channel_id).get(LOCAL_PREFIX + item.client_msg_id) : undefined;
      if (placeholder && !placeholder.failed) this.bucket(item.channel_id).set(placeholder.id, { ...placeholder, failed: true });
    }
    for (const channelId of [...this.messagesByChannel.keys()]) this.trimCache(channelId);
  }

  /**
   * §7.7: keeps the newest CACHED_MESSAGES_PER_CHANNEL rows of a channel nobody is looking at; true when rows were
   * dropped. The engine decides when (never for an open conversation or thread).
   */
  trimMessages(channelId: string): boolean {
    if (!this.trimCache(channelId)) return false;
    this.timelines.delete(channelId);
    this.emit();
    return true;
  }

  /** Rows held for the channel (pending ones included): the engine trims once it passes the cap by a margin. */
  heldCount(channelId: string): number {
    return this.messagesByChannel.get(channelId)?.size ?? 0;
  }

  /** Keeps the newest CACHED_MESSAGES_PER_CHANNEL rows; the loaded range then starts after the dropped ones. */
  private trimCache(channelId: string): boolean {
    const bucket = this.bucket(channelId);
    const confirmed = [...bucket.values()].filter((m) => m.seq !== null).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
    const dropped = confirmed.slice(CACHED_MESSAGES_PER_CHANNEL);
    if (dropped.length === 0) return false;
    const newestDropped = dropped[0]!.seq ?? 0;
    for (const message of dropped) bucket.delete(message.id);
    this.persist((p) => p.deleteOlderMessages(channelId, newestDropped + 1));
    const channel = this.channels.get(channelId);
    if (channel && channel.oldestLoadedSeq !== null && channel.oldestLoadedSeq <= newestDropped) {
      const trimmed: ChannelState = { ...channel, oldestLoadedSeq: newestDropped + 1, hasOlder: true };
      this.channels.set(channelId, trimmed);
      this.persist((p) => p.saveChannel(trimmed));
    }
    return true;
  }

  /** Sign-out (§11): the account's local data (messages, drafts, send queue …) is erased. */
  async wipe(): Promise<void> {
    this.closed = true;
    const persistence = this.persistence;
    if (!persistence) return;
    const cleared = this.writeQueue.then(() => persistence.clearAll());
    this.writeQueue = cleared.catch((err: unknown) => console.error("could not erase the local store", err));
    await cleared;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** A change the message rows show (see rowsVersion). */
  private emitRows(): void {
    this.rowsVersion += 1;
    this.emit();
  }

  private persist(work: (p: Persistence) => Promise<void>): void {
    const persistence = this.persistence;
    if (persistence && !this.closed) this.writeQueue = this.writeQueue.then(() => work(persistence)).catch((err: unknown) => {
      console.error("persist failed", err);
      if (this.persistError === undefined) this.persistError = err ?? new Error("persist failed");
    });
  }

  // --- me / users -------------------------------------------------------------------------

  /**
   * M65 (docs/AI.md §5): GET /ai/status, read after every connection. Null while unknown or when the server has no AI
   * (404, an older server): every AI entry point is hidden then. Not persisted. Rows show the 「AI」 badge from it, so a
   * change moves rowsVersion.
   */
  aiStatus: AiStatusOut | null = null;
  setAiStatus(status: AiStatusOut | null): void {
    if (JSON.stringify(status) === JSON.stringify(this.aiStatus)) return;
    this.aiStatus = status;
    this.emitRows();
  }
  /** The AI agent whose bot user this is (bots of an unavailable AI included: their posts stay AI posts). */
  aiAgentOf(userId: string): AiAgentPublic | undefined {
    return this.aiStatus?.agents.find((agent) => agent.bot_user_id === userId);
  }
  setMe(me: UserMe | null): void {
    this.me = me;
    this.persist((p) => p.saveMeta("me", me ? JSON.stringify(me) : null));
    this.emitRows();
  }

  upsertUser(user: UserPublic): void {
    this.users.set(user.id, user);
    this.noteDndEnd(user.dnd_until);
    this.persist((p) => p.saveUser(user));
    this.emitRows();
  }

  // --- channels ---------------------------------------------------------------------------

  getChannel(id: string): ChannelState | undefined {
    return this.channels.get(id);
  }

  /** Merge server fields into the local channel, keeping the local cursor. */
  upsertChannel(channel: ChannelOut, patch: Partial<ChannelState> = {}): ChannelState {
    const existing = this.channels.get(channel.id);
    const merged: ChannelState = {
      ...channel,
      // Events carry no membership (only responses do): keep the one we know (e.g. my owner role).
      membership: channel.membership ?? existing?.membership ?? null,
      // Not every response counts members (M11h): keep the last known count.
      member_count: channel.member_count ?? existing?.member_count ?? null,
      // M49: only answers to a member carry the preview; null elsewhere means "not said", so the one held stays. Bootstrap
      // passes it in `patch`, where null does mean "no message" (SYNC_PROTOCOL.md §7.8).
      last_message: channel.last_message ?? existing?.last_message ?? null,
      isMember: existing?.isMember ?? channel.membership !== null,
      syncedSeq: existing?.syncedSeq ?? null,
      lastSeq: Math.max(existing?.lastSeq ?? 0, channel.last_seq),
      lastReadSeq: Math.max(existing?.lastReadSeq ?? 0, channel.read_state?.last_read_seq ?? 0),
      unreadCount: channel.read_state?.unread_count ?? existing?.unreadCount ?? 0,
      mentionCount: channel.read_state?.mention_count ?? existing?.mentionCount ?? 0,
      firstUnreadAt: channel.read_state ? (channel.read_state.first_unread_at ?? null) : (existing?.firstUnreadAt ?? null),
      pendingReadSeq: existing?.pendingReadSeq ?? null,
      hasOlder: existing?.hasOlder ?? true,
      oldestLoadedSeq: existing?.oldestLoadedSeq ?? null,
      // M35: the conversation's own level (null while it follows my overall setting) and both mutes.
      ...(channel.notification
        ? ownNotification(channel.notification)
        : { notificationLevel: existing?.notificationLevel ?? null, mutedUntil: existing?.mutedUntil ?? null, muted: existing?.muted ?? false }),
      ...patch,
    };
    this.channels.set(channel.id, merged);
    if (merged.oldestLoadedSeq !== (existing?.oldestLoadedSeq ?? null)) this.timelines.delete(channel.id);
    this.persist((p) => p.saveChannel(merged));
    this.emit();
    return merged;
  }

  /** The conversation's own level (null = follows my overall setting), timed mute and mute until unmuted (M35). */
  setNotification(channelId: string, level: NotificationLevel | null, mutedUntil: string | null, muted = false): void {
    this.updateChannel(channelId, { notificationLevel: level, mutedUntil, muted });
  }

  /** A preference as the server sends it (the PUT's response, notification_preference.updated). */
  applyNotificationPreference(
    pref: Pick<NotificationPreferenceOut, "channel_id" | "level"> & Partial<Pick<NotificationPreferenceOut, "muted_until" | "follows_default" | "muted">>,
  ): void {
    this.updateChannel(pref.channel_id, ownNotification(pref));
  }

  updateChannel(id: string, patch: Partial<ChannelState>): ChannelState | undefined {
    const existing = this.channels.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...patch };
    this.channels.set(id, merged);
    if (merged.oldestLoadedSeq !== existing.oldestLoadedSeq) this.timelines.delete(id);
    this.persist((p) => p.saveChannel(merged));
    this.emit();
    return merged;
  }

  /**
   * M49 (SYNC_PROTOCOL.md §7.8): a timeline message of one of my conversations moves its preview. A newer one takes its
   * place; the one shown, edited, brings its new text; the one shown, deleted, falls back to the newest row held below it.
   * When the rows held cannot say (no contiguous timeline down to it), the preview empties and `onStalePreview` asks the
   * server (GET /channels/{id}). Thread-only replies, pending sends and older rows (history pages, search hits) leave it.
   */
  applyLastMessage(message: PreviewSource & { channel_id: string; parent_id?: string | null; also_in_channel?: boolean; deleted?: boolean }): void {
    const seq = message.seq;
    if (seq === null || (message.parent_id && message.also_in_channel !== true)) return;
    const channel = this.channels.get(message.channel_id);
    if (!channel || !channel.isMember) return;
    const current = channel.last_message ?? null;
    if (message.deleted) {
      if (current?.id !== message.id) return;
      // The loaded range is contiguous up to syncedSeq (§7.3): its newest live row below is the newest there is.
      const timeline = channel.syncedSeq === null ? [] : this.messages(channel.id);
      let below: MessageState | undefined;
      for (let i = timeline.length - 1; i >= 0 && !below; i--) {
        const row = timeline[i]!;
        if (row.seq !== null && row.seq < seq && !row.deleted) below = row;
      }
      this.updateChannel(channel.id, { last_message: below ? lastMessageOf(below, this.users, this.groups) : null });
      if (!below && (channel.syncedSeq === null || channel.hasOlder)) this.onStalePreview?.(channel.id);
      return;
    }
    if (current && current.id !== message.id && current.seq >= seq) return;
    const next = lastMessageOf(message, this.users, this.groups);
    if (!sameLastMessage(current, next)) this.updateChannel(channel.id, { last_message: next });
  }

  /**
   * M49: the server's preview fetched after a deletion the rows held could not replace (GET /channels/{id}). A newer one
   * that came in the meantime (an event after the answer was made) stays.
   */
  setFetchedLastMessage(channelId: string, last: LastMessageOut | null): void {
    const current = this.channels.get(channelId)?.last_message ?? null;
    if (current && (!last || current.seq > last.seq)) return;
    if (!sameLastMessage(current, last)) this.updateChannel(channelId, { last_message: last });
  }

  removeChannel(id: string): void {
    this.channels.delete(id);
    this.messagesByChannel.delete(id);
    this.timelines.delete(id);
    // CANVAS.md §4.6: its canvases and their unsaved edits leave this device too.
    this.canvasLists.delete(id);
    for (const [canvasId, pending] of [...this.canvasPending]) if (pending.channelId === id) this.setPendingCanvas(canvasId, null);
    this.persist(async (p) => {
      await p.clearMessages(id);
      await p.deleteChannel(id);
    });
    this.emit();
  }

  // --- messages ---------------------------------------------------------------------------

  private bucket(channelId: string): Map<string, MessageState> {
    let bucket = this.messagesByChannel.get(channelId);
    if (!bucket) {
      bucket = new Map();
      this.messagesByChannel.set(channelId, bucket);
    }
    return bucket;
  }

  /**
   * The channel timeline: top-level messages and replies also sent to the channel (M15c), confirmed
   * by seq, then pending ones in creation order (SYNC_PROTOCOL.md §9). Only the loaded range is shown
   * (§7.3): older rows that arrived on their own (a reaction, a thread parent, a search hit) stay
   * stored but would leave a gap that paging never fills. The list is cached until the channel changes;
   * callers must not modify it.
   */
  messages(channelId: string): MessageState[] {
    let timeline = this.timelines.get(channelId);
    if (!timeline) {
      const oldest = this.channels.get(channelId)?.oldestLoadedSeq ?? null;
      const shown = (m: MessageState) => (!m.parent_id || m.also_in_channel === true) && (m.seq === null || (oldest !== null && m.seq >= oldest));
      timeline = this.ordered([...this.bucket(channelId).values()].filter(shown));
      this.timelines.set(channelId, timeline);
    }
    return timeline;
  }

  /** Every stored row of the channel that is pinned (M11c), loaded range or not. */
  pinned(channelId: string): MessageState[] {
    return [...this.bucket(channelId).values()].filter((m) => !!m.pinned_at);
  }

  message(channelId: string, id: string): MessageState | undefined {
    return this.bucket(channelId).get(id);
  }

  /** A thread: the replies of one parent, oldest first (pending ones last). */
  replies(channelId: string, parentId: string): MessageState[] {
    return this.ordered([...this.bucket(channelId).values()].filter((m) => m.parent_id === parentId));
  }

  private ordered(all: MessageState[]): MessageState[] {
    const confirmed = all.filter((m) => m.seq !== null).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const pending = all.filter((m) => m.seq === null).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return [...confirmed, ...pending];
  }

  /** A reply moved the parent's counters (message.created / message.deleted with parent_thread). */
  applyParentThread(channelId: string, thread: ParentThread): void {
    const bucket = this.bucket(channelId);
    const parent = bucket.get(thread.id);
    if (!parent || thread.updated_seq <= parent.updated_seq) return;
    const updated: MessageState = {
      ...parent,
      reply_count: thread.reply_count,
      last_reply_at: thread.last_reply_at,
      // C3: an older server sends no list; the parent keeps what it had.
      ...(thread.reply_user_ids ? { reply_user_ids: thread.reply_user_ids } : {}),
      updated_seq: thread.updated_seq,
    };
    bucket.set(parent.id, updated);
    this.timelines.delete(channelId);
    this.persist((p) => p.saveMessage(updated));
    this.emit();
  }

  getMessage(channelId: string, id: string): MessageState | undefined {
    return this.bucket(channelId).get(id);
  }

  // --- threads (THREADS.md §5) -----------------------------------------------------------

  // --- activity (M39, MOBILE_UI.md §7.2) -----------------------------------------------------

  /**
   * The server's activity summary (bootstrap `activity`, GET /activity/summary, PUT /activity/read). A summary behind the
   * read position held (a GET answered after a newer PUT) is stale and dropped: the position only moves forward. Null
   * (a server before M39, or bootstrap without it) leaves the badge to the stage-A rule (ui/mobileTabs.ts).
   */
  /** `activity.updated`: these items' excerpts are gone on the server (CANVAS.md §20.8). */
  eraseActivityExcerpts(itemIds: readonly string[]): void {
    if (itemIds.length === 0) return;
    this.erasedActivityItems = new Set([...this.erasedActivityItems, ...itemIds]);
    this.doneActivityItems = new Set([...this.doneActivityItems, ...itemIds]);
    this.activityEdits += 1;
    this.emit();
  }

  /** My read position in a thread moved (never down; see `threadReadSeqs`). */
  noteThreadRead(parentId: string, seq: number): void {
    if (seq <= (this.threadReadSeqs.get(parentId) ?? 0)) return;
    this.threadReadSeqs.set(parentId, seq);
    this.emit();
  }

  /** Activity items opened at `readAt` (a time only moves forward). */
  noteActivityItemsRead(itemIds: readonly string[], readAt: string): void {
    const next = new Map(this.openedActivityItems);
    let changed = false;
    for (const id of itemIds) {
      const held = next.get(id);
      if (held && Date.parse(held) >= Date.parse(readAt)) continue;
      next.set(id, readAt);
      changed = true;
    }
    if (!changed) return;
    this.openedActivityItems = next;
    this.emit();
  }

  /** A read position went back: the activity list, whose `read` flags came from the server, loads again. */
  reloadActivity(): void {
    this.activityReloads += 1;
    this.emit();
  }

  setActivity(summary: ActivitySummaryOut | null): void {
    const current = this.activity;
    if (summary && current && Date.parse(summary.read_at) < Date.parse(current.read_at)) return;
    if (summary && current && summary.read_at === current.read_at && summary.unread_count === current.unread_count && summary.mention_unread === current.mention_unread) return;
    this.activity = summary;
    this.persist((p) => p.saveMeta("activity", summary ? JSON.stringify(summary) : null));
    this.emit();
  }

  /** M88: bootstrap's (none from a server before M88: the defaults) or the event's settings. */
  setWorkspaceSettings(settings: WorkspaceSettingsOut | null | undefined): void {
    const next = { ...DEFAULT_WORKSPACE_SETTINGS, ...(settings ?? {}) };
    const current = this.workspaceSettings;
    const same = next.show_membership_messages === current.show_membership_messages && next.preview_before_join === current.preview_before_join && next.icon_version === current.icon_version;
    if (same && next.calls_enabled === current.calls_enabled && next.meeting_base_url === current.meeting_base_url) return;
    this.workspaceSettings = next;
    this.emit();
  }

  setThreadSummary(summary: ThreadSummary): void {
    if (summary.unread_count === this.threadSummary.unread_count && summary.mention_count === this.threadSummary.mention_count) return;
    this.threadSummary = summary;
    this.emit();
  }

  /**
   * A page of GET /threads. Rows are merged so an open thread keeps its state across filter changes
   * and refreshes; on a first page, rows the server would have listed but did not (unfollowed or
   * deleted elsewhere) are dropped.
   */
  setThreadPage(filter: ThreadFilter, items: ThreadItem[], cursor: string | null, options: { append: boolean; pageSize: number }): void {
    if (!options.append) {
      const listed = new Set(items.map((i) => i.parent.id));
      const full = items.length >= options.pageSize;
      const oldest = full ? (items[items.length - 1]?.state.last_reply_at ?? "") : "";
      for (const [id, entry] of this.threads) {
        if (listed.has(id) || !entry.state.following) continue;
        if (filter === "unread" && entry.state.unread_count === 0) continue;
        if ((entry.state.last_reply_at ?? "") >= oldest) this.threads.delete(id);
      }
    }
    // A server before the previews sends no latest_replies: the card stays the parent only.
    for (const item of items) this.threads.set(item.parent.id, { parent: item.parent, state: item.state, latestReplies: (item as Partial<ThreadItem>).latest_replies });
    this.threadsFilter = filter;
    this.threadsLoaded = true;
    this.threadsCursor = cursor;
    this.threadsHasMore = items.length >= options.pageSize;
    this.emit();
  }

  /**
   * A reply of a listed thread arrived, changed or went (message.created / updated / deleted, my own sends' answers): the
   * card's preview keeps the newest THREAD_PREVIEW_REPLIES live replies without fetching the list again. A reply that
   * left the preview is replaced from the thread's replies held here, if any (else the list's next fetch fills it).
   * Replies of people I blocked stay out, as the server leaves them out.
   */
  private applyThreadPreview(message: MessageState): void {
    if (!message.parent_id || message.seq === null) return;
    const entry = this.threads.get(message.parent_id);
    if (!entry?.latestReplies) return;
    const shown = entry.latestReplies;
    const held = shown.some((r) => r.id === message.id);
    const visible = !message.deleted && !this.blockedUsers.has(message.sender_id);
    if (!held && !visible) return;
    let next = shown.filter((r) => r.id !== message.id);
    if (visible) next.push(message);
    const live = (r: MessageState) => r.seq !== null && !r.deleted && !this.blockedUsers.has(r.sender_id);
    if (next.length < THREAD_PREVIEW_REPLIES) {
      const ids = new Set(next.map((r) => r.id));
      next.push(...this.replies(message.channel_id, message.parent_id).filter((r) => live(r) && !ids.has(r.id) && r.id !== message.id));
    }
    next = next.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).slice(-THREAD_PREVIEW_REPLIES);
    if (next.length === shown.length && next.every((r, i) => r === shown[i])) return;
    this.threads.set(entry.parent.id, { ...entry, latestReplies: next });
  }

  /** thread.updated / a PUT response: replace the state; the badge moves with it when the old state is known. */
  applyThreadState(state: ThreadState, parent?: MessageOut): void {
    if (state.last_read_seq > (this.threadReadSeqs.get(state.parent_id) ?? 0)) this.threadReadSeqs.set(state.parent_id, state.last_read_seq);
    const entry = this.threads.get(state.parent_id);
    const before = entry?.state;
    if (entry) {
      entry.state = state;
      entry.parent = { ...entry.parent, reply_count: state.reply_count, last_reply_at: state.last_reply_at };
    } else {
      const known: MessageState | undefined = parent ?? this.bucket(state.channel_id).get(state.parent_id);
      if (known && known.seq !== null && !known.pending) this.threads.set(state.parent_id, { parent: { ...(known as MessageOut), reply_count: state.reply_count, last_reply_at: state.last_reply_at }, state });
    }
    if (before) {
      const unread = (state.following && state.unread_count > 0 ? 1 : 0) - (before.following && before.unread_count > 0 ? 1 : 0);
      const mention = (state.following && state.mention_count > 0 ? 1 : 0) - (before.following && before.mention_count > 0 ? 1 : 0);
      this.threadSummary = {
        unread_count: Math.max(0, this.threadSummary.unread_count + unread),
        mention_count: Math.max(0, this.threadSummary.mention_count + mention),
      };
    }
    this.emit();
  }

  /**
   * 「すべて既読にする」 of the threads list before the server answers (THREADS.md §3.2): every held followed row is
   * read to the newest reply held here (never backwards) with no unread, and the badge is 0. Returns what
   * `restoreThreadsRead` puts back when the call fails.
   */
  markAllThreadsReadLocally(): ThreadsReadUndo {
    const rows = new Map<string, { before: ThreadState; after: ThreadState }>();
    for (const [id, entry] of this.threads) {
      if (!entry.state.following) continue;
      const held = [...this.replies(entry.state.channel_id, id), ...(entry.latestReplies ?? [])].map((r) => r.seq ?? 0);
      const lastReadSeq = Math.max(entry.state.last_read_seq, ...held);
      if (lastReadSeq === entry.state.last_read_seq && entry.state.unread_count === 0 && entry.state.mention_count === 0) continue;
      const after = { ...entry.state, last_read_seq: lastReadSeq, unread_count: 0, mention_count: 0 };
      rows.set(id, { before: entry.state, after });
      entry.state = after;
    }
    const undo = { rows, summary: this.threadSummary };
    this.threadSummary = { unread_count: 0, mention_count: 0 };
    this.emit();
    return undo;
  }

  /** The read-all was refused: rows (and the badge) nothing else changed meanwhile go back as they were. */
  restoreThreadsRead(undo: ThreadsReadUndo): void {
    for (const [id, { before, after }] of undo.rows) {
      const entry = this.threads.get(id);
      if (entry && entry.state === after) entry.state = before;
    }
    if (this.threadSummary.unread_count === 0 && this.threadSummary.mention_count === 0) this.threadSummary = undo.summary;
    this.emit();
  }

  // --- custom emoji (M12f) -----------------------------------------------------------------

  replaceCustomEmoji(rows: CustomEmojiOut[]): void {
    this.customEmoji.clear();
    for (const row of rows) this.customEmoji.set(row.name, row);
    this.emitRows();
  }

  replaceEmojiPacks(rows: EmojiPackOut[]): void {
    this.emojiPacks.clear();
    for (const row of rows) this.emojiPacks.set(row.id, row);
    this.emitRows();
  }

  /** emoji_pack.updated: a deleted pack's emoji become ungrouped (their emoji.updated follow too). */
  applyEmojiPack(row: EmojiPackOut, deleted: boolean): void {
    if (deleted) {
      this.emojiPacks.delete(row.id);
      for (const emoji of this.customEmoji.values()) if (emoji.pack_id === row.id) this.customEmoji.set(emoji.name, { ...emoji, pack_id: null });
    } else this.emojiPacks.set(row.id, row);
    this.emitRows();
  }

  /** The packs in tab order (position, then name). */
  sortedEmojiPacks(): EmojiPackOut[] {
    return [...this.emojiPacks.values()].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  applyCustomEmoji(row: CustomEmojiOut, deleted: boolean): void {
    if (deleted) this.customEmoji.delete(row.name);
    else this.customEmoji.set(row.name, row);
    this.emitRows();
  }

  // --- sidebar sections (M14f) -------------------------------------------------------------

  replaceSidebar(rows: SidebarSectionOut[]): void {
    this.sidebarSections = [...rows].sort((a, b) => a.position - b.position);
    this.emit();
  }

  replaceSidebarDefaults(rows: SidebarDefaultOut[]): void {
    this.sidebarDefaults = [...rows];
    this.emit();
  }

  /** The id of my section the conversation sits in, if any. */
  sectionOf(channelId: string): string | null {
    return this.sidebarSections.find((section) => section.channel_ids.includes(channelId))?.id ?? null;
  }

  // --- post templates (M30) -----------------------------------------------------------------

  replaceTemplates(rows: TemplateOut[]): void {
    this.templates.clear();
    for (const row of rows) this.templates.set(row.id, row);
    this.emit();
  }

  /** template.updated (or my own save): replace by id, or remove it. */
  applyTemplate(row: TemplateOut, deleted: boolean): void {
    if (deleted) this.templates.delete(row.id);
    else this.templates.set(row.id, row);
    this.emit();
  }

  // --- lab roster (M23) ---------------------------------------------------------------------

  replaceRoster(rows: LabProfileOut[]): void {
    this.roster.clear();
    for (const row of rows) this.roster.set(row.user_id, row);
    this.emit();
  }

  /** roster.updated (or my own save): the person's line, or null when they left the roster. */
  applyRoster(userId: string, profile: LabProfileOut | null): void {
    if (profile) this.roster.set(userId, profile);
    else this.roster.delete(userId);
    this.emit();
  }

  // --- user groups (M12k) ------------------------------------------------------------------

  replaceGroups(rows: GroupOut[]): void {
    this.groups.clear();
    for (const row of rows) this.groups.set(row.id, row);
    this.emitRows();
  }

  applyGroup(row: GroupOut, deleted: boolean): void {
    if (deleted) this.groups.delete(row.id);
    else this.groups.set(row.id, row);
    this.emitRows();
  }

  // --- reminders (M12e) --------------------------------------------------------------------

  /** Fired first (newest nudge on top), then pending by time. */
  listReminders(): ReminderOut[] {
    return [...this.reminders.values()].sort((a, b) => {
      if (a.status !== b.status) return a.status === "fired" ? -1 : 1;
      return a.status === "fired" ? b.remind_at.localeCompare(a.remind_at) : a.remind_at.localeCompare(b.remind_at);
    });
  }

  firedReminderCount(): number {
    let n = 0;
    for (const row of this.reminders.values()) if (row.status === "fired") n += 1;
    return n;
  }

  replaceReminders(rows: ReminderOut[]): void {
    this.reminders.clear();
    for (const row of rows) if (row.status === "pending" || row.status === "fired") this.reminders.set(row.id, row);
    this.emit();
  }

  applyReminder(row: ReminderOut): void {
    if (row.status === "pending" || row.status === "fired") this.reminders.set(row.id, row);
    else this.reminders.delete(row.id);
    this.emit();
  }

  // --- scheduled messages (M12d) -----------------------------------------------------------

  /** Failed rows first (they need the reader), then the pending ones by time. */
  listScheduled(): ScheduledOut[] {
    return [...this.scheduled.values()].sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed") || a.send_at.localeCompare(b.send_at));
  }

  replaceScheduled(rows: ScheduledOut[]): void {
    this.scheduled.clear();
    for (const row of rows) if (keptScheduled(row)) this.scheduled.set(row.id, row);
    this.emit();
  }

  /**
   * scheduled.updated: pending rows are kept, and failed ones too until dismissed (their text is only there, Codex
   * audit C3; SYNC_PROTOCOL.md §6); sent and cancelled rows drop.
   */
  applyScheduled(row: ScheduledOut): void {
    if (keptScheduled(row)) this.scheduled.set(row.id, row);
    else this.scheduled.delete(row.id);
    this.emit();
  }

  // --- favorites (M12a) --------------------------------------------------------------------

  isFavorite(channelId: string): boolean {
    return this.favorites.has(channelId);
  }

  setFavorite(channelId: string, on: boolean): void {
    if (on ? this.favorites.has(channelId) : !this.favorites.has(channelId)) return;
    if (on) this.favorites.add(channelId);
    else this.favorites.delete(channelId);
    this.emit();
  }

  replaceFavorites(ids: string[]): void {
    this.favorites.clear();
    for (const id of ids) this.favorites.add(id);
    this.emit();
  }

  // --- DM pins (M118) ----------------------------------------------------------------------

  isDmPinned(channelId: string): boolean {
    return this.dmPins?.includes(channelId) ?? false;
  }

  /** dm_pin.updated: a new pin goes last (one already there keeps its place); an unpin leaves the others in order. */
  setDmPinned(channelId: string, on: boolean): void {
    const pins = this.dmPins ?? [];
    if (on === pins.includes(channelId)) return;
    this.dmPins = on ? [...pins, channelId] : pins.filter((id) => id !== channelId);
    this.emit();
  }

  /** Review v0.1.43 #7: a refused close puts back its own pin only (its place before, or out); the others stay. */
  restoreDmPin(channelId: string, place: number | null): void {
    const pins = this.dmPins;
    if (pins === null) return;
    const next = restoredDmPins(pins, channelId, place);
    if (next.length === pins.length && next.every((id, i) => id === pins[i])) return;
    this.dmPins = next;
    this.emit();
  }

  /** Bootstrap's `dm_pins` (null from a server before M118); also puts a rolled-back order back as it was. */
  replaceDmPins(ids: readonly string[] | null): void {
    this.dmPins = ids ? [...ids] : null;
    this.emit();
  }

  // --- closed DMs (M141) --------------------------------------------------------------------

  isDmClosed(channelId: string): boolean {
    return this.closedDms?.has(channelId) ?? false;
  }

  /** dm_close.updated, a timeline message (opens it), my own close / reopen. Nothing when the server has no closes. */
  setDmClosed(channelId: string, closed: boolean): void {
    const set = this.closedDms;
    if (!set || closed === set.has(channelId)) return;
    const next = new Set(set);
    if (closed) next.add(channelId);
    else next.delete(channelId);
    this.closedDms = next;
    this.emit();
  }

  /** Bootstrap's `closed_dms` (null from a server before M141); also puts a rolled-back set back as it was. */
  replaceClosedDms(ids: Iterable<string> | null): void {
    this.closedDms = ids ? new Set(ids) : null;
    this.emit();
  }

  // --- blocks (M104) ------------------------------------------------------------------------

  isBlocked(userId: string): boolean {
    return this.blockedUsers.has(userId);
  }

  setBlocked(userId: string, on: boolean): void {
    if (on ? this.blockedUsers.has(userId) : !this.blockedUsers.has(userId)) return;
    if (on) this.blockedUsers.add(userId);
    else this.blockedUsers.delete(userId);
    this.emit();
  }

  replaceBlocked(ids: string[]): void {
    this.blockedUsers.clear();
    for (const id of ids) this.blockedUsers.add(id);
    this.emit();
  }

  // --- bookmarks (M11c) --------------------------------------------------------------------

  isBookmarked(messageId: string): boolean {
    return this.bookmarks.has(messageId);
  }

  setBookmarked(messageId: string, on: boolean): void {
    if (on ? this.bookmarks.has(messageId) : !this.bookmarks.has(messageId)) return;
    if (on) this.bookmarks.add(messageId);
    else this.bookmarks.delete(messageId);
    this.emit();
  }

  replaceBookmarks(ids: string[]): void {
    this.bookmarks.clear();
    for (const id of ids) this.bookmarks.add(id);
    this.emit();
  }

  // --- presence / typing (volatile, SYNC_PROTOCOL.md §5.2) ---------------------------------

  /** What avatars show (docs/PRESENCE.md §11): 取り込み中 while the person's dnd_until is ahead, else the frames' status. */
  presenceOf(userId: string, now = Date.now()): PresenceLook {
    return presenceLook(this.connectionOf(userId), this.users.get(userId), now);
  }

  /** The `presence` frames' status alone (online / away / offline). */
  connectionOf(userId: string): PresenceStatus {
    return this.presence.get(userId) ?? "offline";
  }

  /**
   * 取り込み中 ends by the clock, with no event: redraw when the soonest dnd_until passes (one timer for everyone; a
   * far one re-arms after a day; the indefinite pause never ends by itself).
   */
  private dndTimer: ReturnType<typeof setTimeout> | null = null;
  private dndTimerAt = Number.POSITIVE_INFINITY;
  private noteDndEnd(until: string | null | undefined): void {
    if (!until || isIndefiniteDnd(until)) return;
    const at = Date.parse(until);
    const now = Date.now();
    if (Number.isNaN(at) || at <= now || at >= this.dndTimerAt) return;
    if (this.dndTimer) clearTimeout(this.dndTimer);
    this.dndTimerAt = at;
    this.dndTimer = setTimeout(() => {
      this.dndTimer = null;
      this.dndTimerAt = Number.POSITIVE_INFINITY;
      for (const user of this.users.values()) this.noteDndEnd(user.dnd_until);
      this.emitRows();
    }, Math.min(at - now + 50, 24 * 60 * 60 * 1000));
  }

  setPresence(userId: string, status: PresenceStatus): void {
    if (this.connectionOf(userId) === status) return;
    if (status === "offline") this.presence.delete(userId);
    else this.presence.set(userId, status);
    this.emit();
  }

  /** bootstrap: the full picture; everyone not listed is offline. */
  replacePresence(entries: PresenceEntry[]): void {
    this.presence.clear();
    for (const entry of entries) if (entry.status !== "offline") this.presence.set(entry.user_id, entry.status);
    this.emit();
  }

  private typingKey(channelId: string, parentId: string | null): string {
    return parentId ? `${channelId}:${parentId}` : channelId;
  }

  noteTyping(channelId: string, parentId: string | null, userId: string, until: number): void {
    const key = this.typingKey(channelId, parentId);
    const users = this.typing.get(key) ?? new Map<string, number>();
    const now = Date.now();
    for (const [other, expiry] of users) if (expiry <= now) users.delete(other); // keep the map small
    users.set(userId, until);
    this.typing.set(key, users);
    this.emit();
  }

  /** The user posted (or stopped): their indicator goes away at once. */
  clearTyping(channelId: string, parentId: string | null, userId: string): void {
    const users = this.typing.get(this.typingKey(channelId, parentId));
    if (!users?.delete(userId)) return;
    this.emit();
  }

  /** M72: a `canvas_presence` frame from someone else (true for 45 s unless refreshed, false ends it). */
  noteCanvasEditing(canvasId: string, userId: string, editing: boolean, section: string | null, now: number = Date.now()): void {
    if (this.canvasEditing.note(canvasId, userId, editing, section, now)) this.emit();
  }

  /** M72: who edits the canvas now; pure (called during render), expired entries are skipped. */
  canvasEditors(canvasId: string, now: number): CanvasEditor[] {
    return this.canvasEditing.of(canvasId, now);
  }

  /** Users typing in this conversation right now; pure (called during render), expired entries are skipped. */
  typingUsers(channelId: string, parentId: string | null, now: number): string[] {
    const users = this.typing.get(this.typingKey(channelId, parentId));
    if (!users) return [];
    return [...users].filter(([, until]) => until > now).map(([userId]) => userId);
  }

  /** The rows of the threads view: followed, newest reply first, unread only when that filter is on. */
  threadList(filter: ThreadFilter = this.threadsFilter): ThreadEntry[] {
    return [...this.threads.values()]
      .filter((e) => e.state.following && (filter === "all" || e.state.unread_count > 0))
      .sort((a, b) => (b.state.last_reply_at ?? "").localeCompare(a.state.last_reply_at ?? "") || b.parent.seq - a.parent.seq);
  }

  /**
   * The merge rule (SYNC_PROTOCOL.md §8): newer updated_seq wins; tombstones delete. The exception is a poll's `mine`
   * (M27): only responses to me carry it, events carry null. A row without it keeps the one known here, and a response
   * with the same updated_seq as the row held (my vote's answer after its own event) still brings it in.
   */
  upsertMessage(message: MessageState): boolean {
    const bucket = this.bucket(message.channel_id);
    if (message.client_msg_id) {
      const placeholder = LOCAL_PREFIX + message.client_msg_id;
      if (bucket.delete(placeholder)) {
        this.timelines.delete(message.channel_id);
        this.persist((p) => p.deleteMessage(placeholder));
      }
    }
    const local = bucket.get(message.id);
    if (local && message.updated_seq <= local.updated_seq) {
      if (message.updated_seq !== local.updated_seq || !message.poll || !local.poll) return false;
      const poll = withMyPart(local.poll, message.poll);
      if (!poll) return false;
      message = { ...local, poll };
    } else if (message.poll && local?.poll) {
      // M27 / M53: what only responses to me carry stays when an event (null) brings the rest.
      message = { ...message, poll: keepMyPart(message.poll, local.poll) };
    }
    const stored = message;
    this.timelines.delete(stored.channel_id);
    // History pages bring no tombstones, so one not held is a deletion (an event, a catch-up, my own delete's answer).
    if (!!stored.pinned_at !== !!local?.pinned_at || (stored.deleted && !local)) this.pinRevisions.set(stored.channel_id, this.pinsRevision(stored.channel_id) + 1);
    if (stored.deleted) {
      bucket.delete(stored.id);
      this.persist((p) => p.deleteMessage(stored.id));
      if (!stored.parent_id) this.forgetThread(stored.channel_id, stored.id);
    } else {
      bucket.set(stored.id, stored);
      this.persist((p) => p.saveMessage(stored));
    }
    this.applyLastMessage(stored); // M49: events, catch-up pages and my own edits / deletes alike
    this.applyThreadPreview(stored);
    this.onMessageStored?.(stored, !local);
    this.emit();
    return true;
  }

  /** True once this session saw the message deleted (THREADS.md §5 「元のメッセージの削除」). */
  wasDeleted(messageId: string): boolean {
    return this.deletedIds.has(messageId);
  }

  /**
   * A thread whose root is gone (deleted, or GET replies answered 404): its row leaves the threads list at once (the
   * server's list leaves deleted roots out) and the reply draft for it goes (the server hides and refuses it).
   */
  forgetThread(channelId: string, rootId: string): void {
    this.deletedIds.add(rootId);
    this.threads.delete(rootId);
    const key = this.draftKey(channelId, rootId);
    if (this.drafts.has(key)) {
      this.drafts.delete(key);
      this.persist((p) => p.saveMeta(key, null));
    }
    this.emit();
  }

  /**
   * The answer to my own vote or close (SYNC_PROTOCOL.md §8, M27): its `mine` goes in whatever the order. Another
   * member's vote event may have come first with a newer updated_seq, and the merge above then drops the answer.
   */
  setMyVotes(message: MessageState): void {
    this.onMyVotes?.(message);
    const local = this.bucket(message.channel_id).get(message.id);
    if (!message.poll || !local?.poll) return;
    const poll = withMyPart(local.poll, message.poll);
    if (!poll) return;
    const stored = { ...local, poll };
    this.bucket(stored.channel_id).set(stored.id, stored);
    this.timelines.delete(stored.channel_id);
    this.persist((p) => p.saveMessage(stored));
    this.emit();
  }

  putPlaceholder(message: MessageState): void {
    this.bucket(message.channel_id).set(message.id, message);
    this.timelines.delete(message.channel_id);
    this.persist((p) => p.saveMessage(message));
    this.emit();
  }

  /** Drops the channel's messages (a reload from the latest page); pending sends stay with their outbox items. */
  clearMessages(channelId: string): void {
    const pending = [...this.bucket(channelId).values()].filter((m) => m.seq === null);
    this.messagesByChannel.delete(channelId);
    this.timelines.delete(channelId);
    for (const message of pending) this.bucket(channelId).set(message.id, message);
    this.persist(async (p) => {
      await p.clearMessages(channelId);
      for (const message of pending) await p.saveMessage(message);
    });
    this.emit();
  }

  // --- outbox -----------------------------------------------------------------------------

  addOutbox(item: OutboxItem): void {
    this.outbox.push(item);
    this.persist((p) => p.saveOutbox(item));
    this.emit();
  }

  removeOutbox(clientMsgId: string): void {
    const index = this.outbox.findIndex((i) => i.client_msg_id === clientMsgId);
    if (index >= 0) this.outbox.splice(index, 1);
    this.persist((p) => p.deleteOutbox(clientMsgId));
    this.emit();
  }

  /** A send refused for good: the item is skipped and its placeholder offers retry / discard, also after a restart. */
  markOutboxFailed(clientMsgId: string, reason: string): void {
    this.setOutboxFailure(clientMsgId, reason);
  }

  /** 「再送」: the item goes back into the queue. */
  clearOutboxFailed(clientMsgId: string): void {
    this.setOutboxFailure(clientMsgId, null);
  }

  private setOutboxFailure(clientMsgId: string, reason: string | null): void {
    const item = this.outbox.find((i) => i.client_msg_id === clientMsgId);
    if (!item) return;
    if (reason === null) delete item.failed;
    else item.failed = reason;
    this.persist((p) => p.saveOutbox(item));
    const bucket = this.bucket(item.channel_id);
    const placeholder = bucket.get(LOCAL_PREFIX + clientMsgId);
    if (placeholder) {
      const updated: MessageState = { ...placeholder, failed: reason !== null };
      bucket.set(updated.id, updated);
      this.timelines.delete(item.channel_id);
      this.persist((p) => p.saveMessage(updated));
    }
    this.emit();
  }

  /** Persisted state for tests / diagnostics. */
  snapshot(): Snapshot {
    return {
      meta: { ...Object.fromEntries([...this.drafts].map(([key, value]) => [key, JSON.stringify(value)])), ...(this.me ? { me: JSON.stringify(this.me) } : {}), ...(this.activity ? { activity: JSON.stringify(this.activity) } : {}) },
      users: [...this.users.values()],
      channels: [...this.channels.values()],
      messages: [...this.messagesByChannel.values()].flatMap((b) => [...b.values()]),
      outbox: [...this.outbox],
    };
  }

  static fromSnapshot(snapshot: Snapshot, persistence: Persistence | null = null): Store {
    const store = new Store(persistence);
    store.restore(snapshot);
    return store;
  }
}

/** A conversation's canvases, most recently updated first (as GET /channels/{id}/canvases lists them). */
function sortCanvases(list: CanvasMeta[]): CanvasMeta[] {
  return [...list].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id < b.id ? 1 : -1));
}

/** A channel row as persisted; rows from older versions lack the §7.3 range, the §10 unsent mark and the §10.1 time. */
function restoredChannel(row: ChannelState): ChannelState {
  const channel: ChannelState = { ...row, pendingReadSeq: row.pendingReadSeq ?? null, firstUnreadAt: row.firstUnreadAt ?? null, muted: row.muted ?? false };
  if ((row as Partial<ChannelState>).oldestLoadedSeq === undefined) {
    // Fully paged back: the range starts at 0. Otherwise the range is unknown: reload the latest page.
    channel.oldestLoadedSeq = row.syncedSeq !== null && !row.hasOlder ? 0 : null;
    if (channel.oldestLoadedSeq === null) channel.syncedSeq = null;
  }
  return channel;
}

/** The same poll options (my votes), in any order; null / missing counts as unknown, which is never the same. */
function sameOptions(a: readonly number[] | null | undefined, b: readonly number[]): boolean {
  if (a == null || a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((option) => set.has(option));
}

/** A poll's fields only responses to me carry (events: null): `mine` (M27), `my_answers` and `my_comment` (M53). */
type MyPart = Pick<PollOut, "mine" | "my_answers" | "my_comment">;

/** `incoming` with the parts it lacks (null) taken from `local`. */
export function keepMyPart(incoming: PollOut, local: PollOut): PollOut {
  const kept: MyPart = {};
  if (incoming.mine == null && local.mine != null) kept.mine = local.mine;
  if (incoming.my_answers == null && local.my_answers != null) kept.my_answers = local.my_answers;
  if (incoming.my_comment == null && local.my_comment != null) kept.my_comment = local.my_comment;
  return Object.keys(kept).length > 0 ? { ...incoming, ...kept } : incoming;
}

/** `local` with the parts `response` carries, or null when they change nothing. */
export function withMyPart(local: PollOut, response: PollOut): PollOut | null {
  const changed: MyPart = {};
  if (response.mine != null && !sameOptions(local.mine, response.mine)) changed.mine = response.mine;
  if (response.my_answers != null && JSON.stringify(response.my_answers) !== JSON.stringify(local.my_answers ?? null)) changed.my_answers = response.my_answers;
  if (response.my_comment != null && response.my_comment !== local.my_comment) changed.my_comment = response.my_comment;
  return Object.keys(changed).length > 0 ? { ...local, ...changed } : null;
}

function keptScheduled(row: ScheduledOut): boolean {
  return row.status === "pending" || row.status === "failed";
}
