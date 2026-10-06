// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { isImeKey } from "../src/ui/richEditorApi";
import { composerModeOf } from "../src/ui/prefs";
import { ComposerModeSettings } from "../src/ui/Settings";
import type { UserMe } from "../src/api/types";
import { FakeServer } from "./fakeServer";

beforeEach(() => {
  localStorage.clear();
  // jsdom lays nothing out; ProseMirror measures ranges when it scrolls the caret into view.
  const range = Range.prototype as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  range.getClientRects ??= () => [];
  range.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function world(options: { sendKey?: string; draft?: string } = {}) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  store.upsertUser(me);
  store.upsertUser(bob);
  store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  if (options.draft) store.setDraft(channel.id, null, { text: options.draft });
  let mode: "rich" | "markdown" = "rich";
  const send = vi.fn();
  const uploadAttachment = vi.fn(async (file: File) => ({ id: `att-${file.name}`, filename: file.name, content_type: file.type, size: file.size }));
  const controller = {
    store,
    engine: { send, sendTyping: vi.fn(), status: "online" },
    api: { uploadAttachment },
    setError: vi.fn(),
    sendKey: options.sendKey ?? "enter",
    isAdmin: false,
    get composerMode() {
      return mode;
    },
    setComposerMode: vi.fn(async (next: "rich" | "markdown") => {
      mode = next;
      store.setDraft(channel.id, null, { text: store.draft(channel.id, null).text + "" }); // a store change redraws
      view.rerender(<View />);
      return true;
    }),
  } as unknown as AppController;
  function View() {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Composer controller={controller} channel={store.getChannel(channel.id)!} />;
  }
  const view = render(<View />);
  const dom = () => document.querySelector<HTMLElement>(".rich-editor");
  await waitFor(() => expect(dom()).not.toBeNull());
  const editor = () => (dom() as unknown as { editor: Editor }).editor;
  /** Types as the keyboard does: each character through the editor's text input (input rules run). */
  const type = (text: string) =>
    act(() => {
      const e = editor();
      e.commands.focus();
      for (const ch of text) {
        const { from, to } = e.state.selection;
        const handled = e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)));
        if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to));
      }
    });
  const key = (init: KeyboardEventInit & { keyCode?: number }) => act(() => void fireEvent.keyDown(dom()!, init));
  return { view, store, channel, bob, controller, send, uploadAttachment, dom, editor, type, key, draft: () => store.draft(channel.id).text };
}

