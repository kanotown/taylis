// @vitest-environment jsdom
// M187 (docs/MOBILE_UI.md §30): the inline edit box offers the composer's `@` / `:` candidates, its emoji picker, 「@」
// and 「書式」; an open list takes Enter / Tab / Esc, which otherwise save and cancel as before.
import { useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomEmojiOut, UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

beforeEach(() => {
  localStorage.clear();
  // jsdom lays nothing out; ProseMirror measures ranges when it scrolls the caret into view.
  const range = Range.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  range.getClientRects ??= () => [];
  range.getBoundingClientRect ??= () => new DOMRect();
  // The picker's popover and the format menu measure their trigger.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const kakunin = { id: "e1", name: "kakunin", kind: "text", label: "確認", color: "green", content_type: "", width: 0, height: 0, keywords: [], position: 0, created_by: "u", created_at: "", pack_id: null } as unknown as CustomEmojiOut;

/** The timeline with my message open in the inline editor (Markdown, or rich). */
async function setUp(body: string, mode: "markdown" | "rich" = "markdown") {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  store.upsertUser(me);
  store.upsertUser(bob);
  store.customEmoji.set(kakunin.name, kakunin);
  const mine = server.post(channel.id, me.id, body).message;
  store.upsertMessage(mine);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 1, oldestLoadedSeq: 0, lastReadSeq: 1 });
  const controller = {
    store, engine: null, version: 0, setError: vi.fn(), setNotice: vi.fn(), messageFocus: null, editing: mine.id as string | null, isAdmin: false, sendKey: "enter", composerMode: mode,
    api: { members: vi.fn(async () => []), fetchBlob: vi.fn(async () => { throw new Error("no pictures here"); }) },
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
    setEditing: vi.fn(function (this: { editing: string | null }, id: string | null) { this.editing = id; }),
    editMessage: vi.fn(async () => true),
  };
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} />;
  }
  render(<View />);
  const box = document.querySelector<HTMLElement>("[data-edit-box]")!;
  if (mode === "rich") await waitFor(() => expect(box.querySelector(".rich-editor")).not.toBeNull());
  return { controller, mine, bob, box };
}

/** The text area as typed into: `value`, the caret at `caret` (its end by default). */
function typeInto(area: HTMLTextAreaElement, value: string, caret = value.length) {
  fireEvent.change(area, { target: { value } });
  area.setSelectionRange(caret, caret);
  fireEvent.keyUp(area, { key: "Unidentified" }); // the selection is read on keyup, as after a key
}

const list = () => document.querySelector<HTMLElement>("[data-edit-completions]");
const rows = () => [...(list()?.querySelectorAll("li") ?? [])].map((li) => li.textContent);

