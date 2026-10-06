import { afterEach, describe, expect, it, vi } from "vitest";

import type { PoolOut } from "../src/api/types";
import { ApiError, NetworkError } from "../src/api/errors";
import { mentionsMe, type SyncApi, SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer, MemoryPersistence } from "./fakeServer";

async function setup(options: { hold?: boolean; active?: boolean; prepare?: (options: { refresh: boolean }) => Promise<void>; sleep?: (ms: number) => Promise<void>; store?: Store; onReservationNotice?: (notice: { text: string }) => void } = {}) {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", alice.id);
  server.join(channel.id, bob.id);
  const store = options.store ?? new Store();
  const notifications: string[] = [];
  const engine = new SyncEngine(
    {
      api: server.apiFor(bob.id),
      connect: server.connectorFor(bob.id),
      store,
      getAccessToken: () => "token",
      prepareConnection: options.prepare,
      sleep: options.sleep ?? (async () => {}),
      random: () => 0.5,
      onNotify: (message) => notifications.push(message.body),
      isActive: () => options.active ?? false,
      onReservationNotice: options.onReservationNotice,
    },
    { pageSize: 3, gapLimit: 5, reconnectMinMs: 0 },
  );
  if (options.hold) server.holdEvents = true;
  return { server, alice, bob, channel, store, engine, notifications };
}

/** Swap the engine's API (a wrapped or failing one) after it was built. */
function useApi(engine: SyncEngine, api: SyncApi): void {
  (engine as unknown as { deps: { api: SyncApi } }).deps.api = api;
}

/** Let reconnects, bootstraps and sends run until `done` (or give up after a while). */
async function settle(engine: SyncEngine, done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) await engine.idle();
  await engine.idle();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SyncEngine", () => {
  it("reports activity at once when the window loses focus", async () => {
    let active = true;
    const { server, engine } = await setup();
    (engine as unknown as { deps: { isActive: () => boolean } }).deps.isActive = () => active;
    await engine.start();
    await engine.idle();
    const sent: string[] = [];
    const ws = (engine as unknown as { ws: { send: (data: string) => void } }).ws;
    const original = ws.send.bind(ws);
    ws.send = (data: string) => {
      sent.push(data);
      original(data);
    };
    active = false;
    engine.reportActivity();
    expect(sent.map((s) => JSON.parse(s))).toEqual([{ type: "ping", active: false }]);
    void server;
  });

  it("says at once after connecting that the window is not in use, and nothing when it is", async () => {
    // The server counts a new connection as in use: a window in the background reconnecting after sleep held back the
    // phone's pushes until its first heartbeat (PUSH_NOTIFICATIONS.md §4.1).
    for (const active of [false, true]) {
      const { engine } = await setup({ active });
      await engine.start();
      await engine.idle();
      const ws = (engine as unknown as { ws: { sent: string[] } }).ws;
      const pings = ws.sent.map((s) => JSON.parse(s)).filter((f) => f.type === "ping");
      expect(pings).toEqual(active ? [] : [{ type: "ping", active: false }]);
      engine.stop();
    }
  });

  it("counts every unread row a live gap's catch-up brings, once, like the server (§7.4)", async () => {
    // Before, only the event that showed the gap was counted; the rows whose events were lost waited for the next
    // bootstrap (Android had it right).
    const { server, alice, bob, channel, store, engine } = await setup();
    for (let i = 1; i <= 3; i++) server.post(channel.id, alice.id, `m${i}`);
    server.markRead(bob.id, channel.id, 3);
    await engine.start();
    await engine.openChannel(channel.id);
    await engine.idle();
    expect(store.getChannel(channel.id)?.unreadCount).toBe(0);
    for (const socket of server.socketsOf(bob.id)) socket.dropNext = 1;
    const lost = server.post(channel.id, alice.id, "lost").message; // 4, its event lost
    server.react(channel.id, alice.id, lost.id, "👍", true); // 5: a gap, and no new row
    await engine.idle();
    expect(store.getChannel(channel.id)?.syncedSeq).toBe(5);
    expect(store.getChannel(channel.id)?.unreadCount).toBe(1);
    expect(server.readState(bob.id, channel.id).unread_count).toBe(1);
    for (const socket of server.socketsOf(bob.id)) socket.dropNext = 1;
    server.post(channel.id, alice.id, "lost too"); // 6, lost
    server.post(channel.id, alice.id, "opens the gap"); // 7
    server.post(channel.id, alice.id, "live"); // 8
    await engine.idle();
    expect(store.getChannel(channel.id)?.syncedSeq).toBe(8);
    expect(store.getChannel(channel.id)?.unreadCount).toBe(4);
    expect(server.readState(bob.id, channel.id).unread_count).toBe(4);
    engine.stop();
  });

  it("catches up a conversation opened while the connection was still starting", async () => {
    // Start-up: the connection catches up the conversation open at that moment; the reader taps another one before
    // the engine is online. That one used to stay empty ("まだメッセージはありません") until something else synced it.
    const { server, alice, bob, channel, store, engine } = await setup();
    const other = server.createChannel("random", alice.id);
    server.join(other.id, bob.id);
    server.post(other.id, alice.id, "r1");
    server.post(other.id, alice.id, "r2");
    await engine.openChannel(channel.id);
    const api = server.apiFor(bob.id);
    let tapped = false;
    useApi(engine, {
      ...api,
      history: async (channelId, beforeSeq, limit) => {
        const out = await api.history(channelId, beforeSeq, limit);
        if (!tapped) {
          tapped = true; // the tap lands after the start-up catch-up of #general, before "online"
          void engine.openChannel(other.id);
        }
        return out;
      },
    });
    await engine.start();
    await settle(engine, () => store.messages(other.id).length === 2);
    expect(engine.status).toBe("online");
    expect(store.messages(other.id).map((m) => m.body)).toEqual(["r1", "r2"]);
  });

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
    expect(store.getChannel(general.id)?.member_count).toBe(1); // M11h: shown by the channel browser
    expect(store.getChannel(secret.id)).toBeUndefined(); // private channels stay invisible

    server.join(general.id, bob.id);
    server.emitMembership(general.id, bob.id);
    await engine.idle();
    expect(store.getChannel(general.id)?.isMember).toBe(true);
    expect(store.getChannel(general.id)?.member_count).toBe(2); // member_added keeps the count current
    engine.stop();
  });
});

