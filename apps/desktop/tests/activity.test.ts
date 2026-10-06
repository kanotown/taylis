/**
 * M39, the activity stage B (MOBILE_UI.md §6.4, §7.2; SYNC_PROTOCOL.md bootstrap `activity`, activity.read,
 * reaction.added): the rows' rules, the badge, the store's summary, and the engine keeping it with the server's.
 */
import { describe, expect, it } from "vitest";

import type { ActivityItem, ActivitySummaryOut, MessageOut, ReactionAdded } from "../src/api/types";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { activityEmptyText, activityHeadline, activityHeadlineText, activityKey, appendActivityPage, isActivityUnread, isReadInConversation, isShownActivity, movesActivityRead, newestActivityAt, type ReadPositions } from "../src/ui/activity";
import { activityBadge } from "../src/ui/mobileTabs";
import { FakeServer, MemoryPersistence } from "./fakeServer";

const item = (kind: ActivityItem["kind"], id: string, at: string, actors: string[] = ["u1"], emojis: string[] = []): ActivityItem => ({
  kind,
  at,
  message: { id, channel_id: "c1", sender_id: "u1", body: "本文" } as unknown as MessageOut,
  actor_ids: actors,
  emojis,
});
const names: Record<string, string> = { u1: "山田", u2: "佐藤", u3: "鈴木" };
const nameOf = (id: string) => names[id] ?? "?";

