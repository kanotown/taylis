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
import { ackCountLabel } from "../src/ui/AckBar";
import { HOVER_LIST } from "../src/ui/primitives";
import { FakeServer } from "./fakeServer";
import { hoverListText, openHoverList } from "./hoverList";
import { chooseFromRowMenu, rowMenuLabels, tick } from "./rowMenu";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function touchScreen(touch: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)" ? touch : !touch, addEventListener: () => {}, removeEventListener: () => {} }));
}

/** Alice (me), Bob, Carol, Dave and Erin in #general; one message of Bob's, reacted to or acknowledged by the test. */
function world({ meIndex = 0, isAdmin = false }: { meIndex?: number; isAdmin?: boolean } = {}) {
  const server = new FakeServer();
  const users = ["alice", "bob", "carol", "dave", "erin"].map((name) => server.addUser(name));
  const [alice, bob] = users as [(typeof users)[0], (typeof users)[0]];
  const channel = server.createChannel("general", alice.id);
  for (const user of users.slice(1)) server.join(channel.id, user.id);
  const store = new Store();
  store.setMe(users[meIndex] as unknown as UserMe);
  for (const user of users) store.upsertUser(user);
  store.replaceCustomEmoji([server.addEmoji("party", alice.id)]);
  const message = server.post(channel.id, bob.id, "明日の件です", undefined, null, [], { ackRequested: true }).message;
  store.upsertMessage(message);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: message.seq, oldestLoadedSeq: 0, lastReadSeq: message.seq });
  URL.createObjectURL = vi.fn(() => "blob:party");
  const onOpenThread = vi.fn();
  // Who the server says has not confirmed (GET …/ack/pending): Dave and Erin.
  const pending = users.slice(3).map((u) => u.id);
  const controller = {
    store, engine: null, api: { baseUrl: "http://server", fetchBlob: vi.fn(async () => new Blob(["png"])) }, version: 0, setError: vi.fn(), messageFocus: null, editing: null, isAdmin, sendKey: "shift-enter",
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {}, toggleReaction: vi.fn(async () => {}), toggleAck: vi.fn(async () => {}), ackPending: vi.fn(async () => pending), remindAck: vi.fn(async () => ({ ok: true, text: "" })),
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
  const ackRow = () => within(document.getElementById(`timeline-${message.id}`)!).getByRole("group", { name: "確認のお願い" });
  return { controller, message, react, acknowledge, ackRow, onOpenThread, row: () => document.getElementById(`timeline-${message.id}`)! };
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

  it("with a mouse: the chips keep their hover names, and the hover bar opens the same list", async () => {
    touchScreen(false);
    const w = world();
    expect(rowMenuLabels(w.row())).not.toContain("リアクションした人"); // nothing to list yet
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await tick();
    w.react(1, "🎉");
    w.react(4, "🎉");
    const chip = w.row().querySelector<HTMLElement>("[data-reacted-by]")!;
    expect(chip.textContent).toContain("2");
    expect(chip.getAttribute("title")).toBeNull(); // not a native tooltip at the pointer
    expect(hoverListText(chip)).toBe("Bob、Erin");
    await chooseFromRowMenu("リアクションした人", w.row());
    expect(within(screen.getByRole("dialog", { name: "リアクションした人" })).getByText("Bob、Erin")).toBeTruthy();
  });
});


