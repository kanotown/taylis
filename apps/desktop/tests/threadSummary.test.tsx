// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { MessageState } from "../src/sync/types";
import { lastReplyLabel } from "../src/ui/format";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";
import { hoverListText } from "./hoverList";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Alice (me) and four others in #general; a post of Bob's, given thread fields by the test. */
function world() {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query !== "(hover: none)", addEventListener: () => {}, removeEventListener: () => {} }));
  const server = new FakeServer();
  const users = ["alice", "bob", "carol", "dave", "erin"].map((name) => server.addUser(name));
  const [me, bob] = users as [(typeof users)[0], (typeof users)[0]];
  const channel = server.createChannel("general", me.id);
  for (const user of users.slice(1)) server.join(channel.id, user.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  for (const user of users) store.upsertUser(user);
  const message = server.post(channel.id, bob.id, "スレッドの親").message;
  store.upsertMessage(message);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: message.seq, oldestLoadedSeq: 0, lastReadSeq: message.seq });
  const onOpenThread = vi.fn();
  const controller = {
    store, engine: null, api: { baseUrl: "http://server", fetchBlob: vi.fn(async () => new Blob(["png"])) }, version: 0, setError: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {}, toggleReaction: vi.fn(async () => {}),
  };
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} onOpenThread={onOpenThread} />;
  }
  render(<View />);
  let updatedSeq = message.updated_seq;
  const setThread = (patch: Partial<MessageState>) => {
    const current = store.message(channel.id, message.id)!;
    act(() => { store.upsertMessage({ ...current, ...patch, updated_seq: ++updatedSeq } as MessageState); });
  };
  const summary = () => screen.getByTestId("thread-summary");
  return { users, message, onOpenThread, setThread, summary };
}

function today(hours: number, minutes: number): string {
  const at = new Date();
  at.setHours(hours, minutes, 0, 0);
  return at.toISOString();
}

describe("the thread line under a parent (C3)", () => {
  it("shows up to three repliers, 「N 件の返信」 and 「最終返信」, and opens the thread", () => {
    const w = world();
    expect(screen.queryByTestId("thread-summary")).toBeNull(); // no replies, no line
    const [alice, , carol, dave, erin] = w.users;
    w.setThread({ reply_count: 6, last_reply_at: today(14, 5), reply_user_ids: [erin!.id, dave!.id, carol!.id, alice!.id] });
    const line = w.summary();
    expect(line.textContent).toContain("6 件の返信");
    expect(line.textContent).toContain("最終返信 今日 14:05");
    const avatars = [...line.querySelectorAll("span[aria-hidden='true']")].map((a) => a.textContent);
    expect(avatars).toEqual(["E", "D", "C"]); // the three most recent, Erin's first
    expect(hoverListText(line)).toMatch(/^返信した人：Erin、Dave、Carol ほか 1 人\n最終返信 /);
    fireEvent.click(line);
    expect(w.onOpenThread).toHaveBeenCalledWith(w.message.id);
  });

  it("an older server sends no repliers: the count and the time without avatars", () => {
    const w = world();
    w.setThread({ reply_count: 2, last_reply_at: today(9, 30), reply_user_ids: undefined });
    const line = w.summary();
    expect(line.querySelectorAll("span[aria-hidden='true']")).toHaveLength(0);
    expect(line.querySelector("svg")).not.toBeNull(); // the speech bubble
    expect(line.textContent).toBe("2 件の返信最終返信 今日 09:30");
    expect(hoverListText(line)).toMatch(/^最終返信 /); // no repliers to name
  });
});

describe("lastReplyLabel (C3)", () => {
  it("says the day as the day separators do, then the time", () => {
    const now = new Date(2026, 8, 30, 18, 0);
    expect(lastReplyLabel(new Date(2026, 8, 30, 14, 5).toISOString(), now)).toBe("最終返信 今日 14:05");
    expect(lastReplyLabel(new Date(2026, 8, 29, 23, 59).toISOString(), now)).toBe("最終返信 昨日 23:59");
    expect(lastReplyLabel(new Date(2026, 8, 26, 8, 0).toISOString(), now)).toBe("最終返信 9月26日 (土) 08:00");
    expect(lastReplyLabel(new Date(2025, 11, 31, 8, 0).toISOString(), now)).toBe("最終返信 2025年12月31日 (水) 08:00");
    expect(lastReplyLabel("not a date", now)).toBe("");
  });
});
