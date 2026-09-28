import type { AttachmentOut, ChannelLinkOut, ChannelOut, ChannelState, CustomEmojiOut, GroupOut, MessageOut, SidebarSectionOut, MessageState, NotificationLevel, OutboxItem, ParentThread, PresenceEntry, PresenceStatus, ReminderOut, ScheduledOut, ThreadEntry, ThreadFilter, ThreadItem, ThreadState, ThreadSummary, UserMe, UserPublic } from "./types";
import type { LabProfileOut } from "../api/types";
import { LOCAL_PREFIX } from "./types";

/** Write-through persistence (SQLite in Tauri). Everything is also kept in memory. */
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

export function emptySnapshot(): Snapshot {
  return { meta: {}, users: [], channels: [], messages: [], outbox: [] };
}

/**
 * At most this many messages are kept per channel (M22, SYNC_PROTOCOL.md §7.7): the newest ones (pending sends always
 * stay). Older history is paged in again when the reader scrolls up.
 */
export const CACHED_MESSAGES_PER_CHANNEL = 500;

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
  threadsFilter: ThreadFilter = "all";
  threadsLoaded = false;
  threadsCursor: string | null = null;
  threadsHasMore = false;
  /** Who is connected right now (SYNC_PROTOCOL.md §5.2); absent = offline. Replaced by bootstrap. */
  readonly presence = new Map<string, PresenceStatus>();
  /** "channel[:parent]" → user id → expiry (ms); volatile typing indicators. */
  readonly typing = new Map<string, Map<string, number>>();
  /** My saved message ids (M11c); from bookmark and bookmark.updated, not persisted. */
  readonly bookmarks = new Set<string>();
  /** My starred channel ids (M12a); from bootstrap and favorite.updated, not persisted. */
  readonly favorites = new Set<string>();
  /** My pending scheduled messages (M12d); from GET /scheduled and scheduled.updated, not persisted. */
  readonly scheduled = new Map<string, ScheduledOut>();
  /** My open reminders (M12e): fired ones wait for 完了, pending ones for their time. */
  readonly reminders = new Map<string, ReminderOut>();
  /** Custom emoji by name (M12f); from bootstrap and emoji.updated, not persisted. */
  readonly customEmoji = new Map<string, CustomEmojiOut>();
  /** User groups by id (M12k); from bootstrap and group.updated. `@name` expands on the server. */
  readonly groups = new Map<string, GroupOut>();
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
  /** My sidebar sections (M14f), in order; from bootstrap and sidebar.updated. */
  sidebarSections: SidebarSectionOut[] = [];
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
    }
  }
  flushPersistence(): Promise<void> { return this.writeQueue; }
  private readonly messagesByChannel = new Map<string, Map<string, MessageState>>();
  /** The sorted timeline of each channel, rebuilt only after its rows or its range change. */
  private readonly timelines = new Map<string, MessageState[]>();
  private readonly listeners = new Set<() => void>();
  /** Set by wipe(): nothing is written any more. */
  private closed = false;

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
    for (const user of snapshot.users) this.users.set(user.id, user);
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
    if (persistence && !this.closed) this.writeQueue = this.writeQueue.then(() => work(persistence)).catch((err: unknown) => console.error("persist failed", err));
  }

  // --- me / users -------------------------------------------------------------------------

  setMe(me: UserMe | null): void {
    this.me = me;
    this.persist((p) => p.saveMeta("me", me ? JSON.stringify(me) : null));
    this.emitRows();
  }

  upsertUser(user: UserPublic): void {
    this.users.set(user.id, user);
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
      notificationLevel: channel.notification?.level ?? existing?.notificationLevel ?? null,
      mutedUntil: channel.notification ? (channel.notification.muted_until ?? null) : (existing?.mutedUntil ?? null),
      ...patch,
    };
    this.channels.set(channel.id, merged);
    if (merged.oldestLoadedSeq !== (existing?.oldestLoadedSeq ?? null)) this.timelines.delete(channel.id);
    this.persist((p) => p.saveChannel(merged));
    this.emit();
    return merged;
  }

  setNotification(channelId: string, level: NotificationLevel, mutedUntil: string | null): void {
    this.updateChannel(channelId, { notificationLevel: level, mutedUntil });
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

  removeChannel(id: string): void {
    this.channels.delete(id);
    this.messagesByChannel.delete(id);
    this.timelines.delete(id);
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
    const updated: MessageState = { ...parent, reply_count: thread.reply_count, last_reply_at: thread.last_reply_at, updated_seq: thread.updated_seq };
    bucket.set(parent.id, updated);
    this.timelines.delete(channelId);
    this.persist((p) => p.saveMessage(updated));
    this.emit();
  }

  getMessage(channelId: string, id: string): MessageState | undefined {
    return this.bucket(channelId).get(id);
  }

  // --- threads (THREADS.md §5) -----------------------------------------------------------

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
    for (const item of items) this.threads.set(item.parent.id, { parent: item.parent, state: item.state });
    this.threadsFilter = filter;
    this.threadsLoaded = true;
    this.threadsCursor = cursor;
    this.threadsHasMore = items.length >= options.pageSize;
    this.emit();
  }

  /** thread.updated / a PUT response: replace the state; the badge moves with it when the old state is known. */
  applyThreadState(state: ThreadState, parent?: MessageOut): void {
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

  // --- custom emoji (M12f) -----------------------------------------------------------------

  replaceCustomEmoji(rows: CustomEmojiOut[]): void {
    this.customEmoji.clear();
    for (const row of rows) this.customEmoji.set(row.name, row);
    this.emitRows();
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

  /** The id of my section the conversation sits in, if any. */
  sectionOf(channelId: string): string | null {
    return this.sidebarSections.find((section) => section.channel_ids.includes(channelId))?.id ?? null;
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

  presenceOf(userId: string): PresenceStatus {
    return this.presence.get(userId) ?? "offline";
  }

  setPresence(userId: string, status: PresenceStatus): void {
    if (this.presenceOf(userId) === status) return;
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

  /** The merge rule (SYNC_PROTOCOL.md §8): newer updated_seq wins; tombstones delete. */
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
    if (local && message.updated_seq <= local.updated_seq) return false;
    this.timelines.delete(message.channel_id);
    if (message.deleted) {
      bucket.delete(message.id);
      this.persist((p) => p.deleteMessage(message.id));
    } else {
      bucket.set(message.id, message);
      this.persist((p) => p.saveMessage(message));
    }
    this.emit();
    return true;
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
      meta: { ...Object.fromEntries([...this.drafts].map(([key, value]) => [key, JSON.stringify(value)])), ...(this.me ? { me: JSON.stringify(this.me) } : {}) },
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

/** A channel row as persisted; rows from older versions lack the §7.3 range, the §10 unsent mark and the §10.1 time. */
function restoredChannel(row: ChannelState): ChannelState {
  const channel: ChannelState = { ...row, pendingReadSeq: row.pendingReadSeq ?? null, firstUnreadAt: row.firstUnreadAt ?? null };
  if ((row as Partial<ChannelState>).oldestLoadedSeq === undefined) {
    // Fully paged back: the range starts at 0. Otherwise the range is unknown: reload the latest page.
    channel.oldestLoadedSeq = row.syncedSeq !== null && !row.hasOlder ? 0 : null;
    if (channel.oldestLoadedSeq === null) channel.syncedSeq = null;
  }
  return channel;
}

function keptScheduled(row: ScheduledOut): boolean {
  return row.status === "pending" || row.status === "failed";
}
