// @vitest-environment jsdom
// M85 (L5, docs/DEADLINES.md): deadlines on top of tasks — the pure rules (notice days, the chip, 「締切」's groups),
// the hub's deadlines window, the header chip, the dialog's 「タスク / 締切」 switch and 「事前の通知」, ⏰ on a card.
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelOut, TaskOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { inDeadlineWindow, type TaskApi, TaskHub } from "../src/sync/tasks";
import {
  deadlineChipText,
  deadlineGroups,
  deadlinePassed,
  deadlineWhen,
  nextDeadline,
  noticeSummary,
  remainingText,
} from "../src/ui/deadlines";
import { DeadlineChip, DeadlinesView } from "../src/ui/DeadlinesView";
import { ChannelTasks } from "../src/ui/TaskBoard";
import { TaskDialog } from "../src/ui/TaskDialog";
import { taskCreateBody, taskDraftProblem, taskPatch, draftFromTask } from "../src/ui/tasks";
import { task } from "./taskFixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const ME = "11111111-1111-4111-8111-111111111111";
const deadline = (title: string, due_on: string, extra: Partial<TaskOut> = {}) => task(title, { kind: "deadline", due_on, notice_days: [7, 3, 1, 0], ...extra });

describe("the rules", () => {
  const today = "2026-10-07"; // a Wednesday
  const now = new Date("2026-10-07T12:00:00+09:00");

  it("says how far a deadline is", () => {
    expect(remainingText({ due_on: "2026-10-07" }, today)).toBe("今日");
    expect(remainingText({ due_on: "2026-10-07", due_at: "2026-10-07T08:00:00Z" }, today)).toBe("今日 17:00");
    expect(remainingText({ due_on: "2026-10-08" }, today)).toBe("明日");
    expect(remainingText({ due_on: "2026-10-10" }, today)).toBe("あと 3 日");
    expect(deadlineChipText(deadline("全国大会 原稿", "2026-10-10"), today)).toBe("全国大会 原稿 あと 3 日");
    expect(deadlineWhen({ due_on: "2026-10-09" }, today)).toBe("10/9 (金)");
    expect(deadlineWhen({ due_on: "2026-10-07", due_at: "2026-10-07T08:00:00Z" }, today)).toBe("今日 17:00");
    expect(noticeSummary([0, 7, 1, 3])).toBe("7 日前・3 日前・前日・当日");
    expect(noticeSummary([])).toBe("通知しない");
  });

  it("knows when it has passed, and picks the channel's next open one", () => {
    expect(deadlinePassed({ due_on: "2026-10-06" }, today, now)).toBe(true);
    expect(deadlinePassed({ due_on: "2026-10-07" }, today, now)).toBe(false);
    expect(deadlinePassed({ due_on: "2026-10-07", due_at: "2026-10-07T02:00:00Z" }, today, now)).toBe(true);
    const past = deadline("過ぎた", "2026-10-06");
    const done = deadline("済み", "2026-10-08", { status: "done", completed_at: "2026-10-05T00:00:00Z" });
    const later = deadline("後", "2026-10-20");
    const soon = deadline("次", "2026-10-09");
    const elsewhere = deadline("他", "2026-10-08", { channel_id: "c-other" });
    const plain = task("ただのタスク", { due_on: "2026-10-08" });
    expect(nextDeadline([past, done, later, soon, elsewhere, plain], "c-lab", today, now)?.title).toBe("次");
    expect(nextDeadline([past, done], "c-lab", today, now)).toBeNull();
  });

  it("groups 今週 / 今月 / それ以降 / 過ぎたもの", () => {
    const rows = [
      deadline("土曜", "2026-10-10"),
      deadline("今日", "2026-10-07"),
      deadline("日曜", "2026-10-11"),
      deadline("月末", "2026-10-31"),
      deadline("来月", "2026-11-02"),
      deadline("昨日", "2026-10-06"),
      deadline("先週", "2026-09-30", { status: "done", completed_at: "2026-09-29T00:00:00Z" }),
      task("タスク", { due_on: "2026-10-08" }),
    ];
    const groups = deadlineGroups(rows, today, now);
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.title)])).toEqual([
      ["今週", ["今日", "土曜"]],
      ["今月", ["日曜", "月末"]],
      ["それ以降", ["来月"]],
      ["過ぎたもの", ["昨日", "先週"]],
    ]);
  });

  it("the dialog's draft: a date is needed, notices go with a new deadline and change alone", () => {
    const draft = { title: "原稿", notes: "", status: "todo" as const, dueOn: "", assigneeIds: [], noticeDays: [1, 7] };
    expect(taskDraftProblem(draft, "deadline")).toBe("締切の日付を入れてください");
    expect(taskDraftProblem(draft, "task")).toBeNull();
    const body = taskCreateBody({ ...draft, dueOn: "2026-10-20" }, { channelId: "c-lab", status: "todo", title: "", kind: "deadline" }, "c-lab", "k1", "Asia/Tokyo");
    expect(body).toMatchObject({ kind: "deadline", channel_id: "c-lab", due_on: "2026-10-20", notice_days: [7, 1] });
    expect(body.rrule).toBeUndefined();
    const saved = deadline("原稿", "2026-10-20", { notice_days: [7, 3, 1, 0] });
    expect(taskPatch(saved, { ...draftFromTask(saved), noticeDays: [0, 3, 7, 1] }, "Asia/Tokyo")).toEqual({});
    expect(taskPatch(saved, { ...draftFromTask(saved), noticeDays: [1] }, "Asia/Tokyo")).toEqual({ notice_days: [1] });
  });
});

