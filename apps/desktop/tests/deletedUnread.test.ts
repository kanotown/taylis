/**
 * SYNC_PROTOCOL.md §10.6 (2026-10-09): a DM or a mention deleted before it was read kept its red badge, and opening the
 * conversation showed nothing and cleared nothing. The rule is shared with iOS and Android
 * (apps/shared/unread-delete-rules.json).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SyncEngine } from "../src/sync/engine";
import { countsAfterDelete } from "../src/sync/readGate";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

interface Case {
  name: string;
  channel: { last_read_seq: number; counted_to: number; unread: number; mentions: number; first_unread_at: string | null };
  event_seq: number;
  message: { seq: number; sender_id: string; type: string; parent_id: string | null; also_in_channel: boolean; created_at: string };
  held: { deleted: boolean; mentions_me: boolean } | null;
  expect: { unread: number; mentions: number; first_unread_at: string | null; refetch: boolean };
}

const rules = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../shared/unread-delete-rules.json"), "utf8")) as { me: string; cases: Case[] };

describe("countsAfterDelete (apps/shared/unread-delete-rules.json)", () => {
  for (const c of rules.cases) {
    it(c.name, () => {
      const got = countsAfterDelete(
        { lastReadSeq: c.channel.last_read_seq, countedTo: c.channel.counted_to, unread: c.channel.unread, mentions: c.channel.mentions, firstUnreadAt: c.channel.first_unread_at },
        c.event_seq,
        c.message,
        c.held ? { deleted: c.held.deleted, mentionsMe: c.held.mentions_me } : null,
        rules.me,
      );
      expect(got).toEqual({ unread: c.expect.unread, mentions: c.expect.mentions, firstUnreadAt: c.expect.first_unread_at, refetch: c.expect.refetch });
    });
  }
});

async function setup() {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", alice.id);
  server.join(channel.id, bob.id);
  const store = new Store();
  const reads: number[] = [];
  const api = server.apiFor(bob.id);
  const markRead = api.markRead.bind(api);
  api.markRead = async (channelId, seq, mode) => {
    reads.push(seq);
    return markRead(channelId, seq, mode);
  };
  const engine = new SyncEngine(
    { api, connect: server.connectorFor(bob.id), store, getAccessToken: () => "token", sleep: async () => {}, random: () => 0.5, isActive: () => false },
    { pageSize: 3, gapLimit: 5, reconnectMinMs: 0 },
  );
  return { server, alice, bob, channel, store, engine, reads };
}

/** The fake server's queue of held events (to drop or replay one). */
type Held = { userIds: Set<string>; frame: unknown };
const hidden = (server: FakeServer) => server as unknown as { held: Held[]; emit: (userIds: Set<string>, frame: unknown) => void };

const counts = (store: Store, id: string) => {
  const c = store.getChannel(id)!;
  return [c.unreadCount, c.mentionCount];
};

describe("a deleted unread message (§10.6)", () => {
  it("leaves the counts of a conversation not opened, at once and without a request", async () => {
    const { server, alice, channel, store, engine, reads } = await setup();
    await engine.start();
    await engine.idle();
    const sent = server.post(channel.id, alice.id, "are you there?").message;
    await engine.idle();
    expect(counts(store, channel.id)).toEqual([1, 0]);
    server.delete(channel.id, alice.id, sent.id);
    await engine.idle();
    expect(counts(store, channel.id)).toEqual([0, 0]);
    expect(store.getChannel(channel.id)?.firstUnreadAt).toBeNull();
    expect(reads).toEqual([]);
  });

  it("takes off a held mention; one not held is asked of the server", async () => {
    const { server, alice, bob, channel, store, engine, reads } = await setup();
    const other = server.createChannel("random", alice.id);
    server.join(other.id, bob.id);
    await engine.start();
    await engine.openChannel(channel.id);
    await engine.idle();
    server.post(channel.id, alice.id, "plain");
    const mention = server.post(channel.id, alice.id, `<@${bob.id}> look`).message;
    await engine.idle();
    expect(counts(store, channel.id)).toEqual([2, 1]);
    server.delete(channel.id, alice.id, mention.id); // held: the timeline is open
    await engine.idle();
    expect(counts(store, channel.id)).toEqual([1, 0]);
    expect(reads).toEqual([]);

    // Not held (the conversation is not loaded here): the mention cannot be told, the server says.
    server.post(other.id, alice.id, "one");
    const second = server.post(other.id, alice.id, `<@${bob.id}> two`).message;
    await engine.idle();
    expect(counts(store, other.id)).toEqual([2, 1]);
    server.delete(other.id, alice.id, second.id);
    await engine.idle();
    await engine.flushReads();
    await engine.idle();
    expect(reads).toEqual([0]);
    expect(counts(store, other.id)).toEqual([1, 0]);
    expect(store.getChannel(other.id)?.lastReadSeq).toBe(0); // the refetch moves nothing
  });

  it("is not taken off twice, nor when the counts already leave it out", async () => {
    const { server, alice, channel, store, engine } = await setup();
    await engine.start();
    await engine.idle();
    const first = server.post(channel.id, alice.id, "one").message;
    server.post(channel.id, alice.id, "two");
    await engine.idle();
    server.holdEvents = true;
    server.delete(channel.id, alice.id, first.id);
    const frames = [...hidden(server).held];
    server.holdEvents = false;
    server.release();
    await engine.idle();
    expect(counts(store, channel.id)).toEqual([1, 0]);
    // The same deletion again (a replayed frame): its seq is within the counted range now.
    for (const { userIds, frame } of frames) hidden(server).emit(userIds, frame);
    await engine.idle();
    expect(counts(store, channel.id)).toEqual([1, 0]);
  });

  it("a stale count with no held unread row is asked again when the conversation opens", async () => {
    const { server, alice, channel, store, engine, reads } = await setup();
    const sent = server.post(channel.id, alice.id, "gone").message;
    await engine.start();
    await engine.idle();
    // A count kept from before (a store saved by an older build missed the deletion).
    server.holdEvents = true;
    server.delete(channel.id, alice.id, sent.id);
    hidden(server).held = []; // its event never came
    server.holdEvents = false;
    expect(counts(store, channel.id)).toEqual([1, 0]);
    await engine.openChannel(channel.id);
    await engine.idle();
    await engine.flushReads();
    await engine.idle();
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set([0]));
    expect(counts(store, channel.id)).toEqual([0, 0]);
  });

  it("a counted row deleted while its events were lost is asked of the server after the catch-up", async () => {
    const { server, alice, bob, channel, store, engine, reads } = await setup();
    await engine.start();
    await engine.openChannel(channel.id);
    await engine.idle();
    const mention = server.post(channel.id, alice.id, `<@${bob.id}> hi`).message;
    server.post(channel.id, alice.id, "later");
    await engine.idle();
    expect(counts(store, channel.id)).toEqual([2, 1]);
    server.holdEvents = true; // the deletion's event is lost
    server.delete(channel.id, alice.id, mention.id);
    hidden(server).held = [];
    server.holdEvents = false;
    server.post(channel.id, alice.id, "after the gap"); // its seq shows the gap
    await engine.idle();
    await engine.flushReads();
    await engine.idle();
    expect(new Set(reads)).toEqual(new Set([0]));
    expect(counts(store, channel.id)).toEqual([2, 0]);
  });
});
