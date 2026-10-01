/**
 * L8 (TIMES_FEED.md §5): the Times feed on this device. The rows are kept in memory only, apart from the conversations'
 * histories (not in the store, not persisted): the first page is read when the feed opens, after reconnecting and on
 * 「再読み込み」, the next ones near the bottom, and message.* events keep the rows current while the feed is on screen.
 * While it is not, no row is added (the next opening reads the first page again); the rows already held still follow
 * edits, deletions and reactions so a feed shown again from memory (offline) is not stale.
 *
 * The functions below are pure (tests/timesFeed.test.ts); TimesFeedHub holds the state and talks to the server.
 */
import { isMutedChannel } from "./notifications";
import type { ChannelState, MessageState, ParentThread } from "./types";

export interface TimesFeedPage {
  items: MessageState[];
  next_cursor: string | null;
}

export interface TimesFeedApi {
  timesFeed(cursor?: string | null, limit?: number): Promise<TimesFeedPage>;
}

export interface FeedState {
  /** Newest first (feedOrder). */
  rows: MessageState[];
  /** The server's cursor for the page after the last row; null when the end is reached (or nothing was read yet). */
  nextCursor: string | null;
  /** A first page has been read at least once. */
  loaded: boolean;
}

export const EMPTY_FEED: FeedState = { rows: [], nextCursor: null, loaded: false };