describe("reservation pools (M112)", () => {
  it("reads the workspace's pools after bootstrap and again (once per burst) on reservation.updated", async () => {
    const { server, store, engine } = await setup();
    const pool = { id: "p1", name: "シート", holders: [], waiting: [], bookings: [], todos: [] } as unknown as PoolOut;
    server.pools = [pool];
    expect(store.reservationPools).toBeNull();
    await engine.start();
    await engine.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.reservationPools?.map((p) => p.name)).toEqual(["シート"]);
    const reads = server.poolReads;
    server.setPools([{ ...pool, name: "Claude Premium シート" }]);
    server.setPools([{ ...pool, name: "Claude Premium シート" }]);
    await engine.idle();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(store.reservationPools?.map((p) => p.name)).toEqual(["Claude Premium シート"]);
    expect(server.poolReads).toBe(reads + 1);
    engine.stop();
  });

  it("shows a reservation notice and refreshes the activity badge", async () => {
    const notices: string[] = [];
    const { server, bob, engine } = await setup({ onReservationNotice: (n: { text: string }) => notices.push(n.text) });
    await engine.start();
    await engine.idle();
    server.noticeReservation(bob.id, "🙋 Alice さんに割り当ててください");
    await engine.idle();
    expect(notices).toEqual(["🙋 Alice さんに割り当ててください"]);
    engine.stop();
  });
});

describe("channel links (M15f)", () => {
  it("loads a conversation's links when it opens, follows changes and reloads after reconnecting", async () => {
    const { server, bob, channel, store, engine } = await setup();
    server.setLinks(channel.id, ["設計書"]);
    await engine.start();
    await engine.idle();
    expect(store.linksOf(channel.id)).toEqual([]); // not part of bootstrap
    await engine.openChannel(channel.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.linksOf(channel.id).map((l) => l.title)).toEqual(["設計書"]);
    server.setLinks(channel.id, ["設計書", "監視"]);
    await engine.idle();
    expect(store.linksOf(channel.id).map((l) => l.title)).toEqual(["設計書", "監視"]);

    server.disconnect(bob.id);
    server.links.set(channel.id, []); // changed while away, no event delivered
    await engine.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await engine.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.linksOf(channel.id)).toEqual([]);
    engine.stop();
  });
});

