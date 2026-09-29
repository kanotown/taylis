// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../src/api/errors";
import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { type SyncApi, SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { PreviewJoinBar, PreviewThreadPane, PreviewTimeline } from "../src/ui/ChannelPreview";
import { LONG_PRESS_MS } from "../src/ui/MessageActionsSheet";
import { ThreadPane } from "../src/ui/ThreadPane";
import { FakeServer, MemoryPersistence } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Alice's public #lab with five posts, a thread and a poll; Bob (this device) has not joined it. Pages of 3, so the
 * preview has an older page.
 */
async function world(options: { refuseNonMembers?: boolean } = {}) {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("lab", alice.id);
  const mine = server.createChannel("general", bob.id);
  const first = server.post(channel.id, alice.id, "one").message;
  server.post(channel.id, alice.id, "two");
  server.post(channel.id, alice.id, "three");
  server.post(channel.id, alice.id, "reply", undefined, first.id);
  const poll = server.postPoll(channel.id, alice.id, { question: "どれ?", options: ["A", "B"] });
  server.vote(channel.id, alice.id, poll.id, 0, true);
  server.react(channel.id, alice.id, first.id, "👍", true);
  server.post(channel.id, alice.id, "five");
  const persistence = new MemoryPersistence();
  const store = new Store(persistence);
  const plain = server.apiFor(bob.id);
  const markRead = vi.fn(plain.markRead);
  const api: SyncApi = { ...plain, markRead };
  // A server before M27: only members read a channel.
  if (options.refuseNonMembers) {
    api.history = async (channelId, before, limit) => {
      if (!server.channels.get(channelId)!.members.has(bob.id)) throw new ApiError(403, "not_a_member", "Not a member");
      return plain.history(channelId, before, limit);
    };
  }
  const engine = new SyncEngine({ api, connect: server.connectorFor(bob.id), store, getAccessToken: () => "token", sleep: async () => {} }, { pageSize: 3, readDebounceMs: 0 });
  await engine.start();
  await engine.idle();
  return { server, alice, bob, channel, mine, first, poll, store, engine, persistence, markRead, api };
}

const bodies = (rows: { body: string }[]) => rows.map((m) => m.body);

/** Let a dropped socket reconnect (the engine's sleep is a no-op here). */
async function reconnected(engine: SyncEngine): Promise<void> {
  for (let i = 0; i < 20 && engine.status !== "online"; i++) await engine.idle();
  await engine.idle();
  expect(engine.status).toBe("online");
}

/** What 「#name に参加する」 does (AppController.joinChannel): the server adds me, the store learns it, the member path opens. */
async function joined(w: Awaited<ReturnType<typeof world>>): Promise<void> {
  w.server.join(w.channel.id, w.bob.id);
  w.store.upsertChannel({ ...w.server.channels.get(w.channel.id)!.channel, membership: { role: "member", joined_at: "" } }, { isMember: true });
  await w.engine.openChannel(w.channel.id);
  await w.engine.idle();
}

describe("preview before joining (SYNC_PROTOCOL.md §7.6.1)", () => {
  it("opens a public channel without joining: its rows in memory only, no cursor, no read mark", async () => {
    const w = await world();
    await w.engine.openChannel(w.mine.id);
    await w.engine.idle();
    expect(w.store.getChannel(w.channel.id)?.isMember).toBe(false); // listed under 参加できるチャンネル

    await w.engine.openPreview(w.channel.id);
    expect(w.engine.currentChannelId).toBeNull(); // no conversation of mine is open meanwhile
    expect(bodies(w.engine.preview!.messages)).toEqual(["three", "📊 どれ?", "five"]);
    expect(w.engine.preview!.hasOlder).toBe(true);
    await w.engine.loadPreviewOlder();
    expect(bodies(w.engine.preview!.messages)).toEqual(["one", "two", "three", "📊 どれ?", "five"]);
    expect(w.engine.preview!.hasOlder).toBe(false);
    await w.engine.loadPreviewThread(w.first.id);
    expect(bodies(w.engine.preview!.replies.get(w.first.id)!)).toEqual(["reply"]);

    // Nothing reached the store or its database, and the channel has no cursor.
    await w.store.flushPersistence();
    expect(w.store.messages(w.channel.id)).toEqual([]);
    expect([...w.persistence.messages.values()].filter((row) => row.channelId === w.channel.id)).toEqual([]);
    expect(w.store.getChannel(w.channel.id)).toMatchObject({ isMember: false, syncedSeq: null });
    // Reading it moves no read position, here or on the server.
    w.engine.markRead(w.channel.id, 7, { force: true });
    await w.engine.flushReads();
    expect(w.markRead).not.toHaveBeenCalled();
    expect(w.server.channels.get(w.channel.id)!.members.has(w.bob.id)).toBe(false);
  });

  it("after joining, the same conversation loads like any of mine and the preview goes", async () => {
    const w = await world();
    await w.engine.openPreview(w.channel.id);
    await joined(w);
    expect(w.engine.preview).toBeNull();
    expect(w.engine.currentChannelId).toBe(w.channel.id);
    expect(bodies(w.store.messages(w.channel.id))).toEqual(["three", "📊 どれ?", "five"]);
  });

  it("another conversation drops the preview; a server without previews (403) leaves joining as the way in", async () => {
    const w = await world({ refuseNonMembers: true });
    await w.engine.openPreview(w.channel.id);
    expect(w.engine.preview).toMatchObject({ refused: true, loaded: false, messages: [] });
    await w.engine.openChannel(w.mine.id);
    expect(w.engine.preview).toBeNull();
  });

  it("reads the latest page again after reconnecting: older pages stay when it reaches them, else it starts over (M28b)", async () => {
    const w = await world();
    await w.engine.openPreview(w.channel.id);
    await w.engine.loadPreviewOlder();
    expect(bodies(w.engine.preview!.messages)).toEqual(["one", "two", "three", "📊 どれ?", "five"]);
    // No event reaches a non-member: only the page read again after the reconnect shows what was posted meanwhile.
    w.server.disconnect(w.bob.id);
    w.server.post(w.channel.id, w.alice.id, "six");
    await reconnected(w.engine);
    await waitFor(() => expect(bodies(w.engine.preview!.messages)).toEqual(["one", "two", "three", "📊 どれ?", "five", "six"]));
    expect(w.engine.preview).toMatchObject({ hasOlder: false, loading: false });
    // More than a page missed: the rows read before may not join up with the page, which replaces them.
    w.server.disconnect(w.bob.id);
    for (const body of ["seven", "eight", "nine", "ten"]) w.server.post(w.channel.id, w.alice.id, body);
    await reconnected(w.engine);
    await waitFor(() => expect(bodies(w.engine.preview!.messages)).toEqual(["eight", "nine", "ten"]));
    expect(w.engine.preview!.hasOlder).toBe(true);
  });

  it("a page that fails once the preview is closed is nobody's error (M28b)", async () => {
    const w = await world();
    await w.engine.openPreview(w.channel.id);
    let fail!: () => void;
    const history = w.api.history;
    w.api.history = (channelId, before, limit) => (channelId === w.channel.id ? new Promise((_, reject) => { fail = () => reject(new NetworkError("offline")); }) : history(channelId, before, limit));
    const older = w.engine.loadPreviewOlder();
    await w.engine.openChannel(w.mine.id); // the reader moved on before the page came back
    fail();
    await expect(older).resolves.toBeUndefined();
    expect(w.engine.preview).toBeNull();
  });

  it("a channel that leaves the store takes its preview or its open conversation with it (M28b)", async () => {
    const w = await world();
    await w.engine.openPreview(w.channel.id);
    w.server.updateChannel(w.channel.id, { type: "private" }); // made private while I read it (M15b)
    await w.engine.idle();
    expect(w.store.getChannel(w.channel.id)).toBeUndefined();
    expect(w.engine.preview).toBeNull();
    await w.engine.openChannel(w.mine.id);
    w.engine.removeChannel(w.mine.id); // channel.member_removed for me
    expect(w.engine.currentChannelId).toBeNull();
  });
});

describe("the preview on screen", () => {
  async function screenWorld() {
    const w = await world();
    w.store.setMe(w.server.users.get(w.bob.id) as unknown as UserMe);
    await w.engine.openPreview(w.channel.id);
    const onJoin = vi.fn(async () => true);
    const onOpenThread = vi.fn();
    const controller = {
      store: w.store, engine: w.engine, api: { baseUrl: "http://server" }, version: 0, setError: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
      linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
      toggleReaction: vi.fn(), vote: vi.fn(), toggleAck: vi.fn(), clearMessageFocus: vi.fn(),
    } as unknown as AppController;
    function View() {
      useSyncExternalStore((l) => w.engine.subscribe(l), () => w.engine.preview);
      useSyncExternalStore((l) => w.store.subscribe(l), () => w.store.version);
      const channel = w.store.getChannel(w.channel.id)!;
      return (
        <>
          <PreviewTimeline controller={controller} channel={channel} onOpenThread={onOpenThread} />
          <PreviewJoinBar controller={controller} channel={channel} onJoin={onJoin} />
        </>
      );
    }
    render(<View />);
    return { ...w, controller, onJoin, onOpenThread };
  }

  it("reads only: no hover bar, reactions and votes that do nothing, and 「#name に参加する」 in place of the input", async () => {
    const w = await screenWorld();
    expect(screen.getByText("five")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector(".row-actions")).toBeNull();
    // Scrolling up brings the older page (and the channel's start).
    const list = screen.getByLabelText("メッセージ一覧");
    await act(async () => { fireEvent.scroll(list, { target: { scrollTop: 0 } }); });
    await waitFor(() => expect(screen.getByText("one")).toBeTruthy());
    const first = document.getElementById(`timeline-${w.first.id}`)!;
    const chip = within(first).getByTitle("Alice");
    expect(chip.tagName).toBe("SPAN"); // no toggle
    expect(within(first).queryByRole("button", { name: "リアクションを追加" })).toBeNull();
    const option = document.getElementById(`timeline-${w.poll.id}`)!.querySelector<HTMLButtonElement>("li button")!;
    expect(option.disabled).toBe(true);
    expect(within(option).getByText("Alice")).toBeTruthy(); // who voted still shows
    expect(screen.queryByText("締め切る")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "#lab に参加する" }));
    expect(w.onJoin).toHaveBeenCalledWith(w.channel.id);
  });

  it("offers no long-press sheet on a phone; a tap opens the thread, read-only", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)", addEventListener: () => {}, removeEventListener: () => {} }));
    const w = await screenWorld();
    vi.useFakeTimers();
    const five = w.server.messageByBody(w.channel.id, "five");
    const row = document.getElementById(`timeline-${five.id}`)!;
    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 50); });
    fireEvent.touchEnd(row);
    expect(screen.queryByRole("dialog", { name: "メッセージの操作" })).toBeNull();
    vi.useRealTimers();
    fireEvent.click(within(row).getByText("five"));
    expect(w.onOpenThread).toHaveBeenCalledWith(five.id);

    cleanup();
    function Thread() {
      useSyncExternalStore((l) => w.engine.subscribe(l), () => w.engine.preview);
      return <PreviewThreadPane controller={w.controller} channel={w.store.getChannel(w.channel.id)!} parentId={w.first.id} onClose={() => {}} />;
    }
    render(<Thread />);
    await waitFor(() => expect(screen.getByText("reply")).toBeTruthy());
    expect(screen.getByText("1 件の返信")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("チャンネルに参加すると返信できます")).toBeTruthy();
    expect(w.store.messages(w.channel.id)).toEqual([]);
  });

  it("keeps a thread from the preview open after joining: a parent older than the loaded page is fetched (M28b)", async () => {
    const w = await screenWorld();
    await w.engine.loadPreviewThread(w.first.id);
    cleanup();
    await joined(w);
    expect(w.store.message(w.channel.id, w.first.id)).toBeUndefined(); // "one" is before the page of three
    (w.controller.api as unknown as { uploadAttachment: unknown }).uploadAttachment = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    function Thread() {
      useSyncExternalStore((l) => w.store.subscribe(l), () => w.store.version);
      return <ThreadPane controller={w.controller} channel={w.store.getChannel(w.channel.id)!} parentId={w.first.id} onClose={() => {}} />;
    }
    render(<Thread />);
    await waitFor(() => expect(screen.getByText("one")).toBeTruthy());
    expect(screen.queryByText("メッセージが見つかりません")).toBeNull();
    expect(screen.getByText("reply")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy(); // the reply box
  });
});
