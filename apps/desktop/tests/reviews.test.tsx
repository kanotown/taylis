// @vitest-environment jsdom
// L9 (REVIEWS.md, M63): review requests on top of tasks — the chip under a message (its words and colours, following
// message.updated change="tasks" through the memoized row), 「レビューを依頼」 from a channel's and a DM's message, a DM's
// 「タスクにする」 shared with assignees, the assignee's 「対応を始める」 / 「完了にする」, and 「自分が依頼した」.
process.env.TZ = "Asia/Tokyo";

import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelOut, MessageTaskOut, TaskOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { type TaskApi, TaskHub } from "../src/sync/tasks";
import type { ChannelState } from "../src/sync/types";
import { AgendaList } from "../src/ui/CalendarView";
import { MessageActionsSheet } from "../src/ui/MessageActionsSheet";
import { MyTasksView } from "../src/ui/MyTasksView";
import { MessageRow } from "../src/ui/Timeline";
import { chooseFromRowMenu, rowMenuLabels, tick } from "./rowMenu";
import {
  canEditTask,
  canShareConversationTask,
  hasOthers,
  isRequestedByMe,
  messageReviewInit,
  messageTaskInit,
  sortRequested,
  taskChip,
  taskBoardChoices,
  taskCreateBody,
  taskNoticeText,
  taskPlace,
} from "../src/ui/tasks";
import { FakeServer } from "./fakeServer";
import { task } from "./taskFixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const names: Record<string, string> = { "u-kano": "加納", "u-ebi": "えび", "u-a": "A", "u-b": "B", "u-c": "C" };
const nameOf = (id: string) => names[id] ?? null;
const chipTask = (extra: Partial<MessageTaskOut> = {}): MessageTaskOut => ({ id: "t1", kind: "review", status: "todo", assignee_ids: ["u-kano"], due_on: null, owner_id: "u-me", ...extra });

describe("the chip's words and colours (pure)", () => {
  const today = "2026-10-02";
  it("a review request: 依頼中 / 対応中 / 完了, its assignees, the due date while open", () => {
    expect(taskChip(chipTask({ due_on: "2026-10-09" }), nameOf, today)).toEqual({ text: "レビュー依頼 · 加納 · 依頼中 · 10/9 まで", tone: "open" });
    expect(taskChip(chipTask({ status: "doing", due_on: today }), nameOf, today)).toEqual({ text: "レビュー依頼 · 加納 · 対応中 · 今日まで", tone: "open" });
    expect(taskChip(chipTask({ status: "done", due_on: "2026-09-01" }), nameOf, today)).toEqual({ text: "レビュー依頼 · 加納 · 完了", tone: "done" });
    expect(taskChip(chipTask({ due_on: "2026-10-01" }), nameOf, today)).toEqual({ text: "レビュー依頼 · 加納 · 依頼中 · 10/1 まで", tone: "overdue" });
    expect(taskChip(chipTask({ due_on: "2027-01-05" }), nameOf, today).text).toBe("レビュー依頼 · 加納 · 依頼中 · 2027/1/5 まで");
  });

  it("a task: 未着手 / 進行中 / 完了; nobody assigned; many assignees; an unknown user", () => {
    expect(taskChip(chipTask({ kind: "task", status: "doing", assignee_ids: ["u-kano", "u-ebi"] }), nameOf, today).text).toBe("タスク · 加納、えび · 進行中");
    expect(taskChip(chipTask({ kind: "task", assignee_ids: [] }), nameOf, today).text).toBe("タスク · 未着手");
    expect(taskChip(chipTask({ assignee_ids: ["u-a", "u-b", "u-c", "u-kano", "u-ebi"] }), nameOf, today).text).toBe("レビュー依頼 · A、B 他 3 人 · 依頼中");
    expect(taskChip(chipTask({ assignee_ids: ["u-gone"] }), nameOf, today).text).toBe("レビュー依頼 · ? · 依頼中");
  });
});

function dmState(id: string, members: string[], extra: Partial<ChannelState> = {}): ChannelState {
  return { id, type: "dm", name: null, dm_user_ids: members, archived: false, isMember: true, posting_policy: "everyone", ...extra } as unknown as ChannelState;
}

