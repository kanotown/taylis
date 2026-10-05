// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkPreviewOut, UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { firstLink } from "../src/ui/links";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

// Called once per row render: counts how many rows a change re-rendered.
vi.mock("../src/ui/links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/links")>();
  return { ...actual, firstLink: vi.fn(actual.firstLink) };
});

afterEach(() => {
  cleanup();
  vi.mocked(firstLink).mockClear();
});

/** A channel of 30 messages from bob (one with a link), shown like the app: re-rendered on every store or controller change. */
function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", me.id);
  const other = server.createChannel("other", me.id);
  server.join(channel.id, bob.id);
  server.join(other.id, bob.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  store.upsertUser(me);
  store.upsertUser(bob);
  const posted = Array.from({ length: 30 }, (_, i) => server.post(channel.id, bob.id, i === 29 ? "see https://example.com/a" : `message ${i}`).message);
  for (const message of posted) store.upsertMessage(message);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 30, oldestLoadedSeq: 0, lastReadSeq: 30 });
  store.upsertChannel(other, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });

  const listeners = new Set<() => void>();
  const previewListeners = new Set<() => void>();
  const controller = {
    store,
    engine: null,
    api: null,
    version: 0,
    setError: vi.fn(),
    messageFocus: null,
    editing: null as string | null,
    isAdmin: false,
    sendKey: "shift-enter",
    linkPreviews: new Map<string, LinkPreviewOut | null>(),
    linkPreview: vi.fn(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeLinkPreviews(listener: () => void) {
      previewListeners.add(listener);
      return () => previewListeners.delete(listener);
    },
    emit() {
      this.version += 1;
      for (const listener of listeners) listener();
    },
    previewArrived(url: string, preview: LinkPreviewOut) {
      this.linkPreviews.set(url, preview);
      for (const listener of previewListeners) listener();
    },
  };
  function View() {
    useSyncExternalStore(
      (listener) => {
        const a = store.subscribe(listener);
        const b = controller.subscribe(listener);
        return () => {
          a();
          b();
        };
      },
      () => `${store.version}:${controller.version}`,
    );
    // A new function on every render, as MainScreen passes it.
    return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} onOpenThread={() => {}} />;
  }
  render(<View />);
  vi.mocked(firstLink).mockClear();
  return { server, me, bob, channel, other, store, controller, posted };
}

describe("memoized message rows (M21)", () => {
  it("a change the rows do not show re-renders none of them; a changed message re-renders only its row", () => {
    const w = world();
    act(() => {
      w.store.noteTyping(w.other.id, null, w.bob.id, Date.now() + 5000);
      w.store.setDraft(w.channel.id, null, { text: "あ" });
      w.store.updateChannel(w.other.id, { unreadCount: 3 });
      w.controller.emit();
    });
    expect(firstLink).not.toHaveBeenCalled();

    const target = w.posted[10]!;
    act(() => {
      w.store.upsertMessage({ ...target, reactions: [{ emoji: "👍", count: 1, user_ids: [w.me.id] }], updated_seq: target.updated_seq + 100 });
    });
    expect(vi.mocked(firstLink).mock.calls.map(([body]) => body)).toEqual([target.body]);
    expect(document.querySelector(`[data-reacted-by="${w.me.display_name}"]`)!.textContent).toContain("👍");
  });

  it("rows still follow what they show besides their message", () => {
    const w = world();
    const target = w.posted[5]!;
    act(() => w.store.upsertUser({ ...w.bob, display_name: "Robert" }));
    expect(screen.getAllByText("Robert").length).toBeGreaterThan(0);

    act(() => w.store.setBookmarked(target.id, true));
    expect(screen.getAllByText("保存済み")).toHaveLength(1);

    act(() => {
      w.controller.editing = target.id;
      w.controller.emit();
    });
    expect(screen.getByLabelText("メッセージを編集")).toBeTruthy();

    act(() => w.controller.previewArrived("https://example.com/a", { url: "https://example.com/a", status: "ok", title: "Example page", fetched_at: "2026-09-28T00:00:00Z" } as LinkPreviewOut));
    expect(screen.getByText("Example page")).toBeTruthy();
  });

  it("a reply also sent to the channel follows its parent's edits", () => {
    const w = world();
    const parent = w.posted[0]!;
    const reply = w.server.post(w.channel.id, w.bob.id, "a reply", undefined, parent.id, [], { alsoInChannel: true }).message;
    act(() => {
      w.store.upsertMessage(reply);
      w.store.updateChannel(w.channel.id, { syncedSeq: reply.seq, lastSeq: reply.seq, lastReadSeq: reply.seq });
    });
    expect(screen.getByText("message 0", { selector: "span.truncate" })).toBeTruthy();
    act(() => w.store.upsertMessage({ ...parent, body: "edited parent", updated_seq: parent.updated_seq + 100 }));
    expect(screen.getByText("edited parent", { selector: "span.truncate" })).toBeTruthy();
  });
});
