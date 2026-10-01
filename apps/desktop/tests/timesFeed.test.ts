/** L8 (TIMES_FEED.md §5): the Times feed's rules (pure) and its hub on a real SyncEngine against the fake server. */
import { describe, expect, it } from "vitest";

import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { appendFeed, applyFeedMessage, applyFeedParentThread, EMPTY_FEED, feedOrder, isFeedRow, isNewFeedRow, pruneFeed, replaceFeed } from "../src/sync/timesFeed";
import type { ChannelState, MessageState } from "../src/sync/types";
import { FakeServer } from "./fakeServer";

const NOW = new Date("2026-10-02T12:00:00Z");

function channel(patch: Partial<ChannelState> = {}): ChannelState {
  return {
    id: "c1", type: "public", name: "times-sato", topic: null, purpose: null, archived: false, created_by: "u1", last_seq: 10,
    last_message_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", membership: null, dm_user_ids: null,
    posting_policy: "everyone", times_owner_id: "u1", isMember: true, syncedSeq: null, lastSeq: 10, lastReadSeq: 3, unreadCount: 0,
    mentionCount: 0, firstUnreadAt: null, pendingReadSeq: null, hasOlder: false, oldestLoadedSeq: null, notificationLevel: null,
    mutedUntil: null, muted: false, ...patch,
  } as ChannelState;
}

