// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { FakeServer } from "./fakeServer";

const FORMAT_BAR = "chikuwa.prefs.formatBar";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as { execCommand?: unknown }).execCommand;
});

function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  store.upsertUser(me);
  store.upsertUser(bob);
  store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  const controller = { store, engine: { send: vi.fn(), sendTyping: vi.fn(), status: "online" }, api: { uploadAttachment: vi.fn() }, setError: vi.fn(), sendKey: "shift-enter", isAdmin: false } as unknown as AppController;
  function View() {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Composer controller={controller} channel={store.getChannel(channel.id)!} />;
  }
  const view = render(<View />);
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  const type = (value: string, caret = value.length) => {
    fireEvent.change(box(), { target: { value } });
    box().setSelectionRange(caret, caret);
  };
  return { view, store, channel, box, type, draft: () => store.draft(channel.id).text };
}

/** execCommand as a browser runs it on a text area: the selection replaced, then an `input` event. */
function browserEditing() {
  const exec = vi.fn((command: string, _ui?: boolean, value?: string) => {
    const el = document.activeElement as HTMLTextAreaElement;
    el.setRangeText(command === "delete" ? "" : value ?? "", el.selectionStart, el.selectionEnd, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true, writable: true });
  return exec;
}

describe("edits through the browser's editing, so ⌘Z undoes them (tester, 2026-09-30)", () => {
  it("a format replaces only what changed with insertText and puts the caret inside the markers", () => {
    const exec = browserEditing();
    const w = world();
    w.type("ab", 1);
    fireEvent.keyDown(w.box(), { key: "b", metaKey: true });
    expect(exec).toHaveBeenCalledExactlyOnceWith("insertText", false, "****");
    expect(w.draft()).toBe("a****b");
    expect([w.box().selectionStart, w.box().selectionEnd]).toEqual([3, 3]);
  });

  it("list continuation and its end go the same way (insertText, then delete)", () => {
    const exec = browserEditing();
    const w = world();
    w.type("- item");
    fireEvent.keyDown(w.box(), { key: "Enter" });
    expect(exec).toHaveBeenLastCalledWith("insertText", false, "\n- ");
    expect(w.draft()).toBe("- item\n- ");
    fireEvent.keyDown(w.box(), { key: "Enter" }); // on the empty item: the list ends
    expect(exec).toHaveBeenLastCalledWith("delete", false, "");
    expect(w.draft()).toBe("- item\n");
  });

  it("falls back to setting the draft where the browser does not take the command", () => {
    const exec = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true, writable: true });
    const w = world();
    w.type("ab", 1);
    fireEvent.keyDown(w.box(), { key: "b", metaKey: true });
    expect(exec).toHaveBeenCalledOnce();
    expect(w.draft()).toBe("a****b");
  });

  it("a URL pasted over selected text links it with insertText (⌘Z takes it back); other pastes go as usual", () => {
    const exec = browserEditing();
    const w = world();
    w.type("see the docs please");
    w.box().focus();
    w.box().setSelectionRange(8, 12);
    const paste = (text: string) => fireEvent.paste(w.box(), { clipboardData: { files: [], types: ["text/plain"], getData: (type: string) => (type === "text/plain" ? text : "") } });
    expect(paste(" https://example.com/a?b=1 ")).toBe(false); // default prevented
    expect(exec).toHaveBeenCalledExactlyOnceWith("insertText", false, expect.stringContaining("[docs](https://example.com/a?b=1)"));
    expect(w.draft()).toBe("see the [docs](https://example.com/a?b=1) please");
    expect([w.box().selectionStart, w.box().selectionEnd]).toEqual([41, 41]);
    // No selection, not a URL, or a URL selected: the browser pastes.
    w.box().setSelectionRange(3, 3);
    expect(paste("https://example.com")).toBe(true);
    w.box().setSelectionRange(0, 3);
    expect(paste("just text")).toBe(true);
    w.type("https://old.example.com");
    w.box().setSelectionRange(0, 23);
    expect(paste("https://new.example.com")).toBe(true);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("「@」 inserts an @ (after a space) and opens the member list", () => {
    const w = world();
    w.type("hi");
    fireEvent.click(screen.getByRole("button", { name: "メンションを追加" }));
    expect(w.draft()).toBe("hi @");
    expect(screen.getByText("@bob")).toBeTruthy();
  });
});

describe("the composer's rows (tester, 2026-09-30)", () => {
  it("「Aa」 hides and shows the formatting bar, remembered on this device", () => {
    const w = world();
    expect(screen.getByRole("button", { name: /^太字/ })).toBeTruthy(); // shown by default
    fireEvent.click(screen.getByRole("button", { name: "書式を隠す" }));
    expect(screen.queryByRole("button", { name: /^太字/ })).toBeNull();
    expect(localStorage.getItem(FORMAT_BAR)).toBe("0");
    w.view.unmount();
    world();
    expect(screen.queryByRole("button", { name: /^太字/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "書式を表示" }));
    expect(screen.getByRole("button", { name: /^太字/ })).toBeTruthy();
    expect(localStorage.getItem(FORMAT_BAR)).toBeNull();
  });

  it("the ▾ beside 送信 opens 「後で送信」", async () => {
    const w = world();
    w.type("あとで");
    const later = screen.getByRole("button", { name: "後で送信" });
    expect(later.parentElement?.contains(screen.getByRole("button", { name: "送信" }))).toBe(true);
    await act(async () => { fireEvent.click(later); });
    expect(screen.getByLabelText("日時を指定")).toBeTruthy();
    expect(screen.getByRole("button", { name: "予約" })).toBeTruthy();
  });

  it("the bottom row never wraps: its groups stay on one line and the send group keeps its size", () => {
    const w = world();
    const row = w.view.container.querySelector("[data-composer-actions]")!;
    expect(row.className).toContain("flex-nowrap");
    expect(row.className).not.toMatch(/(^|\s)flex-wrap/);
    const [left, right] = [...row.children];
    expect(left!.className).toContain("flex-nowrap");
    expect(left!.className).toContain("min-w-0");
    expect(right!.className).toContain("shrink-0");
    expect(w.view.container.querySelector(".flex-wrap")).toBeNull();
    // Preview sits in the text's top-right corner, not in the row; the syntax help is by the send button (2026-10-04).
    expect(row.contains(screen.getByRole("button", { name: "プレビュー" }))).toBe(false);
    expect(right!.contains(screen.getByRole("button", { name: "書式の書き方" }))).toBe(true);
  });

  it("the syntax help shows the table example on its own lines and scrolls inside the window", async () => {
    world();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "書式の書き方" })); });
    const table = screen.getByText((_, el) => el?.tagName === "PRE" && el.textContent!.startsWith("| 項目 | 担当 |"));
    expect(table.textContent).toBe("| 項目 | 担当 |\n| --- | --- |\n| API | 田中 |");
    expect(table.className).toContain("whitespace-pre");
    const popover = table.closest(".rx-popover") as HTMLElement;
    expect(popover.className).toContain("overflow-y-auto");
    expect(popover.className).toContain("--radix-popover-content-available-height");
  });
});
