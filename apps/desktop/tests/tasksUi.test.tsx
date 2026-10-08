// @vitest-environment jsdom
// M55 (TASKS.md §6): the board (columns, cards, drag and drop, read-only), the task dialog, 「自分のタスク」,
// 「タスクにする」 from a message, the tasks in the calendar, and 「タスク（割り当て・期限）」 in the settings.
process.env.TZ = "Asia/Tokyo";

import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { ChannelOut, TaskOut, UserMe, UserPublic } from "../src/api/types";
import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { type TaskApi, TaskHub } from "../src/sync/tasks";
import { AgendaList, MonthGrid } from "../src/ui/CalendarView";
import { MessageActionsSheet } from "../src/ui/MessageActionsSheet";
import { MyTasksView } from "../src/ui/MyTasksView";
import { SettingsDialog } from "../src/ui/Settings";
import { ChannelTasks } from "../src/ui/TaskBoard";
import { TaskDialog } from "../src/ui/TaskDialog";
import { MessageRow } from "../src/ui/Timeline";
import { today } from "../src/ui/calendarDates";
import { FakeServer } from "./fakeServer";
import { chooseFromRowMenu } from "./rowMenu";
import { task } from "./taskFixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// jsdom has no DragEvent: one with the pointer's coordinates (testing-library adds the dataTransfer).
beforeEach(() => {
  if (typeof (window as { DragEvent?: unknown }).DragEvent === "undefined") {
    Object.defineProperty(window, "DragEvent", { configurable: true, value: class DragEvent extends MouseEvent {} });
  }
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const ME = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const people: UserPublic[] = [
  { id: ME, username: "me", display_name: "わたし" } as UserPublic,
  { id: BOB, username: "bob", display_name: "ボブ" } as UserPublic,
  ...["c", "d", "e"].map((x, i) => ({ id: `3333333${i}-3333-4333-8333-333333333333`, username: x, display_name: x.toUpperCase() }) as UserPublic),
];

function channel(id: string, name: string, extra: Partial<ChannelOut> = {}): ChannelOut {
  return { id, type: "public", name, topic: null, purpose: null, archived: false, created_at: "2026-01-01T00:00:00Z", last_seq: 0, posting_policy: "everyone", ...extra } as ChannelOut;
}

function setup(initial: { board?: TaskOut[]; mine?: TaskOut[]; role?: "member" | "owner"; policy?: "everyone" | "owners" } = {}) {
  const store = new Store();
  store.setMe({ ...people[0]!, notify_tasks: true } as unknown as UserMe);
  for (const user of people) store.upsertUser(user);
  store.upsertChannel(channel("c-lab", "lab", { posting_policy: initial.policy ?? "everyone" }), { isMember: true, membership: { role: initial.role ?? "member" } as never });
  const api = {
    listTasks: vi.fn(async () => initial.board ?? []),
    myTasks: vi.fn(async () => initial.mine ?? []),
    dueTasks: vi.fn(async () => []),
    getTask: vi.fn(),
    createTask: vi.fn(async (body: { title: string; channel_id?: string | null; status?: string }) => task(body.title, { channel_id: body.channel_id ?? null, status: (body.status ?? "todo") as TaskOut["status"], position: 99 })),
    updateTask: vi.fn(async (id: string, patch: Partial<TaskOut>) => ({ ...hub.find(id)!, ...patch, updated_at: "2026-10-02T00:00:00Z" })),
    moveTask: vi.fn(async (id: string, body: { status: TaskOut["status"] }) => ({ ...hub.find(id)!, status: body.status, updated_at: "2026-10-02T00:00:00Z" })),
    deleteTask: vi.fn(async () => {}),
    members: vi.fn(async () => people.slice(0, 2).map((u) => ({ user_id: u.id, role: "member", joined_at: "2026-01-01T00:00:00Z" }))),
  };
  const hub: TaskHub = new TaskHub({ api: api as unknown as TaskApi, me: () => ME });
  const controller = {
    store,
    engine: { tasks: hub },
    api,
    isAdmin: false,
    version: 0,
    subscribe: () => () => {},
    setError: vi.fn(),
    setNotice: vi.fn(),
    openPermalink: vi.fn(async () => true),
  } as unknown as AppController;
  return { store, api, hub, controller };
}

const card = (id: string) => document.querySelector(`[data-task-card="${id}"]`) as HTMLElement;
const column = (status: string) => document.querySelector(`[data-column="${status}"]`) as HTMLElement;
const zone = (status: string) => document.querySelector(`[data-drop-zone="${status}"]`) as HTMLElement;

function rect(element: HTMLElement, top: number, height = 40) {
  element.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

describe("the board", () => {
  it("shows three columns with their counts, overdue dates in red, 「今日」, avatars (3, then +N), notes, and done struck through", async () => {
    const now = today();
    const late = task("遅れ", { due_on: "2020-01-01", assignee_ids: people.map((u) => u.id), notes: "メモ" });
    const due = task("今日まで", { due_on: now, status: "doing" });
    const done = task("終わった", { status: "done", due_on: "2020-01-01" });
    const { controller } = setup({ board: [late, due, done] });
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    expect(within(column("todo")).getByRole("heading").textContent).toContain("未着手");
    expect(["todo", "doing", "done"].map((s) => column(s).querySelector("[data-count]")?.textContent)).toEqual(["1", "1", "1"]);
    const overdue = card(late.id).querySelector("[data-due]") as HTMLElement;
    expect(overdue.getAttribute("data-overdue")).toBe("true");
    expect(overdue.className).toContain("text-danger");
    expect(card(due.id).querySelector("[data-due]")?.textContent).toContain("今日");
    expect(card(done.id).querySelector("[data-due]")?.getAttribute("data-overdue")).toBeNull(); // done: never late
    expect(card(done.id).querySelector("[data-task-title]")?.className).toContain("line-through");
    expect(card(late.id).querySelector("[data-assignees]")?.getAttribute("data-assignees")).toBe("5");
    expect(card(late.id).querySelector("[data-more-assignees]")?.textContent).toBe("+2");
    expect(card(late.id).querySelector("[data-has-notes]")).toBeTruthy();
    expect(card(due.id).querySelector("[data-has-notes]")).toBeNull();
    expect(screen.getAllByRole("button", { name: "追加" })).toHaveLength(3);
  });

  it("drags a card into another column under the card it is dropped below, and within its column", async () => {
    const a = task("A", { position: 1 });
    const b = task("B", { position: 2 });
    const c = task("C", { position: 1, status: "doing" });
    const { controller, api, hub } = setup({ board: [a, b, c] });
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    expect(card(a.id).getAttribute("draggable")).toBe("true");
    rect(card(c.id), 0);
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => a.id), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(card(a.id), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", a.id);
    fireEvent.dragOver(zone("doing"), { clientY: 100, dataTransfer });
    expect(zone("doing").querySelector("[data-drop-indicator]")).toBeTruthy(); // the line where it lands
    fireEvent.drop(zone("doing"), { clientY: 100, dataTransfer });
    await flush();
    expect(api.moveTask).toHaveBeenCalledWith(a.id, { status: "doing", after_id: c.id, before_id: null });
    expect(hub.find(a.id)?.status).toBe("doing");

    // Within 未着手 (now B alone)… B dropped on itself: nothing sent. Then C over B in 未着手 (above it).
    rect(card(b.id), 0);
    fireEvent.dragStart(card(b.id), { dataTransfer });
    fireEvent.drop(zone("todo"), { clientY: 10, dataTransfer });
    expect(api.moveTask).toHaveBeenCalledTimes(1);
    fireEvent.dragStart(card(c.id), { dataTransfer });
    fireEvent.dragOver(zone("todo"), { clientY: 10, dataTransfer });
    fireEvent.drop(zone("todo"), { clientY: 10, dataTransfer });
    await flush();
    expect(api.moveTask).toHaveBeenLastCalledWith(c.id, { status: "todo", after_id: null, before_id: b.id });
  });

  it("a refused move goes back and says why", async () => {
    const a = task("A");
    const { controller, api, hub } = setup({ board: [a] });
    api.moveTask.mockRejectedValueOnce(new Error("no"));
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(card(a.id), { dataTransfer });
    fireEvent.drop(zone("done"), { clientY: 0, dataTransfer });
    await flush();
    expect(hub.find(a.id)?.status).toBe("todo");
    expect(controller.setError).toHaveBeenCalled();
  });

  it("「＋ 追加」 adds into its column with Enter and stays open for the next; Esc closes it", async () => {
    const { controller, api } = setup();
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    fireEvent.click(within(column("doing")).getByRole("button", { name: "追加" }));
    const input = screen.getByLabelText("新しいタスクの題名") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  発表 準備  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ channel_id: "c-lab", title: "発表 準備", status: "doing", tz: "Asia/Tokyo" }));
    expect((api.createTask.mock.calls[0] as unknown as [{ client_task_id: string }])[0].client_task_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((screen.getByLabelText("新しいタスクの題名") as HTMLInputElement).value).toBe("");
    expect(within(column("doing")).getByText("発表 準備")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("新しいタスクの題名"), { key: "Escape" });
    expect(screen.queryByLabelText("新しいタスクの題名")).toBeNull();
  });

  it("read-only where I may not post: no dragging, no 「追加」, and why", async () => {
    const a = task("A", { can_delete: false });
    const { controller } = setup({ board: [a], policy: "owners" });
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    expect(card(a.id).getAttribute("draggable")).toBeNull();
    expect(screen.queryByRole("button", { name: "追加" })).toBeNull();
    expect(screen.queryByRole("button", { name: /の操作$/ })).toBeNull();
    expect(screen.getByText("このボードを変更できるのは、チャンネルのオーナーと管理者だけです")).toBeTruthy();
  });

  it("「完了をすべて表示」 once 100 completed cards are shown", async () => {
    const done = Array.from({ length: 100 }, (_, i) => task(`d${i}`, { status: "done" }));
    const { controller, api } = setup({ board: done });
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "完了をすべて表示" }));
    await flush();
    expect(api.listTasks).toHaveBeenLastCalledWith("c-lab", "all");
  });
});

