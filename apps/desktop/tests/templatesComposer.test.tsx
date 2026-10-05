// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TemplateOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { scheduleUsage } from "../src/ui/templates";
import { FakeServer } from "./fakeServer";

beforeEach(() => {
  // Only the clock: the placeholders and /日程 read today's date (2026-09-29, a Tuesday).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 29, 10, 0));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const template = (patch: Partial<TemplateOut> & Pick<TemplateOut, "id" | "name" | "body">): TemplateOut => ({
  scope: "workspace",
  owner_id: null,
  suggest_in: "any",
  position: 0,
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
  ...patch,
});

/** The template list is in the 「＋」 menu (tester, 2026-09-30). */
async function openTemplates() {
  await act(async () => { fireEvent.keyDown(screen.getByRole("button", { name: /^ファイルを添付・その他/ }), { key: "Enter" }); });
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "テンプレート…" })); });
  // It opens once the menu has closed and handed focus back (Radix does that on the next task).
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(screen.getByLabelText("テンプレートの一覧")).toBeTruthy();
}

function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  store.upsertUser(me);
  store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  store.replaceTemplates([
    template({ id: "w1", name: "日報", body: "**日報 {date}**\n今日やったこと\n- " }),
    template({ id: "w2", name: "週報", body: "週報 {week}", position: 1 }),
    template({ id: "u1", name: "メモ", body: "メモ ({weekday})", scope: "user", owner_id: me.id }),
  ]);
  const send = vi.fn();
  const createPoll = vi.fn(async () => true);
  const setError = vi.fn();
  const setNotice = vi.fn();
  const controller = {
    store,
    engine: { send, sendTyping: vi.fn(), status: "online", unreadHold: new Map(), reloadCount: () => 0 },
    api: {},
    setError,
    setNotice,
    createPoll,
    messageFocus: null,
    sendKey: "shift-enter",
    // The real command runner, over this stand-in.
    runCommand(...args: Parameters<AppController["runCommand"]>) {
      return AppController.prototype.runCommand.apply(this as unknown as AppController, args);
    },
  } as unknown as AppController;
  function View() {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Composer controller={controller} channel={store.getChannel(channel.id)!} parentId={null} />;
  }
  render(<View />);
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(box(), { target: { value } });
  const sendKey = async () => { await act(async () => { fireEvent.keyDown(box(), { key: "Enter", shiftKey: true }); }); };
  return { store, channel, send, createPoll, setError, setNotice, box, type, sendKey };
}

describe("templates in the composer (M30)", () => {
  it("`/日報` + Enter puts the template in the input and sends nothing", async () => {
    const w = world();
    w.type("/日報");
    expect(screen.getByLabelText("コマンドの候補").textContent).toContain("/日報");
    await w.sendKey();
    expect(w.box().value).toBe("**日報 2026/09/29 (火)**\n今日やったこと\n- ");
    expect(w.send).not.toHaveBeenCalled();
  });

  it("`/週報 text` + send expands and keeps the text on the next line", async () => {
    const w = world();
    w.type("/週報 今週は発表");
    await w.sendKey();
    expect(w.box().value).toBe("週報 2026-W40\n今週は発表");
    expect(w.send).not.toHaveBeenCalled();
    expect(w.setError).not.toHaveBeenCalled();
  });

  it("offers templates after the built-in commands, my own marked 個人", () => {
    world();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    const items = [...screen.getByLabelText("コマンドの候補").querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(items).toHaveLength(14 + 3);
    expect(items.slice(14)).toEqual(["/日報日報 {date}", "/週報週報 {week}", "/メモメモ ({weekday})個人"]);
  });

  it("「＋」 → 「テンプレート…」 inserts: the body into an empty input, else after a blank line", async () => {
    const w = world();
    await openTemplates();
    await act(async () => { fireEvent.click(screen.getByText("週報")); });
    expect(w.box().value).toBe("週報 2026-W40");
    // The caret goes to the end on the next frame (focus back in the input).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(document.activeElement).toBe(w.box());
    expect(w.box().selectionStart).toBe(w.box().value.length);
    w.type("書きかけ");
    await openTemplates();
    await act(async () => { fireEvent.click(screen.getByText("メモ")); });
    expect(w.box().value).toBe("書きかけ\n\nメモ (火)");
    expect(w.send).not.toHaveBeenCalled();
  });

  it("`/help` lists the templates after the commands", async () => {
    const w = world();
    w.type("/help ");
    await w.sendKey();
    const notice = String(w.setNotice.mock.calls[0]?.[0]);
    expect(notice).toContain("/日程 [題名] 日付 …");
    expect(notice.endsWith("テンプレート: /日報 /週報 /メモ")).toBe(true);
  });

  it("a template changed on another device shows at once (template.updated → the store)", () => {
    const w = world();
    w.store.applyTemplate(template({ id: "w9", name: "議事録", body: "議事録" }), false);
    w.type("/議");
    expect(screen.getByLabelText("コマンドの候補").textContent).toContain("/議事録");
  });
});

describe("/日程 (M30; a scheduling poll since M53)", () => {
  const rows = () => [...screen.getByLabelText("候補の一覧").querySelectorAll("[data-slot-row]")].map((li) => li.querySelector("span")?.textContent);

  it("opens the scheduling form with the dates (and times) typed as its candidates; nothing is posted yet", async () => {
    const w = world();
    w.type("/日程 ゼミ 10/3 10/4 13:00-14:30 10/6");
    await w.sendKey();
    expect(screen.getByRole("dialog", { name: "日程調整を作成" })).toBeTruthy();
    expect((screen.getByPlaceholderText(/M2 中間発表/) as HTMLInputElement).value).toBe("ゼミ");
    expect(rows()).toEqual(["10/3 (土) 終日", "10/4 (日) 13:00〜14:30", "10/6 (火) 終日"]);
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(""); // the composer (the dialog hides it from roles)
    expect(w.createPoll).not.toHaveBeenCalled();
    expect(w.send).not.toHaveBeenCalled();
  });

  it("opens nothing for arguments it cannot read, shows the usage and keeps the text", async () => {
    const w = world();
    w.type("/日程 ゼミ 10/1 10/2 午後");
    await w.sendKey();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(w.send).not.toHaveBeenCalled();
    expect(w.setError).toHaveBeenCalledWith(scheduleUsage());
    expect(w.box().value).toBe("/日程 ゼミ 10/1 10/2 午後");
  });

  it("「＋」 → 「日程調整」 opens the scheduling form", async () => {
    world();
    await act(async () => { fireEvent.keyDown(screen.getByRole("button", { name: /^ファイルを添付・その他/ }), { key: "Enter" }); });
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "日程調整" })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole("dialog", { name: "日程調整を作成" })).toBeTruthy();
  });

  it("`/日程` alone opens the empty scheduling form", async () => {
    const w = world();
    w.type("/日程");
    await w.sendKey(); // takes the suggestion (「/日程 」)
    await w.sendKey(); // sends it: the form opens
    expect(screen.getByRole("dialog", { name: "日程調整を作成" })).toBeTruthy();
    expect(screen.getByText("カレンダーで日を選んでください")).toBeTruthy();
    expect(w.createPoll).not.toHaveBeenCalled();
  });
});