let n = 0;
function msg(patch: Partial<MessageState> = {}): MessageState {
  n += 1;
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`, channel_id: "c1", sender_id: "u1", body: `post ${n}`, seq: n,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(), edited_at: null, deleted: false, client_msg_id: null,
    updated_seq: n, type: "user", parent_id: null, also_in_channel: false, reply_count: 0, reactions: [], attachments: [], ...patch,
  } as MessageState;
}

describe("feed order and rows", () => {
  it("orders by created_at descending, then id descending for rows of the same instant", () => {
    const at = "2026-10-01T00:00:00.000Z";
    const a = msg({ created_at: at, id: "00000000-0000-7000-8000-00000000000a" });
    const b = msg({ created_at: at, id: "00000000-0000-7000-8000-00000000000b" });
    const older = msg({ created_at: "2026-09-30T00:00:00.000Z" });
    const newer = msg({ created_at: "2026-10-02T00:00:00.000Z" });
    expect([a, older, newer, b].sort(feedOrder).map((m) => m.id)).toEqual([newer.id, b.id, a.id, older.id]);
    expect(replaceFeed({ items: [a, older, newer, b], next_cursor: null }).rows.map((m) => m.id)).toEqual([newer.id, b.id, a.id, older.id]);
  });

  it("isFeedRow: a user's timeline row of an unmuted times I am in", () => {
    const c = channel();
    expect(isFeedRow(msg(), c, NOW)).toBe(true);
    expect(isFeedRow(msg({ parent_id: "p" }), c, NOW)).toBe(false); // a reply only in its thread
    expect(isFeedRow(msg({ parent_id: "p", also_in_channel: true }), c, NOW)).toBe(true);
    expect(isFeedRow(msg({ type: "system" }), c, NOW)).toBe(false);
    expect(isFeedRow(msg({ deleted: true }), c, NOW)).toBe(false);
    expect(isFeedRow(msg(), channel({ times_owner_id: null }), NOW)).toBe(false);
    expect(isFeedRow(msg(), channel({ isMember: false }), NOW)).toBe(false);
    expect(isFeedRow(msg(), channel({ muted: true }), NOW)).toBe(false);
    expect(isFeedRow(msg(), channel({ notificationLevel: "none" }), NOW)).toBe(false);
    expect(isFeedRow(msg(), channel({ mutedUntil: "2026-10-03T00:00:00Z" }), NOW)).toBe(false);
    expect(isFeedRow(msg(), channel({ mutedUntil: "2026-10-01T00:00:00Z" }), NOW)).toBe(true); // the mute ran out
    expect(isFeedRow(msg(), channel({ archived: true }), NOW)).toBe(true); // a graduate's times stays readable
    expect(isFeedRow(msg(), undefined, NOW)).toBe(false);
  });

  it("the 「新しい」 dot: past the channel's read position, never on my own rows", () => {
    const c = channel({ lastReadSeq: 5 });
    expect(isNewFeedRow(msg({ seq: 6, sender_id: "u2" }), c, "u1")).toBe(true);
    expect(isNewFeedRow(msg({ seq: 5, sender_id: "u2" }), c, "u1")).toBe(false);
    expect(isNewFeedRow(msg({ seq: 6, sender_id: "u1" }), c, "u1")).toBe(false);
  });
});

describe("pages", () => {
  it("the next page is appended without the rows already held, keeping the newer copy", () => {
    const [a, b, c] = [msg(), msg(), msg()];
    const first = replaceFeed({ items: [c, b], next_cursor: "x" });
    const edited = { ...b, body: "edited", updated_seq: 99 };
    const next = appendFeed(first, { items: [edited, a], next_cursor: null });
    expect(next.rows.map((m) => m.id)).toEqual([c.id, b.id, a.id]);
    expect(next.rows[1]!.body).toBe("edited");
    expect(next.nextCursor).toBeNull();
    const stale = appendFeed(next, { items: [b], next_cursor: null });
    expect(stale.rows[1]!.body).toBe("edited");
  });
});

describe("live messages", () => {
  const base = () => replaceFeed({ items: [msg(), msg()].reverse(), next_cursor: null });

  it("a new row goes in at its place when it belongs; nothing before the first page or when it does not belong", () => {
    const state = base();
    const fresh = msg();
    expect(applyFeedMessage(state, fresh, { created: true, belongs: true }).rows[0]!.id).toBe(fresh.id);
    expect(applyFeedMessage(state, fresh, { created: true, belongs: false })).toBe(state); // muted, a thread-only reply, system …
    expect(applyFeedMessage(state, fresh, { created: false, belongs: true })).toBe(state); // an update of a row not held
    expect(applyFeedMessage(EMPTY_FEED, fresh, { created: true, belongs: true })).toBe(EMPTY_FEED);
    const twice = applyFeedMessage(applyFeedMessage(state, fresh, { created: true, belongs: true }), fresh, { created: true, belongs: true });
    expect(twice.rows.filter((m) => m.id === fresh.id)).toHaveLength(1);
  });

  it("an old row is not inserted below the last one while more pages exist (the page brings it)", () => {
    const old = msg({ created_at: "2020-01-01T00:00:00Z" });
    const state = { ...base(), nextCursor: "more" };
    expect(applyFeedMessage(state, old, { created: true, belongs: true })).toBe(state);
  });

  it("updates replace the held row when newer; deletions and moves into a thread take it out", () => {
    const state = base();
    const row = state.rows[0]!;
    const edited = applyFeedMessage(state, { ...row, body: "edited", updated_seq: row.updated_seq + 1 }, { created: false, belongs: false });
    expect(edited.rows[0]!.body).toBe("edited");
    expect(applyFeedMessage(edited, { ...row, body: "old", updated_seq: row.updated_seq }, { created: false, belongs: false })).toBe(edited);
    const deleted = applyFeedMessage(edited, { ...row, deleted: true, updated_seq: row.updated_seq + 2 }, { created: false, belongs: false });
    expect(deleted.rows.map((m) => m.id)).not.toContain(row.id);
  });

  it("a reply updates its held parent's thread line", () => {
    const state = base();
    const parent = state.rows[1]!;
    const next = applyFeedParentThread(state, { id: parent.id, reply_count: 2, last_reply_at: "2026-10-02T00:00:00Z", reply_user_ids: ["u2"], updated_seq: parent.updated_seq + 5 });
    expect(next.rows[1]).toMatchObject({ reply_count: 2, reply_user_ids: ["u2"] });
    expect(applyFeedParentThread(next, { id: "nope", reply_count: 1, last_reply_at: null, updated_seq: 1 })).toBe(next);
  });

  it("rows of a channel left, muted or no longer a times leave; nothing changes otherwise", () => {
    const state = replaceFeed({ items: [msg({ channel_id: "a" }), msg({ channel_id: "b" }), msg({ channel_id: "a" })], next_cursor: null });
    expect(pruneFeed(state, () => true)).toBe(state);
    expect(pruneFeed(state, (id) => id !== "a").rows.map((m) => m.channel_id)).toEqual(["b"]);
  });
});

/** Bob is in alice's times and carol's times; #general is no times; he has his own times too. */
async function feedWorld() {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const carol = server.addUser("carol");
  const times = (owner: { id: string }, name: string) => {
    const c = server.createChannel(name, owner.id);
    c.times_owner_id = owner.id;
    server.join(c.id, bob.id);
    return c.id;
  };
  const aliceTimes = times(alice, "times-alice");
  const carolTimes = times(carol, "times-carol");
  const general = server.createChannel("general", alice.id).id;
  server.join(general, bob.id);
  server.post(aliceTimes, alice.id, "a1");
  server.post(carolTimes, carol.id, "c1");
  server.post(general, alice.id, "g1");
  const store = new Store();
  const engine = new SyncEngine(
    { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => true },
    { reconnectMinMs: 0 },
  );
  await engine.start();
  await engine.idle();
  return { server, alice, bob, carol, aliceTimes, carolTimes, general, store, engine };
}

const flush = async (w: { engine: SyncEngine }) => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await w.engine.idle();
};
const bodies = (w: { engine: SyncEngine }) => w.engine.timesFeed.state.rows.map((m) => m.body);

describe("the hub on the engine", () => {
  it("reads the first page when opened, follows new posts only while open, and reads again when opened again", async () => {
    const w = await feedWorld();
    const close = w.engine.timesFeed.open();
    await flush(w);
    expect(bodies(w)).toEqual(["c1", "a1"]);
    w.server.post(w.aliceTimes, w.alice.id, "a2");
    w.server.post(w.general, w.alice.id, "g2"); // not a times
    const parent = w.server.messageByBody(w.carolTimes, "c1");
    w.server.post(w.carolTimes, w.carol.id, "thread only", undefined, parent.id);
    w.server.post(w.carolTimes, w.carol.id, "also in channel", undefined, parent.id, [], { alsoInChannel: true });
    await flush(w);
    expect(bodies(w)).toEqual(["also in channel", "a2", "c1", "a1"]);
    expect(w.engine.timesFeed.find(parent.id)?.reply_count).toBe(2); // the parent's 「返信 N 件」 follows
    close();
    w.server.post(w.aliceTimes, w.alice.id, "a3"); // not on screen: not added
    await flush(w);
    expect(bodies(w)).not.toContain("a3");
    w.engine.timesFeed.open();
    await flush(w);
    expect(bodies(w)[0]).toBe("a3");
    expect(w.server.timesFeedCalls).toEqual([null, null]);
    w.engine.stop();
  });

  it("closed and opened again at once (StrictMode) reads the first page once", async () => {
    const w = await feedWorld();
    w.engine.timesFeed.open()();
    w.engine.timesFeed.open();
    await flush(w);
    expect(w.server.timesFeedCalls).toEqual([null]);
    expect(bodies(w)).toEqual(["c1", "a1"]);
    w.engine.stop();
  });

  it("edits and deletions reach held rows; leaving or muting a times drops its rows", async () => {
    const w = await feedWorld();
    w.engine.timesFeed.open();
    await flush(w);
    const a1 = w.server.messageByBody(w.aliceTimes, "a1");
    w.server.edit(w.aliceTimes, w.alice.id, a1.id, "a1 edited");
    await flush(w);
    expect(bodies(w)).toEqual(["c1", "a1 edited"]);
    w.server.delete(w.aliceTimes, w.alice.id, a1.id);
    await flush(w);
    expect(bodies(w)).toEqual(["c1"]);
    w.server.post(w.aliceTimes, w.alice.id, "a2");
    await flush(w);
    expect(bodies(w)).toEqual(["a2", "c1"]);
    w.server.setNotificationPreference(w.bob.id, w.carolTimes, { level: null, muted: true });
    await flush(w);
    expect(bodies(w)).toEqual(["a2"]);
    w.engine.removeChannel(w.aliceTimes); // left (or removed)
    expect(bodies(w)).toEqual([]);
    w.engine.stop();
  });

  it("pages with next_cursor without duplicates, and opening reads nothing as read", async () => {
    const w = await feedWorld();
    for (let i = 0; i < 60; i++) w.server.post(i % 2 ? w.aliceTimes : w.carolTimes, i % 2 ? w.alice.id : w.carol.id, `p${i}`);
    w.engine.timesFeed.open();
    await flush(w);
    expect(w.engine.timesFeed.state.rows).toHaveLength(50);
    await w.engine.timesFeed.loadMore();
    const ids = w.engine.timesFeed.state.rows.map((m) => m.id);
    expect(ids).toHaveLength(62);
    expect(new Set(ids).size).toBe(62);
    expect(w.engine.timesFeed.state.nextCursor).toBeNull();
    expect(w.server.readState(w.bob.id, w.aliceTimes).last_read_seq).toBe(0);
    await w.engine.markAllRead("times");
    expect(w.server.readAllScopes).toEqual(["times"]);
    expect(w.server.readState(w.bob.id, w.aliceTimes).last_read_seq).toBe(w.server.channels.get(w.aliceTimes)!.channel.last_seq);
    expect(w.server.readState(w.bob.id, w.general).last_read_seq).toBe(0); // not a times
    w.engine.stop();
  });
});
