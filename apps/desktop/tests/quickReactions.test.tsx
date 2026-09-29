// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { rememberEmoji } from "../src/ui/EmojiPicker";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  localStorage.removeItem("chikuwa.emoji.recent");
});

/** The quick reactions of every row's hover bar, in order. */
function quickRows(): string[][] {
  return [...document.querySelectorAll(".row-actions")].map((bar) => [...bar.querySelectorAll("button")].map((b) => b.title).filter((t) => t.endsWith("でリアクション")).map((t) => t.replace(" でリアクション", "")));
}

it("a pick in one row moves the quick reactions of every row, memoized or not (M28b)", () => {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", me.id);
  server.join(channel.id, bob.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  store.upsertUser(me);
  store.upsertUser(bob);
  store.upsertMessage(server.post(channel.id, bob.id, "first").message);
  store.upsertMessage(server.post(channel.id, bob.id, "second").message);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 2, oldestLoadedSeq: 0, lastReadSeq: 2 });
  const controller = {
    store, engine: null, api: null, version: 0, setError: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {}, toggleReaction: vi.fn(async () => {}),
  } as unknown as AppController;
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return <Timeline controller={controller} channel={store.getChannel(channel.id)!} />;
  }
  render(<View />);
  expect(quickRows()).toEqual([["👍", "❤️", "😂"], ["👍", "❤️", "😂"]]);
  // What toggleReaction (AppController) and the pickers do after a pick; nothing else re-renders the rows here.
  act(() => rememberEmoji("🍤"));
  expect(quickRows()).toEqual([["🍤", "👍", "❤️"], ["🍤", "👍", "❤️"]]);
});
