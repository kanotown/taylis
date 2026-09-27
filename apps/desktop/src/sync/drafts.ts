import { isRetryable } from "../api/errors";
import type { Store } from "./store";
import type { DraftOut, DraftUpdated } from "./types";

export interface DraftApi {
  saveDraft(channelId: string, parentId: string | null, body: string): Promise<DraftOut>;
  deleteDraft(channelId: string, parentId: string | null): Promise<void>;
}

const composerKey = (channelId: string, parentId: string | null): string => `${channelId}:${parentId ?? ""}`;

/**
 * M15d: keeps my drafts in step across my devices (SYNC_PROTOCOL.md §8 「下書きの同期」).
 * Local edits are saved a moment after typing pauses; while a draft has unsaved edits (dirty),
 * versions from other devices are ignored so that nothing typed here is lost.
 */
export class DraftSync {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: { api: DraftApi | null; store: Store; isOnline: () => boolean; delayMs: number },
  ) {}

  /** A local edit: save it once typing pauses (an emptied composer, e.g. after sending, right away). */
  edited(channelId: string, parentId: string | null): void {
    if (!this.deps.api) return;
    const key = composerKey(channelId, parentId);
    const pending = this.timers.get(key);
    if (pending) clearTimeout(pending);
    const delay = this.deps.store.draft(channelId, parentId).text === "" ? 0 : this.deps.delayMs;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.push(channelId, parentId);
    }, delay));
  }

  /** Bootstrap: take the server's drafts, forget the ones sent or deleted elsewhere. */
  applyBootstrap(drafts: DraftOut[]): void {
    const store = this.deps.store;
    for (const { channelId, parentId, draft } of store.draftEntries()) {
      // Written before this device synced drafts (or never saved): this device's text wins.
      if (!draft.dirty && !draft.syncedAt && draft.text.trim() !== "" && store.getChannel(channelId)?.isMember) store.markDraftDirty(channelId, parentId);
    }
    const onServer = new Set<string>();
    for (const draft of drafts) {
      onServer.add(composerKey(draft.channel_id, draft.parent_id ?? null));
      store.applyRemoteDraft(draft.channel_id, draft.parent_id ?? null, draft.body, draft.updated_at);
    }
    for (const { channelId, parentId, draft } of store.draftEntries()) {
      if (!draft.dirty && draft.syncedAt && !onServer.has(composerKey(channelId, parentId))) store.applyRemoteDraft(channelId, parentId, null, null);
    }
  }

  applyEvent(data: DraftUpdated): void {
    this.deps.store.applyRemoteDraft(data.channel_id, data.parent_id ?? null, data.deleted ? null : data.body, data.updated_at);
  }

  /** Save every draft edited while offline (after connecting), or now instead of after the pause. */
  flush(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const { channelId, parentId, draft } of this.deps.store.draftEntries()) {
      if (draft.dirty && this.deps.store.getChannel(channelId)?.isMember) void this.push(channelId, parentId);
    }
    return this.running;
  }

  idle(): Promise<void> {
    return this.running;
  }

  /** Saves run one at a time, in order. */
  private push(channelId: string, parentId: string | null): Promise<void> {
    const run = this.running.then(() => this.save(channelId, parentId));
    this.running = run.catch((err: unknown) => console.warn("could not save a draft", err));
    return this.running;
  }

  private async save(channelId: string, parentId: string | null): Promise<void> {
    const { api, store, isOnline } = this.deps;
    if (!api || !isOnline()) return; // stays dirty: flushed after reconnecting
    const draft = store.draft(channelId, parentId);
    if (!draft.dirty) return;
    const text = draft.text;
    try {
      if (text.trim() === "") {
        await api.deleteDraft(channelId, parentId);
        store.markDraftSaved(channelId, parentId, text, null);
      } else {
        const saved = await api.saveDraft(channelId, parentId, text);
        store.markDraftSaved(channelId, parentId, text, saved.updated_at);
      }
    } catch (err) {
      if (isRetryable(err)) return;
      // Refused for good (left the conversation, the thread is gone …): keep the text here only.
      store.markDraftSaved(channelId, parentId, text, null);
    }
  }
}
