// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { pollHidesBody } from "../src/ui/PollCard";
import { PollDialog, pollProblem } from "../src/ui/PollDialog";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

describe("アンケートを作成 (tester request: a form like Polly, several answers)", () => {
  it("checks the question and the options before sending", () => {
    expect(pollProblem("", ["a", "b"])).toBe("質問を入れてください");
    expect(pollProblem("いつ？", ["月曜", " "])).toBe("選択肢を 2 つ以上入れてください");
    expect(pollProblem("いつ？", ["月曜", "月曜 "])).toBe("同じ選択肢が重なっています");
    expect(pollProblem("いつ？", ["月曜", "火曜", ""])).toBeNull(); // blank rows are left out
  });

  it("makes a poll with several answers from the form", async () => {
    const createPoll = vi.fn(async () => true);
    const onClose = vi.fn();
    render(<PollDialog controller={{ createPoll } as unknown as AppController} channelId="c1" parentId={null} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText(/次回のミーティング/), { target: { value: "打ち上げの候補日" } });
    fireEvent.change(screen.getByLabelText("選択肢 1"), { target: { value: "金曜" } });
    fireEvent.change(screen.getByLabelText("選択肢 2"), { target: { value: "土曜" } });
    fireEvent.click(screen.getByText("選択肢を追加"));
    fireEvent.change(screen.getByLabelText("選択肢 3"), { target: { value: "日曜" } });
    fireEvent.click(screen.getByLabelText("複数選択を許可する"));
    await act(async () => { fireEvent.click(screen.getByText("作成")); });
    expect(createPoll).toHaveBeenCalledWith("c1", null, "打ち上げの候補日", ["金曜", "土曜", "日曜"], true);
    expect(onClose).toHaveBeenCalled();
  });

  it("`/poll` alone opens the form", async () => {
    const server = new FakeServer();
    const me = server.addUser("alice");
    const channel = server.createChannel("general", me.id);
    const store = new Store();
    store.upsertUser(me);
    store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
    const controller = { store, engine: { send: vi.fn(), sendTyping: vi.fn(), status: "online", unreadHold: new Map(), reloadCount: () => 0 }, api: {}, setError: vi.fn(), messageFocus: null, sendKey: "shift-enter", runCommand: vi.fn() } as unknown as AppController;
    function View() {
      useSyncExternalStore(store.subscribe.bind(store), () => store.version);
      return <Composer controller={controller} channel={store.getChannel(channel.id)!} parentId={null} />;
    }
    render(<View />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/poll" } });
    // The first key takes the /poll suggestion (「/poll 」), the second sends it: the form opens instead.
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value.trim()).toBe("/poll");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "アンケートを作成" })).toBeTruthy();
    expect((controller as unknown as { runCommand: ReturnType<typeof vi.fn> }).runCommand).not.toHaveBeenCalled();
  });
});

describe("a poll's message (testers, 2026-09-29: the question came twice in a row)", () => {
  const poll = { question: "ランチはどこ?", options: ["そば", "カレー"], multiple: false, closed_at: null, votes: [[], []] };
  it("leaves out the text the server made from the question; the card shows it", () => {
    expect(pollHidesBody({ body: "📊 ランチはどこ?", poll })).toBe(true);
    expect(pollHidesBody({ body: "明日のランチを決めたいです", poll })).toBe(false); // written by the author
    expect(pollHidesBody({ body: "📊 ランチはどこ?", poll: null })).toBe(false);
  });
});
