import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "../src/api/errors";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

async function setup(options: { hold?: boolean; active?: boolean; prepare?: () => Promise<void> } = {}) {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", alice.id);
  server.join(channel.id, bob.id);
  const store = new Store();
  const notifications: string[] = [];
  const engine = new SyncEngine(
    {
      api: server.apiFor(bob.id),
      connect: server.connectorFor(bob.id),
      store,
      getAccessToken: () => "token",
      prepareConnection: options.prepare,
      sleep: async () => {},
      random: () => 0.5,
      onNotify: (message) => notifications.push(message.body),
      isActive: () => options.active ?? false,
    },
    { pageSize: 3, gapLimit: 5, reconnectMinMs: 0 },
  );
  if (options.hold) server.holdEvents = true;
  return { server, alice, bob, channel, store, engine, notifications };
}

describe("SyncEngine", () => {
  it("bootstraps and loads the latest page of the opened channel", async () => {
    const { server, alice, channel, store, engine } = await setup();
    for (let i = 1; i <= 5; i++) server.post(channel.id, alice.id, `m${i}`);
    await engine.openChannel(channel.id); // before start: remembered as the current channel
    await engine.start();
    await engine.idle();
    expect(engine.status).toBe("online");
    expect(store.me?.username).toBe("bob");
    expect(store.getChannel(channel.id)?.isMember).toBe(true);
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["m3", "m4", "m5"]);
    expect(store.getChannel(channel.id)?.syncedSeq).toBe(5);
    expect(store.getChannel(channel.id)?.hasOlder).toBe(true);
    await engine.loadOlder(channel.id);
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(store.getChannel(channel.id)?.hasOlder).toBe(false);
  });

  it("applies contiguous live events and detects gaps", async () => {
    const { server, alice, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    server.post(channel.id, alice.id, "m1");
    await engine.idle();
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["m1"]);

    server.socketsOf(engine.store.me!.id)[0]!.dropNext = 2; // m2 and m3 are lost on the wire
    server.post(channel.id, alice.id, "m2");
    server.post(channel.id, alice.id, "m3");
    await engine.idle();
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["m1"]);
    server.post(channel.id, alice.id, "m4"); // seq 4 > synced 1 + 1: gap → catch_up
    await engine.idle();
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(store.getChannel(channel.id)?.syncedSeq).toBe(4);
  });

  it("buffers events that arrive during bootstrap", async () => {
    const { server, alice, channel, store, engine } = await setup({ hold: true });
    await engine.openChannel(channel.id);
    const started = engine.start();
    server.holdEvents = false;
    server.post(channel.id, alice.id, "during"); // arrives while bootstrap is in flight
    await started;
    await engine.idle();
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["during"]);
  });

  it("sends optimistically, reconciles the placeholder and never duplicates on retry", async () => {
    const { server, bob, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    const api = server.apiFor(bob.id);
    api.failNext(new NetworkError("offline"));
    (engine as unknown as { deps: { api: typeof api } }).deps.api = api;

    await engine.send(channel.id, "hello");
    expect(store.outbox).toHaveLength(1); // temporary failure keeps it queued
    expect(store.messages(channel.id).map((m) => [m.body, m.pending])).toEqual([["hello", true]]);

    await engine.flushOutbox(); // retry with the same client_msg_id
    await engine.idle();
    expect(store.outbox).toHaveLength(0);
    const messages = store.messages(channel.id);
    expect(messages.map((m) => [m.body, m.seq, m.pending ?? false])).toEqual([["hello", 1, false]]);
    expect(server.channels.get(channel.id)!.messages).toHaveLength(1);
  });

  it("marks permanent failures and lets the user discard them", async () => {
    const { server, bob, channel, store, engine } = await setup();
    await engine.start();
    const api = server.apiFor(bob.id);
    api.failNext(new ApiError(409, "channel_archived", "archived"));
    (engine as unknown as { deps: { api: typeof api } }).deps.api = api;
    await engine.send(channel.id, "nope");
    expect(store.outbox[0]?.failed).toBe("channel_archived");
    expect(store.messages(channel.id)[0]?.failed).toBe(true);
    engine.discardFailed(store.outbox[0]!.client_msg_id);
    expect(store.outbox).toHaveLength(0);
    expect(store.messages(channel.id)).toHaveLength(0);
  });

  it("reconnects after a dropped socket and recovers missed events", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    server.post(channel.id, alice.id, "m1");
    await engine.idle();
    server.disconnect(bob.id);
    server.post(channel.id, alice.id, "m2");
    server.post(channel.id, alice.id, "m3");
    for (let i = 0; i < 20 && engine.status !== "online"; i++) await engine.idle();
    await engine.idle();
    expect(engine.status).toBe("online");
    expect(engine.stats.reconnects).toBe(1);
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["m1", "m2", "m3"]);
  });

  it("signs out when the session is revoked", async () => {
    const { server, bob, engine } = await setup();
    let signedOut = false;
    (engine as unknown as { deps: { onSignedOut: () => void } }).deps.onSignedOut = () => {
      signedOut = true;
    };
    await engine.start();
    server.revokeSession(bob.id);
    await engine.idle();
    expect(engine.status).toBe("signed_out");
    expect(signedOut).toBe(true);
  });

  it("notifies for direct messages from others when the window is inactive", async () => {
    const { server, alice, bob, store, engine, notifications } = await setup();
    const dm = server.createChannel("", alice.id, "dm");
    server.join(dm.id, bob.id);
    await engine.start();
    server.post(dm.id, alice.id, "psst");
    await engine.idle();
    expect(notifications).toEqual(["psst"]);
    expect(store.getChannel(dm.id)?.lastSeq).toBe(1);
  });

  it("resumes from a persisted snapshot after a restart", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    server.post(channel.id, alice.id, "m1");
    await engine.idle();
    engine.stop();
    server.post(channel.id, alice.id, "m2");

    const restored = Store.fromSnapshot(store.snapshot());
    const second = new SyncEngine(
      { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store: restored, getAccessToken: () => "t", sleep: async () => {} },
      { pageSize: 3 },
    );
    await second.openChannel(channel.id);
    await second.start();
    await second.idle();
    expect(restored.messages(channel.id).map((m) => m.body)).toEqual(["m1", "m2"]);
    expect(restored.getChannel(channel.id)?.syncedSeq).toBe(2);
  });
});