describe("message priority (M15e)", () => {
  it("keeps priority and the acknowledgement request through the outbox, only on top-level posts", async () => {
    const { server, bob, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    const api = server.apiFor(bob.id);
    api.failNext(new NetworkError("offline")); // the first attempt fails: the flags must survive the retry
    (engine as unknown as { deps: { api: typeof api } }).deps.api = api;
    await engine.send(channel.id, "本番を止めます", undefined, null, [], { priority: "urgent", ackRequested: true });
    const queued = store.outbox[0];
    expect(queued).toMatchObject({ priority: "urgent", ack_requested: true });
    await engine.flushOutbox();
    await engine.idle();
    const sent = store.messages(channel.id).at(-1)!;
    expect([sent.body, sent.priority, sent.ack_requested, sent.pending ?? false]).toEqual(["本番を止めます", "urgent", true, false]);
    await engine.send(channel.id, "返信", undefined, sent.id, [], { priority: "important", ackRequested: true });
    await engine.idle();
    const reply = store.replies(channel.id, sent.id).at(-1)!;
    expect([reply.priority ?? null, reply.ack_requested ?? false]).toEqual([null, false]);
    engine.stop();
  });
});

describe("channel settings (M15)", () => {
  it("keeps my owner role across channel.updated and drops a channel made private for non-members", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const general = server.createChannel("general", alice.id);
    const owner = new Store();
    const outsider = new Store();
    const engines = [new SyncEngine({ api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store: owner, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 3 }), new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store: outsider, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 3 })];
    for (const engine of engines) {
      await engine.start();
      await engine.idle();
    }
    expect(owner.getChannel(general.id)?.membership?.role).toBe("owner");
    expect(outsider.getChannel(general.id)?.isMember).toBe(false);

    server.updateChannel(general.id, { posting_policy: "owners" });
    for (const engine of engines) await engine.idle();
    expect(owner.getChannel(general.id)?.posting_policy).toBe("owners");
    expect(owner.getChannel(general.id)?.membership?.role).toBe("owner"); // the event carries no membership
    expect(outsider.getChannel(general.id)?.posting_policy).toBe("everyone"); // members-only event

    server.updateChannel(general.id, { type: "private" });
    for (const engine of engines) await engine.idle();
    expect(owner.getChannel(general.id)?.type).toBe("private");
    expect(outsider.getChannel(general.id)).toBeUndefined();

    server.updateChannel(general.id, { type: "public" });
    for (const engine of engines) await engine.idle();
    expect(outsider.getChannel(general.id)?.isMember).toBe(false); // browsable again
    for (const engine of engines) engine.stop();
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

  it("counts and notifies my notification keywords itself: the server keeps those hits private", async () => {
    const { server, alice, bob, channel, store, engine, notifications } = await setup();
    server.keywords.set(bob.id, ["デプロイ"]);
    await engine.start();
    await engine.idle();
    const before = store.getChannel(channel.id)!.mentionCount;
    server.post(channel.id, alice.id, "今夜デプロイします");
    await engine.idle();
    expect(notifications).toEqual(["今夜デプロイします"]);
    expect(store.getChannel(channel.id)!.mentionCount).toBe(before + 1);
    expect(mentionsMe({ body: "DEPLOY now" }, { id: bob.id, notify_keywords: ["deploy"] })).toBe(true);
    expect(mentionsMe({ body: "nothing" }, { id: bob.id, notify_keywords: ["deploy", ""] })).toBe(false);
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

  it("M35: takes the own level from bootstrap (follows_default) and keeps the mute until unmuted", async () => {
    const { server, bob, channel, store, engine } = await setup();
    const other = server.createChannel("other", bob.id);
    server.setNotificationPreference(bob.id, channel.id, { level: "all", muted_until: null });
    server.setNotificationPreference(bob.id, other.id, { level: null, muted_until: null, muted: true });
    server.setNotificationDefault(bob.id, "none");
    await engine.start();
    await engine.idle();
    expect(store.me?.notification_default).toBe("none");
    expect(store.getChannel(channel.id)).toMatchObject({ notificationLevel: "all", muted: false });
    // The server says "none" (resolved from the overall setting), but the channel has no level of its own.
    expect(store.getChannel(other.id)).toMatchObject({ notificationLevel: null, muted: true });
    // notification_preference.updated from another device: back to the default, unmuted.
    server.setNotificationPreference(bob.id, other.id, { level: null, muted_until: null, muted: false });
    server.setNotificationPreference(bob.id, channel.id, { level: null, muted_until: null });
    await engine.idle();
    expect(store.getChannel(other.id)).toMatchObject({ notificationLevel: null, muted: false });
    expect(store.getChannel(channel.id)).toMatchObject({ notificationLevel: null, muted: false });
  });

  it("M35: an older server's preference (no follows_default / muted) is the conversation's own level, unmuted", async () => {
    const { channel, store } = await setup();
    store.upsertChannel({ ...channel, notification: { channel_id: channel.id, level: "none", muted_until: null } as never }, { isMember: true });
    expect(store.getChannel(channel.id)).toMatchObject({ notificationLevel: "none", muted: false });
    store.applyNotificationPreference({ channel_id: channel.id, level: "all", follows_default: false, muted: true });
    expect(store.getChannel(channel.id)).toMatchObject({ notificationLevel: "all", muted: true, mutedUntil: null });
  });

  it("M35: desktop notifications follow the overall setting where the conversation has no level of its own", async () => {
    const { server, alice, bob, channel, store, engine, notifications } = await setup();
    const dm = server.createChannel("", alice.id, "dm");
    server.join(dm.id, bob.id);
    const times = server.createChannel("times-alice", alice.id);
    server.channels.get(times.id)!.channel.times_owner_id = alice.id;
    server.join(times.id, bob.id);
    await engine.start();
    await engine.idle();
    const post = async (channelId: string, body: string) => {
      server.post(channelId, alice.id, body);
      await engine.idle();
    };
    const overall = (level: "all" | "mentions" | "none") => store.setMe({ ...store.me!, notification_default: level });

    overall("all");
    await post(channel.id, "channel, all");
    await post(dm.id, "dm, all");
    await post(times.id, "times without a mention"); // someone else's times: mentions only
    await post(times.id, `times <@${bob.id}>`);
    expect(notifications).toEqual(["channel, all", "dm, all", `times <@${bob.id}>`]);

    notifications.length = 0;
    overall("mentions");
    await post(channel.id, "channel, mentions");
    await post(channel.id, `channel <@${bob.id}>`);
    await post(dm.id, "dm, mentions"); // DMs: every message unless the overall setting is "none"
    expect(notifications).toEqual([`channel <@${bob.id}>`, "dm, mentions"]);

    notifications.length = 0;
    overall("none");
    await post(dm.id, "dm, none");
    await post(channel.id, `channel none <@${bob.id}>`);
    expect(notifications).toEqual([]);
    // A level of its own wins over the overall setting; a mute until unmuted silences it again.
    store.setNotification(dm.id, "all", null);
    await post(dm.id, "dm, own level all");
    store.setNotification(dm.id, "all", null, true);
    await post(dm.id, "dm, muted");
    expect(notifications).toEqual(["dm, own level all"]);
  });
});

describe("read state (M8b)", () => {
  it("counts unread and mentions, follows reads from other devices and clears on own sends", async () => {
    const { server, alice, bob, channel, store, engine } = await setup({ active: true });
    server.post(channel.id, alice.id, "m1");
    server.post(channel.id, alice.id, "m2");
    await engine.start();
    await engine.openChannel(channel.id); // §10.1: visible rows mark read only once the unread rows are loaded
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
    expect(store.message(channel.id, parent.id)?.reply_user_ids).toEqual([bob.id, alice.id]); // C3: parent_thread carries them
    server.post(channel.id, alice.id, "reply 3", undefined, parent.id);
    await engine.idle();
    expect(store.message(channel.id, parent.id)?.reply_user_ids).toEqual([alice.id, bob.id]);
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

  it("shows a reply also sent to the channel in both places and counts it unread (M15c)", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    const { message: parent } = server.post(channel.id, alice.id, "topic");
    await engine.idle();
    server.post(channel.id, alice.id, "quiet", undefined, parent.id);
    server.post(channel.id, alice.id, "loud", undefined, parent.id, [], { alsoInChannel: true });
    await engine.idle();
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["topic", "loud"]);
    expect(store.replies(channel.id, parent.id).map((m) => m.body)).toEqual(["quiet", "loud"]);
    expect(store.getChannel(channel.id)?.unreadCount).toBe(2); // the topic and the shared reply

    await engine.send(channel.id, "mine too", undefined, parent.id, [], { alsoInChannel: true });
    await engine.idle();
    const mine = store.messages(channel.id).at(-1)!;
    expect([mine.body, mine.also_in_channel, mine.pending ?? false]).toEqual(["mine too", true, false]);

    // Another device finds both shared replies in the channel history.
    const restored = new Store();
    const second = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store: restored, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 3 });
    await second.start();
    await second.openChannel(channel.id);
    await second.idle();
    expect(restored.messages(channel.id).map((m) => m.body)).toEqual(["topic", "loud", "mine too"]);
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

  it("a set from another device below an advance not sent yet drops that advance: nothing re-advances the position (§10, M28b)", async () => {
    // The debounce waits on this sleep until the test lets it go.
    const waits: Array<() => void> = [];
    const { server, alice, bob, channel, store, engine } = await setup({ active: true, sleep: () => new Promise<void>((resolve) => { waits.push(resolve); }) });
    for (const body of ["m1", "m2", "m3"]) server.post(channel.id, alice.id, body);
    await engine.start();
    await engine.openChannel(channel.id);
    await engine.idle();
    engine.markRead(channel.id, 3);
    expect(store.getChannel(channel.id)).toMatchObject({ lastReadSeq: 3, pendingReadSeq: 3, unreadCount: 0 });
    server.markRead(bob.id, channel.id, 1, "set"); // the phone: 「ここから未読にする」 on m2
    await engine.idle();
    expect(store.getChannel(channel.id)).toMatchObject({ lastReadSeq: 1, pendingReadSeq: null, unreadCount: 2 });
    for (const resume of waits.splice(0)) resume();
    await engine.flushReads();
    expect(server.readState(bob.id, channel.id).last_read_seq).toBe(1); // the waiting PUT did not go out
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

describe("presence and typing (M11b)", () => {
  it("tracks presence from bootstrap and frames, and shows typing for a few seconds", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    // alice is connected before bob bootstraps: listed in bootstrap.
    const aliceSocket = await server.connectorFor(alice.id)("t");
    aliceSocket.send(JSON.stringify({ type: "auth", token: "t" }));
    await engine.start();
    await engine.openChannel(channel.id);
    expect(store.presenceOf(alice.id)).toBe("online");
    expect(store.presenceOf(bob.id)).toBe("online"); // own connection announced too

    server.awayUsers.add(alice.id);
    server.announcePresence(alice.id);
    await engine.idle();
    expect(store.presenceOf(alice.id)).toBe("away");
    aliceSocket.close();
    await engine.idle();
    expect(store.presenceOf(alice.id)).toBe("offline");
    expect(store.presence.has(alice.id)).toBe(false);

    // Typing from alice shows up for bob, expires, and is cleared by her message.
    const aliceAgain = await server.connectorFor(alice.id)("t");
    aliceAgain.send(JSON.stringify({ type: "auth", token: "t" }));
    aliceAgain.send(JSON.stringify({ type: "typing", channel_id: channel.id }));
    await engine.idle();
    const t0 = Date.now();
    expect(store.typingUsers(channel.id, null, t0)).toEqual([alice.id]);
    expect(store.typingUsers(channel.id, null, t0 + 6_000)).toEqual([]); // 5 s TTL
    aliceAgain.send(JSON.stringify({ type: "typing", channel_id: channel.id, parent_id: "p1" }));
    await engine.idle();
    expect(store.typingUsers(channel.id, "p1", Date.now())).toEqual([alice.id]); // thread typing is keyed by the thread
    aliceAgain.send(JSON.stringify({ type: "typing", channel_id: channel.id }));
    await engine.idle();
    server.post(channel.id, alice.id, "here it is");
    await engine.idle();
    expect(store.typingUsers(channel.id, null, Date.now())).toEqual([]);

    // Our own typing goes out at most once per interval and never comes back to us.
    engine.sendTyping(channel.id);
    engine.sendTyping(channel.id);
    const sent = server.socketsOf(bob.id)[0]!.sent.filter((raw) => (JSON.parse(raw) as { type: string }).type === "typing");
    expect(sent).toHaveLength(1);
    expect(store.typingUsers(channel.id, null, Date.now())).toEqual([]);
    engine.stop();
  });
});

describe("pins and bookmarks (M11c)", () => {
  it("carries pins through message.updated and bookmarks through bootstrap and bookmark.updated", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    const { message } = server.post(channel.id, alice.id, "keep this");
    server.setBookmark(bob.id, message.id, true); // saved on another device before this one started
    await engine.start();
    await engine.openChannel(channel.id);
    expect(store.isBookmarked(message.id)).toBe(true);

    // A pin is an ordinary seq-consuming update: the row gets pinned_by without a resync.
    server.pin(channel.id, alice.id, message.id, true);
    await engine.idle();
    const pinned = store.message(channel.id, message.id)!;
    expect(pinned.pinned_by).toBe(alice.id);
    expect(pinned.updated_seq).toBe(2);
    expect(store.getChannel(channel.id)?.syncedSeq).toBe(2);
    server.pin(channel.id, bob.id, message.id, false);
    await engine.idle();
    expect(store.message(channel.id, message.id)?.pinned_at).toBeNull();

    // Another device removes the bookmark: the flag follows the user event.
    server.setBookmark(bob.id, message.id, false);
    await engine.idle();
    expect(store.isBookmarked(message.id)).toBe(false);
    server.setBookmark(bob.id, message.id, true);
    await engine.idle();
    expect(store.isBookmarked(message.id)).toBe(true);
    engine.stop();
  });

  it("moves the pins revision when a pinned message is deleted or unpinned, held or not (2026-10-06)", async () => {
    const { server, alice, channel, store, engine } = await setup();
    const old = server.post(channel.id, alice.id, "old, pinned").message;
    const older = server.post(channel.id, alice.id, "old too, pinned").message;
    server.pin(channel.id, alice.id, old.id, true);
    server.pin(channel.id, alice.id, older.id, true);
    for (const body of ["a", "b", "c", "d"]) server.post(channel.id, alice.id, body);
    const recent = server.post(channel.id, alice.id, "recent").message;
    await engine.start();
    await engine.openChannel(channel.id); // a page of 3: the pinned rows stay on the server
    expect(store.message(channel.id, old.id)).toBeUndefined();
    let revision = store.pinsRevision(channel.id);
    const moved = () => {
      const now = store.pinsRevision(channel.id);
      const changed = now > revision;
      revision = now;
      return changed;
    };

    // Someone else deletes a pinned row this device does not hold: pinned() cannot see it, the revision can.
    server.delete(channel.id, alice.id, old.id);
    await engine.idle();
    expect(moved()).toBe(true);
    // ... or unpins one.
    server.pin(channel.id, alice.id, older.id, false);
    await engine.idle();
    expect(moved()).toBe(true);

    // A held row: pinned, then deleted (its pin leaves with it).
    server.pin(channel.id, alice.id, recent.id, true);
    await engine.idle();
    expect(moved()).toBe(true);
    expect(store.pinned(channel.id).map((m) => m.id)).toEqual([recent.id]);
    server.delete(channel.id, alice.id, recent.id);
    await engine.idle();
    expect(moved()).toBe(true);
    expect(store.pinned(channel.id)).toEqual([]);

    // Ordinary traffic leaves it alone.
    server.post(channel.id, alice.id, "chatter");
    await engine.idle();
    expect(moved()).toBe(false);
    engine.stop();
  });
});

describe("send queue (§9)", () => {
  it("sends a message queued while another is in flight in the same run", async () => {
    const { server, bob, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    const api = server.apiFor(bob.id);
    const post = api.postMessage;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    api.postMessage = async (...args: Parameters<SyncApi["postMessage"]>) => {
      if (++calls === 1) await gate; // "one" stays in flight until released
      return post(...args);
    };
    useApi(engine, api);
    const first = engine.send(channel.id, "one");
    const second = engine.send(channel.id, "two"); // queued while "one" is on the wire
    release();
    await Promise.all([first, second]);
    await engine.idle();
    expect(store.outbox).toHaveLength(0);
    expect(store.messages(channel.id).map((m) => [m.body, m.pending ?? false])).toEqual([["one", false], ["two", false]]);
    expect(server.channels.get(channel.id)!.messages.map((m) => m.body)).toEqual(["one", "two"]);
    engine.stop();
  });

  it("retries a temporary failure (a proxy's 502 page) after 2 s, then 4 s, while online", async () => {
    vi.useFakeTimers();
    const { server, bob, channel, store, engine } = await setup();
    await engine.start();
    const api = server.apiFor(bob.id);
    const post = api.postMessage;
    let attempts = 0;
    api.postMessage = async (...args: Parameters<SyncApi["postMessage"]>) => {
      if (++attempts <= 2) throw new ApiError(502, "http_502", "Request failed");
      return post(...args);
    };
    useApi(engine, api);
    await engine.send(channel.id, "eventually");
    expect([attempts, store.outbox.length]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    await engine.idle();
    expect(store.outbox).toHaveLength(0);
    expect(server.channels.get(channel.id)!.messages.map((m) => m.body)).toEqual(["eventually"]);
    engine.stop();
  });

  it("「再送」 on one failed message sends that message only", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    const other = server.createChannel("random", alice.id);
    server.join(other.id, bob.id);
    await engine.start();
    await engine.openChannel(channel.id);
    const api = server.apiFor(bob.id);
    const post = api.postMessage;
    let refuse = true;
    api.postMessage = async (...args: Parameters<SyncApi["postMessage"]>) => {
      if (refuse) throw new ApiError(422, "validation_error", "bad");
      return post(...args);
    };
    useApi(engine, api);
    await engine.send(channel.id, "here");
    await engine.send(other.id, "there");
    await engine.idle();
    expect(store.outbox.map((i) => [i.body, i.failed])).toEqual([["here", "validation_error"], ["there", "validation_error"]]);

    refuse = false;
    await engine.retryFailed(store.outbox.find((i) => i.body === "here")!.client_msg_id);
    await engine.idle();
    expect(server.channels.get(channel.id)!.messages.map((m) => m.body)).toEqual(["here"]);
    expect(server.channels.get(other.id)!.messages).toEqual([]);
    expect(store.outbox.map((i) => [i.body, i.failed])).toEqual([["there", "validation_error"]]); // still failed, still offered
    engine.stop();
  });

  it("marks a refused send failed, goes on with the next one, and keeps the failure across a restart", async () => {
    const persistence = new MemoryPersistence();
    const { server, bob, channel, store, engine } = await setup({ store: new Store(persistence) });
    await engine.start();
    await engine.openChannel(channel.id);
    engine.stop(); // both are queued while offline
    await engine.send(channel.id, "refused");
    await engine.send(channel.id, "fine");
    const api = server.apiFor(bob.id);
    const post = api.postMessage;
    api.postMessage = async (...args: Parameters<SyncApi["postMessage"]>) => {
      if (args[2] === "refused") throw new ApiError(422, "validation_error", "bad");
      return post(...args);
    };
    useApi(engine, api);
    await engine.start();
    await engine.idle();
    expect(store.outbox.map((i) => [i.body, i.failed])).toEqual([["refused", "validation_error"]]);
    expect(store.messages(channel.id).map((m) => [m.body, m.failed ?? false])).toEqual([["fine", false], ["refused", true]]);
    engine.stop();

    await store.flushPersistence();
    const restarted = new Store(persistence);
    await restarted.load();
    expect(restarted.messages(channel.id).map((m) => [m.body, m.failed ?? false])).toEqual([["fine", false], ["refused", true]]);
    const second = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store: restarted, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 3 });
    await second.start();
    await second.idle();
    expect(restarted.outbox.map((i) => i.body)).toEqual(["refused"]); // not sent again until 再送
    await second.retryFailed(restarted.outbox[0]!.client_msg_id);
    await second.idle();
    expect(restarted.outbox).toEqual([]);
    expect(server.channels.get(channel.id)!.messages.map((m) => m.body)).toEqual(["fine", "refused"]);
    second.stop();
  });
});

describe("connection lifecycle (§5.3)", () => {
  it("never reports online for a connection that closed during bootstrap, and reconnects once", async () => {
    const sleeping: Array<() => void> = [];
    const { server, alice, bob, channel, store, engine } = await setup({ sleep: () => new Promise<void>((resolve) => { sleeping.push(resolve); }) });
    const api = server.apiFor(bob.id);
    const bootstrap = api.bootstrap;
    let first = true;
    api.bootstrap = async () => {
      if (first) {
        first = false;
        server.disconnect(bob.id); // the socket dies while bootstrap is on its way
      }
      return bootstrap();
    };
    useApi(engine, api);
    await engine.openChannel(channel.id);
    await engine.start();
    await engine.idle();
    expect(engine.status).toBe("offline"); // not "online" without a socket
    expect(sleeping).toHaveLength(1); // one reconnect waiting for its backoff
    sleeping.shift()!();
    await settle(engine, () => engine.status === "online");
    expect(engine.status).toBe("online");
    expect(server.socketsOf(bob.id)).toHaveLength(1);
    server.post(channel.id, alice.id, "over the new socket");
    await engine.idle();
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["over the new socket"]);
    engine.stop();
  });

  it("drops a silent connection 60 s after the last frame (not after the first unanswered ping) and reconnects", async () => {
    vi.useFakeTimers();
    const { server, bob, engine } = await setup();
    await engine.start();
    const first = server.socketsOf(bob.id)[0]!;
    first.pongDelayMs = 1_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000); // pings every 30 s, pongs a second later: nothing happens
    expect(first.closed).toBe(false);
    first.silent = true; // half-open from here on (the last frame was the pong just now): pings go out, nothing comes back
    await vi.advanceTimersByTimeAsync(59_999);
    expect([first.closed, engine.status]).toEqual([false, "online"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.closed).toBe(true);
    await settle(engine, () => engine.status === "online");
    const sockets = server.socketsOf(bob.id);
    expect(engine.status).toBe("online");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).not.toBe(first);
    engine.stop();
  });

  it("keeps a slow connection whose pongs arrive after the next ping", async () => {
    vi.useFakeTimers();
    const { server, bob, engine } = await setup();
    await engine.start();
    const first = server.socketsOf(bob.id)[0]!;
    first.pongDelayMs = 1_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    first.pongDelayMs = 30_500; // each pong lands after the next ping, yet something arrives within every 60 s
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect([first.closed, engine.status, engine.stats.reconnects]).toEqual([false, "online", 0]);
    engine.stop();
  });

  it("gets a new access token and reconnects after close 4001; only a refused refresh signs out", async () => {
    const refreshes: boolean[] = [];
    let refuse = false;
    let signedOut = false;
    const { server, bob, engine } = await setup({
      prepare: async ({ refresh }) => {
        refreshes.push(refresh);
        if (refresh && refuse) throw new ApiError(401, "session_revoked", "revoked");
      },
    });
    (engine as unknown as { deps: { onSignedOut: () => void } }).deps.onSignedOut = () => {
      signedOut = true;
    };
    await engine.start();
    expect(refreshes).toEqual([false]);
    server.disconnect(bob.id, 4001);
    await settle(engine, () => engine.status === "online");
    expect([engine.status, signedOut]).toEqual(["online", false]);
    expect(refreshes).toEqual([false, true]);
    refuse = true;
    server.disconnect(bob.id, 4001);
    await settle(engine, () => engine.status === "signed_out");
    expect([engine.status, signedOut]).toEqual(["signed_out", true]);
  });
});

describe("timeline range (§7.3)", () => {
  it("keeps old rows that arrive on their own out of the timeline and pages back from the loaded range", async () => {
    const { server, alice, channel, store, engine } = await setup(); // pages of 3
    const posted = Array.from({ length: 10 }, (_, i) => server.post(channel.id, alice.id, `m${i + 1}`).message);
    await engine.start();
    await engine.openChannel(channel.id);
    const bodies = () => store.messages(channel.id).map((m) => m.body);
    expect(bodies()).toEqual(["m8", "m9", "m10"]);
    expect(store.getChannel(channel.id)).toMatchObject({ oldestLoadedSeq: 8, hasOlder: true });

    // Old rows arrive by themselves: a reaction event, a reply under an old parent, an API response.
    server.react(channel.id, alice.id, posted[1]!.id, "👍", true);
    server.post(channel.id, alice.id, "late reply", undefined, posted[0]!.id);
    await engine.idle();
    store.upsertMessage(server.messageByBody(channel.id, "m4")); // e.g. reacting in a search result
    expect(bodies()).toEqual(["m8", "m9", "m10"]); // stored, but no gap in the timeline
    expect(store.message(channel.id, posted[1]!.id)?.reactions?.map((r) => r.emoji)).toEqual(["👍"]);

    await engine.loadOlder(channel.id); // before_seq = 8, not 2
    expect(bodies()).toEqual(["m5", "m6", "m7", "m8", "m9", "m10"]);
    expect(Store.fromSnapshot(store.snapshot()).messages(channel.id).map((m) => m.body)).toEqual(bodies()); // the range is persisted
    await engine.loadOlder(channel.id);
    expect(bodies()).toEqual(["m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
    await engine.loadOlder(channel.id);
    expect(bodies()).toEqual(posted.map((m) => m.body));
    expect(store.getChannel(channel.id)).toMatchObject({ oldestLoadedSeq: 0, hasOlder: false });
    expect(store.message(channel.id, posted[0]!.id)?.reply_count).toBe(1);
    engine.stop();
  });

  it("keeps the newest 500 messages per channel when loading and moves the range start past the pruned ones", async () => {
    const persistence = new MemoryPersistence();
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const channel = server.createChannel("general", alice.id);
    for (let i = 1; i <= 520; i++) server.post(channel.id, alice.id, `m${i}`);
    const writer = new Store(persistence);
    writer.upsertChannel(channel, { isMember: true, syncedSeq: 520, oldestLoadedSeq: 0, hasOlder: false });
    for (const message of server.channels.get(channel.id)!.messages) writer.upsertMessage(message);
    writer.putPlaceholder({ id: "local:c1", channel_id: channel.id, sender_id: alice.id, seq: null, updated_seq: -1, client_msg_id: "c1", body: "unsent", created_at: "9999", edited_at: null, deleted: false, pending: true });
    await writer.flushPersistence();

    const reader = new Store(persistence);
    await reader.load();
    const timeline = reader.messages(channel.id);
    expect(timeline).toHaveLength(501);
    expect([timeline[0]!.body, timeline[499]!.body, timeline[500]!.body]).toEqual(["m21", "m520", "unsent"]);
    expect(reader.getChannel(channel.id)).toMatchObject({ oldestLoadedSeq: 21, hasOlder: true });
    await reader.flushPersistence();
    expect(persistence.messages.size).toBe(501); // pruned on disk too
  });
});

describe("the cap on held messages (§7.7, M22)", () => {
  /** The timeline's seqs are one unbroken run from the range start to the newest message. */
  function unbroken(store: Store, channelId: string): boolean {
    const seqs = store.messages(channelId).map((m) => m.seq!);
    return seqs.every((seq, i) => i === 0 || seq === seqs[i - 1]! + 1) && seqs[0] === store.getChannel(channelId)!.oldestLoadedSeq;
  }

  it("trims a conversation when the reader leaves it, never while it is open, and pages it back in", async () => {
    const { server, alice, bob, channel, store, engine } = await setup(); // pages of 3
    const other = server.createChannel("random", alice.id);
    server.join(other.id, bob.id);
    await engine.start();
    await engine.openChannel(channel.id);
    for (let i = 1; i <= 620; i++) server.post(channel.id, alice.id, `m${i}`);
    await engine.idle();
    expect(store.messages(channel.id)).toHaveLength(620); // open: every live row stays

    await engine.openChannel(other.id);
    await engine.idle();
    const kept = store.messages(channel.id);
    expect(kept).toHaveLength(500);
    expect([kept[0]!.body, kept[499]!.body]).toEqual(["m121", "m620"]);
    expect(store.getChannel(channel.id)).toMatchObject({ oldestLoadedSeq: 121, hasOlder: true, syncedSeq: 620 });

    await engine.openChannel(channel.id);
    await engine.loadOlder(channel.id); // back from the new range start, with no gap
    expect(store.messages(channel.id).map((m) => m.body).slice(0, 4)).toEqual(["m118", "m119", "m120", "m121"]);
    expect(unbroken(store, channel.id)).toBe(true);
    engine.stop();
  });

  it("trims a channel nobody looks at once live rows pass the cap by the margin", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    const other = server.createChannel("random", alice.id);
    server.join(other.id, bob.id);
    await engine.start();
    await engine.openChannel(channel.id); // synced: its live rows are kept
    await engine.openChannel(other.id);
    await engine.idle();
    for (let i = 1; i <= 650; i++) server.post(channel.id, alice.id, `m${i}`);
    await engine.idle();
    const held = store.messages(channel.id);
    expect(held.length).toBeGreaterThanOrEqual(500);
    expect(held.length).toBeLessThanOrEqual(600);
    expect(held.at(-1)!.body).toBe("m650");
    expect(unbroken(store, channel.id)).toBe(true);
    expect(store.getChannel(channel.id)).toMatchObject({ hasOlder: true, syncedSeq: 650 });
    engine.stop();
  });

  it("keeps a channel whole while a thread of it is open", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    const other = server.createChannel("random", alice.id);
    server.join(other.id, bob.id);
    await engine.start();
    await engine.openChannel(channel.id);
    for (let i = 1; i <= 520; i++) server.post(channel.id, alice.id, `m${i}`);
    await engine.idle();
    const release = engine.viewing(channel.id);
    await engine.openChannel(other.id);
    await engine.idle();
    expect(store.messages(channel.id)).toHaveLength(520);
    release();
    release(); // once only
    await engine.idle();
    expect(store.messages(channel.id)).toHaveLength(500);
    engine.stop();
  });
});

describe("threads without a loaded timeline (§7.4)", () => {
  it("shows new replies in a thread opened from the threads view although the channel was never opened", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    const { message: parent } = server.post(channel.id, alice.id, `question for <@${bob.id}>`);
    server.post(channel.id, alice.id, "first answer", undefined, parent.id);
    await engine.start();
    await engine.loadThreads("all");
    expect(store.getChannel(channel.id)?.syncedSeq).toBeNull();
    await engine.loadReplies(channel.id, parent.id); // the thread pane opens
    const { message: second } = server.post(channel.id, alice.id, "second answer", undefined, parent.id);
    await engine.idle();
    expect(store.replies(channel.id, parent.id).map((m) => m.body)).toEqual(["first answer", "second answer"]);
    server.edit(channel.id, alice.id, second.id, "second answer (edited)");
    await engine.idle();
    expect(store.replies(channel.id, parent.id).map((m) => m.body)).toEqual(["first answer", "second answer (edited)"]);
    expect(store.messages(channel.id)).toEqual([]); // still no timeline
    engine.stop();
  });
});

