// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { ackLine, compactNames } from "../src/ui/format";
import { LONG_PRESS_MS } from "../src/ui/MessageActionsSheet";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function touchScreen(touch: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)" ? touch : !touch, addEventListener: () => {}, removeEventListener: () => {} }));
}

/** Alice (me), Bob, Carol, Dave and Erin in #general; one message of Bob's, reacted to or acknowledged by the test. */
function world() {
  const server = new FakeServer();
  const users = ["alice", "bob", "carol", "dave", "erin"].map((name) => server.addUser(name));
  const [me, bob] = users as [(typeof users)[0], (typeof users)[0]];
  const channel = server.createChannel("general", me.id);
  for (const user of users.slice(1)) server.join(channel.id, user.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  for (const user of users) store.upsertUser(user);
  store.replaceCustomEmoji([server.addEmoji("party", me.id)]);
  const message = server.post(channel.id, bob.id, "明日の件です", undefined, null, [], { ackRequested: true }).message;
  store.upsertMessage(message);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: message.seq, oldestLoadedSeq: 0, lastReadSeq: message.seq });
  URL.createObjectURL = vi.fn(() => "blob:party");
  const onOpenThread = vi.fn();
  const controller = {
    store, engine: null, api: { baseUrl: "http://server", fetchBlob: vi.fn(async () => new Blob(["png"])) }, version: 0, setError: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {}, toggleReaction: vi.fn(async () => {}), toggleAck: vi.fn(async () => {}), ackPending: vi.fn(async () => users.slice(3).map((u) => u.id)), remindAck: vi.fn(async () => ({ ok: true, text: "" })),
  };
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} onOpenThread={onOpenThread} />;
  }
  render(<View />);
  const react = (userIndex: number, emoji: string) => {
    act(() => { store.upsertMessage(server.react(channel.id, users[userIndex]!.id, message.id, emoji, true).message); });
  };
  const acknowledge = (userIndexes: number[]) => {
    const current = store.message(channel.id, message.id)!;
    const acks = userIndexes.map((i, n) => ({ user_id: users[i]!.id, acked_at: new Date(Date.UTC(2026, 8, 29, 1, n)).toISOString() }));
    act(() => { store.upsertMessage({ ...current, acks, updated_seq: current.updated_seq + 1 }); });
  };
  return { controller, message, react, acknowledge, onOpenThread, row: () => document.getElementById(`timeline-${message.id}`)! };
}

describe("names in a line (M27, the same on iOS and Android)", () => {
  it("shows up to three names, then 「ほか N 人」", () => {
    expect(compactNames(["山田"])).toBe("山田");
    expect(compactNames(["山田", "佐藤", "鈴木"])).toBe("山田、佐藤、鈴木");
    expect(compactNames(["山田", "佐藤", "鈴木", "田中", "高橋"])).toBe("山田、佐藤、鈴木 ほか 2 人");
    expect(ackLine(["山田", "佐藤"])).toBe("山田、佐藤 が確認");
    expect(ackLine(["山田", "佐藤", "鈴木", "田中"])).toBe("山田、佐藤、鈴木 ほか 1 人が確認");
    expect(ackLine([])).toBe("");
  });
});

describe("リアクションした人 (M27)", () => {
  it("on a phone: the long-press sheet offers it while the message has reactions, and lists each emoji with its people", async () => {
    touchScreen(true);
    vi.useFakeTimers();
    const w = world();
    const longPress = () => {
      fireEvent.touchStart(w.row(), { touches: [{ clientX: 10, clientY: 10 }] });
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    };
    longPress();
    expect(within(screen.getByRole("dialog", { name: "メッセージの操作" })).queryByText("リアクションした人")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });

    w.react(2, "👍");
    w.react(0, "👍");
    w.react(3, ":party:");
    longPress();
    act(() => { vi.advanceTimersByTime(400); }); // the finger that opened the sheet has lifted
    fireEvent.click(within(screen.getByRole("dialog", { name: "メッセージの操作" })).getByText("リアクションした人"));
    vi.useRealTimers();
    const list = screen.getByRole("dialog", { name: "リアクションした人" });
    const rows = list.querySelectorAll("[data-reaction]");
    expect([...rows].map((r) => r.getAttribute("data-reaction"))).toEqual(["👍", ":party:"]);
    expect(rows[0]!.textContent).toContain("Carol、Alice"); // in the order they reacted
    expect(rows[0]!.textContent).toContain("2");
    expect(rows[1]!.textContent).toContain("Dave");
    // A custom emoji is its picture, as in the chips.
    await waitFor(() => expect(within(rows[1] as HTMLElement).getByRole("img").getAttribute("alt")).toBe(":party:"));
    // A tap in the list is not a tap on the message behind it (the dialog is a portal the row's handlers still hear).
    fireEvent.click(rows[0]!);
    expect(w.onOpenThread).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "リアクションした人" })).toBeTruthy();
  });

  it("with a mouse: the chips keep their hover names, and the hover bar opens the same list", () => {
    touchScreen(false);
    const w = world();
    expect(within(w.row()).queryByRole("button", { name: "リアクションした人" })).toBeNull(); // nothing to list yet
    w.react(1, "🎉");
    w.react(4, "🎉");
    const chip = within(w.row()).getByTitle("Bob, Erin");
    expect(chip.textContent).toContain("2");
    fireEvent.click(within(w.row()).getByRole("button", { name: "リアクションした人" }));
    expect(within(screen.getByRole("dialog", { name: "リアクションした人" })).getByText("Bob、Erin")).toBeTruthy();
  });
});

describe("確認した人 (M27)", () => {
  it("names who confirmed in the line, and a click lists all of them, oldest first", () => {
    touchScreen(false);
    const w = world();
    expect(within(w.row()).getByText("まだ誰も確認していません")).toBeTruthy();
    w.acknowledge([2, 0]);
    expect(within(w.row()).getByText("Carol、Alice が確認")).toBeTruthy();
    w.acknowledge([2, 0, 3, 4]);
    const line = within(w.row()).getByRole("button", { name: "確認した人 (4 人)" });
    expect(line.textContent).toBe("Carol、Alice、Dave ほか 1 人が確認");
    fireEvent.click(line);
    const list = screen.getByRole("dialog", { name: "確認した人" });
    // The first list (who confirmed); 「未確認」 below has its own (M31).
    expect([...list.querySelector("ul")!.querySelectorAll("li")].map((li) => li.querySelector("span.font-medium")?.textContent)).toEqual(["Carol", "Alice", "Dave", "Erin"]);
  });

  it("「まだ誰も確認していません」 opens the list too, with who has not confirmed (M31)", async () => {
    touchScreen(false);
    const w = world();
    fireEvent.click(within(w.row()).getByRole("button", { name: "まだ誰も確認していません" }));
    const list = screen.getByRole("dialog", { name: "確認した人" });
    expect(await within(list).findByText("未確認 2 人")).toBeTruthy();
    expect(within(list).getByText("Dave")).toBeTruthy();
    expect(within(list).getByText("Erin")).toBeTruthy();
    // Alice is neither the author (Bob is) nor an admin: no reminder button.
    expect(within(list).queryByRole("button", { name: "未確認の人にリマインド" })).toBeNull();
  });
});