describe("the rules (pure)", () => {
  it("a DM's task: editable by its members (not once archived); its place is the DM", () => {
    const dm = dmState("d1", ["u-me", "u-kano"]);
    expect(canEditTask({ channel_id: "d1" }, dm, false)).toBe(true);
    expect(canEditTask({ channel_id: "d1" }, { ...dm, archived: true }, false)).toBe(false);
    expect(canEditTask({ channel_id: "d1" }, { ...dm, isMember: false }, false)).toBe(false);
    expect(taskPlace({ channel_id: "d1", channel_name: null }, () => "加納")).toBe("加納");
    expect(taskPlace({ channel_id: "d1", channel_name: null })).toBe("DM");
    expect(taskPlace({ channel_id: "c1", channel_name: "lab" })).toBe("#lab");
    expect(taskPlace({ channel_id: null, channel_name: null })).toBe("自分のタスク");
  });

  it("a DM's 「タスクにする」: personal without assignees, shared in the DM with them", () => {
    const users = new Map<string, UserPublic>();
    const init = messageTaskInit({ id: "m1", body: "見てください" }, dmState("d1", ["u-me", "u-kano"]), users, new Map(), false);
    expect(init).toMatchObject({ channelId: null, shareChannelId: "d1", boardChoices: [] });
    const draft = { title: "見てください", notes: "", status: "todo" as const, dueOn: "", assigneeIds: [] as string[] };
    const personal = taskCreateBody(draft, init, "me", "k1", "Asia/Tokyo");
    expect(personal).toMatchObject({ kind: "task", source_message_id: "m1" });
    expect(personal.channel_id).toBeUndefined();
    expect(personal.assignee_ids).toBeUndefined();
    expect(taskCreateBody({ ...draft, assigneeIds: ["u-kano", "u-kano"] }, init, "me", "k1", "Asia/Tokyo")).toMatchObject({ channel_id: "d1", assignee_ids: ["u-kano"] });
    // Archived: no sharing.
    expect(messageTaskInit({ id: "m1", body: "x" }, dmState("d1", ["u-me"], { archived: true }), users, new Map(), false).shareChannelId).toBeNull();
  });

  it("my own DM: a plain personal task, nobody to ask for a review (2026-10-09)", () => {
    const notes = dmState("n1", ["u-me"]);
    expect(hasOthers(notes)).toBe(false);
    expect(hasOthers(dmState("d1", ["u-me", "u-kano"]))).toBe(true);
    expect(hasOthers({ type: "public", dm_user_ids: null } as unknown as ChannelState)).toBe(true);
    expect(messageTaskInit({ id: "m1", body: "あとで" }, notes, new Map(), new Map(), false).shareChannelId).toBeNull();
    expect(canShareConversationTask(notes, false)).toBe(false);
    expect(canShareConversationTask(dmState("g1", ["u-me", "u-kano", "u-ebi"], { type: "group_dm" } as Partial<ChannelState>), false)).toBe(true);
    // A task already shared there stays mine to change.
    expect(canEditTask({ channel_id: "n1" }, notes, false)).toBe(true);
  });

  it("「自分のタスク」's ＋ offers the boards I may add to, by name (2026-10-09)", () => {
    const board = (id: string, extra: Partial<ChannelState> = {}) =>
      ({ id, type: "public", name: id, archived: false, isMember: true, posting_policy: "everyone", membership: { role: "member" }, ...extra }) as unknown as ChannelState;
    expect(taskBoardChoices([board("zeta"), board("alpha"), board("old", { archived: true }), board("news", { posting_policy: "owners" } as Partial<ChannelState>), dmState("d1", ["u-me", "u-kano"])], false)).toEqual(["alpha", "zeta"]);
  });

  it("「レビューを依頼」: 「レビュー：<one line>」 within 200 characters, kind review, in the message's conversation", () => {
    const init = messageReviewInit({ id: "m1", channel_id: "d1", body: "**原稿** です\n見てください" }, new Map(), new Map());
    expect(init).toMatchObject({ kind: "review", channelId: "d1", title: "レビュー：原稿 です 見てください", sourceMessageId: "m1", sourceExcerpt: "原稿 です 見てください" });
    expect(messageReviewInit({ id: "m1", channel_id: "c1", body: "あ".repeat(400) }, new Map(), new Map()).title.length).toBeLessThanOrEqual(200);
    expect(messageReviewInit({ id: "m1", channel_id: "c1", body: "", attachments: [{ content_type: "application/pdf" }] }, new Map(), new Map()).title).toMatch(/^レビュー：\S/);
    const body = taskCreateBody({ title: init.title, notes: "", status: "todo", dueOn: "2026-10-09", assigneeIds: ["u-kano"] }, init, "d1", "k1", "Asia/Tokyo");
    expect(body).toMatchObject({ kind: "review", channel_id: "d1", assignee_ids: ["u-kano"], due_on: "2026-10-09", source_message_id: "m1" });
  });

  it("「自分が依頼した」: mine, shared, someone else assigned; open by due date (none last), done newest first", () => {
    expect(isRequestedByMe({ channel_id: "c", owner_id: "me", assignee_ids: ["x"] }, "me")).toBe(true);
    expect(isRequestedByMe({ channel_id: "c", owner_id: "me", assignee_ids: ["me"] }, "me")).toBe(false);
    expect(isRequestedByMe({ channel_id: null, owner_id: "me", assignee_ids: ["x"] }, "me")).toBe(false);
    expect(isRequestedByMe({ channel_id: "c", owner_id: "x", assignee_ids: ["y"] }, "me")).toBe(false);
    const a = task("a", { due_on: null });
    const b = task("b", { due_on: "2026-10-09" });
    const c = task("c", { due_on: "2026-10-03" });
    const d = task("d", { status: "done", completed_at: "2026-10-01T00:00:00Z" });
    const e = task("e", { status: "done", completed_at: "2026-10-02T00:00:00Z" });
    const { open, done } = sortRequested([a, b, c, d, e]);
    expect(open.map((t) => t.title)).toEqual(["c", "b", "a"]);
    expect(done.map((t) => t.title)).toEqual(["e", "d"]);
  });

  it("the open app's notices: a review requested, a review done, a DM's (no channel name)", () => {
    const base = { task_id: "t1", channel_id: "c1", channel_name: "lab", title: "原稿", by_user_id: "u-kano" };
    expect(taskNoticeText({ kind: "assigned", data: { ...base, kind: "review" } }, nameOf).body).toBe("加納 がレビューを依頼しました：原稿 (#lab)");
    expect(taskNoticeText({ kind: "assigned", data: base }, nameOf).body).toBe("加納 がタスクを割り当てました：原稿 (#lab)");
    expect(taskNoticeText({ kind: "review_done", data: { ...base, channel_name: "" } }, nameOf).body).toBe("加納 がレビューを完了しました：原稿");
  });
});

