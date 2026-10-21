/**
 * MOBILE_UI.md §23: a channel's member ids for the @ list's members tier, read from GET /channels/{id}/members the
 * first time the list opens there, in memory only (never persisted). Read again when the store learns the members
 * changed (channel.member_added / _removed / _updated bump the revision), or after MAX_AGE_MS (a missed event). A failed
 * read keeps what was there (nothing: the list ranks as without members) and is tried again after RETRY_MS at most.
 */
export const MEMBERS_MAX_AGE_MS = 5 * 60_000;
export const MEMBERS_RETRY_MS = 30_000;

interface Entry {
  ids: readonly string[] | null;
  revision: number;
  at: number;
  failed: boolean;
  loading: boolean;
}

export class ChannelMembers {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly onChange: () => void) {}

  /** The ids last read for the channel (also while a newer read runs); undefined while none was read. */
  ids(channelId: string): readonly string[] | undefined {
    return this.entries.get(channelId)?.ids ?? undefined;
  }

  /** Reads the members unless a fresh read for this revision is held or running. */
  want(channelId: string, revision: number, load: () => Promise<readonly string[]>, now = Date.now()): void {
    const entry = this.entries.get(channelId);
    if (entry?.loading) return;
    if (entry && entry.revision === revision && now - entry.at < (entry.failed ? MEMBERS_RETRY_MS : MEMBERS_MAX_AGE_MS)) return;
    const next: Entry = { ids: entry?.ids ?? null, revision, at: now, failed: false, loading: true };
    this.entries.set(channelId, next);
    void Promise.resolve().then(load).then(
      (ids) => {
        if (this.entries.get(channelId) !== next) return;
        this.entries.set(channelId, { ...next, ids: [...ids], loading: false });
        this.onChange();
      },
      (error: unknown) => {
        if (this.entries.get(channelId) !== next) return;
        // Not shown: the @ list works without the members tier (MOBILE_UI.md §23).
        console.warn("channel members for the @ list could not be read", channelId, error);
        this.entries.set(channelId, { ...next, failed: true, loading: false });
      },
    );
  }
}

/** What `requestChannelMembers` reads: the store of the workspace on screen. */
interface MembersSource {
  channels: ReadonlyMap<string, { type: string }>;
  channelMembers: ChannelMembers;
  membersRevision(channelId: string): number;
}

/** The @ list opened in (or for a canvas of) this channel: read its members if needed. A DM has its dm_user_ids. */
export function requestChannelMembers(
  store: MembersSource,
  api: { members(channelId: string): Promise<Array<{ user_id: string }>> } | null,
  channelId: string | null | undefined,
): void {
  if (!api || !channelId) return;
  const type = store.channels.get(channelId)?.type;
  if (type !== "public" && type !== "private") return;
  store.channelMembers.want(channelId, store.membersRevision(channelId), () => api.members(channelId).then((list) => list.map((m) => m.user_id)));
}