describe("activity rows", () => {
  it("say who did what: a mention, a reply, one or several people's reactions", () => {
    expect(activityHeadlineText(item("mention", "m1", "2026-09-30T01:00:00Z"), nameOf)).toBe("山田 がメンション");
    expect(activityHeadlineText(item("thread_reply", "m1", "2026-09-30T01:00:00Z", ["u2"]), nameOf)).toBe("佐藤 がスレッドに返信");
    expect(activityHeadlineText(item("reaction", "m1", "2026-09-30T01:00:00Z", ["u2"], ["👍"]), nameOf)).toBe("佐藤 が 👍");
    expect(activityHeadlineText(item("reaction", "m1", "2026-09-30T01:00:00Z", ["u2", "u1", "u3"], ["👍", "🎉"]), nameOf)).toBe("佐藤 ほか 2 人が 👍🎉");
    expect(activityHeadline(item("reaction", "m1", "2026-09-30T01:00:00Z", ["u2", "u3"]), nameOf)).toEqual({ who: "佐藤 ほか 1 人", what: "が" });
    expect(activityHeadline(item("mention", "m1", "2026-09-30T01:00:00Z", []), nameOf).who).toBe("誰か");
    expect(activityEmptyText("reactions")).toBe("自分の投稿へのリアクションはまだありません");
  });

  it("have a dot after the read position only, and mark read up to the newest one shown", () => {
    const readAt = "2026-09-30T01:00:00.000Z";
    expect(isActivityUnread(item("mention", "m1", "2026-09-30T01:00:00.001Z"), readAt)).toBe(true);
    expect(isActivityUnread(item("mention", "m1", readAt), readAt)).toBe(false);
    expect(isActivityUnread(item("mention", "m1", "2026-09-30T02:00:00Z"), null)).toBe(false);
    const rows = [item("mention", "a", "2026-09-30T01:00:00Z"), item("reaction", "b", "2026-09-30T03:00:00Z"), item("thread_reply", "c", "2026-09-30T02:00:00Z")];
    expect(newestActivityAt(rows)).toBe("2026-09-30T03:00:00Z");
    expect(newestActivityAt([])).toBeNull();
    expect(movesActivityRead("2026-09-30T03:00:00Z", "2026-09-30T02:00:00Z")).toBe(true);
    expect(movesActivityRead("2026-09-30T02:00:00Z", "2026-09-30T02:00:00Z")).toBe(false);
    expect(movesActivityRead(null, "2026-09-30T02:00:00Z")).toBe(false);
  });

  it("2026-10-06 (§6.4): a mention or reply read in its conversation or thread has no dot; `read` null (an older server) is the time alone", () => {
    const readAt = "2026-09-30T01:00:00.000Z";
    const at = "2026-09-30T02:00:00.000Z";
    const msg = (patch: Partial<MessageOut>) => ({ id: "m", channel_id: "c1", sender_id: "u1", body: "", seq: 10, parent_id: null, also_in_channel: false, ...patch }) as unknown as MessageOut;
    const row = (kind: ActivityItem["kind"], message: MessageOut, read: boolean | null): ActivityItem => ({ kind, at, message, actor_ids: ["u1"], emojis: [], read });
    const pos = (channel: number, thread: number): ReadPositions => ({ channel: () => channel, thread: () => thread });
    // The rule: a timeline row by the conversation's position, a reply by its thread's, a reply also in the channel by either.
    expect(isReadInConversation(row("mention", msg({}), false), pos(10, 0))).toBe(true);
    expect(isReadInConversation(row("mention", msg({}), false), pos(9, 99))).toBe(false);
    expect(isReadInConversation(row("thread_reply", msg({ parent_id: "p" }), false), pos(99, 9))).toBe(false);
    expect(isReadInConversation(row("thread_reply", msg({ parent_id: "p" }), false), pos(0, 10))).toBe(true);
    expect(isReadInConversation(row("mention", msg({ parent_id: "p", also_in_channel: true }), false), pos(10, 0))).toBe(true);
    expect(isReadInConversation(row("mention", msg({ parent_id: "p", also_in_channel: true }), false), pos(0, 10))).toBe(true);
    expect(isReadInConversation(row("reaction", msg({}), false), pos(99, 99))).toBe(false);
    // The dot: the server's flag (newer than the list's read_at: read in its conversation), or this device's positions.
    expect(isActivityUnread(row("mention", msg({}), false), readAt, { listReadAt: readAt, positions: pos(0, 0) })).toBe(true);
    expect(isActivityUnread(row("mention", msg({}), true), readAt, { listReadAt: readAt, positions: pos(0, 0) })).toBe(false);
    expect(isActivityUnread(row("mention", msg({}), false), readAt, { listReadAt: readAt, positions: pos(10, 0) })).toBe(false);
    // `read` true only because it is behind the list's read position: the dot stays while looking (seen from earlier).
    expect(isActivityUnread(row("reaction", msg({}), true), readAt, { listReadAt: "2026-09-30T03:00:00.000Z" })).toBe(true);
    // An older server: no flag, the positions are not looked at.
    expect(isActivityUnread(row("mention", msg({}), null), readAt, { listReadAt: readAt, positions: pos(10, 10) })).toBe(true);
  });

  it("come in pages without listing a row twice (kind and message make a row)", () => {
    const first = [item("mention", "a", "3"), item("reaction", "b", "2")];
    const next = [item("reaction", "b", "2"), item("mention", "b", "2"), item("thread_reply", "c", "1")];
    expect(appendActivityPage(first, next).map(activityKey)).toEqual(["mention:a", "reaction:b", "mention:b", "thread_reply:c"]);
  });

  it("M76: a canvas mention has no message: keyed by its own id, worded with the canvas's title, shown only with its canvas", () => {
    const canvasItem: ActivityItem = {
      kind: "canvas_mention",
      at: "2026-10-02T01:00:00Z",
      message: null,
      actor_ids: ["u2"],
      emojis: [],
      canvas: { item_id: "cm1", canvas_id: "cv1", channel_id: "c1", title: "議事録", excerpt: "予稿 @山田", rev_id: "r1" },
    };
    expect(activityKey(canvasItem)).toBe("canvas_mention:cm1");
    expect(activityHeadlineText(canvasItem, nameOf)).toBe("佐藤 が「議事録」であなたをメンションしました");
    expect(isShownActivity(canvasItem)).toBe(true);
    expect(isShownActivity({ ...canvasItem, canvas: null })).toBe(false);
    expect(isShownActivity({ ...canvasItem, kind: "later" as never })).toBe(false);
    expect(isShownActivity(item("mention", "m1", "1"))).toBe(true);
    expect(appendActivityPage([canvasItem], [{ ...canvasItem }, item("mention", "m1", "1")]).map(activityKey)).toEqual(["canvas_mention:cm1", "mention:m1"]);
  });
});