describe("rich composer", () => {
  it("writes Markdown to the draft and sends it with the send key", async () => {
    const w = await world();
    w.type("**太字** と _斜体_ と a_b");
    expect(w.draft()).toBe("**太字** と _斜体_ と a_b");
    expect(w.dom()!.querySelector("strong")?.textContent).toBe("太字");
    w.key({ key: "Enter" });
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.send.mock.calls[0]![1]).toBe("**太字** と _斜体_ と a_b");
    expect(w.draft()).toBe("");
    expect(w.editor().isEmpty).toBe(true);
  });

  it("opens a draft (Markdown) in its formats", async () => {
    const w = await world({ draft: "- a\n  - b\n\n> 引用" });
    expect(w.dom()!.querySelectorAll("ul ul li")).toHaveLength(1);
    expect(w.dom()!.querySelector("blockquote")?.textContent).toBe("引用");
    expect(w.draft()).toBe("- a\n  - b\n\n> 引用"); // opening it changes nothing
  });

  it("Shift+Enter is a newline with Enter sending; ⌘Enter sends when chosen", async () => {
    const w = await world();
    w.type("一行目");
    w.key({ key: "Enter", shiftKey: true });
    w.type("二行目");
    expect(w.draft()).toBe("一行目\n二行目");
    expect(w.send).not.toHaveBeenCalled();
    cleanup();
    const m = await world({ sendKey: "mod-enter" });
    m.type("a");
    m.key({ key: "Enter", metaKey: true });
    expect(m.send).toHaveBeenCalledOnce();
  });

  it("never sends during an IME composition or on the Enter that confirms it", async () => {
    const w = await world();
    w.type("にほんご");
    act(() => void fireEvent.compositionStart(w.dom()!));
    w.key({ key: "Enter", isComposing: true, keyCode: 229 });
    expect(w.send).not.toHaveBeenCalled();
    act(() => void fireEvent.compositionEnd(w.dom()!));
    w.key({ key: "Enter" }); // WebKit's commit Enter right after compositionend
    expect(w.send).not.toHaveBeenCalled();
    const later = Date.now() + 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    w.key({ key: "Enter" });
    expect(w.send).toHaveBeenCalledOnce();
  });

  it("completes a mention and an emoji in place", async () => {
    const w = await world();
    w.type("hi @bo");
    expect(screen.getByText("@bob")).toBeTruthy();
    w.key({ key: "Enter" });
    expect(w.draft()).toBe("hi @bob ");
    w.type(":tada");
    w.key({ key: "Tab" });
    expect(w.draft()).toBe("hi @bob 🎉 ");
    w.key({ key: "Enter" });
    expect(w.send.mock.calls[0]![1]).toBe(`hi <@${w.bob.id}> 🎉`);
  });

  it("the format bar formats the selection and shows what is on", async () => {
    const w = await world();
    w.type("word");
    act(() => void w.editor().commands.selectAll());
    act(() => void fireEvent.click(screen.getByRole("button", { name: /太字/ })));
    expect(w.draft()).toBe("**word**");
    expect(screen.getByRole("button", { name: /太字/ }).getAttribute("aria-pressed")).toBe("true");
    act(() => void fireEvent.click(screen.getByRole("button", { name: "箇条書き" })));
    expect(w.draft()).toBe("- **word**");
  });

  it("offers the slash commands and replaces the text with the one picked", async () => {
    const w = await world();
    w.type("/po");
    expect(screen.getByRole("list", { name: "コマンドの候補" })).toBeTruthy();
    w.key({ key: "Tab" });
    expect(w.draft().startsWith("/po")).toBe(true);
    expect(w.draft().endsWith(" ")).toBe(true);
  });

  it("switching to Markdown keeps the text, and back again", async () => {
    const w = await world();
    w.type("**a** b");
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Markdown" })));
    expect(w.controller.setComposerMode).toHaveBeenCalledWith("markdown");
    const area = screen.getByRole("textbox", { name: "メッセージ" }) as HTMLTextAreaElement;
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.value).toBe("**a** b");
    fireEvent.change(area, { target: { value: "**a** b _c_" } });
    act(() => void fireEvent.click(screen.getByRole("button", { name: "リッチテキスト" })));
    await waitFor(() => expect(w.dom()).not.toBeNull());
    expect(w.dom()!.querySelector("em")?.textContent).toBe("c");
    expect(w.draft()).toBe("**a** b _c_");
  });

  it("pastes HTML as the supported formats, plain text literally, files as attachments", async () => {
    const w = await world();
    act(() => void w.editor().commands.focus());
    const paste = (data: Record<string, string>, files: File[] = []) =>
      act(() => {
        fireEvent.paste(w.dom()!, { clipboardData: { getData: (type: string) => data[type] ?? "", types: Object.keys(data), files, items: [] } });
      });
    paste({
      "text/html": '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700">太字</span><span> と </span><span style="font-style:italic">斜体</span></p><ul><li><p>項目</p></li></ul><p><img src="https://example.com/x.png">画像</p></b>',
      "text/plain": "太字 と 斜体\n項目\n画像",
    });
    expect(w.draft()).toContain("**太字** と _斜体_");
    expect(w.draft()).toContain("- 項目");
    expect(w.draft()).not.toContain("img");
    act(() => void w.editor().commands.setContent(""));
    paste({ "text/plain": "**not bold**\n- not a list" });
    expect(w.dom()!.querySelector("strong")).toBeNull();
    expect(w.dom()!.querySelector("ul")).toBeNull();
    const file = new File(["x"], "photo.png", { type: "image/png" });
    paste({ "text/plain": "" }, [file]);
    await waitFor(() => expect(w.uploadAttachment).toHaveBeenCalledOnce());
  });

  it("a URL pasted over selected text links it", async () => {
    const w = await world();
    w.type("サイト");
    act(() => void w.editor().commands.selectAll());
    act(() => {
      fireEvent.paste(w.dom()!, { clipboardData: { getData: (type: string) => (type === "text/plain" ? "https://example.com/a" : ""), types: ["text/plain"], files: [], items: [] } });
    });
    expect(w.draft()).toBe("[サイト](https://example.com/a)");
  });

  it("the link row links the selection (⌘⇧U) and refuses what is not http(s)", async () => {
    const w = await world();
    w.type("ここ");
    act(() => void w.editor().commands.selectAll());
    w.key({ key: "u", metaKey: true, shiftKey: true });
    const input = screen.getByRole("textbox", { name: "リンク先の URL" });
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    act(() => void fireEvent.submit(input.closest("form")!));
    expect(screen.getAllByText("http:// か https:// で始まる URL を入力してください").length).toBeGreaterThan(0);
    fireEvent.change(input, { target: { value: "https://example.com" } });
    act(() => void fireEvent.submit(input.closest("form")!));
    expect(w.draft()).toBe("[ここ](https://example.com)");
  });
});