/** The server's order (§2): created_at descending, then id descending (UUIDv7: same-instant rows of an import). */
export function feedOrder(a: Pick<MessageState, "created_at" | "id">, b: Pick<MessageState, "created_at" | "id">): number {
  const at = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (at !== 0 && !Number.isNaN(at)) return at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The channel's posts belong in the feed: a times I am a member of and have not muted (§2, SYNC_PROTOCOL.md §10.5). */
export function isFeedChannel(channel: ChannelState | undefined, now: Date = new Date()): boolean {
  return !!channel && channel.isMember && !!channel.times_owner_id && !isMutedChannel(channel, now);
}

/** §5 isFeedRow: a user's timeline row (top-level, or a reply also sent to the channel) of a feed channel, not deleted. */
export function isFeedRow(message: MessageState, channel: ChannelState | undefined, now: Date = new Date()): boolean {
  return (
    (message.type ?? "user") === "user" &&
    !message.deleted &&
    message.seq !== null &&
    (!message.parent_id || !!message.also_in_channel) &&
    isFeedChannel(channel, now)
  );
}

function sorted(rows: MessageState[]): MessageState[] {
  return [...rows].sort(feedOrder);
}

/** The first page (opening, reconnecting, refreshing): it replaces what was held. */
export function replaceFeed(page: TimesFeedPage): FeedState {
  const seen = new Set<string>();
  const rows = page.items.filter((m) => !m.deleted && !seen.has(m.id) && (seen.add(m.id), true));
  return { rows: sorted(rows), nextCursor: page.next_cursor, loaded: true };
}

/** The next page: appended, without the rows already held (a row that moved between pages keeps the newer copy). */
export function appendFeed(state: FeedState, page: TimesFeedPage): FeedState {
  const held = new Map(state.rows.map((m) => [m.id, m]));
  for (const message of page.items) {
    if (message.deleted) continue;
    const current = held.get(message.id);
    if (!current || message.updated_seq > current.updated_seq) held.set(message.id, message);
  }
  return { rows: sorted([...held.values()]), nextCursor: page.next_cursor, loaded: true };
}

/**
 * A message from an event or from an answer to me (a reaction, a pin, a delete). `created` rows are added when they
 * belong in the feed (isFeedRow, judged by the caller's channel); every message replaces the held row of the same id
 * when newer (updated_seq), and a deleted one — or one that is no longer a feed row — leaves.
 */
export function applyFeedMessage(state: FeedState, message: MessageState, options: { created: boolean; belongs: boolean }): FeedState {
  const index = state.rows.findIndex((m) => m.id === message.id);
  if (index >= 0) {
    const current = state.rows[index]!;
    if (message.updated_seq < current.updated_seq) return state;
    if (message.deleted || (message.parent_id && !message.also_in_channel)) {
      return { ...state, rows: state.rows.filter((m) => m.id !== message.id) };
    }
    if (message.updated_seq === current.updated_seq && message === current) return state;
    const rows = [...state.rows];
    rows[index] = message;
    return { ...state, rows };
  }
  if (!options.created || !options.belongs || !state.loaded) return state;
  // Older than the last row while more pages exist: the page that holds it brings it (no hole in the list).
  const last = state.rows[state.rows.length - 1];
  if (last && state.nextCursor !== null && feedOrder(message, last) > 0) return state;
  return { ...state, rows: sorted([message, ...state.rows]) };
}

/** A reply changed a held parent's thread (reply count, last reply, repliers). */
export function applyFeedParentThread(state: FeedState, thread: ParentThread): FeedState {
  const index = state.rows.findIndex((m) => m.id === thread.id);
  if (index < 0) return state;
  const current = state.rows[index]!;
  if (thread.updated_seq <= current.updated_seq) return state;
  const rows = [...state.rows];
  rows[index] = {
    ...current,
    reply_count: thread.reply_count,
    last_reply_at: thread.last_reply_at,
    ...(thread.reply_user_ids ? { reply_user_ids: thread.reply_user_ids } : {}),
    updated_seq: thread.updated_seq,
  };
  return { ...state, rows };
}

/** Rows of channels that no longer belong (left, muted, no longer a times) leave; unchanged state when none does. */
export function pruneFeed(state: FeedState, keep: (channelId: string) => boolean): FeedState {
  const verdicts = new Map<string, boolean>();
  const kept = (channelId: string) => {
    let verdict = verdicts.get(channelId);
    if (verdict === undefined) verdicts.set(channelId, (verdict = keep(channelId)));
    return verdict;
  };
  const rows = state.rows.filter((m) => kept(m.channel_id));
  return rows.length === state.rows.length ? state : { ...state, rows };
}

/** Whether a row shows the 「新しい」 dot (§4): past that channel's read position, and not my own. */
export function isNewFeedRow(message: MessageState, channel: ChannelState | undefined, meId: string | null): boolean {
  return !!channel && message.seq !== null && message.seq > channel.lastReadSeq && message.sender_id !== meId;
}

export type FeedStatus = "idle" | "loading" | "ready" | "failed" | "unsupported";

/**
 * The feed on this device (the engine owns one; the view opens it while on screen). Every read carries a number, so an
 * older answer never replaces a newer one, and a page read before a refresh never lands after it.
 */
export class TimesFeedHub {
  state: FeedState = EMPTY_FEED;
  status: FeedStatus = "idle";
  /** A next page is being read. */
  loadingMore = false;
  version = 0;
  private visible = 0;
  private read = 0;
  private readonly listeners = new Set<() => void>();
  private unsubscribeStore: (() => void) | null = null;

  constructor(
    private readonly deps: {
      api: TimesFeedApi | null;
      channel: (id: string) => ChannelState | undefined;
      /** The store's change feed: rows of channels that stop belonging are dropped while the feed is on screen. */
      subscribeChannels?: (listener: () => void) => () => void;
      isOnline?: () => boolean;
      pageSize?: number;
      now?: () => Date;
    },
  ) {
    if (deps.api === null) this.status = "unsupported";
  }

  get available(): boolean {
    return this.deps.api !== null;
  }

  get isVisible(): boolean {
    return this.visible > 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private set(state: FeedState): void {
    if (state === this.state) return;
    this.state = state;
    this.changed();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The feed is on screen: the first page is read (again), and events add rows until the returned function runs. */
  open(): () => void {
    this.visible += 1;
    if (this.visible === 1) {
      this.unsubscribeStore = this.deps.subscribeChannels?.(() => this.prune()) ?? null;
      this.prune();
      // A first page already on its way (closed and opened again at once: React's StrictMode, a quick back and forth)
      // serves this opening too.
      if (this.status !== "loading") void this.refresh();
    }
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.visible -= 1;
      if (this.visible === 0) {
        this.unsubscribeStore?.();
        this.unsubscribeStore = null;
      }
    };
  }

  /** The first page, replacing the rows (opening, reconnecting, 「再読み込み」). Offline the held rows stay as they are. */
  async refresh(): Promise<void> {
    const api = this.deps.api;
    if (!api || (this.deps.isOnline && !this.deps.isOnline())) return;
    const id = ++this.read;
    this.loadingMore = false;
    this.status = "loading";
    this.changed();
    try {
      const page = await api.timesFeed(null, this.deps.pageSize ?? 50);
      if (id !== this.read) return;
      this.state = pruneFeed(replaceFeed(page), (channelId) => isFeedChannel(this.deps.channel(channelId), this.now()));
      this.status = "ready";
    } catch (err) {
      if (id !== this.read) return;
      console.warn("could not load the times feed", err);
      this.status = "failed";
    }
    this.changed();
  }

  /** The page after the last row, when there is one (near the bottom). */
  async loadMore(): Promise<void> {
    const api = this.deps.api;
    const cursor = this.state.nextCursor;
    if (!api || !cursor || this.loadingMore || this.status === "loading") return;
    const id = this.read;
    this.loadingMore = true;
    this.changed();
    try {
      const page = await api.timesFeed(cursor, this.deps.pageSize ?? 50);
      if (id !== this.read) return;
      this.state = appendFeed(this.state, page);
    } catch (err) {
      if (id !== this.read) return;
      console.warn("could not load more of the times feed", err);
    } finally {
      if (id === this.read) {
        this.loadingMore = false;
        this.changed();
      }
    }
  }

  /** Connected again: a feed on screen reads its first page again (events may have been missed). */
  online(): void {
    if (this.isVisible) void this.refresh();
  }

  /** message.created / updated / deleted, or a message the server answered me with. */
  applyMessage(message: MessageState, created: boolean): void {
    const belongs = created && this.isVisible && isFeedRow(message, this.deps.channel(message.channel_id), this.now());
    this.set(applyFeedMessage(this.state, message, { created, belongs }));
  }

  applyParentThread(thread: ParentThread): void {
    this.set(applyFeedParentThread(this.state, thread));
  }

  /** I left the channel (or was removed): its rows leave at once. */
  removeChannel(channelId: string): void {
    this.set(pruneFeed(this.state, (id) => id !== channelId));
  }

  /** Rows of channels muted, left or no longer times since they were read leave (§5). */
  prune(): void {
    if (this.state.rows.length === 0) return;
    const now = this.now();
    this.set(pruneFeed(this.state, (channelId) => isFeedChannel(this.deps.channel(channelId), now)));
  }

  /** A held row (the thread pane's parent when its channel's timeline is not loaded). */
  find(messageId: string): MessageState | undefined {
    return this.state.rows.find((m) => m.id === messageId);
  }

  /** Signed out: nothing is kept. */
  stop(): void {
    this.read += 1;
    this.state = EMPTY_FEED;
    this.status = this.deps.api ? "idle" : "unsupported";
    this.loadingMore = false;
    this.changed();
  }
}