describe("channel browsing", () => {
  it("lists public channels created before login and reflects joining", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const general = server.createChannel("general", alice.id);
    const secret = server.createChannel("secret", alice.id, "private");
    const store = new Store();
    const engine = new SyncEngine(
      { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} },
      { pageSize: 3 },
    );
    await engine.start();
    await engine.idle();
    expect(store.getChannel(general.id)?.isMember).toBe(false); // browsable
    expect(store.getChannel(secret.id)).toBeUndefined(); // private channels stay invisible

    server.join(general.id, bob.id);
    server.emitMembership(general.id, bob.id);
    await engine.idle();
    expect(store.getChannel(general.id)?.isMember).toBe(true);
    engine.stop();
  });
});

describe("edits, deletions, reactions and mentions (M8a)", () => {
  it("applies live edits, deletions and reactions in order", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    const { message: m1 } = server.post(channel.id, alice.id, "m1");
    const { message: m2 } = server.post(channel.id, alice.id, "m2");
    await engine.idle();
    server.edit(channel.id, alice.id, m1.id, "m1 edited");
    await engine.idle();
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["m1 edited", "m2"]);
    expect(store.messages(channel.id)[0]?.edited_at).toBeTruthy();
    server.react(channel.id, bob.id, m2.id, "👍", true);
    await engine.idle();
    expect(store.messages(channel.id)[1]?.reactions).toEqual([{ emoji: "👍", count: 1, user_ids: [bob.id] }]);
    server.react(channel.id, bob.id, m2.id, "👍", false);
    await engine.idle();
    expect(store.messages(channel.id)[1]?.reactions).toEqual([]);
    server.delete(channel.id, alice.id, m2.id);
    await engine.idle();
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["m1 edited"]);
    expect(store.getChannel(channel.id)?.syncedSeq).toBe(6);
  });

  it("notifies for channel messages only when mentioned", async () => {
    const { server, alice, bob, channel, engine, notifications } = await setup();
    await engine.start();
    await engine.idle();
    server.post(channel.id, alice.id, "plain");
    await engine.idle();
    expect(notifications).toEqual([]);
    server.post(channel.id, alice.id, `hey <@${bob.id}>`);
    server.post(channel.id, alice.id, "<!here> all");
    await engine.idle();
    expect(notifications).toEqual([`hey <@${bob.id}>`, "<!here> all"]);
  });

  it("follows the channel notification level: all notifies everything, none and a mute silence mentions", async () => {
    const { server, alice, bob, channel, store, engine, notifications } = await setup();
    await engine.start();
    await engine.idle();
    store.setNotification(channel.id, "all", null);
    server.post(channel.id, alice.id, "every message");
    await engine.idle();
    expect(notifications).toEqual(["every message"]);
    store.setNotification(channel.id, "none", null);
    server.post(channel.id, alice.id, `silenced <@${bob.id}>`);
    await engine.idle();
    store.setNotification(channel.id, "mentions", new Date(Date.now() + 3600_000).toISOString());
    server.post(channel.id, alice.id, `muted <@${bob.id}>`);
    await engine.idle();
    expect(notifications).toEqual(["every message"]);
    store.setNotification(channel.id, "mentions", new Date(Date.now() - 1000).toISOString());
    server.post(channel.id, alice.id, `expired mute <@${bob.id}>`);
    await engine.idle();
    expect(notifications).toEqual(["every message", `expired mute <@${bob.id}>`]);
  });
});