/** A conversation (a channel or a DM) with bob's message in it, shown as the app shows a row. */
function conversation(type: ChannelOut["type"], options: { tasks?: MessageTaskOut[]; loadTask?: (id: string) => Promise<TaskOut | null> } = {}) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const carol = server.addUser("carol");
  const channel = server.createChannel(type === "dm" ? "" : "general", me.id, type);
  server.join(channel.id, bob.id);
  if (type !== "dm") server.join(channel.id, carol.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  for (const user of [me, bob, carol]) store.upsertUser(user);
  const message = { ...server.post(channel.id, bob.id, "明日までに **原稿** を見てください").message, tasks: options.tasks ?? [] };
  store.upsertMessage(message);
  store.upsertChannel({ ...server.channels.get(channel.id)!.channel, ...(type === "dm" ? { dm_user_ids: [me.id, bob.id] } : {}) }, { isMember: true, syncedSeq: 1, oldestLoadedSeq: 0, lastReadSeq: 1, membership: { role: "member" } as never });
  const memberIds = type === "dm" ? [me.id, bob.id] : [me.id, bob.id, carol.id];
  const api = {
    createTask: vi.fn(async (body: { title: string; channel_id?: string }) => task(body.title, { channel_id: body.channel_id ?? null })),
    updateTask: vi.fn(async (id: string, patch: Partial<TaskOut>) => task("updated", { id, ...patch })),
    members: vi.fn(async () => memberIds.map((id) => ({ user_id: id, role: "member", joined_at: "2026-01-01T00:00:00Z" }))),
  };
  const hub = new TaskHub({ api: { ...api, listTasks: vi.fn(), myTasks: vi.fn(), dueTasks: vi.fn(), getTask: vi.fn(), moveTask: vi.fn(), deleteTask: vi.fn() } as unknown as TaskApi, me: () => me.id });
  const controller = {
    store, engine: { tasks: hub }, api, version: 0, setError: vi.fn(), setNotice: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
    loadTask: vi.fn(options.loadTask ?? (async () => null)),
    openPermalink: vi.fn(async () => true),
  };
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return <MessageRow controller={controller as unknown as AppController} message={store.getMessage(channel.id, message.id)!} />;
  }
  render(<View />);
  return { api, controller, store, message, channel, me, bob, carol };
}