describe("the task dialog", () => {
  it("opens prefilled from a card and saves only what changed", async () => {
    const a = task("資料", { notes: "メモ", due_on: "2026-10-05", assignee_ids: [BOB], source: { message_id: "m1", channel_id: "c-lab", excerpt: "元の発言" } });
    const { controller, api } = setup({ board: [a] });
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    fireEvent.click(within(card(a.id)).getByText("資料"));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "タスクを編集" });
    expect((within(dialog).getByLabelText("題名") as HTMLInputElement).value).toBe("資料");
    expect((within(dialog).getByLabelText("メモ") as HTMLTextAreaElement).value).toBe("メモ");
    expect((within(dialog).getByLabelText("期限") as HTMLInputElement).value).toBe("2026-10-05");
    expect(within(dialog).getByRole("radio", { name: "未着手" }).getAttribute("aria-checked")).toBe("true");
    expect((within(dialog).getByRole("checkbox", { name: "ボブ" }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByText("元の発言")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("題名"), { target: { value: "資料をまとめる" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "進行中" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "わたし" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await flush();
    expect(api.updateTask).toHaveBeenCalledWith(a.id, { title: "資料をまとめる", status: "doing", assignee_ids: [ME, BOB].sort() });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("「メッセージを開く」 and, for who may, 「削除」 after asking", async () => {
    const a = task("資料", { source: { message_id: "m1", channel_id: "c-lab", excerpt: "元の発言" } });
    const { controller, api } = setup({ board: [a] });
    const onOpenMessage = vi.fn();
    render(<TaskDialog controller={controller} task={a} onClose={() => {}} onOpenMessage={onOpenMessage} />);
    fireEvent.click(screen.getByRole("button", { name: "メッセージを開く" }));
    expect(onOpenMessage).toHaveBeenCalledWith("m1");
    cleanup();
    const onClose = vi.fn();
    render(<TaskDialog controller={controller} task={a} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /削除/ }));
    expect(screen.getByText("このタスクを削除しますか？")).toBeTruthy();
    expect(api.deleteTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await flush();
    expect(api.deleteTask).toHaveBeenCalledWith(a.id);
    expect(onClose).toHaveBeenCalled();
  });

  it("a deleted source says so (no link); no 削除 without can_delete; read-only where I may not post", () => {
    const gone = task("x", { channel_id: "c-lab", can_delete: false, source: { message_id: null, channel_id: "c-lab", excerpt: null } });
    const { controller } = setup({ policy: "owners" });
    render(<TaskDialog controller={controller} task={gone} onClose={() => {}} />);
    expect(screen.getByText("元のメッセージは削除されました")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "メッセージを開く" })).toBeNull();
    expect(screen.queryByRole("button", { name: /削除/ })).toBeNull();
    expect(screen.queryByLabelText("題名")).toBeNull(); // read-only
    expect(screen.getAllByRole("button", { name: "閉じる" })).toHaveLength(2); // the text one and the ✕
  });
});

describe("「自分のタスク」", () => {
  it("my list with checkboxes and 「完了（N）」, then 「自分の担当」 by channel (its name opens the board)", async () => {
    const p1 = task("牛乳を買う", { channel_id: null, channel_name: null });
    const p2 = task("済んだこと", { channel_id: null, channel_name: null, status: "done", completed_at: "2026-09-30T00:00:00Z" });
    const s1 = task("発表", { assignee_ids: [ME], status: "doing" });
    const { controller, api } = setup({ mine: [p1, p2, s1] });
    const onOpenBoard = vi.fn();
    render(<MyTasksView controller={controller} onOpenBoard={onOpenBoard} />);
    await flush();
    const mine = screen.getByRole("region", { name: "自分のタスク" });
    expect(within(mine).getByText("牛乳を買う")).toBeTruthy();
    expect(within(mine).queryByText("済んだこと")).toBeNull(); // folded
    fireEvent.click(within(mine).getByRole("button", { name: /完了（1）/ }));
    expect(within(mine).getByText("済んだこと")).toBeTruthy();
    const assigned = screen.getByRole("region", { name: "自分の担当" });
    expect(within(assigned).getByText("発表")).toBeTruthy();
    expect(within(assigned).getByText("進行中")).toBeTruthy();
    fireEvent.click(within(assigned).getByRole("button", { name: /lab/ }));
    expect(onOpenBoard).toHaveBeenCalledWith("c-lab");
    fireEvent.click(within(mine).getByRole("checkbox", { name: "「牛乳を買う」を完了にする" }));
    await flush();
    expect(api.updateTask).toHaveBeenCalledWith(p1.id, { status: "done" });
  });

  it("「＋ 追加」 there makes a personal task", async () => {
    const { controller, api } = setup();
    render(<MyTasksView controller={controller} onOpenBoard={() => {}} />);
    await flush();
    fireEvent.click(within(screen.getByRole("region", { name: "自分のタスク" })).getByRole("button", { name: "追加" }));
    fireEvent.change(screen.getByLabelText("新しいタスクの題名"), { target: { value: "掃除" } });
    fireEvent.keyDown(screen.getByLabelText("新しいタスクの題名"), { key: "Enter" });
    await flush();
    const body = (api.createTask.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).toMatchObject({ title: "掃除", status: "todo" });
    expect(body.channel_id).toBeUndefined();
  });

  it("「タスクを追加」 starts in 「自分のタスク」, says why there are no assignees, and offers my boards (2026-10-09)", async () => {
    const { controller, api } = setup();
    render(<MyTasksView controller={controller} onOpenBoard={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "タスクを追加" }));
    const dialog = screen.getByRole("dialog", { name: "タスクを追加" });
    const where = within(dialog).getByLabelText("追加先") as HTMLSelectElement;
    expect(where.value).toBe("me");
    expect([...where.options].map((o) => o.textContent)).toEqual(["#lab のボード", "自分のタスク（自分だけに表示）"]);
    const personal = dialog.querySelector("[data-task-personal-assignees]") as HTMLElement;
    expect(personal.textContent).toContain("チャンネルのボードを選ぶと、そのメンバーから選べます");
    fireEvent.change(within(personal).getByLabelText("ボードを選ぶ"), { target: { value: "c-lab" } });
    await flush();
    expect(where.value).toBe("c-lab");
    expect(dialog.querySelector("[data-task-personal-assignees]")).toBeNull();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "ボブ" }));
    fireEvent.change(within(dialog).getByLabelText("題名"), { target: { value: "発表練習" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "追加" }));
    await flush();
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "発表練習", channel_id: "c-lab", assignee_ids: [BOB] }));
  });

  it("a board with only me says how others come in", async () => {
    const { controller, api } = setup();
    api.members.mockResolvedValue([{ user_id: ME, role: "member", joined_at: "2026-01-01T00:00:00Z" }]);
    render(<MyTasksView controller={controller} onOpenBoard={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "タスクを追加" }));
    const dialog = screen.getByRole("dialog", { name: "タスクを追加" });
    fireEvent.change(within(dialog).getByLabelText("追加先"), { target: { value: "c-lab" } });
    await flush();
    expect(dialog.querySelector("[data-task-alone]")?.textContent).toBe("ほかの人を選ぶには、その人をこのチャンネルに追加してください");
  });

  describe("quick add: the field keeps the focus for the next title", () => {
    const open = async () => {
      const setup_ = setup();
      render(<MyTasksView controller={setup_.controller} onOpenBoard={() => {}} />);
      await flush();
      fireEvent.click(within(screen.getByRole("region", { name: "自分のタスク" })).getByRole("button", { name: "追加" }));
      const input = screen.getByLabelText("新しいタスクの題名") as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      return { ...setup_, input };
    };

    it("Enter adds, and the field stays focused and empty (also when the new row took the focus away)", async () => {
      const { api, input } = await open();
      const create = api.createTask.getMockImplementation()!;
      // The list re-rendering around the new row drops the focus to the page.
      api.createTask.mockImplementation(async (body) => {
        (document.activeElement as HTMLElement | null)?.blur();
        return create(body);
      });
      for (const title of ["一つ目", "二つ目"]) {
        fireEvent.change(input, { target: { value: title } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(input.readOnly).toBe(true); // not disabled: that would drop the focus
        await flush();
        expect(screen.getByLabelText("新しいタスクの題名")).toBe(input);
        expect(input.value).toBe("");
        expect(input.readOnly).toBe(false);
        expect(document.activeElement).toBe(input);
      }
      expect(api.createTask.mock.calls.map((c) => (c as unknown as [{ title: string }])[0].title)).toEqual(["一つ目", "二つ目"]);
      expect(within(screen.getByRole("region", { name: "自分のタスク" })).getByText("二つ目")).toBeTruthy();
    });

    it("the Enter of an IME conversion and Shift+Enter add nothing", async () => {
      const { api, input } = await open();
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: "はっぴょう" } });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
      fireEvent.compositionEnd(input);
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 }); // Safari: the confirming Enter after compositionend
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      await flush();
      expect(api.createTask).not.toHaveBeenCalled();
      expect(input.value).toBe("はっぴょう");
      expect(document.activeElement).toBe(input);
    });

    it("a failed add keeps the text and the focus", async () => {
      const { api, controller, input } = await open();
      api.createTask.mockRejectedValueOnce(new Error("offline"));
      fireEvent.change(input, { target: { value: "掃除" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await flush();
      expect(controller.setError).toHaveBeenCalled();
      expect(input.value).toBe("掃除");
      expect(document.activeElement).toBe(input);
    });

    it("does not take the focus back from where the user moved it", async () => {
      const { api, input } = await open();
      let finish: () => void = () => {};
      const create = api.createTask.getMockImplementation()!;
      api.createTask.mockImplementation((body) => new Promise((resolve) => { finish = () => resolve(create(body)); }));
      fireEvent.change(input, { target: { value: "掃除" } });
      fireEvent.keyDown(input, { key: "Enter" });
      const other = screen.getByRole("button", { name: "タスクを追加" });
      fireEvent.pointerDown(other);
      other.focus();
      await act(async () => { finish(); });
      await flush();
      expect(input.value).toBe("");
      expect(document.activeElement).toBe(other);
    });
  });
});

