// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { schedulePresets } from "../src/ui/schedule";
import { FakeServer } from "./fakeServer";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function world(scheduleMessage: (...args: unknown[]) => Promise<boolean>, parentId: string | null = null) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  store.upsertUser(me);
  store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  const controller = { store, engine: { send: vi.fn(), sendTyping: vi.fn(), status: "online", unreadHold: new Map(), reloadCount: () => 0 }, api: { uploadAttachment: vi.fn() }, setError: vi.fn(), messageFocus: null, sendKey: "shift-enter", scheduleMessage: vi.fn(scheduleMessage) } as unknown as AppController & { scheduleMessage: ReturnType<typeof vi.fn> };
  function View() {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Composer controller={controller} channel={store.getChannel(channel.id)!} parentId={parentId} />;
  }
  render(<View />);
  return { store, channel, controller };
}

async function scheduleFirstPreset() {
  await act(async () => { fireEvent.click(screen.getByLabelText("後で送信")); });
  await act(async () => { fireEvent.click(screen.getByText(schedulePresets()[0]!.label)); });
}

describe("後で送信 from the composer (Codex audit C1, C2)", () => {
  it("keeps what was typed while the request was on its way", async () => {
    let finish!: (ok: boolean) => void;
    const w = world(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "あとで送る" } });
    await scheduleFirstPreset();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "あとで送る。追記" } });
    await act(async () => { finish(true); });
    expect(w.store.draft(w.channel.id).text).toBe("あとで送る。追記");
  });

  it("clears the draft when nothing changed, and schedules a retry of the same draft with the same key", async () => {
    let answer = false;
    const w = world(async () => answer);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "明日の連絡" } });
    await scheduleFirstPreset(); // the response is lost
    expect(w.store.draft(w.channel.id).text).toBe("明日の連絡");
    answer = true;
    await scheduleFirstPreset();
    const keys = w.controller.scheduleMessage.mock.calls.map((call) => call[5]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(w.store.draft(w.channel.id).text).toBe("");
  });

  it("schedules the chosen priority and acknowledgement with the post, then clears them (review v0.1.84 #1)", async () => {
    const w = world(async () => true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "必ず読んで" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重要度" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^重要$/ })); });
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "確認を求める" })); });
    await scheduleFirstPreset();
    expect(w.controller.scheduleMessage.mock.calls[0]?.[6]).toEqual({ priority: "important", ackRequested: true });
    // Cleared after the schedule, as after a send: the next post is plain.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ふつうの連絡" } });
    await scheduleFirstPreset();
    expect(w.controller.scheduleMessage.mock.calls[1]?.[6]).toEqual({});
  });

  it("schedules a thread reply with 「チャンネルにも送信」 (review v0.1.84 #1)", async () => {
    const w = world(async () => true, "parent-1");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "スレッドとチャンネルへ" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /にも送信/ }));
    await scheduleFirstPreset();
    const call = w.controller.scheduleMessage.mock.calls[0]!;
    expect(call[1]).toBe("parent-1");
    expect(call[6]).toEqual({ alsoInChannel: true });
    expect((screen.getByRole("checkbox", { name: /にも送信/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("another choice of options is another schedule (another key)", async () => {
    let answer = false;
    const w = world(async () => answer);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "同じ本文" } });
    await scheduleFirstPreset(); // failed
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重要度" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^緊急$/ })); });
    answer = true;
    await scheduleFirstPreset();
    const keys = w.controller.scheduleMessage.mock.calls.map((call) => call[5]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(w.controller.scheduleMessage.mock.calls[1]?.[6]).toEqual({ priority: "urgent" });
  });
});