describe("確認のお願い (M27, its own row since 2026-10-05)", () => {
  it("a reader who has not confirmed: the tinted row, 「0/2 人が確認」 and a prominent 「確認しました」", async () => {
    touchScreen(false);
    const w = world();
    const row = w.ackRow();
    expect(row.getAttribute("data-ack-row")).toBe("todo");
    expect(row.className).toContain("bg-accent-soft");
    expect(within(row).getByText("確認のお願い")).toBeTruthy();
    // Before the server says who is pending, no total.
    expect(within(row).getByText("まだ誰も確認していません")).toBeTruthy();
    expect(await within(row).findByText("0/2 人が確認")).toBeTruthy();
    const confirm = within(row).getByRole("button", { name: "確認しました" });
    expect(confirm.getAttribute("aria-pressed")).toBe("false");
    expect(confirm.className).toContain("bg-accent-solid");
    fireEvent.click(confirm);
    expect(w.controller.toggleAck).toHaveBeenCalledTimes(1);
    // Not the author nor an admin: no 「未確認 N 人」.
    expect(within(row).queryByText(/^未確認/)).toBeNull();
    // Loaded quietly: a failure would not toast.
    expect(w.controller.ackPending).toHaveBeenCalledWith(expect.objectContaining({ id: w.message.id }), { quiet: true });
  });

  it("once I have: 「確認済み」 pressed, the count and names, and a click lists all of them, oldest first", async () => {
    touchScreen(false);
    const w = world();
    w.acknowledge([2, 0]);
    const row = w.ackRow();
    expect(row.getAttribute("data-ack-row")).toBe("done");
    expect(row.className).not.toContain("bg-accent-soft");
    const done = within(row).getByRole("button", { name: "確認済み" });
    expect(done.getAttribute("aria-pressed")).toBe("true");
    expect(await within(row).findByText("2/4 人が確認")).toBeTruthy();
    const count = within(row).getByRole("button", { name: "確認した人 (2 人)" });
    expect(count.textContent).toBe("2/4 人が確認· Carol、Alice");
    expect(hoverListText(count)).toBe("Carol、Alice");

    w.acknowledge([2, 0, 3, 4]);
    // Dave and Erin have confirmed since the list was loaded: they no longer count as pending.
    const line = within(w.ackRow()).getByRole("button", { name: "確認した人 (4 人)" });
    expect(line.textContent).toBe("4/4 人が確認· Carol、Alice、Dave ほか 1 人");
    expect(within(w.ackRow()).getByText("全員が確認済み")).toBeTruthy();
    fireEvent.click(line);
    const list = screen.getByRole("dialog", { name: "確認した人" });
    // The first list (who confirmed); 「未確認」 below has its own (M31).
    expect([...list.querySelector("ul")!.querySelectorAll("li")].map((li) => li.querySelector("span.font-medium")?.textContent)).toEqual(["Carol", "Alice", "Dave", "Erin"]);
  });

  it("the author: no button of their own, 「未確認 2 人」 opening the list with the reminder", async () => {
    touchScreen(false);
    const w = world({ meIndex: 1 });
    const row = w.ackRow();
    expect(row.getAttribute("data-ack-row")).toBe("author");
    expect(within(row).queryByRole("button", { name: /確認しました|確認済み/ })).toBeNull();
    fireEvent.click(await within(row).findByRole("button", { name: "未確認 2 人" }));
    const list = screen.getByRole("dialog", { name: "確認した人" });
    expect(await within(list).findByText("未確認 2 人")).toBeTruthy();
    expect(within(list).getByRole("button", { name: "未確認の人にリマインド" })).toBeTruthy();
  });

  it("an admin who is a reader: both 「確認しました」 and 「未確認 N 人」", async () => {
    touchScreen(false);
    const w = world({ isAdmin: true });
    const row = w.ackRow();
    expect(await within(row).findByRole("button", { name: "未確認 2 人" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "確認しました" })).toBeTruthy();
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

  it("ackCountLabel: with the total once known", () => {
    expect(ackCountLabel(0, null)).toBe("まだ誰も確認していません");
    expect(ackCountLabel(3, null)).toBe("3 人が確認");
    expect(ackCountLabel(3, 5)).toBe("3/8 人が確認");
    expect(ackCountLabel(0, 4)).toBe("0/4 人が確認");
  });
});

describe("hover lists (2026-10-05): above the trigger, off the pointer", () => {
  it("open on top with an 8 px offset after 300 ms, and take no pointer", () => {
    expect(HOVER_LIST).toEqual({ side: "top", sideOffset: 8, delayDuration: 300, collisionPadding: 8 });
    touchScreen(false);
    const w = world();
    w.react(1, "🎉");
    const chip = w.row().querySelector<HTMLElement>("[data-reacted-by]")!;
    // Room above the chip: it opens on top.
    chip.getBoundingClientRect = () => ({ x: 200, y: 300, top: 300, left: 200, right: 240, bottom: 324, width: 40, height: 24, toJSON: () => ({}) });
    const content = openHoverList(chip)!;
    expect(content).not.toBeNull();
    expect(content.getAttribute("data-side")).toBe("top");
    expect(content.className).toContain("pointer-events-none");
    expect(screen.getByRole("tooltip").textContent).toBe("Bob");
  });
});
