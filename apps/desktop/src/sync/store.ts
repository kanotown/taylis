import type { AttachmentOut, ChannelOut, ChannelState, MessageOut, MessageState, NotificationLevel, OutboxItem, ParentThread, PresenceEntry, PresenceStatus, ThreadEntry, ThreadFilter, ThreadItem, ThreadState, ThreadSummary, UserMe, UserPublic } from "./types";
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

export interface Draft { text: string; attachments: AttachmentOut[] }

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
  /** My saved message ids (M11c); from bootstrap and bookmark.updated, not persisted. */
  readonly bookmarks = new Set<string>();
  version = 0;
  private readonly drafts = new Map<string, Draft>();
  private readonly uploads = new Map<string, number>();
  private writeQueue = Promise.resolve();

  private draftKey(channelId: string, parentId: string | null): string { return `draft:${channelId}:${parentId ?? ""}`; }
  draft(channelId: string, parentId: string | null = null): Draft {
    return this.drafts.get(this.draftKey(channelId, parentId)) ?? { text: "", attachments: [] };
  }
  setDraft(channelId: string, parentId: string | null, patch: Partial<Draft>): void {
    const key = this.draftKey(channelId, parentId);
    const draft = { ...this.draft(channelId, parentId), ...patch };
    if (!draft.text && !draft.attachments.length) this.drafts.delete(key);
    else this.drafts.set(key, draft);
    const encoded = this.drafts.has(key) ? JSON.stringify(draft) : null;
    this.persist((p) => p.saveMeta(key, encoded));
    this.emit();
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
  private readonly listeners = new Set<() => void>();

  constructor(private readonly persistence: Persistence | null = null) {}

  async load(): Promise<void> {
    if (!this.persistence) return;
    const snapshot = await this.persistence.loadAll();
    this.loadDrafts(snapshot.meta);
    const me = snapshot.meta["me"];
    this.me = me ? (JSON.parse(me) as UserMe) : null;
    for (const user of snapshot.users) this.users.set(user.id, user);
    for (const channel of snapshot.channels) this.channels.set(channel.id, channel);
    for (const message of snapshot.messages) this.bucket(message.channel_id).set(message.id, message);
    this.outbox.push(...snapshot.outbox);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private persist(work: (p: Persistence) => Promise<void>): void {
    const persistence = this.persistence;
    if (persistence) this.writeQueue = this.writeQueue.then(() => work(persistence)).catch((err: unknown) => console.error("persist failed", err));
  }

  // --- me / users -------------------------------------------------------------------------

  setMe(me: UserMe | null): void {
    this.me = me;
    this.persist((p) => p.saveMeta("me", me ? JSON.stringify(me) : null));
    this.emit();
  }

  upsertUser(user: UserPublic): void {
    this.users.set(user.id, user);
    this.persist((p) => p.saveUser(user));
    this.emit();
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
      isMember: existing?.isMember ?? channel.membership !== null,
      syncedSeq: existing?.syncedSeq ?? null,
      lastSeq: Math.max(existing?.lastSeq ?? 0, channel.last_seq),
      lastReadSeq: Math.max(existing?.lastReadSeq ?? 0, channel.read_state?.last_read_seq ?? 0),
      unreadCount: channel.read_state?.unread_count ?? existing?.unreadCount ?? 0,
      mentionCount: channel.read_state?.mention_count ?? existing?.mentionCount ?? 0,
      hasOlder: existing?.hasOlder ?? true,
      notificationLevel: channel.notification?.level ?? existing?.notificationLevel ?? null,
      mutedUntil: channel.notification ? (channel.notification.muted_until ?? null) : (existing?.mutedUntil ?? null),
      ...patch,
    };
    this.channels.set(channel.id, merged);
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
    this.persist((p) => p.saveChannel(merged));
    this.emit();
    return merged;
  }

  removeChannel(id: string): void {
    this.channels.delete(id);
    this.messagesByChannel.delete(id);
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

  /** Confirmed messages by seq, then pending ones in creation order (SYNC_PROTOCOL.md §9). */
  /** Top-level messages: confirmed by seq, then pending ones in creation order (SYNC_PROTOCOL.md §9). */
  messages(channelId: string): MessageState[] {
    return this.ordered([...this.bucket(channelId).values()].filter((m) => !m.parent_id));
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
      if (bucket.delete(placeholder)) this.persist((p) => p.deleteMessage(placeholder));
    }
    const local = bucket.get(message.id);
    if (local && message.updated_seq <= local.updated_seq) return false;
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
    this.persist((p) => p.saveMessage(message));
    this.emit();
  }

  clearMessages(channelId: string): void {
    this.messagesByChannel.delete(channelId);
    this.persist((p) => p.clearMessages(channelId));
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

  markOutboxFailed(clientMsgId: string, reason: string): void {
    const item = this.outbox.find((i) => i.client_msg_id === clientMsgId);
    if (!item) return;
    item.failed = reason;
    const placeholder = this.bucket(item.channel_id).get(LOCAL_PREFIX + clientMsgId);
    if (placeholder) placeholder.failed = true;
    this.persist((p) => p.saveOutbox(item));
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
    store.loadDrafts(snapshot.meta);
    const me = snapshot.meta["me"];
    store.me = me ? (JSON.parse(me) as UserMe) : null;
    for (const user of snapshot.users) store.users.set(user.id, user);
    for (const channel of snapshot.channels) store.channels.set(channel.id, { ...channel });
    for (const message of snapshot.messages) store.bucket(message.channel_id).set(message.id, { ...message });
    store.outbox.push(...snapshot.outbox.map((i) => ({ ...i })));
    return store;
  }
}
