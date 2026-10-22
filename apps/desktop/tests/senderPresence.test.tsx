// @vitest-environment jsdom
// The presence dot on a message's sender (docs/PRESENCE.md §11.5, 2026-10-13): at the corner of the avatar of a group's
// first message in a conversation and in a thread, kept current by its own subscription (the rows are not redrawn),
// none for a bot, none on a continuation row (no avatar there), and its ring cut out of the picture. Offline (2026-10-13):
// a hollow grey ring in the hole, one element.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { avatarDotSize, presenceRing } from "../src/ui/Avatar";
import { MessageRow } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const bot = { ...server.addUser("hook"), role: "bot" } as UserPublic;
  const channel = server.createChannel("general", me.id);
  server.join(channel.id, bob.id);
  server.join(channel.id, bot.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  for (const user of [me, bob, bot]) store.upsertUser(user);
  const first = server.post(channel.id, bob.id, "最初").message;
  const next = server.post(channel.id, bob.id, "続き").message;
  const fromBot = server.post(channel.id, bot.id, "通知").message;
  const reply = server.post(channel.id, bob.id, "返信", undefined, first.id).message;
  for (const m of [first, next, fromBot, reply]) store.upsertMessage(m);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 4, oldestLoadedSeq: 0, lastReadSeq: 4 });
  const controller = {
    store, engine: { markUnread: vi.fn(), tasks: null }, api: null, version: 0, setError: vi.fn(), setNotice: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
  } as unknown as AppController;
  // No subscription here: the rows are drawn once, so a dot that changes later changed by itself.
  const parentRenders = { count: 0 };
  function View() {
    parentRenders.count += 1;
    return (
      <>
        <MessageRow controller={controller} message={store.getMessage(channel.id, first.id)!} onOpenThread={() => {}} />
        <MessageRow controller={controller} message={store.getMessage(channel.id, next.id)!} compact onOpenThread={() => {}} />
        <MessageRow controller={controller} message={store.getMessage(channel.id, fromBot.id)!} onOpenThread={() => {}} />
        <MessageRow thread controller={controller} message={store.getMessage(channel.id, reply.id)!} />
      </>
    );
  }
  render(<View />);
  const row = (id: string, thread = false) => document.getElementById(`${thread ? "thread" : "timeline"}-${id}`)!;
  const dot = (id: string, thread = false) => row(id, thread).querySelector<HTMLElement>("[data-presence]");
  return { store, bob, bot, parentRenders, ids: { first: first.id, next: next.id, fromBot: fromBot.id, reply: reply.id }, dot };
}

describe("the presence dot on a message's sender", () => {
  it("appears on the first message of a group and on a thread reply, sized to the avatar, its ring cut out", () => {
    const w = world();
    act(() => w.store.setPresence(w.bob.id, "online"));
    const dot = w.dot(w.ids.first)!;
    expect(dot.dataset.presence).toBe("online");
    expect(dot.className).toContain("bg-success");
    expect(dot.className).toContain("border-transparent");
    expect(dot.style.width).toBe(`${avatarDotSize(36)}px`);
    const threadDot = w.dot(w.ids.reply, true)!;
    expect(threadDot.dataset.presence).toBe("online");
    expect(threadDot.style.width).toBe(`${avatarDotSize(30)}px`);
    // The thread pane's 30 px pictures (2026-10-23: 9 px looked small): 11 px with a 1.5 px ring; the channel's 14 px.
    expect(threadDot.style.width).toBe("11px");
    expect(threadDot.style.borderWidth).toBe("1.5px");
    expect(dot.style.width).toBe("14px");
  });

  it("updates live (away, 取り込み中, offline) without redrawing the list", () => {
    const w = world();
    expect(w.dot(w.ids.first)?.dataset.presence).toBe("offline"); // offline: the hollow ring
    const renders = w.parentRenders.count;
    act(() => w.store.setPresence(w.bob.id, "online"));
    expect(w.dot(w.ids.first)?.dataset.presence).toBe("online");
    act(() => w.store.setPresence(w.bob.id, "away"));
    expect(w.dot(w.ids.first)?.dataset.presence).toBe("away");
    expect(w.dot(w.ids.reply, true)?.dataset.presence).toBe("away");
    act(() => w.store.upsertUser({ ...w.bob, dnd_until: new Date(Date.now() + 3_600_000).toISOString() }));
    expect(w.dot(w.ids.first)?.dataset.presence).toBe("dnd");
    expect(w.dot(w.ids.first)?.className).toContain("bg-danger");
    act(() => {
      w.store.upsertUser({ ...w.bob, dnd_until: null });
      w.store.setPresence(w.bob.id, "offline");
    });
    expect(w.dot(w.ids.first)?.dataset.presence).toBe("offline");
    expect(w.dot(w.ids.reply, true)?.dataset.presence).toBe("offline");
    expect(w.parentRenders.count).toBe(renders);
  });

  it("offline: one grey ring with a see-through centre, in a hole cut out of the picture", () => {
    const w = world();
    const ring = w.dot(w.ids.first)!;
    expect(ring.dataset.presence).toBe("offline");
    expect(ring.childElementCount).toBe(0);
    expect(ring.className).toContain("border-muted");
    expect(ring.className).toContain("bg-transparent");
    // 36 px: a 14 px dot, a 10 px ring 2 px wide inside a 2 px gap (PRESENCE.md §11.9).
    expect(ring.style.width).toBe(`${avatarDotSize(36) - 2 * presenceRing(avatarDotSize(36))}px`);
    expect(ring.style.width).toBe("10px");
    expect(ring.style.borderWidth).toBe("2px");
    const picture = ring.closest("[aria-hidden]")!.firstElementChild as HTMLElement;
    expect(picture.style.maskImage).toContain("radial-gradient");
    // A bot offline still has none.
    expect(w.dot(w.ids.fromBot)).toBeNull();
  });

  it("is absent for a bot (a webhook's too) and on a continuation row", () => {
    const w = world();
    act(() => {
      w.store.setPresence(w.bob.id, "online");
      w.store.setPresence(w.bot.id, "online");
    });
    expect(w.dot(w.ids.fromBot)).toBeNull();
    expect(w.dot(w.ids.next)).toBeNull();
    expect(w.dot(w.ids.first)).not.toBeNull();
  });
});
