/**
 * M17 (SYNC_PROTOCOL.md §10.1 / §10.2): the first unread row not loaded. Engine-level checks of the shared
 * test vectors of SYNC_PROTOCOL.md §10.4 (V2 … V29) against the fake server, with its real-shaped rows (client_msg_id ≠ id).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { NetworkError } from "../src/api/errors";
import { dividerMark, firstUnreadRow, jumpButtonShown } from "../src/sync/readGate";
import { bannerText } from "../src/ui/format";
import { holdFrames, openFirst, stamp, threadWorld, type World, world } from "./unreadWorld";

const now = new Date(2026, 8, 28, 15, 0); // Monday, local time

afterEach(() => {
  vi.restoreAllMocks();
});

const seqs = (w: World) => w.store.messages(w.channelId).map((m) => m.seq);
const state = (w: World) => w.store.getChannel(w.channelId)!;

describe("the first unread row not loaded (§10.1, M17)", () => {
  it("V2 (M17 acceptance): opening 2,000 unread never sends PUT /read past the loaded start; V3: 「既読にする」 does", async () => {
    const w = world({ posts: 3000, lastRead: 1000 });
    stamp(w, 1001, new Date(2026, 8, 28, 10, 23));
    await openFirst(w);
    expect(seqs(w)).toHaveLength(50);
    expect(seqs(w)[0]).toBe(2951);
    expect(state(w)).toMatchObject({ oldestLoadedSeq: 2951, lastReadSeq: 1000, unreadCount: 2000 });
    expect(w.engine.readRangeReady(w.channelId)).toBe(false);
    expect(dividerMark(null, 1000, state(w).oldestLoadedSeq)).toBeNull(); // no divider
    expect(bannerText(state(w).unreadCount, state(w).firstUnreadAt, now)).toBe("未読 2,000 件 · 10:23 以降");
    expect(jumpButtonShown(false, 2000)).toBe(false); // only 「既読にする」

    w.engine.markRead(w.channelId, 3000); // rows 2980..3000 on screen
    expect(state(w)).toMatchObject({ lastReadSeq: 1000, pendingReadSeq: null, unreadCount: 2000 });
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([]);
    expect(w.server.readState(w.bob.id, w.channelId).last_read_seq).toBe(1000);

    // V3: the banner's 「既読にする」
    w.engine.markRead(w.channelId, 3000, { force: true });
    expect(state(w)).toMatchObject({ lastReadSeq: 3000, unreadCount: 0, firstUnreadAt: null });
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([{ seq: 3000, mode: "advance" }]);
    expect(w.server.readState(w.bob.id, w.channelId)).toMatchObject({ last_read_seq: 3000, unread_count: 0, first_unread_at: null });
    w.engine.stop();
  });

  it("V8: a new message while not ready adds to the count and keeps the time; V9: my own post reads everything", async () => {
    const w = world({ posts: 3000, lastRead: 1000 });
    stamp(w, 1001, new Date(2026, 8, 28, 10, 23));
    await openFirst(w);
    const since = state(w).firstUnreadAt;
    w.server.post(w.channelId, w.alice.id, "m3001");
    await w.engine.idle();
    w.engine.markRead(w.channelId, 3001); // visible at the bottom
    await w.engine.flushReads();
    expect(state(w)).toMatchObject({ unreadCount: 2001, lastReadSeq: 1000, firstUnreadAt: since });
    expect(bannerText(2001, since, now)).toBe("未読 2,001 件 · 10:23 以降");
    expect(w.calls.reads).toEqual([]);

    await w.engine.send(w.channelId, "mine");
    await w.engine.idle();
    expect(state(w)).toMatchObject({ unreadCount: 0, firstUnreadAt: null, lastReadSeq: 3002 });
    expect(w.server.readState(w.bob.id, w.channelId).last_read_seq).toBe(3002);
    w.engine.stop();
  });

  it("V9 for a poll of mine (M14b): made through its own endpoint, not the outbox, it reads the channel from its response", async () => {
    const w = world({ posts: 3000, lastRead: 1000 });
    await openFirst(w);
    const { message } = w.server.post(w.channelId, w.bob.id, "poll");
    w.engine.postedFromHere(message); // before its event or read.updated
    expect(state(w)).toMatchObject({ unreadCount: 0, firstUnreadAt: null, lastReadSeq: message.seq });
    w.engine.stop();
  });

  it("V4: 「最初の未読へ」 pages back 200 at a time until the range reaches the read position, then reading moves it", async () => {
    const w = world({ posts: 1300, lastRead: 1000 });
    await openFirst(w);
    expect(w.engine.readRangeReady(w.channelId)).toBe(false);
    expect(jumpButtonShown(false, state(w).unreadCount)).toBe(true); // 300 ≤ 500
    expect(await w.engine.loadFirstUnread(w.channelId)).toBe(true);
    expect(w.calls.history).toEqual([{ before: null, limit: 50 }, { before: 1251, limit: 200 }, { before: 1051, limit: 200 }]);
    expect(seqs(w)).toHaveLength(450);
    expect(state(w)).toMatchObject({ oldestLoadedSeq: 851, hasOlder: true });
    expect(w.engine.readRangeReady(w.channelId)).toBe(true);
    const mark = dividerMark(null, state(w).lastReadSeq, state(w).oldestLoadedSeq);
    expect(mark).toBe(1000);
    expect(firstUnreadRow(w.store.messages(w.channelId), mark!, w.bob.id)?.seq).toBe(1001);

    w.engine.markRead(w.channelId, 1012); // 1001..1012 on screen
    await w.engine.flushReads();
    expect(w.server.readState(w.bob.id, w.channelId)).toMatchObject({ last_read_seq: 1012, unread_count: 288 });
    // Already ready: pressing again makes no request.
    expect(await w.engine.loadFirstUnread(w.channelId)).toBe(true);
    expect(w.calls.history).toHaveLength(3);
    w.engine.stop();
  });

  it("V5: covers is conservative across seqs used by replies: one more page, then the divider before 104", async () => {
    const w = world({ posts: 100, lastRead: 100 });
    const parent = w.server.messageByBody(w.channelId, "m1");
    for (let i = 1; i <= 3; i++) w.server.post(w.channelId, w.alice.id, `r${i}`, undefined, parent.id);
    for (let i = 104; i <= 153; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
    await openFirst(w);
    expect(seqs(w)[0]).toBe(104);
    expect(state(w)).toMatchObject({ oldestLoadedSeq: 104, hasOlder: true, unreadCount: 50 });
    expect(w.engine.readRangeReady(w.channelId)).toBe(false); // 104 > 101
    w.engine.markRead(w.channelId, 153);
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([]);

    expect(await w.engine.loadFirstUnread(w.channelId)).toBe(true);
    expect(w.calls.history.slice(1)).toEqual([{ before: 104, limit: 200 }]);
    expect(state(w).oldestLoadedSeq).toBe(0);
    const mark = dividerMark(null, 100, state(w).oldestLoadedSeq);
    expect(firstUnreadRow(w.store.messages(w.channelId), mark!, w.bob.id)?.seq).toBe(104);
    w.engine.stop();
  });

  it("V10: a §7.3 reload after a long time offline makes the range not ready again", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    await openFirst(w);
    expect(state(w).oldestLoadedSeq).toBe(81);
    w.engine.markRead(w.channelId, 130); // V1 read to the end
    await w.engine.flushReads();
    expect(w.server.readState(w.bob.id, w.channelId).last_read_seq).toBe(130);

    w.engine.stop();
    for (let i = 131; i <= 6130; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
    await w.engine.start();
    await w.engine.idle();
    expect(w.engine.stats.reloads).toBe(1);
    expect(state(w)).toMatchObject({ unreadCount: 6000, lastReadSeq: 130, oldestLoadedSeq: 6081 });
    expect(w.engine.readRangeReady(w.channelId)).toBe(false);
    expect(jumpButtonShown(false, 6000)).toBe(false);
    w.engine.markRead(w.channelId, 6130);
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([{ seq: 130, mode: "advance" }]);
    expect(w.server.readState(w.bob.id, w.channelId).last_read_seq).toBe(130);
    w.engine.stop();
  });

  it("V15: rows that are not unread (system rows) make the jump stop after 4 pages; a second press goes on", async () => {
    const w = world({ posts: 2200, lastRead: 1000 });
    // 1001..2200: every fourth row is alice's post, the rest system rows (not counted as unread).
    for (const message of w.server.channels.get(w.channelId)!.messages) if (message.seq > 1000 && (message.seq - 1001) % 4 !== 0) message.type = "system";
    await openFirst(w);
    expect(state(w)).toMatchObject({ unreadCount: 300, oldestLoadedSeq: 2151 });

    expect(await w.engine.loadFirstUnread(w.channelId)).toBe(false);
    expect(w.calls.history.slice(1).map((c) => [c.before, c.limit])).toEqual([[2151, 200], [1951, 200], [1751, 200], [1551, 200]]);
    expect(state(w).oldestLoadedSeq).toBe(1351);
    expect(w.engine.readRangeReady(w.channelId)).toBe(false);

    expect(await w.engine.loadFirstUnread(w.channelId)).toBe(true);
    expect(w.calls.history.slice(5).map((c) => c.before)).toEqual([1351, 1151]);
    expect(state(w).oldestLoadedSeq).toBe(951);
    const mark = dividerMark(null, 1000, state(w).oldestLoadedSeq);
    expect(firstUnreadRow(w.store.messages(w.channelId), mark!, w.bob.id)).toMatchObject({ seq: 1001, type: "user" });
    w.engine.stop();
  });

  it("the jump waits for the first page, stops for another channel and reports errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // the queue logs the failed step
    const w = world({ posts: 1300, lastRead: 1000 });
    await w.engine.start();
    expect(await w.engine.loadFirstUnread(w.channelId)).toBe(false); // not opened: nothing loaded yet
    expect(w.calls.history).toEqual([]);
    await w.engine.openChannel(w.channelId);
    await w.engine.idle();
    w.api.failNext(new NetworkError("offline"));
    await expect(w.engine.loadFirstUnread(w.channelId)).rejects.toThrow("offline");
    expect(state(w).oldestLoadedSeq).toBe(1251);
    w.engine.currentChannelId = "elsewhere";
    expect(await w.engine.loadFirstUnread(w.channelId)).toBe(false);
    expect(w.calls.history).toHaveLength(2);
    w.engine.stop();
  });

  it("V12: a mark-as-unread from another device below the loaded range makes it not ready", async () => {
    const w = world({ posts: 1500, lastRead: 1460 });
    await openFirst(w);
    expect(w.engine.readRangeReady(w.channelId)).toBe(true); // 1451 ≤ 1461
    w.server.markRead(w.bob.id, w.channelId, 1100, "set");
    await w.engine.idle();
    expect(state(w)).toMatchObject({ lastReadSeq: 1100, unreadCount: 400 });
    expect(w.engine.readRangeReady(w.channelId)).toBe(false);
    expect(jumpButtonShown(false, 400)).toBe(true);
    w.engine.markRead(w.channelId, 1500);
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([]);
    expect(state(w).lastReadSeq).toBe(1100);
    w.engine.stop();
  });

  it("V14: nothing unread (only system rows after the position): ready without the range", async () => {
    const w = world({ posts: 160, lastRead: 100 });
    for (const message of w.server.channels.get(w.channelId)!.messages) if (message.seq > 100) message.type = "system";
    await openFirst(w);
    expect(state(w)).toMatchObject({ unreadCount: 0, oldestLoadedSeq: 111, firstUnreadAt: null });
    expect(w.engine.readRangeReady(w.channelId)).toBe(true);
    w.engine.markRead(w.channelId, 160);
    await w.engine.flushReads();
    expect(w.server.readState(w.bob.id, w.channelId).last_read_seq).toBe(160);
    w.engine.stop();
  });

  it("V28: a visible-range mark does nothing until the range is ready; a forced one reads to the end", async () => {
    const w = world({ posts: 60 });
    await openFirst(w);
    expect(state(w)).toMatchObject({ unreadCount: 60, lastReadSeq: 0, oldestLoadedSeq: 11, hasOlder: true });
    w.engine.markRead(w.channelId, 60);
    expect(state(w)).toMatchObject({ unreadCount: 60, lastReadSeq: 0, pendingReadSeq: null });
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([]);
    w.engine.markRead(w.channelId, 60, { force: true });
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([{ seq: 60, mode: "advance" }]);
    expect(state(w)).toMatchObject({ unreadCount: 0, lastReadSeq: 60, firstUnreadAt: null });
    w.engine.stop();
  });

  it("V29: firstUnreadAt follows the server and the local unread transitions", async () => {
    const w = world({ posts: 3, lastRead: 3 });
    await openFirst(w);
    expect(state(w)).toMatchObject({ unreadCount: 0, firstUnreadAt: null });
    const { message: m4 } = w.server.post(w.channelId, w.alice.id, "m4");
    await w.engine.idle();
    expect(state(w)).toMatchObject({ unreadCount: 1, firstUnreadAt: m4.created_at }); // 0 → 1
    const { message: m5 } = w.server.post(w.channelId, w.alice.id, "m5");
    await w.engine.idle();
    expect(state(w)).toMatchObject({ unreadCount: 2, firstUnreadAt: m4.created_at }); // unchanged

    w.engine.markRead(w.channelId, 5); // reaches last_seq
    expect(state(w)).toMatchObject({ unreadCount: 0, firstUnreadAt: null });
    await w.engine.flushReads();
    expect(state(w).firstUnreadAt).toBeNull();

    w.engine.markUnread(w.channelId, 4); // 「ここから未読にする」 on m4
    expect(state(w)).toMatchObject({ unreadCount: 2, firstUnreadAt: m4.created_at });
    await w.engine.flushReads();
    expect(state(w).firstUnreadAt).toBe(m4.created_at); // the PUT (set) answer

    w.server.markRead(w.bob.id, w.channelId, 4); // another device: read.updated
    await w.engine.idle();
    expect(state(w)).toMatchObject({ unreadCount: 1, firstUnreadAt: m5.created_at });

    await w.engine.markAllRead(); // read-all
    expect(state(w)).toMatchObject({ unreadCount: 0, firstUnreadAt: null });

    // Bootstrap carries it too.
    w.server.post(w.channelId, w.alice.id, "m6");
    w.engine.stop();
    await w.engine.start();
    await w.engine.idle();
    expect(state(w).firstUnreadAt).toBe(w.server.messageByBody(w.channelId, "m6").created_at);
    w.engine.stop();
  });
});

describe("round 2 rules (§10.1 1., 10.–12.)", () => {
  it("V32 / V33: after bootstrap raised last_seq and before the catch-up, the range is not ready and marks do nothing", async () => {
    const w = world({ posts: 130, lastRead: 100 });
    const other = w.server.createChannel("d", w.alice.id).id;
    w.server.join(other, w.bob.id);
    await openFirst(w);
    w.engine.markRead(w.channelId, 130);
    await w.engine.flushReads();
    await w.engine.openChannel(other); // C stays held but is not the open one: no catch-up on reconnecting
    await w.engine.idle();
    w.engine.stop();
    for (let i = 131; i <= 430; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
    await w.engine.start();
    await w.engine.idle();
    expect(state(w)).toMatchObject({ syncedSeq: 130, lastSeq: 430, lastReadSeq: 130, unreadCount: 300, oldestLoadedSeq: 81 });
    expect(w.engine.readRangeReady(w.channelId)).toBe(false); // covers(81, 130), but rows 131..430 are on their way
    w.engine.markRead(w.channelId, 200);
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([{ seq: 130, mode: "advance" }]);
    expect(state(w).lastReadSeq).toBe(130);

    await w.engine.openChannel(w.channelId); // the catch-up
    await w.engine.idle();
    expect(w.engine.readRangeReady(w.channelId)).toBe(true);
    w.engine.stop();
  });

  it("V38: 「ここから未読にする」 forward past rows not held changes nothing but the hold; within the range it sets the position", async () => {
    const w = world({ posts: 3000, lastRead: 1000 });
    await openFirst(w);
    w.engine.markUnread(w.channelId, 2990);
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([]);
    expect(state(w)).toMatchObject({ lastReadSeq: 1000, unreadCount: 2000 });
    expect(w.engine.unreadHold.get(w.channelId)).toBe(1000);
    w.engine.markRead(w.channelId, 3000); // the hold pauses visible-range reads
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([]);
    w.engine.stop();

    const v1 = world({ posts: 130, lastRead: 100 });
    await openFirst(v1);
    v1.engine.markRead(v1.channelId, 115);
    v1.engine.markUnread(v1.channelId, 125);
    await v1.engine.flushReads();
    expect(v1.calls.reads.at(-1)).toEqual({ seq: 124, mode: "set" });
    expect(state(v1)).toMatchObject({ lastReadSeq: 124, unreadCount: 6 });
    expect(v1.server.readState(v1.bob.id, v1.channelId).last_read_seq).toBe(124);
    v1.engine.stop();
  });

  it("V41: my post from another device waits for read.updated; one from this device reads at its POST answer and ends the hold", async () => {
    const w = world({ posts: 130, lastRead: 130 });
    await openFirst(w);
    const frames = holdFrames(w);
    w.server.post(w.channelId, w.alice.id, "m131");
    w.server.post(w.channelId, w.bob.id, "from my phone");
    expect(frames.held.map((f) => f.event)).toEqual(["message.created", "message.created", "read.updated"]);
    await frames.pass(1);
    expect(state(w)).toMatchObject({ lastReadSeq: 130, unreadCount: 1 });
    await frames.pass(1); // my own message.created: not unread, and the position stays
    expect(state(w)).toMatchObject({ syncedSeq: 132, lastReadSeq: 130, unreadCount: 1 });
    await frames.pass(1);
    expect(state(w)).toMatchObject({ lastReadSeq: 132, unreadCount: 0 });

    w.server.post(w.channelId, w.alice.id, "m133");
    await frames.pass();
    w.engine.markUnread(w.channelId, 133);
    await w.engine.flushReads();
    await frames.pass();
    expect(w.engine.unreadHold.get(w.channelId)).toBe(132);
    await w.engine.send(w.channelId, "from here"); // its events stay held: the POST answer alone
    expect(state(w)).toMatchObject({ lastReadSeq: 134, unreadCount: 0, firstUnreadAt: null });
    expect(w.engine.unreadHold.has(w.channelId)).toBe(false);
    await frames.pass();
    expect(state(w)).toMatchObject({ lastReadSeq: 134, unreadCount: 0 });
    w.engine.stop();
  });

  it("V41: a replayed POST (its first answer lost) reads nothing here: the unread rows posted meanwhile stay unread", async () => {
    const w = world({ posts: 130, lastRead: 130 });
    await openFirst(w);
    const post = w.api.postMessage;
    w.api.postMessage = async (...args: Parameters<typeof post>) => {
      w.api.postMessage = post;
      w.engine.stop(); // the network drops with the request on its way: the server stores 131 and reads to it...
      await post(...args);
      throw new NetworkError("no answer"); // ...but the answer never arrives
    };
    await w.engine.send(w.channelId, "lost answer");
    for (let i = 132; i <= 231; i++) w.server.post(w.channelId, w.alice.id, `m${i}`);
    const answers: boolean[] = [];
    w.api.postMessage = async (...args: Parameters<typeof post>) => {
      const answer = await post(...args);
      answers.push(answer.created);
      return answer;
    };
    await w.engine.start(); // bootstrap: read 131, 100 unread; the catch-up; then the outbox replays the POST
    await w.engine.idle();
    expect(answers).toEqual([false]);
    expect(w.store.outbox).toEqual([]);
    const first = w.store.messages(w.channelId).find((m) => m.seq === 132)!;
    expect(state(w)).toMatchObject({ lastSeq: 231, lastReadSeq: 131, unreadCount: 100, firstUnreadAt: first.created_at });
    w.engine.stop();
  });

  it("V41: rows from others that arrive before my POST's answer stay unread (counted again when all are held)", async () => {
    const w = world({ posts: 130, lastRead: 130 });
    await openFirst(w);
    const chain = () => (w.engine as unknown as { chain: Promise<void> }).chain;
    const post = w.api.postMessage;
    let m132: { created_at: string } | null = null;
    w.api.postMessage = async (...args: Parameters<typeof post>) => {
      const answer = await post(...args);
      m132 = w.server.post(w.channelId, w.alice.id, "m132 @bob").message; // its event comes before my answer
      await chain();
      expect(state(w)).toMatchObject({ lastSeq: 132, lastReadSeq: 131, unreadCount: 1 });
      return answer;
    };
    await w.engine.send(w.channelId, "mine");
    await w.engine.idle();
    expect(state(w)).toMatchObject({ lastReadSeq: 131, unreadCount: 1, firstUnreadAt: m132!.created_at });
    expect(w.server.readState(w.bob.id, w.channelId)).toMatchObject({ last_read_seq: 131, unread_count: 1 });
    w.engine.stop();
  });

  it("V42: my scheduled send does not move the read position, so a later visible mark cannot skip unread rows", async () => {
    const w = world({ posts: 3000, lastRead: 1000 });
    await openFirst(w);
    w.server.post(w.channelId, w.bob.id, "scheduled earlier", undefined, null, [], { scheduled: true });
    await w.engine.idle();
    expect(state(w)).toMatchObject({ lastSeq: 3001, lastReadSeq: 1000, unreadCount: 2000 });
    w.server.post(w.channelId, w.alice.id, "m3002");
    await w.engine.idle();
    expect(state(w)).toMatchObject({ lastReadSeq: 1000, unreadCount: 2001 });
    w.engine.markRead(w.channelId, 3002); // 3002 on screen
    await w.engine.flushReads();
    expect(w.calls.reads).toEqual([]);
    expect(w.server.readState(w.bob.id, w.channelId).last_read_seq).toBe(1000);
    w.engine.stop();
  });

  it("V44: a live system row is not unread; the next user post is, and dates 「… 以降」", async () => {
    const w = world({ posts: 130, lastRead: 130 });
    await openFirst(w);
    w.server.post(w.channelId, w.alice.id, "alice joined", undefined, null, [], { type: "system" });
    await w.engine.idle();
    expect(state(w)).toMatchObject({ unreadCount: 0, firstUnreadAt: null });
    const { message } = w.server.post(w.channelId, w.alice.id, "hello");
    await w.engine.idle();
    expect(state(w)).toMatchObject({ unreadCount: 1, firstUnreadAt: message.created_at });
    expect(w.server.readState(w.bob.id, w.channelId)).toMatchObject({ unread_count: 1, first_unread_at: message.created_at });
    w.engine.stop();
  });
});

describe("thread read marks wait for the whole thread (§10.2, M17)", () => {
  it("V24: replies seen before GET replies finished do not move the thread position; afterwards they do", async () => {
    const w = await threadWorld();
    expect(w.store.replies(w.channelId, w.parent.id).map((r) => r.body)).toEqual(["r29", "r30"]);
    expect(w.store.threads.get(w.parent.id)?.state.last_read_seq).toBe(510);
    expect(w.engine.threadComplete(w.parent.id)).toBe(false);
    w.engine.markThreadRead(w.parent.id, 530);
    await w.engine.flushReads();
    expect(w.calls.threadReads).toEqual([]);
    expect(w.store.threads.get(w.parent.id)?.state.last_read_seq).toBe(510);

    expect(await w.engine.loadReplies(w.channelId, w.parent.id)).toBe(true);
    expect(w.engine.threadComplete(w.parent.id)).toBe(true);
    const replies = w.store.replies(w.channelId, w.parent.id);
    expect(replies).toHaveLength(30);
    expect(firstUnreadRow(replies, 510, w.bob.id)?.body).toBe("r11");
    w.engine.markThreadRead(w.parent.id, 518); // r11..r18 on screen
    await w.engine.flushReads();
    expect(w.calls.threadReads).toEqual([518]);
    expect(w.server.threadState(w.bob.id, w.parent.id).last_read_seq).toBe(518);
    w.engine.stop();
  });

  it("V25: a §7.3 reload of the channel forgets that the thread was complete", async () => {
    const w = await threadWorld({ gapLimit: 100 });
    expect(await w.engine.loadReplies(w.channelId, w.parent.id)).toBe(true);
    w.engine.stop();
    for (let i = 0; i < 150; i++) w.server.post(w.channelId, w.alice.id, `later ${i}`);
    await w.engine.start();
    await w.engine.idle();
    expect(w.engine.stats.reloads).toBe(1);
    expect(w.engine.threadComplete(w.parent.id)).toBe(false);
    w.engine.markThreadRead(w.parent.id, 520);
    await w.engine.flushReads();
    expect(w.calls.threadReads).toEqual([]);

    expect(await w.engine.loadReplies(w.channelId, w.parent.id)).toBe(true);
    w.engine.markThreadRead(w.parent.id, 520);
    await w.engine.flushReads();
    expect(w.calls.threadReads).toEqual([520]);
    w.engine.stop();
  });

  it("a browsed public channel that is no longer listed leaves with its complete threads", async () => {
    const w = world({ posts: 1 });
    const browsed = w.server.createChannel("p", w.alice.id).id; // public; bob is not a member
    const { message: parent } = w.server.post(browsed, w.alice.id, "parent");
    const { message: reply } = w.server.post(browsed, w.alice.id, "reply", undefined, parent.id);
    await openFirst(w);
    expect(w.store.getChannel(browsed)?.isMember).toBe(false);
    w.api.replies = async () => [reply]; // the fake server lets only members read; the real one lets anyone read a public channel
    expect(await w.engine.loadReplies(browsed, parent.id)).toBe(true);
    w.server.channels.get(browsed)!.channel.type = "private";
    await w.engine.loadBrowsableChannels();
    expect(w.store.getChannel(browsed)).toBeUndefined();
    expect(w.engine.threadComplete(parent.id)).toBe(false);
    w.engine.stop();
  });

  it("V52: a server thread state behind this device's read (its PUT still debounced) never lowers the position", async () => {
    const w = await threadWorld();
    expect(await w.engine.loadReplies(w.channelId, w.parent.id)).toBe(true);
    await w.engine.setThreadFollow(w.parent.id, true); // thread.updated reaches bob from now on
    let release!: () => void;
    const debounce = new Promise<void>((resolve) => (release = resolve));
    (w.engine as unknown as { deps: { sleep: () => Promise<void> } }).deps.sleep = () => debounce;
    const position = () => w.store.threads.get(w.parent.id)?.state.last_read_seq;
    w.engine.markThreadRead(w.parent.id, 518); // r11..r18 on screen
    expect(position()).toBe(518);
    w.server.post(w.channelId, w.alice.id, "r31", undefined, w.parent.id); // thread.updated (reply) with last_read 510
    await w.engine.idle();
    expect(w.store.replies(w.channelId, w.parent.id).at(-1)?.body).toBe("r31");
    expect(position()).toBe(518);
    await w.engine.loadThreadState(w.parent.id); // GET thread state
    expect(position()).toBe(518);
    await w.engine.loadThreads("all"); // the threads list
    expect(position()).toBe(518);
    await w.engine.setThreadFollow(w.parent.id, false); // the follow answer
    expect(position()).toBe(518);
    release();
    await w.engine.flushReads();
    expect(w.calls.threadReads).toEqual([518]);
    expect(w.server.threadState(w.bob.id, w.parent.id).last_read_seq).toBe(518);
    w.engine.stop();
  });

  it("V53: a channel removed here (member_removed missed) and back after reconnecting: its thread is not complete until fetched again", async () => {
    const w = await threadWorld();
    expect(await w.engine.loadReplies(w.channelId, w.parent.id)).toBe(true);
    w.engine.removeChannel(w.channelId); // what leaving through the app does
    w.engine.stop();
    await w.engine.start(); // still a member on the server: bootstrap brings it back
    await w.engine.idle();
    expect(w.store.getChannel(w.channelId)?.isMember).toBe(true);
    expect(w.engine.threadComplete(w.parent.id)).toBe(false);
    w.engine.markThreadRead(w.parent.id, 520);
    await w.engine.flushReads();
    expect(w.calls.threadReads).toEqual([]);
    expect(await w.engine.loadReplies(w.channelId, w.parent.id)).toBe(true);
    w.engine.markThreadRead(w.parent.id, 520);
    await w.engine.flushReads();
    expect(w.calls.threadReads).toEqual([520]);
    w.engine.stop();
  });

  it("GET replies: false while offline, errors reach the caller, and neither completes the thread", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // the queue logs the failed step
    const w = await threadWorld();
    w.api.failNext(new NetworkError("offline"));
    await expect(w.engine.loadReplies(w.channelId, w.parent.id)).rejects.toThrow("offline");
    expect(w.engine.threadComplete(w.parent.id)).toBe(false);
    w.engine.stop();
    expect(await w.engine.loadReplies(w.channelId, w.parent.id)).toBe(false);
    expect(w.engine.threadComplete(w.parent.id)).toBe(false);
  });
});