describe("read state (M8b)", () => {
  it("counts unread and mentions, follows reads from other devices and clears on own sends", async () => {
    const { server, alice, bob, channel, store, engine } = await setup({ active: true });
    server.post(channel.id, alice.id, "m1");
    server.post(channel.id, alice.id, "m2");
    await engine.start();
    await engine.idle();
    expect(store.getChannel(channel.id)?.unreadCount).toBe(2);
    server.post(channel.id, alice.id, `hey <@${bob.id}>`);
    await engine.idle();
    expect([store.getChannel(channel.id)?.unreadCount, store.getChannel(channel.id)?.mentionCount]).toEqual([3, 1]);
    engine.markRead(channel.id, 2);
    await engine.flushReads();
    let state = store.getChannel(channel.id)!;
    expect([state.lastReadSeq, state.unreadCount, state.mentionCount]).toEqual([2, 1, 1]);
    server.markRead(bob.id, channel.id, 3); // another device of bob
    await engine.idle();
    state = store.getChannel(channel.id)!;
    expect([state.lastReadSeq, state.unreadCount, state.mentionCount]).toEqual([3, 0, 0]);
    engine.markRead(channel.id, 1); // stale: ignored
    await engine.flushReads();
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(3);
    server.post(channel.id, alice.id, "m4");
    await engine.idle();
    await engine.openChannel(channel.id);
    await engine.send(channel.id, "mine");
    await engine.idle();
    state = store.getChannel(channel.id)!;
    expect([state.lastReadSeq, state.unreadCount, state.mentionCount]).toEqual([5, 0, 0]);
  });
});

