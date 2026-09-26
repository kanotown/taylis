import type { ChannelOut, ChannelState, MessageState, OutboxItem, UserMe, UserPublic } from "./types";
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

/** The single source of truth for the UI (ARCHITECTURE.md §11). */
export class Store {
  me: UserMe | null = null;
  readonly users = new Map<string, UserPublic>();
  readonly channels = new Map<string, ChannelState>();
  readonly outbox: OutboxItem[] = [];
  version = 0;
  private readonly messagesByChannel = new Map<string, Map<string, MessageState>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly persistence: Persistence | null = null) {}

  async load(): Promise<void> {
    if (!this.persistence) return;
    const snapshot = await this.persistence.loadAll();
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
    if (this.persistence) void work(this.persistence).catch((err: unknown) => console.error("persist failed", err));
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
      seenSeq: existing?.seenSeq ?? 0,
      hasOlder: existing?.hasOlder ?? true,
      ...patch,
    };
    this.channels.set(channel.id, merged);
    this.persist((p) => p.saveChannel(merged));
    this.emit();
    return merged;
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
  messages(channelId: string): MessageState[] {
    const all = [...this.bucket(channelId).values()];
    const confirmed = all.filter((m) => m.seq !== null).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const pending = all.filter((m) => m.seq === null).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return [...confirmed, ...pending];
  }

  getMessage(channelId: string, id: string): MessageState | undefined {
    return this.bucket(channelId).get(id);
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
      meta: this.me ? { me: JSON.stringify(this.me) } : {},
      users: [...this.users.values()],
      channels: [...this.channels.values()],
      messages: [...this.messagesByChannel.values()].flatMap((b) => [...b.values()]),
      outbox: [...this.outbox],
    };
  }

  static fromSnapshot(snapshot: Snapshot, persistence: Persistence | null = null): Store {
    const store = new Store(persistence);
    const me = snapshot.meta["me"];
    store.me = me ? (JSON.parse(me) as UserMe) : null;
    for (const user of snapshot.users) store.users.set(user.id, user);
    for (const channel of snapshot.channels) store.channels.set(channel.id, { ...channel });
    for (const message of snapshot.messages) store.bucket(message.channel_id).set(message.id, { ...message });
    store.outbox.push(...snapshot.outbox.map((i) => ({ ...i })));
    return store;
  }
}