describe("the activity badge", () => {
  const channel = (patch: Partial<ChannelState>) => ({ id: "c", type: "public", isMember: true, mentionCount: 0, unreadCount: 0, ...patch }) as ChannelState;
  it("is the server's unread count (red with a mention among them) once the server has activity, else stage A's", () => {
    const channels = [channel({ mentionCount: 2 })];
    const threads = { unread_count: 1, mention_count: 0 };
    expect(activityBadge(channels, threads, null)).toEqual({ count: 2, mention: true });
    const summary: ActivitySummaryOut = { read_at: "2026-09-30T00:00:00Z", unread_count: 5, mention_unread: false };
    expect(activityBadge(channels, threads, summary)).toEqual({ count: 5, mention: false });
    expect(activityBadge(channels, threads, { ...summary, mention_unread: true })).toEqual({ count: 5, mention: true });
    expect(activityBadge(channels, threads, { ...summary, unread_count: 0, mention_unread: true })).toEqual({ count: 0, mention: false });
  });
});

describe("Store.setActivity", () => {
  it("keeps the newest read position (a summary answered after a newer PUT is dropped) and survives a restart", async () => {
    const persistence = new MemoryPersistence();
    const store = new Store(persistence);
    store.setActivity({ read_at: "2026-09-30T02:00:00.000Z", unread_count: 0, mention_unread: false });
    store.setActivity({ read_at: "2026-09-30T01:00:00.000Z", unread_count: 4, mention_unread: true });
    expect(store.activity).toEqual({ read_at: "2026-09-30T02:00:00.000Z", unread_count: 0, mention_unread: false });
    store.setActivity({ read_at: "2026-09-30T02:00:00.000Z", unread_count: 1, mention_unread: false });
    expect(store.activity?.unread_count).toBe(1);
    await store.flushPersistence();
    const again = new Store(persistence);
    await again.load();
    expect(again.activity).toEqual({ read_at: "2026-09-30T02:00:00.000Z", unread_count: 1, mention_unread: false });
    store.setActivity(null);
    expect(store.activity).toBeNull();
  });
});

/** Bob on this device, alice and carol posting in channel C; `reactions` collects the reaction banners. */
async function setup(options: { activity?: boolean; notifyReactions?: boolean; active?: boolean } = {}) {
  const server = new FakeServer();
  server.activityEnabled = options.activity ?? true;
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const carol = server.addUser("carol");
  const channel = server.createChannel("c", alice.id);
  server.join(channel.id, bob.id);
  server.join(channel.id, carol.id);
  if (options.notifyReactions) server.notifyReactions.add(bob.id);
  const inner = server.apiFor(bob.id);
  const calls = { summary: 0 };
  const api = { ...inner, activitySummary: inner.activitySummary && (async () => { calls.summary += 1; return inner.activitySummary!(); }) };
  const store = new Store();
  const reactions: Array<{ reaction: ReactionAdded; channel: string }> = [];
  const engine = new SyncEngine(
    {
      api,
      connect: server.connectorFor(bob.id),
      store,
      getAccessToken: () => "t",
      sleep: async () => {},
      random: () => 0.5,
      isActive: () => options.active ?? false,
      onReaction: (reaction, c) => reactions.push({ reaction, channel: c.id }),
    },
    { reconnectMinMs: 0 },
  );
  await engine.start();
  await engine.idle();
  const settle = async () => {
    await engine.idle();
    await engine.flushActivity();
  };
  return { server, alice, bob, carol, channel, store, engine, calls, reactions, settle };
}