describe("threads (M8c)", () => {
  it("keeps replies out of the timeline, updates the parent and loads a thread on demand", async () => {
    const { server, alice, bob, channel, store, engine, notifications } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    const { message: parent } = server.post(channel.id, alice.id, "topic");
    await engine.idle();
    server.post(channel.id, alice.id, "reply 1", undefined, parent.id);
    await engine.idle();
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["topic"]);
    expect(store.replies(channel.id, parent.id).map((m) => m.body)).toEqual(["reply 1"]);
    expect(store.message(channel.id, parent.id)?.reply_count).toBe(1);
    expect(notifications).toEqual([]); // bob is not part of the thread
    expect(store.getChannel(channel.id)?.unreadCount).toBe(1); // replies are not unread items

    await engine.send(channel.id, "reply 2", undefined, parent.id);
    await engine.idle();
    expect(store.replies(channel.id, parent.id).map((m) => m.body)).toEqual(["reply 1", "reply 2"]);
    expect(store.message(channel.id, parent.id)?.reply_count).toBe(2);
    server.post(channel.id, alice.id, "reply 3", undefined, parent.id);
    await engine.idle();
    expect(notifications).toEqual(["reply 3"]); // bob replied, so alice's reply notifies him

    const restored = new Store();
    const second = new SyncEngine(
      { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store: restored, getAccessToken: () => "t", sleep: async () => {} },
      {},
    );
    await second.start();
    await second.idle();
    expect(restored.replies(channel.id, parent.id)).toHaveLength(0);
    await second.loadReplies(channel.id, parent.id);
    expect(restored.replies(channel.id, parent.id).map((m) => m.body)).toEqual(["reply 1", "reply 2", "reply 3"]);
    second.stop();
    engine.stop();
  });
});