describe("「タスクにする」", () => {
  function timeline(type: ChannelOut["type"]) {
    const server = new FakeServer();
    const me = server.addUser("alice");
    const bob = server.addUser("bob");
    const conversation = server.createChannel(type === "dm" ? "" : "general", me.id, type);
    server.join(conversation.id, bob.id);
    const store = new Store();
    store.setMe(me as unknown as UserMe);
    store.upsertUser(me);
    store.upsertUser(bob);
    const message = server.post(conversation.id, bob.id, "明日までに **資料** をお願いします").message;
    store.upsertMessage(message);
    store.upsertChannel(server.channels.get(conversation.id)!.channel, { isMember: true, syncedSeq: 1, oldestLoadedSeq: 0, lastReadSeq: 1, membership: { role: "member" } as never });
    const api = { createTask: vi.fn(async (body: { title: string }) => task(body.title)), members: vi.fn(async () => []) };
    const hub = new TaskHub({ api: { ...api, listTasks: vi.fn(), myTasks: vi.fn(), dueTasks: vi.fn(), getTask: vi.fn(), updateTask: vi.fn(), moveTask: vi.fn(), deleteTask: vi.fn() } as unknown as TaskApi, me: () => me.id });
    const controller = {
      store, engine: { tasks: hub }, api, version: 0, setError: vi.fn(), setNotice: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
      linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
    };
    function View() {
      useSyncExternalStore((l) => store.subscribe(l), () => store.version);
      return <MessageRow controller={controller as unknown as AppController} message={store.getMessage(conversation.id, message.id)!} />;
    }
    render(<View />);
    return { api, controller, message, conversation };
  }

  it("from a DM without assignees: a personal task with the message's text and the message as its source", async () => {
    const { api, controller, message } = timeline("dm");
    await chooseFromRowMenu("タスクにする");
    const dialog = screen.getByRole("dialog", { name: "タスクを追加" });
    // L9: no board to choose; assignees (the DM's members) would share it in the DM.
    expect(within(dialog).queryByLabelText("追加先")).toBeNull();
    expect(dialog.querySelector("[data-task-board]")?.textContent).toContain("選ばなければ自分のタスク");
    expect((within(dialog).getByLabelText("題名") as HTMLInputElement).value).toBe("明日までに 資料 をお願いします");
    fireEvent.click(within(dialog).getByRole("button", { name: "追加" }));
    await flush();
    const body = (api.createTask.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).toMatchObject({ title: "明日までに 資料 をお願いします", source_message_id: message.id, status: "todo" });
    expect(body.channel_id).toBeUndefined();
    expect(controller.setNotice).toHaveBeenCalledWith("タスクを作成しました");
  });

  it("from a channel: its board, switchable to 「自分のタスク」", async () => {
    const { api, conversation } = timeline("public");
    await chooseFromRowMenu("タスクにする");
    const dialog = screen.getByRole("dialog", { name: "タスクを追加" });
    const where = within(dialog).getByLabelText("追加先") as HTMLSelectElement;
    expect(where.value).toBe(conversation.id);
    expect([...where.options].map((o) => o.textContent)).toEqual(["#general のボード", "自分のタスク（自分だけに表示）"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "追加" }));
    await flush();
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ channel_id: conversation.id }));
  });
});

