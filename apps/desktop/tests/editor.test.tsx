// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

describe("the inline editor (Codex audit C4)", () => {
  it("stays open with the text until the server takes the edit", async () => {
    const server = new FakeServer();
    const me = server.addUser("alice");
    const channel = server.createChannel("general", me.id);
    const store = new Store();
    store.setMe(me as unknown as UserMe);
    store.upsertUser(me);
    const mine = server.post(channel.id, me.id, "before").message;
    store.upsertMessage(mine);
    store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 1, oldestLoadedSeq: 0, lastReadSeq: 1 });
    let online = false;
    const controller = {
      store, engine: null, api: null, version: 0, setError: vi.fn(), messageFocus: null, editing: mine.id as string | null, isAdmin: false, sendKey: "shift-enter",
      linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
      setEditing: vi.fn(function (this: { editing: string | null }, id: string | null) { this.editing = id; }),
      editMessage: vi.fn(async () => online),
    };
    function View() {
      useSyncExternalStore((l) => store.subscribe(l), () => store.version);
      return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} />;
    }
    render(<View />);
    const editor = screen.getByLabelText("メッセージを編集") as HTMLTextAreaElement;
    // A URL pasted over selected text links it (jsdom has no execCommand: the draft is set).
    editor.setSelectionRange(0, 6);
    const pasted = fireEvent.paste(editor, { clipboardData: { files: [], getData: () => "https://example.com" } });
    expect(pasted).toBe(false);
    expect(editor.value).toBe("[before](https://example.com)");
    fireEvent.change(editor, { target: { value: "after" } });

    await act(async () => { fireEvent.click(screen.getByText("保存")); });
    expect(controller.editMessage).toHaveBeenCalledWith(mine.id, "after");
    expect(controller.setEditing).not.toHaveBeenCalled(); // offline: still open, the text kept
    expect((screen.getByLabelText("メッセージを編集") as HTMLTextAreaElement).value).toBe("after");

    online = true;
    await act(async () => { fireEvent.click(screen.getByText("保存")); });
    expect(controller.setEditing).toHaveBeenCalledWith(null);
  });
});

describe("the inline editor in rich mode", () => {
  it("opens the message in its formats and saves Markdown with the mentions encoded", async () => {
    const range = Range.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
    range.getClientRects ??= () => [];
    range.getBoundingClientRect ??= () => new DOMRect();
    const server = new FakeServer();
    const me = server.addUser("alice");
    const bob = server.addUser("bob");
    const channel = server.createChannel("general", me.id);
    const store = new Store();
    store.setMe(me as unknown as UserMe);
    store.upsertUser(me);
    store.upsertUser(bob);
    const mine = server.post(channel.id, me.id, `**太字** <@${bob.id}>\n- a`).message;
    store.upsertMessage(mine);
    store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 1, oldestLoadedSeq: 0, lastReadSeq: 1 });
    const controller = {
      store, engine: null, api: null, version: 0, setError: vi.fn(), messageFocus: null, editing: mine.id as string | null, isAdmin: false, sendKey: "enter", composerMode: "rich",
      linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
      setEditing: vi.fn(function (this: { editing: string | null }, id: string | null) { this.editing = id; }),
      editMessage: vi.fn(async () => true),
    };
    function View() {
      useSyncExternalStore((l) => store.subscribe(l), () => store.version);
      return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} />;
    }
    render(<View />);
    await waitFor(() => expect(document.querySelector(".rich-editor")).not.toBeNull());
    const dom = document.querySelector<HTMLElement>(".rich-editor")!;
    expect(dom.getAttribute("aria-label")).toBe("メッセージを編集");
    expect(dom.querySelector("strong")?.textContent).toBe("太字");
    expect(dom.querySelector("li")?.textContent).toBe("a");
    const editor = (dom as unknown as { editor: Editor }).editor;
    act(() => void editor.chain().focus("end").insertContent("b").run());
    await act(async () => { fireEvent.keyDown(dom, { key: "Enter" }); });
    expect(controller.editMessage).toHaveBeenCalledWith(mine.id, `**太字** <@${bob.id}>\n- ab`);
  });
});