describe("read positions (§10)", () => {
  it("takes the server's position at bootstrap and sends a mark that failed again after reconnecting", async () => {
    const { server, alice, bob, channel, store, engine } = await setup({ active: true });
    for (const body of ["m1", "m2", "m3"]) server.post(channel.id, alice.id, body);
    await engine.start();
    await engine.openChannel(channel.id);
    const api = server.apiFor(bob.id);
    api.failNext(new NetworkError("offline"));
    useApi(engine, api);
    engine.markRead(channel.id, 3);
    await engine.flushReads();
    expect(server.readState(bob.id, channel.id).last_read_seq).toBe(0);
    expect(store.getChannel(channel.id)).toMatchObject({ lastReadSeq: 3, unreadCount: 0, pendingReadSeq: 3 });

    server.disconnect(bob.id);
    await settle(engine, () => engine.status === "online");
    await engine.flushReads();
    expect(server.readState(bob.id, channel.id)).toMatchObject({ last_read_seq: 3, unread_count: 0 });
    expect(store.getChannel(channel.id)).toMatchObject({ lastReadSeq: 3, unreadCount: 0, pendingReadSeq: null });
    engine.stop();
  });

  it("does not keep a local position the server never got, so the channel can be read again", async () => {
    const { server, alice, bob, channel, store, engine } = await setup({ active: true });
    for (const body of ["m1", "m2", "m3"]) server.post(channel.id, alice.id, body);
    await engine.start();
    await engine.openChannel(channel.id);
    store.updateChannel(channel.id, { lastReadSeq: 3 }); // ahead of the server, nothing left to send
    server.disconnect(bob.id);
    await settle(engine, () => engine.status === "online");
    expect(store.getChannel(channel.id)).toMatchObject({ lastReadSeq: 0, unreadCount: 3 }); // bootstrap is authoritative
    engine.markRead(channel.id, 3);
    await engine.flushReads();
    expect(server.readState(bob.id, channel.id).last_read_seq).toBe(3);
    expect(store.getChannel(channel.id)?.unreadCount).toBe(0);
    engine.stop();
  });

  it("sends a mark made just before the app closed (during the debounce) after the restart", async () => {
    const { server, alice, bob, channel, store, engine } = await setup({ active: true, sleep: () => new Promise<void>(() => {}) }); // the debounce never ends
    for (const body of ["m1", "m2"]) server.post(channel.id, alice.id, body);
    await engine.start();
    await engine.openChannel(channel.id);
    engine.markRead(channel.id, 2);
    engine.stop(); // the app quits during the debounce
    expect(server.readState(bob.id, channel.id).last_read_seq).toBe(0);

    const restarted = Store.fromSnapshot(store.snapshot());
    const second = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store: restarted, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 3 });
    await second.start();
    await second.flushReads();
    expect(server.readState(bob.id, channel.id).last_read_seq).toBe(2);
    expect(restarted.getChannel(channel.id)).toMatchObject({ lastReadSeq: 2, unreadCount: 0, pendingReadSeq: null });
    second.stop();
  });

  it("sends a thread read mark that failed again after reconnecting", async () => {
    const { server, alice, bob, channel, store, engine } = await setup({ active: true });
    const { message: parent } = server.post(channel.id, alice.id, `topic <@${bob.id}>`);
    const { message: reply } = server.post(channel.id, alice.id, "reply", undefined, parent.id);
    await engine.start();
    await engine.loadThreads("all");
    await engine.loadReplies(channel.id, parent.id);
    const api = server.apiFor(bob.id);
    api.failNext(new NetworkError("offline"));
    useApi(engine, api);
    engine.markThreadRead(parent.id, reply.seq);
    await engine.flushReads();
    expect(server.threadState(bob.id, parent.id).last_read_seq).toBe(0);
    expect(store.threads.get(parent.id)?.state.unread_count).toBe(0); // shown as read meanwhile

    server.disconnect(bob.id);
    await settle(engine, () => engine.status === "online");
    await engine.flushReads();
    expect(server.threadState(bob.id, parent.id)).toMatchObject({ last_read_seq: reply.seq, unread_count: 0 });
    engine.stop();
  });

  it("leaves the channel's unread count and read position alone when I reply in a thread", async () => {
    const { server, alice, bob, channel, store, engine } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    const { message: topic } = server.post(channel.id, alice.id, "topic");
    await engine.idle();
    expect(store.getChannel(channel.id)).toMatchObject({ unreadCount: 1, lastReadSeq: 0 });
    await engine.send(channel.id, "my reply", undefined, topic.id);
    await engine.send(channel.id, "shared reply", undefined, topic.id, [], { alsoInChannel: true });
    await engine.idle();
    expect(store.getChannel(channel.id)).toMatchObject({ unreadCount: 1, lastReadSeq: 0 });
    expect(server.readState(bob.id, channel.id)).toMatchObject({ last_read_seq: 0, unread_count: 1 });
    await engine.send(channel.id, "top-level"); // posting in the channel reads it
    await engine.idle();
    expect(store.getChannel(channel.id)).toMatchObject({ unreadCount: 0, lastReadSeq: 4 });
    expect(server.readState(bob.id, channel.id)).toMatchObject({ last_read_seq: 4, unread_count: 0 });
    engine.stop();
  });
});

