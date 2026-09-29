// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { LONG_PRESS_MS } from "../src/ui/MessageActionsSheet";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A phone: no hover, so a long press opens the sheet (M25). */
function touchScreen(hover: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)" ? !hover : hover, addEventListener: () => {}, removeEventListener: () => {} }));
}

function world(onOpenThread: (id: string) => void = () => {}, theirReplies = 0) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", me.id);
  server.join(channel.id, bob.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  store.upsertUser(me);
  store.upsertUser(bob);
  const mine = server.post(channel.id, me.id, "自分の投稿").message;
  const theirs = server.post(channel.id, bob.id, "相手の投稿").message;
  store.upsertMessage(mine);
  store.upsertMessage({ ...theirs, reply_count: theirReplies });
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 2, oldestLoadedSeq: 0, lastReadSeq: 2 });
  const controller = {
    store, engine: null, api: null, version: 0, setError: vi.fn(), messageFocus: null, editing: null as string | null, isAdmin: false, sendKey: "shift-enter",
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
    copyMessageText: vi.fn(async () => {}), toggleReaction: vi.fn(async () => {}), setEditing: vi.fn(),
  };
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} onOpenThread={onOpenThread} />;
  }
  render(<View />);
  return { controller, mine, theirs };
}

function longPress(element: HTMLElement) {
  fireEvent.touchStart(element, { touches: [{ clientX: 10, clientY: 10 }] });
  act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
}