describe("the calendar", () => {
  it("shows the tasks due as all-day rows 「☐ 題名」 (done 「☑」, struck through); a click opens the task", () => {
    const open = task("提出", { due_on: "2026-10-07" });
    const done = task("済み", { due_on: "2026-10-07", status: "done", channel_id: null, channel_name: null });
    const onOpenTask = vi.fn();
    render(<MonthGrid anchor="2026-10-01" today="2026-10-01" events={[]} tasks={[open, done]} onOpen={() => {}} onOpenTask={onOpenTask} onNew={() => {}} onDay={() => {}} />);
    const cell = document.querySelector('[data-day="2026-10-07"]') as HTMLElement;
    const rows = [...cell.querySelectorAll("[data-task]")] as HTMLElement[];
    expect(rows.map((r) => r.textContent)).toEqual(["☐提出", "☑済み"]);
    expect(rows[1]!.querySelector(".line-through")).toBeTruthy();
    expect(rows[0]!.querySelector(".line-through")).toBeNull();
    fireEvent.click(rows[0]!);
    expect(onOpenTask).toHaveBeenCalledWith(open);
    cleanup();
    render(<AgendaList events={[]} tasks={[open]} start="2026-10-01" end="2026-10-31" today="2026-10-01" onOpen={() => {}} onOpenTask={onOpenTask} />);
    const day = document.querySelector('[data-agenda-day="2026-10-07"]') as HTMLElement;
    expect(within(day).getByText("提出")).toBeTruthy();
    expect(within(day).getByText("#lab")).toBeTruthy();
  });
});