describe("the edit box's candidates (Markdown)", () => {
  it("offers people for @ in the middle of the text; Enter picks instead of saving, the text after the caret kept", async () => {
    const { controller, bob, box } = await setUp("確認 さん");
    const area = within(box).getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    typeInto(area, "確認 @bo さん", 6);
    expect(rows()[0]).toContain("@bob");
    act(() => void fireEvent.keyDown(area, { key: "Enter" }));
    expect(area.value).toBe("確認 @bob さん"); // the space already there is the pick's own: no second one
    await waitFor(() => expect(area.selectionStart).toBe(8)); // after it
    expect(controller.editMessage).not.toHaveBeenCalled();
    expect(list()).toBeNull();
    // The save key saves again once no list is open; the mention is encoded.
    await act(async () => void fireEvent.keyDown(area, { key: "Enter" }));
    expect(controller.editMessage).toHaveBeenCalledExactlyOnceWith(expect.any(String), `確認 <@${bob.id}> さん`);
  });

  it("offers emoji for :, the workspace's first; Tab and a click pick; ↓ moves", async () => {
    const { box } = await setUp("OK");
    const area = within(box).getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    typeInto(area, "OK :kaku");
    expect(rows()[0]).toContain(":kakunin:");
    act(() => void fireEvent.keyDown(area, { key: "Tab" }));
    expect(area.value).toBe("OK :kakunin: ");
    typeInto(area, "OK :kakunin: :smile");
    expect(rows().length).toBeGreaterThan(1);
    act(() => void fireEvent.keyDown(area, { key: "ArrowDown" }));
    const second = list()!.querySelectorAll("li")[1]!;
    expect(second.className).toContain("bg-accent-soft");
    const glyph = second.querySelector("span")!.textContent!;
    act(() => {
      fireEvent.mouseDown(second);
      fireEvent.mouseUp(second);
    });
    expect(area.value).toBe(`OK :kakunin: ${glyph} `);
    expect(list()).toBeNull();
  });

  it("Esc closes the list and leaves the editor open; the next Esc cancels", async () => {
    const { controller, box } = await setUp("hi");
    const area = within(box).getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    typeInto(area, "hi @b");
    expect(list()).not.toBeNull();
    act(() => void fireEvent.keyDown(area, { key: "Escape" }));
    expect(list()).toBeNull();
    expect(controller.setEditing).not.toHaveBeenCalled();
    act(() => void fireEvent.keyDown(area, { key: "Escape" }));
    expect(controller.setEditing).toHaveBeenCalledWith(null);
  });

  it("never opens a list while a range is selected, nor takes the key that confirms a conversion", async () => {
    const { controller, box } = await setUp("hi");
    const area = within(box).getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    typeInto(area, "hi @bo");
    area.setSelectionRange(3, 6);
    fireEvent.keyUp(area, { key: "Shift" });
    expect(list()).toBeNull();
    typeInto(area, "hi @bo");
    act(() => void fireEvent.keyDown(area, { key: "Enter", isComposing: true, keyCode: 229 }));
    expect(area.value).toBe("hi @bo");
    expect(controller.editMessage).not.toHaveBeenCalled();
  });

  it("the bar's picker, 「@」 and 「書式」 work at the caret", async () => {
    // jsdom lays nothing out: the picker would take its button for scrolled out of view (and close).
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(20, 100, 28, 24));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this === document.documentElement ? 1280 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this === document.documentElement ? 800 : 0; });
    const { box } = await setUp("ab");
    const area = within(box).getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    area.setSelectionRange(1, 1);
    fireEvent.click(within(box).getByRole("button", { name: "絵文字" }));
    const cell = () => document.querySelector<HTMLElement>('button[title="確認 :kakunin:"]');
    await waitFor(() => expect(cell()).not.toBeNull());
    fireEvent.click(cell()!);
    expect(area.value).toBe("a:kakunin:b");
    await waitFor(() => expect(cell()).toBeNull()); // the picker closed

    area.setSelectionRange(0, 0);
    fireEvent.click(within(box).getByRole("button", { name: "メンションを追加" }));
    expect(area.value).toBe("@a:kakunin:b");
    await waitFor(() => expect(list()).not.toBeNull()); // the member list opens at the @

    area.setSelectionRange(1, 2);
    fireEvent.keyUp(area, { key: "Shift" });
    const trigger = within(box).getByRole("button", { name: "書式" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /太字/ }));
    expect(area.value).toBe("@**a**:kakunin:b");
    // The composer's shortcut too.
    area.setSelectionRange(0, 1);
    act(() => void fireEvent.keyDown(area, { key: "i", metaKey: true }));
    expect(area.value).toBe("_@_**a**:kakunin:b");
  });
});

describe("the edit box's candidates (rich)", () => {
  it("completes a mention and an emoji in place; Enter picks, then saves", async () => {
    const { controller, bob, box } = await setUp("hi", "rich");
    const dom = box.querySelector<HTMLElement>(".rich-editor")!;
    const editor = (dom as unknown as { editor: Editor }).editor;
    const type = (text: string) =>
      act(() => {
        editor.commands.focus("end");
        for (const ch of text) {
          const { from, to } = editor.state.selection;
          editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
        }
      });
    const key = (init: KeyboardEventInit) => act(() => void fireEvent.keyDown(dom, init));
    type(" @bo");
    expect(rows()[0]).toContain("@bob");
    key({ key: "Enter" });
    expect(controller.editMessage).not.toHaveBeenCalled();
    type(":kaku");
    key({ key: "Tab" });
    await act(async () => void key({ key: "Enter" }));
    expect(controller.editMessage).toHaveBeenCalledExactlyOnceWith(expect.any(String), `hi <@${bob.id}> :kakunin:`);
  });
});
