// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TemplateOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { SCHEDULE_USAGE } from "../src/ui/templates";
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
    expect(items.slice(14)).toEqual(["/日報**日報 {date}**", "/週報週報 {week}", "/メモメモ ({weekday})個人"]);
  });

  it("the 「テンプレート」 button inserts: the body into an empty input, else after a blank line", async () => {
    const w = world();
    await act(async () => { fireEvent.click(screen.getByLabelText("テンプレート")); });
    await act(async () => { fireEvent.click(screen.getByText("週報")); });
    expect(w.box().value).toBe("週報 2026-W40");
    // The caret goes to the end on the next frame (focus back in the input).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(document.activeElement).toBe(w.box());
    expect(w.box().selectionStart).toBe(w.box().value.length);
    w.type("書きかけ");
    await act(async () => { fireEvent.click(screen.getByLabelText("テンプレート")); });
    await act(async () => { fireEvent.click(screen.getByText("メモ")); });
    expect(w.box().value).toBe("書きかけ\n\nメモ (火)");
    expect(w.send).not.toHaveBeenCalled();
  });

  it("`/help` lists the templates after the commands", async () => {
    const w = world();
    w.type("/help ");
    await w.sendKey();
    const notice = String(w.setNotice.mock.calls[0]?.[0]);
    expect(notice).toContain("/日程 [質問] 日付 …");
    expect(notice.endsWith("テンプレート: /日報 /週報 /メモ")).toBe(true);
  });

  it("a template changed on another device shows at once (template.updated → the store)", () => {
    const w = world();
    w.store.applyTemplate(template({ id: "w9", name: "議事録", body: "議事録" }), false);
    w.type("/議");
    expect(screen.getByLabelText("コマンドの候補").textContent).toContain("/議事録");
  });
});

describe("/日程 (M30)", () => {
  it("posts a multiple-choice poll with the dates as its options", async () => {
    const w = world();
    w.type("/日程 ゼミ 10/3 10/4");
    await w.sendKey();
    expect(w.createPoll).toHaveBeenCalledWith(w.channel.id, null, "ゼミ", ["10/3 (土)", "10/4 (日)"], true);
    expect(w.box().value).toBe("");
    expect(w.send).not.toHaveBeenCalled();
  });

  it("posts nothing for arguments it cannot read, shows the usage and keeps the text", async () => {
    const w = world();
    w.type("/日程 ゼミ 10/1 10/2 午後");
    await w.sendKey();
    expect(w.createPoll).not.toHaveBeenCalled();
    expect(w.send).not.toHaveBeenCalled();
    expect(w.setError).toHaveBeenCalledWith(SCHEDULE_USAGE);
    expect(w.box().value).toBe("/日程 ゼミ 10/1 10/2 午後");
  });

  it("`/日程` alone opens the poll form with the next five weekdays, several answers allowed", async () => {
    const w = world();
    w.type("/日程");
    await w.sendKey(); // takes the suggestion (「/日程 」)
    await w.sendKey(); // sends it: the form opens
    expect(screen.getByRole("dialog", { name: "アンケートを作成" })).toBeTruthy();
    expect((screen.getByPlaceholderText(/次回のミーティング/) as HTMLInputElement).value).toBe("日程調整");
    expect([1, 2, 3, 4, 5].map((n) => (screen.getByLabelText(`選択肢 ${n}`) as HTMLInputElement).value)).toEqual(["9/30 (水)", "10/1 (木)", "10/2 (金)", "10/5 (月)", "10/6 (火)"]);
    expect((screen.getByLabelText("複数選択を許可する") as HTMLInputElement).checked).toBe(true);
    await act(async () => { fireEvent.click(screen.getByText("作成")); });
    expect(w.createPoll).toHaveBeenCalledWith(w.channel.id, null, "日程調整", ["9/30 (水)", "10/1 (木)", "10/2 (金)", "10/5 (月)", "10/6 (火)"], true, false);
  });
});
