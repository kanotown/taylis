/** Fixtures for the M17 tests (SYNC_PROTOCOL.md §10.1): channel C, alice posting, bob reading. */
import { type SyncApi, SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

export interface World {
  server: FakeServer;
  alice: { id: string };
  bob: { id: string };
  channelId: string;
  store: Store;
  engine: SyncEngine;
  /** Requests the engine made (history pages, channel and thread read PUTs). */
  calls: { history: Array<{ before: number | null; limit: number }>; reads: Array<{ seq: number; mode: string }>; threadReads: number[] };
  api: SyncApi & { failNext: (error: Error) => void };
}

/** Channel C with `posts` top-level posts by alice (`body` names them); bob (the reader) has read up to `lastRead`. */
export function world(options: { posts?: number; lastRead?: number; gapLimit?: number; body?: (i: number) => string } = {}): World {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channelId = server.createChannel("c", alice.id).id;
  server.join(channelId, bob.id);
  for (let i = 1; i <= (options.posts ?? 0); i++) server.post(channelId, alice.id, options.body?.(i) ?? `m${i}`);
  if (options.lastRead) server.markRead(bob.id, channelId, options.lastRead);
  const store = new Store();
  const inner = server.apiFor(bob.id);
  const calls: World["calls"] = { history: [], reads: [], threadReads: [] };
  const api: World["api"] = {
    ...inner,
    history: async (channel, before, limit) => {
      calls.history.push({ before, limit });
      return inner.history(channel, before, limit);
    },
    markRead: async (channel, seq, mode = "advance") => {
      calls.reads.push({ seq, mode });
      return inner.markRead(channel, seq, mode);
    },
    markThreadRead: async (parentId, seq) => {
      calls.threadReads.push(seq);
      return inner.markThreadRead(parentId, seq);
    },
  };
  const engine = new SyncEngine(
    { api, connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => true },
    { gapLimit: options.gapLimit ?? 5000, reconnectMinMs: 0 },
  );
  return { server, alice, bob, channelId, store, engine, calls, api };
}

/** Timestamps like a real channel: `firstSeq` at `at`, one second per seq around it. */
export function stamp(w: World, firstSeq: number, at: Date): void {
  for (const message of w.server.channels.get(w.channelId)!.messages) message.created_at = new Date(at.getTime() + (message.seq - firstSeq) * 1000).toISOString();
}

/** First open on this device: start, open the channel, the newest page arrives. */
export async function openFirst(w: World): Promise<void> {
  await w.engine.start();
  await w.engine.openChannel(w.channelId);
  await w.engine.idle();
}

/** V24's thread: parent at seq 500, r1..r28 there before, r29 and r30 arrive live; bob has read it up to `threadRead`. */
export async function threadWorld(options: { gapLimit?: number; threadRead?: number } = {}) {
  const w = world({ posts: 499, gapLimit: options.gapLimit });
  const { message: parent } = w.server.post(w.channelId, w.alice.id, "parent");
  for (let i = 1; i <= 28; i++) w.server.post(w.channelId, w.alice.id, `r${i}`, undefined, parent.id);
  await openFirst(w);
  for (const body of ["r29", "r30"]) w.server.post(w.channelId, w.alice.id, body, undefined, parent.id);
  w.server.markThreadRead(w.bob.id, parent.id, options.threadRead ?? 510);
  await w.engine.idle();
  await w.engine.loadThreadState(parent.id);
  return { ...w, parent };
}

/**
 * Holds the frames the server sends bob from now on, so a test can hand them over one at a time (the state between
 * two events of one post, or a POST answer before its event). `pass` delivers the next `n` held frames.
 */
export function holdFrames(w: World) {
  const socket = w.server.socketsOf(w.bob.id)[0]!;
  const deliver = Object.getPrototypeOf(socket).deliver as (frame: unknown) => void;
  const held: Array<{ event?: string }> = [];
  socket.deliver = (frame: unknown) => {
    if ((frame as { type?: string }).type === "event") held.push(frame as { event?: string });
    else deliver.call(socket, frame);
  };
  return {
    held,
    async pass(n = held.length) {
      for (const frame of held.splice(0, n)) deliver.call(socket, frame);
      await w.engine.idle();
    },
    stop() {
      delete (socket as { deliver?: unknown }).deliver;
    },
  };
}