describe("Settings → 表示 → 入力欄", () => {
  const withMe = (composer_mode: string | null | undefined) => {
    const server = new FakeServer();
    const me = { ...server.meOf(server.addUser("alice").id), composer_mode } as unknown as UserMe;
    const store = new Store();
    store.setMe(me);
    const setComposerMode = vi.fn(async () => true);
    return { controller: { store, me, setComposerMode } as unknown as AppController, setComposerMode };
  };

  it("shows rich for someone who never chose, and saves a choice", () => {
    const { controller, setComposerMode } = withMe(null);
    render(<ComposerModeSettings controller={controller} />);
    expect(screen.getByRole("button", { name: /リッチテキスト/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Markdown/ }));
    expect(setComposerMode).toHaveBeenCalledWith("markdown");
  });

  it("is not offered by a server without the setting", () => {
    const { controller } = withMe(undefined);
    const { container } = render(<ComposerModeSettings controller={controller} />);
    expect(container.textContent).toBe("");
    expect(composerModeOf({ composer_mode: "markdown" })).toBe("markdown");
    expect(composerModeOf({ composer_mode: null })).toBe("rich");
    expect(composerModeOf(null)).toBe("rich");
  });
});

describe("AppController.setComposerMode", () => {
  const self = (composer_mode: string | null | undefined) => {
    const server = new FakeServer();
    const store = new Store();
    store.setMe({ ...server.meOf(server.addUser("alice").id), composer_mode } as unknown as UserMe);
    const updateProfile = vi.fn(async () => true);
    return { self: { api: {}, store, updateProfile } as unknown as AppController, store, updateProfile };
  };

  it("saves the choice on a server that has the setting", async () => {
    const { self: controller, store, updateProfile } = self(null);
    expect(await AppController.prototype.setComposerMode.call(controller, "markdown")).toBe(true);
    expect(updateProfile).toHaveBeenCalledWith({ composer_mode: "markdown" });
    expect(store.me?.composer_mode).toBe("markdown");
  });

  it("switches this session only on a server without it (PATCH would refuse the field)", async () => {
    const { self: controller, store, updateProfile } = self(undefined);
    await AppController.prototype.setComposerMode.call(controller, "markdown");
    await AppController.prototype.setComposerMode.call(controller, "rich");
    expect(updateProfile).not.toHaveBeenCalled();
    expect(store.me?.composer_mode).toBe("rich");
  });
});

describe("IME guard", () => {
  it("treats composition, keyCode 229 and the moment after compositionend as composition", () => {
    expect(isImeKey({ isComposing: true }, false, 0, 10_000)).toBe(true);
    expect(isImeKey({ keyCode: 229 }, false, 0, 10_000)).toBe(true);
    expect(isImeKey({}, true, 0, 10_000)).toBe(true);
    expect(isImeKey({}, false, 9_950, 10_000)).toBe(true);
    expect(isImeKey({}, false, 9_000, 10_000)).toBe(false);
  });
});