describe("attachments (M9a)", () => {
  it("attachment ids travel with the outbox and come back on the message", async () => {
    const { server, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    await engine.send(channel.id, "", undefined, null, ["a1", "a2"]);
    await engine.idle();
    const sent = store.messages(channel.id)[0]!;
    expect(sent.attachments?.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(server.channels.get(channel.id)!.messages[0]!.attachments.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});


describe("mark as unread (§10 mode=set)", () => {
  it("moves the position back, pauses visible marking until the channel is left, and follows other devices", async () => {
    const { server, alice, bob, channel, store, engine } = await setup({ active: true });
    for (const body of ["m1", "m2", "m3"]) server.post(channel.id, alice.id, body);
    await engine.start();
    await engine.openChannel(channel.id);
    engine.markRead(channel.id, 3);
    await engine.flushReads();
    expect(store.getChannel(channel.id)?.unreadCount).toBe(0);

    engine.markUnread(channel.id, 2); // 「ここから未読にする」 on m2
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(1);
    expect(store.getChannel(channel.id)?.unreadCount).toBe(2);
    await engine.flushReads();
    expect(server.readState(bob.id, channel.id).last_read_seq).toBe(1);
    // Visible-range marking is ignored while the hold is on…
    engine.markRead(channel.id, 3);
    await engine.flushReads();
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(1);
    // …an explicit read (Esc) overrides it…
    engine.markRead(channel.id, 3, { force: true });
    await engine.flushReads();
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(3);
    // …and leaving the channel drops the hold.
    engine.markUnread(channel.id, 3);
    await engine.flushReads();
    const other = server.createChannel("other", alice.id);
    server.join(other.id, bob.id);
    store.upsertChannel(other, { isMember: true });
    await engine.openChannel(other.id);
    engine.markRead(channel.id, 3);
    await engine.flushReads();
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(3);

    // Another device marking unread arrives as read.updated and lowers the position here too.
    server.markRead(bob.id, channel.id, 0, "set");
    await engine.idle();
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(0);
    expect(store.getChannel(channel.id)?.unreadCount).toBe(3);
    // A plain advance event that is behind the local position (an older PUT of ours) must not lower it.
    engine.markRead(channel.id, 3);
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(3);
    server.markRead(bob.id, channel.id, 2);
    await engine.idle();
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(3);
    await engine.flushReads();
    engine.stop();
  });
});

describe("conversation safety", () => {
  it("does not mark an opened channel read while inactive or offline", async () => {
    const { server, alice, channel, store, engine } = await setup();
    server.post(channel.id, alice.id, "unseen");
    await engine.start();
    await engine.openChannel(channel.id);
    expect(store.getChannel(channel.id)?.unreadCount).toBe(1);
    engine.markRead(channel.id, 1);
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(0);
    engine.stop();
    engine.markRead(channel.id, 1);
    expect(store.getChannel(channel.id)?.lastReadSeq).toBe(0);
    await engine.send(channel.id, "offline send");
    expect(store.outbox).toHaveLength(1);
    expect(server.channels.get(channel.id)!.messages).toHaveLength(1);
    await engine.start();
    await engine.idle();
    expect(store.outbox).toHaveLength(0);
    expect(server.channels.get(channel.id)!.messages).toHaveLength(2);
    engine.stop();
  });

  it("retries a temporary session restoration failure without signing out", async () => {
    let attempts = 0;
    const { engine, store } = await setup({ prepare: async () => {
      if (++attempts === 1) throw new NetworkError("offline");
    } });
    store.setDraft("channel", null, { text: "offline draft" });
    await engine.start();
    for (let i = 0; i < 20; i++) await engine.idle();
    expect(engine.status).toBe("online");
    expect(attempts).toBe(2);
    expect(store.draft("channel").text).toBe("offline draft");
    engine.stop();
  });

  it("signs out if restoring the session is rejected", async () => {
    const { engine } = await setup({ prepare: async () => { throw new ApiError(401, "session_revoked", "revoked"); } });
    await engine.start();
    expect(engine.status).toBe("signed_out");
    engine.stop();
  });
});

describe("followed threads (M11a)", () => {
  it("lists followed threads, counts unread replies and marks them read", async () => {
    const { server, alice, bob, channel, store, engine } = await setup({ active: true });
    await engine.start();
    await engine.openChannel(channel.id);
    expect(store.threadSummary).toEqual({ unread_count: 0, mention_count: 0 });

    // bob's own topic: alice's reply makes it a followed, unread thread (badge via thread.updated).
    await engine.send(channel.id, "topic");
    await engine.idle();
    const parent = server.messageByBody(channel.id, "topic");
    server.post(channel.id, alice.id, `<@${bob.id}> reply 1`, undefined, parent.id);
    await engine.flushThreads();
    expect(store.threadSummary).toEqual({ unread_count: 1, mention_count: 1 });
    expect(store.threadsLoaded).toBe(false); // only the badge until the view opens

    await engine.loadThreads("all");
    const rows = store.threadList();
    expect(rows.map((r) => r.parent.body)).toEqual(["topic"]);
    expect(rows[0]!.state).toMatchObject({ following: true, last_read_seq: 0, unread_count: 1, mention_count: 1, reply_count: 1, participant_ids: [bob.id, alice.id] });

    // Showing the reply marks the thread read (debounced PUT); the badge drops at once.
    const reply = server.messageByBody(channel.id, `<@${bob.id}> reply 1`);
    await engine.loadReplies(channel.id, parent.id);
    engine.markThreadRead(parent.id, reply.seq);
    expect(store.threads.get(parent.id)?.state).toMatchObject({ last_read_seq: reply.seq, unread_count: 0 });
    expect(store.threadSummary).toEqual({ unread_count: 0, mention_count: 0 });
    await engine.flushThreads();
    expect(server.threadState(bob.id, parent.id).last_read_seq).toBe(reply.seq);
    expect(store.threadList("unread")).toEqual([]);

    // A newer reply arriving while the list is open shows up as unread again.
    server.post(channel.id, alice.id, "reply 2", undefined, parent.id);
    await engine.flushThreads();
    expect(store.threads.get(parent.id)?.state).toMatchObject({ unread_count: 1, mention_count: 0, reply_count: 2 });
    expect(store.threadSummary).toEqual({ unread_count: 1, mention_count: 0 });
    engine.stop();
  });

  it("unfollowing drops the thread from the list and from notifications; a thread opened from a channel loads its state", async () => {
    const { server, alice, bob, channel, store, engine, notifications } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    const { message: parent } = server.post(channel.id, alice.id, "alice topic");
    await engine.idle();
    await engine.send(channel.id, "my reply", undefined, parent.id); // bob follows by replying
    await engine.flushThreads();
    expect(store.threads.get(parent.id)?.state).toMatchObject({ following: true, unread_count: 0 }); // thread.updated

    // A fresh client (nothing fetched yet) asks for the state when the thread pane opens.
    const fresh = new Store();
    const second = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store: fresh, getAccessToken: () => "t", sleep: async () => {} }, {});
    await second.start();
    await second.openChannel(channel.id);
    await second.idle();
    expect(fresh.threads.get(parent.id)).toBeUndefined();
    await second.loadThreadState(parent.id);
    expect(fresh.threads.get(parent.id)?.state).toMatchObject({ following: true, last_read_seq: 2, unread_count: 0, reply_count: 1 });
    second.stop();

    await engine.setThreadFollow(parent.id, false);
    expect(store.threads.get(parent.id)?.state.following).toBe(false);
    await engine.loadThreads("all");
    expect(store.threadList()).toEqual([]);
    server.post(channel.id, alice.id, "alice again", undefined, parent.id);
    await engine.flushThreads();
    expect(notifications).toEqual([]); // no longer a participant
    expect(store.threadSummary).toEqual({ unread_count: 0, mention_count: 0 });

    await engine.setThreadFollow(parent.id, true);
    await engine.flushThreads();
    expect(store.threadList().map((r) => r.parent.id)).toEqual([parent.id]);
    expect(store.threads.get(parent.id)?.state).toMatchObject({ following: true, unread_count: 1 });
    engine.stop();
  });

  it("pages the list and reloads it after reconnecting", async () => {
    const { server, alice, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    for (let i = 1; i <= 3; i++) {
      await engine.send(channel.id, `topic ${i}`);
      await engine.idle();
      server.post(channel.id, alice.id, `re ${i}`, undefined, server.messageByBody(channel.id, `topic ${i}`).id);
    }
    await engine.flushThreads();
    // thread.updated created the rows (the parents are in the timeline): pages merge into what is known.
    expect(store.threadList().map((r) => r.parent.body)).toEqual(["topic 3", "topic 2", "topic 1"]);
    const me = store.me!.id;
    engine.stop();

    const fresh = new Store();
    const paged = new SyncEngine({ api: server.apiFor(me), connect: server.connectorFor(me), store: fresh, getAccessToken: () => "t", sleep: async () => {} }, { threadPageSize: 2 });
    await paged.start();
    await paged.loadThreads("all");
    expect(fresh.threadList().map((r) => r.parent.body)).toEqual(["topic 3", "topic 2"]);
    expect(fresh.threadsHasMore).toBe(true);
    await paged.loadThreads("all", { more: true });
    expect(fresh.threadList().map((r) => r.parent.body)).toEqual(["topic 3", "topic 2", "topic 1"]);
    expect(fresh.threadsHasMore).toBe(false);

    // A thread unfollowed elsewhere disappears from the next first page; older rows stay.
    server.setThreadFollow(me, server.messageByBody(channel.id, "topic 3").id, false);
    await paged.flushThreads();
    server.disconnect(me);
    await paged.idle();
    await paged.flushThreads();
    expect(fresh.threadsLoaded).toBe(true);
    expect(fresh.threadList().map((r) => r.parent.body)).toEqual(["topic 2", "topic 1"]);
    expect(fresh.threadSummary.unread_count).toBe(2);
    paged.stop();
  });
});