function setup(deadlines: TaskOut[], board: TaskOut[] = []) {
  const store = new Store();
  store.setMe({ id: ME, username: "me", display_name: "わたし", notify_tasks: true } as unknown as UserMe);
  store.upsertUser({ id: ME, username: "me", display_name: "わたし" } as UserPublic);
  store.upsertChannel({ id: "c-lab", type: "public", name: "lab", archived: false, posting_policy: "everyone", last_seq: 0, created_at: "2026-01-01T00:00:00Z" } as ChannelOut, { isMember: true, membership: { role: "member" } as never });
  const api = {
    listTasks: vi.fn(async () => board),
    myTasks: vi.fn(async () => []),
    dueTasks: vi.fn(async () => []),
    deadlineTasks: vi.fn(async () => deadlines),
    getTask: vi.fn(),
    createTask: vi.fn(async (body: Partial<TaskOut>) => ({ ...deadline(String(body.title), String(body.due_on)), ...body })),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    deleteTask: vi.fn(),
    members: vi.fn(async () => [{ user_id: ME, role: "member", joined_at: "2026-01-01T00:00:00Z" }]),
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
  return { api, hub, controller };
}

describe("the hub's deadlines window", () => {
  it("is read once and kept by the events", async () => {
    const soon = deadline("原稿", "2099-01-10");
    const { hub, api } = setup([soon]);
    await hub.openDeadlines();
    await hub.openDeadlines();
    expect(api.deadlineTasks).toHaveBeenCalledTimes(1);
    expect(hub.deadlineList()?.tasks.map((t) => t.title)).toEqual(["原稿"]);
    // A new deadline comes in, a plain task does not; a deadline deleted goes.
    const next = deadline("奨学金", "2099-02-01");
    hub.applyEvent("task.updated", { task: next, deleter_ids: [] });
    hub.applyEvent("task.updated", { task: task("ただのタスク", { due_on: "2099-01-01" }), deleter_ids: [] });
    expect(hub.deadlineList()?.tasks.map((t) => t.title).sort()).toEqual(["原稿", "奨学金"]);
    hub.applyEvent("task.deleted", { id: soon.id, channel_id: "c-lab" });
    expect(hub.deadlineList()?.tasks.map((t) => t.title)).toEqual(["奨学金"]);
    hub.removeChannel("c-lab");
    expect(hub.deadlineList()?.tasks).toEqual([]);
    expect(inDeadlineWindow({ kind: "deadline", channel_id: "c", due_on: "2000-01-01" })).toBe(false);
  });

  it("an older server (422: no such route) leaves it unsupported", async () => {
    const { hub, api } = setup([]);
    const { ApiError } = await import("../src/api/errors");
    api.deadlineTasks.mockRejectedValueOnce(new ApiError(422, "validation_error", "x"));
    await hub.openDeadlines();
    expect(hub.deadlineList()?.state).toBe("unsupported");
  });
});

describe("the screens", () => {
  it("the header chip shows the next open deadline and opens it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T10:00:00+09:00"));
    const target = deadline("全国大会 原稿", "2026-10-10");
    const { controller } = setup([deadline("過ぎた", "2026-10-01"), target, deadline("後", "2026-11-01")]);
    const onOpen = vi.fn();
    render(<DeadlineChip controller={controller} channel={controller.store.getChannel("c-lab")!} onOpen={onOpen} />);
    await flush();
    const chip = document.querySelector("[data-deadline-chip]") as HTMLElement;
    expect(chip.textContent).toBe("全国大会 原稿 あと 3 日");
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: target.id }));
  });

  it("「締切」 groups the deadlines", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T10:00:00+09:00"));
    const { controller } = setup([deadline("過ぎた", "2026-10-01"), deadline("近い", "2026-10-09"), deadline("先", "2026-12-01")]);
    render(<DeadlinesView controller={controller} />);
    await flush();
    const groups = [...document.querySelectorAll("[data-deadline-group]")].map((g) => g.getAttribute("data-deadline-group"));
    expect(groups).toEqual(["week", "later", "past"]);
    expect(screen.getByText("近い")).toBeTruthy();
  });

  it("the board marks a deadline ⏰ and 「締切を追加」 makes one with its notices", async () => {
    const card = deadline("原稿", "2099-01-10");
    const { controller, api } = setup([], [card, task("普通", {})]);
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    expect(document.querySelector(`[data-task-card="${card.id}"] [data-deadline]`)).toBeTruthy();
    expect(document.querySelectorAll("[data-deadline]").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "締切を追加" }));
    expect(screen.getByRole("radio", { name: "⏰ 締切" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("自分のタスク (自分だけに表示)")).toBeNull();
    fireEvent.change(screen.getByLabelText("題名"), { target: { value: "全国大会 原稿" } });
    fireEvent.change(screen.getByLabelText("締切日"), { target: { value: "2099-02-01" } });
    fireEvent.click(screen.getByLabelText("当日"));
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await flush();
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ kind: "deadline", channel_id: "c-lab", title: "全国大会 原稿", due_on: "2099-02-01", notice_days: [7, 3, 1] }));
  });

  it("the switch turns a new board task into a deadline (no 繰り返し)", async () => {
    const { controller } = setup([]);
    render(<TaskDialog controller={controller} task={null} init={{ channelId: "c-lab", status: "todo", title: "", boardChoices: ["c-lab"] }} onClose={() => {}} />);
    expect(screen.getByRole("radio", { name: "タスク" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByLabelText("期限"), { target: { value: "2099-02-01" } });
    expect(document.querySelector("[data-task-repeat]")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "⏰ 締切" }));
    expect(document.querySelector("[data-task-repeat]")).toBeNull();
    expect(document.querySelector("[data-notice-days]")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "締切を追加" })).toBeTruthy();
  });
});
