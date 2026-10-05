// @vitest-environment jsdom
// The hover bar (Slack-like, 2026-10-02): a few buttons, the rest in 「その他」 (⋯), the same action list as the
// long-press sheet (messageActions.ts), the quick reactions left out on a narrow row, and the bar kept shown while its
// menu or a popover opened from it is open.
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { MessageState } from "../src/sync/types";
import { hoverMenuGroups, messageActions, rowFitsQuickReactions } from "../src/ui/messageActions";
import { type FeedRowProps, MessageRow } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";
import { chooseFromRowMenu, openRowMenu, rowMenuLabels, tick } from "./rowMenu";

afterEach(() => {
  cleanup();
  localStorage.removeItem("chikuwa.emoji.recent");
});

function world(options: { isAdmin?: boolean; thread?: boolean; feed?: FeedRowProps; lastRead?: number } = {}) {
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
  store.upsertMessage(theirs);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 2, oldestLoadedSeq: 0, lastReadSeq: options.lastRead ?? 2 });
  const engine = { markUnread: vi.fn(), tasks: null };
  const controller = {
    store, engine, api: null, version: 0, setError: vi.fn(), setNotice: vi.fn(), messageFocus: null, editing: null, isAdmin: options.isAdmin ?? false, sendKey: "shift-enter",
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
    toggleReaction: vi.fn(async () => {}), setEditing: vi.fn(), toggleBookmark: vi.fn(async () => {}), copyPermalink: vi.fn(async () => {}),
    togglePin: vi.fn(async () => {}), deleteMessage: vi.fn(async () => {}), setReminder: vi.fn(async () => {}), copyMessageText: vi.fn(async () => {}),
  };
  const onOpenThread = vi.fn();
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return (
      <>
        {[mine, theirs].map((m) => (
          <MessageRow key={m.id} controller={controller as unknown as AppController} message={store.getMessage(channel.id, m.id)!} onOpenThread={options.thread === false ? undefined : onOpenThread} feed={options.feed} />
        ))}
      </>
    );
  }
  render(<View />);
  const row = (m: MessageState) => document.getElementById(`timeline-${m.id}`)!;
  return { store, controller, engine, onOpenThread, mine: () => row(mine), theirs: () => row(theirs), mineMessage: mine, theirMessage: theirs, channelId: channel.id };
}

/** The bar's own buttons (not the popovers' or the menu's, which sit in portals). */
function barLabels(row: HTMLElement): string[] {
  return [...row.querySelector(".row-actions")!.querySelectorAll(":scope > button")].map((b) => b.getAttribute("aria-label") ?? b.getAttribute("title") ?? "");
}

function setWidth(row: HTMLElement, width: number) {
  Object.defineProperty(row, "clientWidth", { configurable: true, value: width });
  fireEvent.mouseEnter(row);
}

describe("the hover bar", () => {
  it("my own message: three quick reactions, add, thread, save, edit and ⋯", () => {
    const w = world();
    expect(barLabels(w.mine())).toEqual(["👍 でリアクション", "❤️ でリアクション", "😂 でリアクション", "リアクションを追加", "スレッドで返信", "あとで見る（保存）", "編集（空の入力欄で ↑）", "その他"]);
  });

  it("someone else's message: no edit; no thread where threads are not offered", () => {
    const w = world();
    expect(barLabels(w.theirs())).toEqual(["👍 でリアクション", "❤️ でリアクション", "😂 でリアクション", "リアクションを追加", "スレッドで返信", "あとで見る（保存）", "その他"]);
    cleanup();
    const noThreads = world({ thread: false });
    expect(barLabels(noThreads.mine())).not.toContain("スレッドで返信");
  });

  it("a row of the Times feed: no edit in place, nor 「ここから未読にする」", () => {
    const w = world({ feed: { channelName: "times-alice", isNew: false, onOpenChannel: vi.fn(), onActivate: vi.fn() }, lastRead: 0 });
    expect(barLabels(w.mine())).not.toContain("編集（空の入力欄で ↑）");
    expect(rowMenuLabels(w.mine())).not.toContain("ここから未読にする");
  });

  it("a narrow row (the thread pane) leaves out the quick reactions; a wide one has them again", () => {
    const w = world();
    setWidth(w.mine(), 360);
    expect(barLabels(w.mine())).toEqual(["リアクションを追加", "スレッドで返信", "あとで見る（保存）", "編集（空の入力欄で ↑）", "その他"]);
    setWidth(w.mine(), 420);
    expect(barLabels(w.mine()).slice(0, 3)).toEqual(["👍 でリアクション", "❤️ でリアクション", "😂 でリアクション"]);
    // Keyboard focus measures too (the bar shows on focus).
    Object.defineProperty(w.theirs(), "clientWidth", { configurable: true, value: 300 });
    fireEvent.focus(w.theirs());
    expect(barLabels(w.theirs())[0]).toBe("リアクションを追加");
    expect(rowFitsQuickReactions(0)).toBe(true); // not laid out yet
    expect(rowFitsQuickReactions(419)).toBe(false);
  });

  it("stays shown while ⋯ or the remind popover is open", async () => {
    const w = world();
    const bar = w.mine().querySelector(".row-actions")!;
    expect(bar.className).toContain("opacity-0");
    expect(bar.className).not.toContain("opacity-100");
    openRowMenu(w.mine());
    expect(bar.className).toContain("opacity-100");
    fireEvent.click(screen.getByRole("menuitem", { name: "リマインド…" }));
    await tick();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByLabelText("リマインドのメモ")).toBeTruthy();
    expect(bar.className).toContain("opacity-100");
  });
});