describe("the long-press sheet (M25)", () => {
  it("opens on a long press with the actions in the phone apps' order", () => {
    touchScreen(false);
    vi.useFakeTimers();
    const w = world();
    longPress(document.getElementById(`timeline-${w.mine.id}`)!);
    const sheet = screen.getByRole("dialog", { name: "メッセージの操作" });
    const labels = within(sheet).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    expect(labels).toEqual([
      "👍 でリアクション", "❤️ でリアクション", "😂 でリアクション", "🎉 でリアクション", "👀 でリアクション", "✅ でリアクション", "その他のリアクション",
      "スレッドで返信", "編集", "テキストをコピー", "あとで見る (保存)", "リマインド…", "ここから未読にする", "リンクをコピー", "別のチャンネルに共有…", "チャンネルにピン留め", "削除",
    ]);
    // The finger that opened it lifts over it: that is not a choice.
    fireEvent.click(within(sheet).getByText("リンクをコピー"));
    expect(screen.getByRole("dialog", { name: "メッセージの操作" })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(400); });
    fireEvent.click(within(sheet).getByText("テキストをコピー"));
    expect(w.controller.copyMessageText).toHaveBeenCalledWith("自分の投稿");
    expect(screen.queryByRole("dialog", { name: "メッセージの操作" })).toBeNull();

    // Someone else's message: no edit, no delete.
    longPress(document.getElementById(`timeline-${w.theirs.id}`)!);
    const other = within(screen.getByRole("dialog", { name: "メッセージの操作" })).getAllByRole("button").map((b) => b.textContent?.trim());
    expect(other).not.toContain("編集");
    expect(other).not.toContain("削除");
  });

  it("puts the reactions I used last first", () => {
    touchScreen(false);
    vi.useFakeTimers();
    localStorage.setItem("chikuwa.emoji.recent", JSON.stringify(["🙏", ":party:", "👍"]));
    const w = world();
    longPress(document.getElementById(`timeline-${w.mine.id}`)!);
    const quick = within(screen.getByRole("dialog", { name: "メッセージの操作" })).getAllByRole("button").slice(0, 6).map((b) => b.textContent);
    expect(quick).toEqual(["🙏", "👍", "❤️", "😂", "🎉", "👀"]); // custom emoji stay in the picker
    localStorage.removeItem("chikuwa.emoji.recent");
  });

  it("a tap on a message opens its thread on a phone, not while typing and not with a mouse", () => {
    touchScreen(false);
    const onOpenThread = vi.fn();
    const w = world(onOpenThread, 2);
    fireEvent.click(document.getElementById(`timeline-${w.theirs.id}`)!.querySelector("p, div")!);
    expect(onOpenThread).toHaveBeenCalledWith(w.theirs.id);
    onOpenThread.mockClear();
    const mine = document.getElementById(`timeline-${w.mine.id}`)!;
    fireEvent.click(mine); // no replies yet: its thread, to reply
    expect(onOpenThread).toHaveBeenCalledWith(w.mine.id);
    onOpenThread.mockClear();
    // The keyboard was up when the finger came down: the tap only closes it.
    const input = document.body.appendChild(document.createElement("textarea"));
    input.focus();
    fireEvent.touchStart(mine, { touches: [{ clientX: 10, clientY: 10 }] });
    input.blur();
    fireEvent.touchEnd(mine);
    fireEvent.click(mine);
    expect(onOpenThread).not.toHaveBeenCalled();
    input.remove();
    fireEvent.touchStart(mine, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchEnd(mine);
    fireEvent.click(mine);
    expect(onOpenThread).toHaveBeenCalledWith(w.mine.id);
    onOpenThread.mockClear();
    cleanup();
    touchScreen(true);
    const desk = world(onOpenThread, 2);
    fireEvent.click(document.getElementById(`timeline-${desk.theirs.id}`)!);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("a short tap, a scroll or a mouse does not open it", () => {
    vi.useFakeTimers();
    touchScreen(false);
    const w = world();
    const row = document.getElementById(`timeline-${w.mine.id}`)!;
    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchEnd(row);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 10, clientY: 60 }] });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(screen.queryByRole("dialog", { name: "メッセージの操作" })).toBeNull();
    cleanup();
    touchScreen(true);
    const desk = world();
    longPress(document.getElementById(`timeline-${desk.mine.id}`)!);
    expect(screen.queryByRole("dialog", { name: "メッセージの操作" })).toBeNull();
  });

  it("the tap that opens a thread unfocuses the row, so its floating actions do not cover the reply box (M28b)", () => {
    touchScreen(false);
    const onOpenThread = vi.fn();
    const w = world(onOpenThread);
    const row = document.getElementById(`timeline-${w.theirs.id}`)!;
    row.focus(); // what the tap did on the phone (tabIndex)
    expect(document.activeElement).toBe(row);
    fireEvent.click(row);
    expect(onOpenThread).toHaveBeenCalledWith(w.theirs.id);
    expect(document.activeElement).not.toBe(row);
  });

  it("「リマインド…」 takes a note and a time of my own besides the presets (M28b)", () => {
    touchScreen(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T09:00:00"));
    const w = world();
    const setReminder = vi.fn(async () => true);
    (w.controller as unknown as { setReminder: unknown }).setReminder = setReminder;
    longPress(document.getElementById(`timeline-${w.theirs.id}`)!);
    act(() => { vi.advanceTimersByTime(400); });
    const sheet = screen.getByRole("dialog", { name: "メッセージの操作" });
    fireEvent.click(within(sheet).getByText("リマインド…"));
    fireEvent.change(within(sheet).getByLabelText("リマインドのメモ"), { target: { value: "返事を書く" } });
    fireEvent.change(within(sheet).getByLabelText("日時を指定"), { target: { value: "2026-09-30T10:30" } });
    fireEvent.click(within(sheet).getByText("設定"));
    expect(setReminder).toHaveBeenCalledWith(w.theirs.id, new Date("2026-09-30T10:30"), "返事を書く");
    expect(screen.queryByRole("dialog", { name: "メッセージの操作" })).toBeNull();
    // A time already passed is refused, and the sheet stays.
    longPress(document.getElementById(`timeline-${w.theirs.id}`)!);
    act(() => { vi.advanceTimersByTime(400); });
    const again = screen.getByRole("dialog", { name: "メッセージの操作" });
    fireEvent.click(within(again).getByText("リマインド…"));
    fireEvent.change(within(again).getByLabelText("日時を指定"), { target: { value: "2026-09-29T08:00" } });
    fireEvent.click(within(again).getByText("設定"));
    expect(w.controller.setError).toHaveBeenCalledWith("1 分以上先の時刻を選んでください");
    expect(setReminder).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "メッセージの操作" })).toBeTruthy();
  });
});