describe("the settings", () => {
  it("「タスク（割り当て・期限）」 is saved as notify_tasks", async () => {
    const patches: unknown[] = [];
    const controller = new AppController();
    controller.api = {
      baseUrl: "http://server",
      totpStatus: async () => ({ enabled: false, recovery_codes_left: 0 }),
      updateMe: async (patch: { notify_tasks?: boolean }) => { patches.push(patch); return { ...controller.store.me!, ...patch }; },
    } as unknown as ApiClient;
    controller.store.setMe({ ...people[0]!, email: null, must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "mentions", notify_reactions: false, notify_tasks: true, has_password: true } as unknown as UserMe);
    controller.store.upsertUser(people[0]!);
    function View() {
      useSyncExternalStore((l) => controller.store.subscribe(l), () => controller.store.version);
      return <SettingsDialog controller={controller} onClose={() => {}} />;
    }
    render(<View />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "設定の項目" })).getByRole("button", { name: "通知" }));
    const toggle = screen.getByRole("switch", { name: /タスク（割り当て・期限）/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await flush();
    expect(patches).toEqual([{ notify_tasks: false }]);
    expect((screen.getByRole("switch", { name: /タスク（割り当て・期限）/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("the long-press sheet", () => {
  it("offers 「タスクにする」 after 「リマインド…」 when the server has tasks", () => {
    const { controller } = setup();
    const onMakeTask = vi.fn();
    const message = { id: "m1", channel_id: "c-lab", sender_id: BOB, body: "x", reactions: [], seq: 1 } as never;
    vi.useFakeTimers();
    try {
      render(<MessageActionsSheet controller={controller} message={message} onClose={() => {}} onShare={() => {}} onMakeTask={onMakeTask} unreadOffered={false} saved={false} isAdmin={false} />);
      const labels = within(screen.getByRole("dialog", { name: "メッセージの操作" })).getAllByRole("button").map((b) => b.textContent?.trim());
      expect(labels.indexOf("タスクにする")).toBe(labels.indexOf("リマインド…") + 1);
      act(() => { vi.advanceTimersByTime(400); });
      fireEvent.click(screen.getByText("タスクにする"));
      expect(onMakeTask).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