describe("the ⋯ menu", () => {
  it("my own message: grouped, 削除 last", () => {
    const w = world({ lastRead: 0 });
    openRowMenu(w.mine());
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.replace("Alt+クリック", ""))).toEqual([
      "リンクをコピー", "別のチャンネルに共有…", "リマインド…", "チャンネルにピン留め", "ここから未読にする", "削除",
    ]);
    expect(menu.querySelectorAll("[role=separator]")).toHaveLength(2);
  });

  it("someone else's: no 削除 (an admin has it); 「リアクションした人」 once there are reactions", () => {
    const w = world();
    expect(rowMenuLabels(w.theirs())).toEqual(["リンクをコピー", "別のチャンネルに共有…", "リマインド…", "チャンネルにピン留め", "ここから未読にする", "報告する"]);
    cleanup();
    const admin = world({ isAdmin: true });
    act(() => admin.store.upsertMessage({ ...admin.theirMessage, updated_seq: admin.theirMessage.updated_seq + 1, reactions: [{ emoji: "🎉", count: 1, user_ids: [admin.theirMessage.sender_id] }] }));
    expect(rowMenuLabels(admin.theirs())).toEqual(["リンクをコピー", "別のチャンネルに共有…", "リマインド…", "リアクションした人", "チャンネルにピン留め", "ここから未読にする", "報告する", "削除"]);
  });

  it("the shared list: tasks and reviews in their own group; the sheet's order unchanged", () => {
    const message = { body: "x", reactions: [], pinned_at: null } as unknown as MessageState;
    const ctx = { message, mine: true, isAdmin: false, saved: false, thread: true, editable: true, showReactions: true, canMakeTask: true, canRequestReview: true, unreadOffered: true };
    expect(messageActions(ctx).map((a) => a.key)).toEqual(["thread", "edit", "copyText", "save", "remind", "task", "review", "unread", "copyLink", "share", "pin", "delete"]);
    expect(hoverMenuGroups(messageActions(ctx)).map((g) => g.map((a) => a.key))).toEqual([["copyLink", "share", "remind"], ["task", "review"], ["pin", "unread"], ["delete"]]);
  });

  it("each item works: copy link, pin, mark unread, the delete confirmation", async () => {
    const w = world({ lastRead: 0 });
    await chooseFromRowMenu("リンクをコピー", w.mine());
    expect(w.controller.copyPermalink).toHaveBeenCalledWith(w.mineMessage.id);
    await chooseFromRowMenu("チャンネルにピン留め", w.mine());
    expect(w.controller.togglePin).toHaveBeenCalledWith(expect.objectContaining({ id: w.mineMessage.id }));
    await chooseFromRowMenu("ここから未読にする", w.mine());
    expect(w.engine.markUnread).toHaveBeenCalledWith(w.channelId, w.mineMessage.seq);

    await chooseFromRowMenu("削除", w.mine());
    expect(w.controller.deleteMessage).not.toHaveBeenCalled(); // asks first
    const confirm = screen.getByRole("dialog", { name: "メッセージの削除" });
    expect(within(confirm).getByText("このメッセージを削除しますか？")).toBeTruthy();
    expect(w.mine().querySelector(".row-actions")!.className).toContain("opacity-100");
    fireEvent.click(within(confirm).getByRole("button", { name: "キャンセル" }));
    expect(w.controller.deleteMessage).not.toHaveBeenCalled();
    await chooseFromRowMenu("削除", w.mine());
    fireEvent.click(within(screen.getByRole("dialog", { name: "メッセージの削除" })).getByRole("button", { name: "削除する" }));
    expect(w.controller.deleteMessage).toHaveBeenCalledWith(w.mineMessage.id);
  });

  it("「リマインド…」 opens the presets and the note by ⋯", async () => {
    const w = world();
    await chooseFromRowMenu("リマインド…", w.theirs());
    fireEvent.change(screen.getByLabelText("リマインドのメモ"), { target: { value: "読む" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "リマインド" })).getAllByRole("button")[0]!);
    expect(w.controller.setReminder).toHaveBeenCalledWith(w.theirMessage.id, expect.any(Date), "読む");
  });

  it("the bar's buttons and gestures: save, edit, thread, Alt+click", () => {
    const w = world({ lastRead: 0 });
    fireEvent.click(within(w.mine()).getByRole("button", { name: "あとで見る（保存）" }));
    expect(w.controller.toggleBookmark).toHaveBeenCalled();
    fireEvent.click(within(w.mine()).getByRole("button", { name: "編集（空の入力欄で ↑）" }));
    expect(w.controller.setEditing).toHaveBeenCalledWith(w.mineMessage.id);
    fireEvent.click(within(w.theirs()).getByRole("button", { name: "スレッドで返信" }));
    expect(w.onOpenThread).toHaveBeenCalledWith(w.theirMessage.id);
    fireEvent.click(w.theirs(), { altKey: true });
    expect(w.engine.markUnread).toHaveBeenCalledWith(w.channelId, w.theirMessage.seq);
  });
});
