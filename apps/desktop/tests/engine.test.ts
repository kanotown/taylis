import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "../src/api/errors";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

async function setup(options: { hold?: boolean } = {}) {
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
      sleep: async () => {},
      random: () => 0.5,
      onNotify: (message) => notifications.push(message.body),
      isActive: () => false,
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
});

describe("read state (M8b)", () => {
  it("counts unread and mentions, follows reads from other devices and clears on own sends", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
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