describe("DM list order (§7.4)", () => {
  it("moves a conversation's last_message_at with each new timeline message", async () => {
    const { server, alice, bob, store, engine } = await setup();
    const dm = server.createChannel("", alice.id, "dm");
    server.join(dm.id, bob.id);
    await engine.start();
    expect(store.getChannel(dm.id)?.last_message_at).toBeNull();
    const { message } = server.post(dm.id, alice.id, "hi");
    await engine.idle();
    expect(store.getChannel(dm.id)?.last_message_at).toBe(message.created_at);
    server.post(dm.id, alice.id, "in a thread", undefined, message.id);
    await engine.idle();
    expect(store.getChannel(dm.id)?.last_message_at).toBe(message.created_at); // a plain reply does not move it
    engine.stop();
  });
});

describe("thread-only replies and notifications (PUSH_NOTIFICATIONS.md §4)", () => {
  it("at level all, a reply only in a thread I do not follow stays silent; one I follow or also in the channel notifies", async () => {
    const { server, alice, bob, channel, store, engine, notifications } = await setup();
    const carol = server.addUser("carol");
    server.join(channel.id, carol.id);
    server.keywords.set(bob.id, ["deploy"]);
    await engine.start();
    await engine.idle();
    store.setNotification(channel.id, "all", null);

    const { message: other } = server.post(channel.id, alice.id, "alice and carol");
    server.post(channel.id, carol.id, "carol joins", undefined, other.id);
    await engine.idle();
    notifications.length = 0;
    server.post(channel.id, alice.id, "between them", undefined, other.id);
    await engine.idle();
    expect(notifications).toEqual([]); // not a follower, not mentioned

    server.post(channel.id, alice.id, "also here", undefined, other.id, [], { alsoInChannel: true });
    await engine.idle();
    expect(notifications).toEqual(["also here"]);

    server.post(channel.id, alice.id, `ping <@${bob.id}>`, undefined, other.id);
    await engine.idle();
    expect(notifications).toEqual(["also here", `ping <@${bob.id}>`]); // a mention reaches me (and makes me follow)
    server.post(channel.id, carol.id, "now I follow", undefined, other.id);
    await engine.idle();
    expect(notifications.at(-1)).toBe("now I follow");

    // Unfollowed by hand: silent even when mentioned or hit by a keyword; also in the channel still notifies.
    await engine.setThreadFollow(other.id, false);
    notifications.length = 0;
    server.post(channel.id, alice.id, "after unfollow", undefined, other.id);
    server.post(channel.id, alice.id, `again <@${bob.id}>`, undefined, other.id);
    server.post(channel.id, alice.id, "deploy tonight", undefined, other.id);
    await engine.idle();
    expect(notifications).toEqual([]);
    server.post(channel.id, alice.id, "shared reply", undefined, other.id, [], { alsoInChannel: true });
    await engine.idle();
    expect(notifications).toEqual(["shared reply"]);
    engine.stop();
  });
});
