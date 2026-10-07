// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import type { MessageState, ThreadEntry } from "../src/sync/types";
import { threadCardReplies } from "../src/ui/threadCard";
import { ThreadsView } from "../src/ui/ThreadsView";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Bob (me) follows his own topic in #general; Alice and Carol reply (THREADS.md §5). */
async function world(options: { previews?: boolean } = {}) {
  const server = new FakeServer();
  server.threadPreviews = options.previews ?? true;
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const carol = server.addUser("carol");
  const channel = server.createChannel("general", alice.id);
  server.join(channel.id, bob.id);
  server.join(channel.id, carol.id);
  const store = new Store();
  const engine = new SyncEngine(
    { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => true },
    { pageSize: 50, reconnectMinMs: 0 },
  );
  await engine.start();
  await engine.openChannel(channel.id);
  await engine.send(channel.id, "topic");
  await engine.idle();
  const parent = server.messageByBody(channel.id, "topic");
  server.post(channel.id, alice.id, "first", undefined, parent.id);
  server.post(channel.id, carol.id, "second", undefined, parent.id);
  server.post(channel.id, alice.id, "third", undefined, parent.id);
  await engine.flushThreads();
  await engine.loadThreads("all");
  const preview = () => store.threads.get(parent.id)?.latestReplies?.map((m) => m.body);
  return { server, alice, bob, carol, channel, store, engine, parent, preview };
}

describe("the threads list's reply previews", () => {
  it("shows the newest two replies from GET /threads, oldest first, and 「他 n 件」 for the rest", async () => {
    const w = await world();
    expect(w.preview()).toEqual(["second", "third"]);
    const entry = w.store.threads.get(w.parent.id)!;
    const card = threadCardReplies(entry, w.bob.id, () => false)!;
    expect(card.more).toBe(1);
    // Nothing read yet in the thread: both are others' replies after my position.
    expect(card.replies.map((r) => r.unread)).toEqual([true, true]);
    w.engine.stop();
  });

  it("keeps the newest two as replies arrive, change and go, without fetching the list", async () => {
    const w = await world();
    // The list's own re-read after thread.updated (300 ms) never comes: what changes is the events' doing.
    (w.engine as unknown as { deps: { sleep: (ms: number) => Promise<void> } }).deps.sleep = (ms) => (ms === 300 ? new Promise(() => {}) : Promise.resolve());
    const listCalls = vi.spyOn(w.server, "threads");
    w.server.post(w.channel.id, w.carol.id, "fourth", undefined, w.parent.id);
    await w.engine.idle();
    expect(w.preview()).toEqual(["third", "fourth"]);

    const fourth = w.server.messageByBody(w.channel.id, "fourth");
    w.server.edit(w.channel.id, w.carol.id, fourth.id, "fourth (edited)");
    await w.engine.idle();
    expect(w.preview()).toEqual(["third", "fourth (edited)"]);

    // A shown reply deleted: the next newest one held here takes its place.
    await w.engine.loadReplies(w.channel.id, w.parent.id);
    w.server.delete(w.channel.id, w.carol.id, fourth.id);
    await w.engine.idle();
    expect(w.preview()).toEqual(["second", "third"]);
    expect(listCalls).not.toHaveBeenCalled();
    w.engine.stop();
  });

  it("an older server sends no previews: the card is the parent only, and events add nothing", async () => {
    const w = await world({ previews: false });
    expect(w.store.threads.get(w.parent.id)).toBeDefined();
    expect(w.preview()).toBeUndefined();
    expect(threadCardReplies(w.store.threads.get(w.parent.id)!, w.bob.id, () => false)).toBeNull();
    w.server.post(w.channel.id, w.carol.id, "fourth", undefined, w.parent.id);
    await w.engine.idle();
    expect(w.preview()).toBeUndefined();
    w.engine.stop();
  });
});

describe("threadCardReplies", () => {
  const reply = (id: string, sender: string, seq: number, extra: Partial<MessageState> = {}) => ({ id, sender_id: sender, seq, body: id, deleted: false, ...extra }) as MessageState;
  const entry = (replies: MessageState[] | undefined, lastRead: number, count: number) =>
    ({ parent: { id: "p" }, state: { last_read_seq: lastRead, reply_count: count }, latestReplies: replies }) as unknown as ThreadEntry;

  it("marks others' replies after my read position, never mine, and leaves blocked people out", () => {
    const card = threadCardReplies(entry([reply("a", "me", 5), reply("b", "bob", 6), reply("c", "eve", 7)], 5, 9), "me", (id) => id === "eve")!;
    expect(card.replies.map((r) => [r.message.id, r.unread])).toEqual([["a", false], ["b", true]]);
    expect(card.more).toBe(7);
    expect(threadCardReplies(entry([reply("b", "bob", 6)], 6, 1), "me", () => false)).toEqual({ replies: [{ message: expect.objectContaining({ id: "b" }), unread: false }], more: 0 });
  });
});

describe("ThreadsView card", () => {
  it("renders the replies under the parent; a reply opens the thread at it, the 「他」 line the thread", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
    const w = await world();
    w.store.setMe({ ...w.server.users.get(w.bob.id)!, id: w.bob.id } as unknown as UserMe);
    const onOpen = vi.fn();
    const controller = {
      store: w.store, engine: null, api: { baseUrl: "http://server", fetchBlob: vi.fn(async () => new Blob(["png"])) }, version: 0, setError: vi.fn(), messageFocus: null,
      subscribe: () => () => {},
    };
    function View() {
      useSyncExternalStore((l) => w.store.subscribe(l), () => w.store.version);
      return <ThreadsView controller={controller as unknown as AppController} selectedId={null} onOpen={onOpen} onOpenChannel={vi.fn()} />;
    }
    render(<View />);
    const rows = [...document.querySelectorAll("[data-thread-reply]")];
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("second"), expect.stringContaining("third")]);
    expect(rows[0]!.textContent).toContain("Carol");
    fireEvent.click(screen.getByText("他 1 件の返信"));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ parent: expect.objectContaining({ id: w.parent.id }) }), undefined);
    fireEvent.click(rows[1]!);
    expect(onOpen).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ body: "third" }));
    w.engine.stop();
  });
});