describe("「レビューを依頼」", () => {
  it("from a channel: 依頼先 first (not me), 希望日, then kind review in the channel with the message as source", async () => {
    const { api, controller, message, channel, bob } = conversation("public");
    await chooseFromRowMenu("レビューを依頼");
    await flush();
    const dialog = screen.getByRole("dialog", { name: "レビューを依頼" });
    expect(within(dialog).queryByLabelText("追加先")).toBeNull();
    const picker = within(dialog).getByRole("group", { name: "依頼先" });
    expect(within(picker).queryByLabelText("Alice")).toBeNull(); // not myself
    expect(within(picker).getAllByRole("checkbox")).toHaveLength(2);
    const title = within(dialog).getByLabelText("題名") as HTMLInputElement;
    expect(title.value).toBe("レビュー：明日までに 原稿 を見てください");
    expect(picker.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // the picker comes first
    expect(within(dialog).queryByRole("radiogroup", { name: "状態" })).toBeNull();
    const submit = within(dialog).getByRole("button", { name: "依頼する" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // nobody to ask yet
    fireEvent.click(within(picker).getByLabelText("Bob"));
    fireEvent.change(within(dialog).getByLabelText("希望日"), { target: { value: "2026-10-09" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await flush();
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({
      kind: "review",
      channel_id: channel.id,
      assignee_ids: [bob.id],
      due_on: "2026-10-09",
      source_message_id: message.id,
      title: "レビュー：明日までに 原稿 を見てください",
    });
    expect(controller.setNotice).toHaveBeenCalledWith("レビューを依頼しました");
  });

  it("from a DM: in the DM (channel_id = the DM), the other member as 依頼先", async () => {
    const { api, channel, bob } = conversation("dm");
    await chooseFromRowMenu("レビューを依頼");
    await flush();
    const dialog = screen.getByRole("dialog", { name: "レビューを依頼" });
    expect(dialog.querySelector("[data-task-board]")?.textContent).toBe("Bob との DM で共有");
    fireEvent.click(within(within(dialog).getByRole("group", { name: "依頼先" })).getByLabelText("Bob"));
    fireEvent.click(within(dialog).getByRole("button", { name: "依頼する" }));
    await flush();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ kind: "review", channel_id: channel.id, assignee_ids: [bob.id] });
  });

  it("a DM's 「タスクにする」 with an assignee is shared in the DM", async () => {
    const { api, channel, bob } = conversation("dm");
    await chooseFromRowMenu("タスクにする");
    await flush();
    const dialog = screen.getByRole("dialog", { name: "タスクを追加" });
    fireEvent.click(within(within(dialog).getByRole("group", { name: "担当者" })).getByLabelText("Bob"));
    expect(dialog.querySelector("[data-task-board]")?.textContent).toBe("Bob との DM で共有");
    fireEvent.click(within(dialog).getByRole("button", { name: "追加" }));
    await flush();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ kind: "task", channel_id: channel.id, assignee_ids: [bob.id] });
  });

  it("the long-press sheet offers it right after 「タスクにする」", () => {
    const { controller, store, channel, message } = conversation("public");
    cleanup();
    const onRequestReview = vi.fn();
    vi.useFakeTimers();
    render(<MessageActionsSheet controller={controller as unknown as AppController} message={store.getMessage(channel.id, message.id)!} onClose={() => {}} onShare={() => {}} onMakeTask={() => {}} onRequestReview={onRequestReview} unreadOffered={false} saved={false} isAdmin={false} />);
    const labels = within(screen.getByRole("dialog", { name: "メッセージの操作" })).getAllByRole("button").map((b) => b.textContent?.trim());
    expect(labels.indexOf("レビューを依頼")).toBe(labels.indexOf("タスクにする") + 1);
    act(() => { vi.advanceTimersByTime(400); });
    fireEvent.click(screen.getByText("レビューを依頼"));
    expect(onRequestReview).toHaveBeenCalled();
  });

  it("not offered in an archived channel", async () => {
    const { store, channel, message } = conversation("public");
    expect(rowMenuLabels()).toContain("レビューを依頼");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await tick();
    act(() => store.updateChannel(channel.id, { archived: true }));
    // The row re-renders with its message: a changed message picks up the archived conversation.
    act(() => store.upsertMessage({ ...message, updated_seq: message.updated_seq + 1 }));
    const labels = rowMenuLabels();
    expect(labels).not.toContain("レビューを依頼");
    expect(labels).toContain("タスクにする"); // a personal task still
  });
});

describe("the chip under a message", () => {
  const due = "2099-10-09";
  it("shows the message's tasks and follows message.updated (change tasks) through the memoized row", () => {
    const { store, message, bob } = conversation("public", { tasks: [{ id: "t1", kind: "review", status: "todo", assignee_ids: [], due_on: due, owner_id: "x" }] });
    const chip = () => document.querySelector('[data-task-chip="t1"]') as HTMLElement;
    expect(chip().textContent).toBe("レビュー依頼 · 依頼中 · 2099/10/9 まで");
    expect(chip().getAttribute("data-tone")).toBe("open");
    act(() => store.upsertMessage({ ...message, updated_seq: message.updated_seq + 1, tasks: [{ id: "t1", kind: "review", status: "doing", assignee_ids: [bob.id], due_on: due, owner_id: "x" }] }));
    expect(chip().textContent).toBe("レビュー依頼 · Bob · 対応中 · 2099/10/9 まで");
    act(() => store.upsertMessage({ ...message, updated_seq: message.updated_seq + 2, tasks: [{ id: "t1", kind: "review", status: "todo", assignee_ids: [bob.id], due_on: "2020-01-01", owner_id: "x" }] }));
    expect(chip().getAttribute("data-tone")).toBe("overdue");
    expect(chip().className).toContain("text-danger");
    act(() => store.upsertMessage({ ...message, updated_seq: message.updated_seq + 3, tasks: [{ id: "t1", kind: "review", status: "done", assignee_ids: [bob.id], due_on: "2020-01-01", owner_id: "x" }] }));
    expect(chip().textContent).toBe("レビュー依頼 · Bob · 完了");
    expect(chip().getAttribute("data-tone")).toBe("done");
    expect(chip().className).toContain("text-muted");
    // Deleted: the chip goes with the task.
    act(() => store.upsertMessage({ ...message, updated_seq: message.updated_seq + 4, tasks: [] }));
    expect(document.querySelector("[data-message-tasks]")).toBeNull();
  });

  it("opens the task; its assignee gets 「対応を始める」 and 「完了にする」", async () => {
    let loaded: TaskOut | null = null;
    const { api, controller, me, channel } = conversation("public", {
      tasks: [{ id: "t-rev", kind: "review", status: "todo", assignee_ids: [], due_on: null, owner_id: "x" }],
      loadTask: async () => loaded,
    });
    loaded = task("レビュー：原稿", { id: "t-rev", kind: "review", channel_id: channel.id, channel_name: "general", assignee_ids: [me.id], owner_id: "u-bob" });
    fireEvent.click(document.querySelector('[data-task-chip="t-rev"]') as HTMLElement);
    await flush();
    expect(controller.loadTask).toHaveBeenCalledWith("t-rev");
    const dialog = screen.getByRole("dialog", { name: "レビュー依頼を編集" });
    expect(within(dialog).getByRole("radio", { name: "依頼中" })).toBeTruthy();
    expect(within(dialog).getByText("希望日")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /対応を始める/ }));
    await flush();
    expect(api.updateTask).toHaveBeenCalledWith("t-rev", { status: "doing" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("someone not assigned sees no such buttons; done shows none either", async () => {
    let loaded: TaskOut | null = null;
    const { channel, me } = conversation("public", {
      tasks: [{ id: "t2", kind: "task", status: "todo", assignee_ids: [], due_on: null, owner_id: "x" }, { id: "t3", kind: "task", status: "done", assignee_ids: [], due_on: null, owner_id: "x" }],
      loadTask: async () => loaded,
    });
    loaded = task("x", { id: "t2", channel_id: channel.id, assignee_ids: ["someone"] });
    fireEvent.click(document.querySelector('[data-task-chip="t2"]') as HTMLElement);
    await flush();
    expect(screen.getByRole("dialog", { name: "タスクを編集" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /完了にする/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    loaded = task("y", { id: "t3", channel_id: channel.id, assignee_ids: [me.id], status: "done" });
    fireEvent.click(document.querySelector('[data-task-chip="t3"]') as HTMLElement);
    await flush();
    expect(screen.queryByRole("button", { name: /完了にする/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /対応を始める/ })).toBeNull();
  });
});

describe("message.updated change=tasks (engine)", () => {
  it("replaces the message's tasks in the store", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const channel = server.createChannel("general", alice.id);
    server.join(channel.id, bob.id);
    const store = new Store();
    const engine = new SyncEngine(
      { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "token", sleep: async () => {}, random: () => 0.5, isActive: () => false },
      { pageSize: 3, gapLimit: 5, reconnectMinMs: 0 },
    );
    const { message } = server.post(channel.id, alice.id, "原稿です");
    await engine.start();
    await engine.openChannel(channel.id);
    expect(store.message(channel.id, message.id)?.tasks).toEqual([]);
    const tasks: MessageTaskOut[] = [{ id: "t1", kind: "review", status: "todo", assignee_ids: [bob.id], due_on: "2026-10-09", owner_id: alice.id }];
    server.setMessageTasks(channel.id, message.id, tasks);
    await engine.idle();
    expect(store.message(channel.id, message.id)?.tasks).toEqual(tasks);
    server.setMessageTasks(channel.id, message.id, [{ ...tasks[0]!, status: "done" }]);
    await engine.idle();
    expect(store.message(channel.id, message.id)?.tasks?.[0]?.status).toBe("done");
    engine.stop();
  });
});

describe("「自分が依頼した」", () => {
  function myTasks(requested: TaskOut[], mine: TaskOut[] = [], withRoute = true) {
    const store = new Store();
    const me = { id: "u-me", username: "me", display_name: "わたし" } as UserPublic;
    const kano = { id: "u-kano", username: "kano", display_name: "加納" } as UserPublic;
    store.setMe(me as unknown as UserMe);
    store.upsertUser(me);
    store.upsertUser(kano);
    store.upsertChannel({ id: "c-lab", type: "public", name: "lab", archived: false, posting_policy: "everyone" } as ChannelOut, { isMember: true });
    store.upsertChannel({ id: "d-kano", type: "dm", name: null, dm_user_ids: ["u-me", "u-kano"], archived: false, posting_policy: "everyone" } as unknown as ChannelOut, { isMember: true });
    const api = {
      listTasks: vi.fn(), myTasks: vi.fn(async () => mine), dueTasks: vi.fn(), getTask: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), moveTask: vi.fn(), deleteTask: vi.fn(),
      ...(withRoute ? { requestedTasks: vi.fn(async () => requested) } : {}),
    };
    const hub = new TaskHub({ api: api as unknown as TaskApi, me: () => "u-me" });
    const controller = { store, engine: { tasks: hub }, api, isAdmin: false, version: 0, subscribe: () => () => {}, setError: vi.fn(), openPermalink: vi.fn() } as unknown as AppController;
    const onOpenBoard = vi.fn();
    render(<MyTasksView controller={controller} onOpenBoard={onOpenBoard} />);
    return { hub, api, onOpenBoard };
  }
  const data = (t: TaskOut) => {
    const { can_delete: _, ...rest } = t;
    return rest;
  };

  it("lists them by due date with where each lives (a DM by its member), and follows task.updated / task.deleted", async () => {
    const lab = task("lab の依頼", { owner_id: "u-me", assignee_ids: ["u-kano"], due_on: "2026-10-20", kind: "review" });
    const dm = task("DM の依頼", { channel_id: "d-kano", channel_name: null, owner_id: "u-me", assignee_ids: ["u-kano"], due_on: "2026-10-05", kind: "review", status: "doing" });
    const done = task("済んだ依頼", { owner_id: "u-me", assignee_ids: ["u-kano"], status: "done", completed_at: "2026-10-01T00:00:00Z" });
    const { hub } = myTasks([lab, dm, done]);
    await flush();
    const section = screen.getByRole("region", { name: "自分が依頼した" });
    const cards = () => [...section.querySelectorAll("[data-task-card]")].map((c) => c.querySelector("[data-task-title]")?.textContent);
    expect(cards()).toEqual(["DM の依頼", "lab の依頼"]);
    expect([...section.querySelectorAll("[data-task-place]")].map((p) => p.textContent)).toEqual(["加納", "#lab"]);
    expect(within(section).getByText("対応中")).toBeTruthy(); // a review's doing
    expect(within(section).queryAllByRole("checkbox")).toHaveLength(0); // the assignee completes it
    expect(within(section).getByRole("button", { name: /完了（1）/ })).toBeTruthy();

    act(() => hub.applyEvent("task.updated", { task: { ...data(lab), assignee_ids: [], updated_at: "2026-10-02T00:00:00Z" }, deleter_ids: [] }));
    expect(cards()).toEqual(["DM の依頼"]);
    const fresh = task("新しい依頼", { owner_id: "u-me", assignee_ids: ["u-kano"], due_on: "2026-10-03" });
    act(() => hub.applyEvent("task.updated", { task: data(fresh), deleter_ids: [] }));
    expect(cards()).toEqual(["新しい依頼", "DM の依頼"]);
    act(() => hub.applyEvent("task.deleted", { id: dm.id, channel_id: "d-kano" }));
    expect(cards()).toEqual(["新しい依頼"]);
    // Reconnecting reads it again.
    hub.online();
    await flush();
    expect(cards()).toEqual(["DM の依頼", "lab の依頼"]);
  });

  it("a DM's task assigned to me is grouped under the DM, with no board to open", async () => {
    const mine = task("見てください", { channel_id: "d-kano", channel_name: null, owner_id: "u-kano", assignee_ids: ["u-me"], kind: "review" });
    const { onOpenBoard } = myTasks([], [mine]);
    await flush();
    const assigned = screen.getByRole("region", { name: "自分の担当" });
    expect(assigned.querySelector("[data-dm-group]")?.textContent).toContain("加納");
    expect(within(assigned).queryByRole("button", { name: /加納/ })).toBeNull();
    expect(onOpenBoard).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "自分が依頼した" }).textContent).toContain("依頼したタスクはありません");
  });

  it("a server without GET /tasks/requested: no section", async () => {
    myTasks([], [], false);
    await flush();
    expect(screen.queryByRole("region", { name: "自分が依頼した" })).toBeNull();
  });
});

describe("the calendar", () => {
  it("names a DM's task by its members, never as 「自分のタスク」", () => {
    const dm = task("原稿を見る", { channel_id: "d-kano", channel_name: null, due_on: "2026-10-07" });
    render(<AgendaList events={[]} tasks={[dm]} start="2026-10-01" end="2026-10-31" today="2026-10-01" onOpen={() => {}} />);
    const day = document.querySelector('[data-agenda-day="2026-10-07"]') as HTMLElement;
    expect(within(day).getByText("DM")).toBeTruthy();
    cleanup();
    render(<AgendaList events={[]} tasks={[dm]} taskPlaceOf={(t) => taskPlace(t, () => "加納")} start="2026-10-01" end="2026-10-31" today="2026-10-01" onOpen={() => {}} />);
    expect(within(document.querySelector('[data-agenda-day="2026-10-07"]') as HTMLElement).getByText("加納")).toBeTruthy();
  });
});
