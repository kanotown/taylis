// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Sidebar } from "../src/ui/Sidebar";
import { NoticeToast, Toast } from "../src/ui/Toast";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A clipboard that takes the text, or refuses it (a browser without the permission). */
function stubClipboard(refuse: boolean) {
  const writeText = vi.fn(async (_text: string) => {
    if (refuse) throw new DOMException("Write permission denied.", "NotAllowedError");
  });
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
}

describe("copy buttons (2026-10-08)", () => {
  it("copies and says 「コピーしました」 in the toast", async () => {
    const writeText = stubClipboard(false);
    const controller = new AppController();
    expect(await controller.copyToClipboard("secret-1")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("secret-1");
    render(<NoticeToast controller={controller} />);
    expect(screen.getByRole("status").textContent).toContain("コピーしました");
  });

  it("names what was copied when asked to (「仮パスワードをコピーしました」)", async () => {
    stubClipboard(false);
    const controller = new AppController();
    await controller.copyToClipboard("Tmp-pass-1", "仮パスワードをコピーしました");
    expect(controller.notice).toBe("仮パスワードをコピーしました");
    expect(controller.error).toBeNull();
  });

  it("shows the error toast when the clipboard refuses and the fallback fails too", async () => {
    stubClipboard(true);
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AppController();
    expect(await controller.copyToClipboard("x")).toBe(false);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(controller.notice).toBeNull();
    render(<Toast controller={controller} />);
    expect(screen.getByRole("alert").textContent).toContain("クリップボードに書き込めませんでした");
  });

  it("falls back to the hidden textarea when the async clipboard is refused", async () => {
    stubClipboard(true);
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => true), configurable: true });
    const controller = new AppController();
    expect(await controller.copyToClipboard("x")).toBe(true);
    expect(controller.notice).toBe("コピーしました");
  });

  it("a copy that works takes away an earlier refusal", async () => {
    stubClipboard(false);
    const controller = new AppController();
    controller.setError("クリップボードに書き込めませんでした");
    await controller.copyToClipboard("x");
    expect(controller.error).toBeNull();
    controller.setError("送信できませんでした");
    await controller.copyToClipboard("x");
    expect(controller.error).toBe("送信できませんでした"); // someone else's error stays
  });

  it("a message link says 「リンクをコピーしました」", async () => {
    stubClipboard(false);
    const controller = new AppController();
    vi.spyOn(controller, "permalink").mockReturnValue("https://chat.example/m/1");
    await controller.copyPermalink("1");
    expect(controller.notice).toBe("リンクをコピーしました");
  });
});

describe("the sidebar without 「参加できるチャンネル」 (2026-10-08)", () => {
  function world(isGuest = false) {
    const server = new FakeServer();
    const me = server.addUser("alice");
    const bob = server.addUser("bob");
    const store = new Store();
    store.setMe(me as unknown as UserMe);
    store.upsertUser(me);
    const general = server.createChannel("general", me.id);
    store.upsertChannel(general, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
    for (const name of ["papers", "seminar", "random"]) store.upsertChannel(server.createChannel(name, bob.id), { isMember: false, syncedSeq: 0, oldestLoadedSeq: 0 });
    const controller = { store, engine: null, me, isGuest, isAdmin: false };
    const onBrowse = vi.fn();
    render(
      <Sidebar controller={controller as unknown as AppController} channels={[...store.channels.values()]} currentId={general.id} unreadOnly={false}
        onToggleUnreadOnly={() => {}} onOpen={() => {}} onNewDm={() => {}} onNewChannel={() => {}} onBrowse={onBrowse} />,
    );
    return { onBrowse };
  }

  it("lists no channel I could join, and a 「チャンネルを探す」 row in チャンネル opens the browser", () => {
    const w = world();
    expect(screen.queryByText("参加できるチャンネル")).toBeNull();
    for (const name of ["papers", "seminar", "random"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByRole("button", { name: "general" })).toBeTruthy();
    const row = screen.getByRole("button", { name: "チャンネルを探す" });
    expect(row.closest("section")?.textContent).toContain("チャンネル");
    fireEvent.click(row);
    expect(w.onBrowse).toHaveBeenCalledTimes(1);
  });

  it("offers no 「チャンネルを探す」 row to a guest", () => {
    world(true);
    expect(screen.queryByRole("button", { name: "チャンネルを探す" })).toBeNull();
  });
});