describe("SyncEngine and the activity (M39)", () => {
  it("takes the badge from bootstrap; a server before M39 sends none and nothing is asked for", async () => {
    const old = await setup({ activity: false });
    expect(old.store.activity).toBeNull();
    old.server.post(old.channel.id, old.alice.id, `<@${old.bob.id}> 見て`);
    await old.settle();
    expect(old.calls.summary).toBe(0);
    old.engine.stop();

    const w = await setup();
    expect(w.store.activity).toMatchObject({ unread_count: 0, mention_unread: false });
    w.engine.stop();
  });

  it("asks for the summary on a mention, a reply in a thread I follow, a reaction to my message; not for my own posts or other messages", async () => {
    const w = await setup();
    w.server.post(w.channel.id, w.alice.id, "ただの投稿");
    await w.settle();
    expect(w.calls.summary).toBe(0);

    w.server.post(w.channel.id, w.alice.id, `<@${w.bob.id}> 見て`);
    await w.settle();
    expect(w.calls.summary).toBe(1);
    expect(w.store.activity).toMatchObject({ unread_count: 1, mention_unread: true });

    // A thread bob follows (his reply), a reply by alice.
    const parent = w.server.post(w.channel.id, w.carol.id, "親").message;
    w.server.post(w.channel.id, w.bob.id, "bob の返信", undefined, parent.id);
    await w.settle();
    expect(w.calls.summary).toBe(1); // my own reply is nothing new
    w.server.post(w.channel.id, w.alice.id, "alice の返信", undefined, parent.id);
    await w.settle();
    expect(w.calls.summary).toBe(2);
    expect(w.store.activity?.unread_count).toBe(2);

    // Carol reacts to bob's message: reaction.added to bob only.
    // (Posting at the top level reads the channel: read.updated, and the mention above was read there, §6.4.)
    const mine = w.server.post(w.channel.id, w.bob.id, "bob の投稿").message;
    await w.settle();
    expect(w.calls.summary).toBe(3);
    expect(w.store.activity?.unread_count).toBe(1);
    w.server.react(w.channel.id, w.carol.id, mine.id, "👍", true);
    await w.settle();
    expect(w.calls.summary).toBe(4);
    expect(w.store.activity?.unread_count).toBe(2);
    // Taken back: no event (the list drops it; the next bootstrap or event corrects the badge).
    w.server.react(w.channel.id, w.carol.id, mine.id, "👍", false);
    await w.settle();
    expect(w.calls.summary).toBe(4);
    w.engine.stop();
  });

  it("2026-10-06 (§6.4): reading the mention's conversation or the reply's thread on another device recounts the badge (read.updated, thread.updated read)", async () => {
    const w = await setup();
    w.server.post(w.channel.id, w.alice.id, `<@${w.bob.id}> 見て`);
    const parent = w.server.post(w.channel.id, w.carol.id, "親").message;
    w.server.post(w.channel.id, w.bob.id, "bob の返信", undefined, parent.id);
    const reply = w.server.post(w.channel.id, w.alice.id, "alice の返信", undefined, parent.id).message;
    await w.settle();
    expect(w.store.activity).toMatchObject({ unread_count: 2, mention_unread: true });
    expect(w.server.listActivity(w.bob.id, "all", null, 50).items.map((i) => [i.kind, i.read])).toEqual([["thread_reply", false], ["mention", false]]);

    // Another device reads the conversation: read.updated, the summary again — the mention is read, the reply is not.
    const calls = w.calls.summary;
    w.server.markRead(w.bob.id, w.channel.id, parent.seq);
    await w.settle();
    expect(w.calls.summary).toBe(calls + 1);
    expect(w.store.activity).toMatchObject({ unread_count: 1, mention_unread: false });
    expect(w.store.activityReloads).toBe(0);

    // Back to unread from the mention (「ここから未読にする」 elsewhere): unread again, and the list is to load again.
    w.server.markRead(w.bob.id, w.channel.id, parent.seq - 2, "set");
    await w.settle();
    expect(w.store.activity).toMatchObject({ unread_count: 2, mention_unread: true });
    expect(w.store.activityReloads).toBe(1);

    // Another device reads the thread: thread.updated (read), the summary again; the store keeps that position.
    w.server.markThreadRead(w.bob.id, parent.id, reply.seq);
    await w.settle();
    expect(w.store.activity).toMatchObject({ unread_count: 1, mention_unread: true });
    expect(w.store.threadReadSeqs.get(parent.id)).toBe(reply.seq);
    w.engine.stop();
  });

  it("2026-10-06: this device's own read of the conversation or the thread recounts at once (the PUT's answer, not the event)", async () => {
    const w = await setup({ active: true });
    w.server.post(w.channel.id, w.alice.id, `<@${w.bob.id}> 見て`);
    const parent = w.server.post(w.channel.id, w.carol.id, "親").message;
    w.server.post(w.channel.id, w.bob.id, "bob の返信", undefined, parent.id);
    const reply = w.server.post(w.channel.id, w.alice.id, "alice の返信", undefined, parent.id).message;
    await w.settle();
    await w.engine.openChannel(w.channel.id);
    expect(await w.engine.loadReplies(w.channel.id, parent.id)).toBe(true);
    // From here nothing reaches this device over the socket: only the PUT answers can bring the new count.
    for (const socket of w.server.sockets) socket.silent = true;
    w.engine.markRead(w.channel.id, parent.seq, { force: true });
    await w.engine.flushReads();
    await w.engine.flushActivity();
    expect(w.store.activity).toMatchObject({ unread_count: 1, mention_unread: false });

    w.engine.markThreadRead(parent.id, reply.seq);
    expect(w.store.threadReadSeqs.get(parent.id)).toBe(reply.seq); // the list's dot goes before the PUT
    await w.engine.flushReads();
    await w.engine.flushActivity();
    expect(w.store.activity).toMatchObject({ unread_count: 0, mention_unread: false });
    w.engine.stop();
  });

  it("reads up to a time (PUT /activity/read) and follows my other device's activity.read", async () => {
    const w = await setup();
    w.server.post(w.channel.id, w.alice.id, `<@${w.bob.id}> 一つ目`);
    const second = w.server.post(w.channel.id, w.alice.id, `<@${w.bob.id}> 二つ目`).message;
    await w.settle();
    expect(w.store.activity?.unread_count).toBe(2);
    const first = w.server.activityItems(w.bob.id).at(-1)!;
    await w.engine.markActivityRead(first.at);
    expect(w.store.activity).toMatchObject({ read_at: first.at, unread_count: 1 });
    await w.settle();
    // The other device reads everything: activity.read moves the position, the summary brings the count.
    w.server.markActivityRead(w.bob.id, second.created_at);
    await w.settle();
    expect(w.store.activity).toMatchObject({ read_at: second.created_at, unread_count: 0, mention_unread: false });
    // Never backwards: a PUT behind the position changes nothing.
    await w.engine.markActivityRead(first.at);
    expect(w.store.activity?.read_at).toBe(second.created_at);
    w.engine.stop();
  });

  it("shows a reaction banner only with notify_reactions on, not in a muted or silent conversation, nor the one on screen", async () => {
    const off = await setup();
    const mineOff = off.server.post(off.channel.id, off.bob.id, "投稿").message;
    await off.settle();
    off.server.react(off.channel.id, off.alice.id, mineOff.id, "👍", true);
    await off.settle();
    expect(off.reactions).toEqual([]);
    off.engine.stop();

    const w = await setup({ notifyReactions: true, active: true });
    const mine = w.server.post(w.channel.id, w.bob.id, "投稿").message;
    await w.settle();
    w.server.react(w.channel.id, w.alice.id, mine.id, "🎉", true);
    await w.settle();
    expect(w.reactions.map((r) => [r.reaction.emoji, r.reaction.user_id, r.channel])).toEqual([["🎉", w.alice.id, w.channel.id]]);
    // Looking at that conversation (the window in use): no banner.
    await w.engine.openChannel(w.channel.id);
    w.server.react(w.channel.id, w.carol.id, mine.id, "👀", true);
    await w.settle();
    expect(w.reactions).toHaveLength(1);
    w.engine.closeChannel();
    // Muted until unmuted, then the level "none": nothing either.
    w.server.setNotificationPreference(w.bob.id, w.channel.id, { level: null, muted: true });
    await w.settle();
    w.server.react(w.channel.id, w.alice.id, mine.id, "👍", true);
    await w.settle();
    expect(w.reactions).toHaveLength(1);
    w.server.setNotificationPreference(w.bob.id, w.channel.id, { level: "none", muted: false });
    await w.settle();
    w.server.react(w.channel.id, w.carol.id, mine.id, "👍", true);
    await w.settle();
    expect(w.reactions).toHaveLength(1);
    // Back to following the overall setting: the next one shows.
    w.server.setNotificationPreference(w.bob.id, w.channel.id, { level: null, muted: false });
    await w.settle();
    w.server.react(w.channel.id, w.alice.id, mine.id, "🙏", true);
    await w.settle();
    expect(w.reactions.map((r) => r.reaction.emoji)).toEqual(["🎉", "🙏"]);
    w.engine.stop();
  });
});
