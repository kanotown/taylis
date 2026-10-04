// @vitest-environment jsdom
// M104 (docs/MODERATION.md): a blocked person's messages fold away (「表示」 shows one), 「報告する」 sends a reason and a
// note, the block list follows bootstrap and block.updated, and 「アカウントを削除」 asks for the password first.
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { messageActions } from "../src/ui/messageActions";
import { DeleteAccountDialog } from "../src/ui/ModerationDialogs";
import { MessageRow } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";
import { chooseFromRowMenu, tick } from "./rowMenu";

afterEach(cleanup);

function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", me.id);
  server.join(channel.id, bob.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  store.upsertUser(me);
  store.upsertUser(bob);
  const theirs = server.post(channel.id, bob.id, "相手の投稿").message;
  store.upsertMessage(theirs);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 1, oldestLoadedSeq: 0, lastReadSeq: 1 });
  const controller = {
    store, engine: { markUnread: vi.fn(), tasks: null }, api: null, version: 0, setError: vi.fn(), setNotice: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
    toggleReaction: vi.fn(async () => {}), setEditing: vi.fn(), toggleBookmark: vi.fn(async () => {}), copyPermalink: vi.fn(async () => {}),
    togglePin: vi.fn(async () => {}), deleteMessage: vi.fn(async () => {}), setReminder: vi.fn(async () => {}), copyMessageText: vi.fn(async () => {}),
    reportMessage: vi.fn(async () => true), deleteAccount: vi.fn(async () => null as string | null),
  };
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return <MessageRow controller={controller as unknown as AppController} message={store.getMessage(channel.id, theirs.id)!} onOpenThread={vi.fn()} />;
  }
  render(<View />);
  return { store, controller, bob, theirs, row: () => document.getElementById(`timeline-${theirs.id}`)! };
}

describe("blocking", () => {
  it("folds a blocked person's message; 「表示」 shows it; unblocking brings it back", () => {
    const w = world();
    expect(w.row().textContent).toContain("相手の投稿");
    act(() => w.store.replaceBlocked([w.bob.id]));
    expect(w.row().textContent).toContain("ブロック中のユーザーのメッセージ");
    expect(w.row().textContent).not.toContain("相手の投稿");
    fireEvent.click(within(w.row()).getByRole("button", { name: "表示" }));
    expect(w.row().textContent).toContain("相手の投稿");
    act(() => w.store.setBlocked(w.bob.id, false));
    expect(w.store.isBlocked(w.bob.id)).toBe(false);
    expect(w.row().textContent).toContain("相手の投稿");
  });
});

describe("reporting", () => {
  it("is offered on someone else's stored message only", () => {
    const w = world();
    const base = { isAdmin: false, saved: false, thread: true, editable: false, showReactions: false, canMakeTask: false, canRequestReview: false, unreadOffered: false };
    const theirs = w.store.getMessage(w.theirs.channel_id, w.theirs.id)!;
    expect(messageActions({ ...base, message: theirs, mine: false }).map((a) => a.key)).toContain("report");
    expect(messageActions({ ...base, message: theirs, mine: true }).map((a) => a.key)).not.toContain("report");
    expect(messageActions({ ...base, message: { ...theirs, pending: true }, mine: false }).map((a) => a.key)).not.toContain("report");
  });

  it("sends the chosen reason and note", async () => {
    const w = world();
    await chooseFromRowMenu("報告する", w.row());
    const dialog = screen.getByRole("dialog", { name: "メッセージを報告" });
    const send = within(dialog).getByRole("button", { name: "報告する" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true); // a reason first
    fireEvent.click(within(dialog).getByLabelText("嫌がらせ"));
    fireEvent.change(within(dialog).getByLabelText("補足"), { target: { value: "何度も" } });
    fireEvent.click(send);
    await tick();
    expect(w.controller.reportMessage).toHaveBeenCalledWith(w.theirs.id, "harassment", "何度も");
    expect(screen.queryByRole("dialog", { name: "メッセージを報告" })).toBeNull();
  });
});

describe("deleting my account", () => {
  it("asks for the password and shows the server's refusal", async () => {
    const w = world();
    w.controller.deleteAccount.mockResolvedValueOnce("現在のパスワードが違います");
    const onClose = vi.fn();
    render(<DeleteAccountDialog controller={w.controller as unknown as AppController} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "アカウントを削除" });
    const button = within(dialog).getByRole("button", { name: "アカウントを削除" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("確認のためパスワードを入力"), { target: { value: "wrong" } });
    fireEvent.click(button);
    await tick();
    expect(within(dialog).getByRole("alert").textContent).toBe("現在のパスワードが違います");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(button);
    await tick();
    expect(w.controller.deleteAccount).toHaveBeenLastCalledWith("wrong");
    expect(onClose).toHaveBeenCalled();
  });
});
