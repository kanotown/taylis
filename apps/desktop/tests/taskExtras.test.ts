// M81 (TASKS.md §11): due times, subtasks, repeats and board columns — the pure rules and the hub.
process.env.TZ = "Asia/Tokyo";

import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { TaskColumnOut, TaskOut } from "../src/api/types";
import { type TaskApi, TaskHub } from "../src/sync/tasks";
import { noRepeat } from "../src/ui/calendarRecurrence";
import {
  applyLocalMove,
  type BoardColumn,
  columnMoveTarget,
  columnOfTask,
  draftFromTask,
  dueText,
  emptyExtras,
  FALLBACK_COLUMNS,
  isFallbackColumns,
  isOverdue,
  repeatForDue,
  sortBoardColumn,
  subtaskProgress,
  taskChip,
  taskCreateBody,
  taskDraftProblem,
  taskNoticeText,
  taskPatch,
  tasksForDay,
} from "../src/ui/tasks";
import { task } from "./taskFixtures";

const columns: BoardColumn[] = [
  { id: "col-todo", name: "未着手", status: "todo", builtin: true, position: 1 },
  { id: "col-doing", name: "進行中", status: "doing", builtin: true, position: 2 },
  { id: "col-review", name: "レビュー待ち", status: "doing", builtin: false, position: 2.5 },
  { id: "col-done", name: "完了", status: "done", builtin: true, position: 3 },
];

describe("columns", () => {
  it("puts a card in its added column, else the built-in one of its status", () => {
    const a = task("a", { status: "doing" });
    const b = task("b", { status: "doing", column_id: "col-review" });
    const c = task("c", { status: "doing", column_id: "col-gone" }); // a column deleted meanwhile
    expect(columnOfTask(a, columns)?.id).toBe("col-doing");
    expect(columnOfTask(b, columns)?.id).toBe("col-review");
    expect(columnOfTask(c, columns)?.id).toBe("col-doing");
    expect(sortBoardColumn([a, b, c], columns[1]!, columns).map((t) => t.title)).toEqual(["a", "c"]);
    expect(isFallbackColumns(FALLBACK_COLUMNS)).toBe(true);
    expect(isFallbackColumns(columns)).toBe(false);
  });

  it("「左へ」 / 「右へ」 name the column to go right of (null: the left end)", () => {
    expect(columnMoveTarget(columns, "col-review", -1)).toBe("col-todo");
    expect(columnMoveTarget(columns, "col-review", 1)).toBe("col-done");
    expect(columnMoveTarget(columns, "col-doing", -1)).toBeNull();
    expect(columnMoveTarget(columns, "col-todo", -1)).toBeUndefined();
    expect(columnMoveTarget(columns, "col-done", 1)).toBeUndefined();
  });

  it("the optimistic move keeps the column while the status stays, else the built-in one", () => {
    const a = task("a", { status: "doing", column_id: "col-review", position: 1 });
    const b = task("b", { status: "doing", position: 5 });
    const same = applyLocalMove([a, b], a.id, "doing", { after_id: null, before_id: null });
    expect(same.find((t) => t.id === a.id)?.column_id).toBe("col-review");
    const done = applyLocalMove([a, b], a.id, "done", { after_id: null, before_id: null });
    expect(done.find((t) => t.id === a.id)?.column_id).toBeNull();
    const into = applyLocalMove([a, b], b.id, "doing", { after_id: a.id, before_id: null }, undefined, null, "col-review");
    const moved = into.find((t) => t.id === b.id)!;
    expect(moved.column_id).toBe("col-review");
    expect(moved.position).toBeGreaterThan(1);
  });
});

describe("due times", () => {
  it("shows the time, is late once it has passed, sorts after the whole-day ones", () => {
    const timed = task("会議", { due_on: "2030-01-10", due_at: "2030-01-10T05:00:00Z", due_tz: "Asia/Tokyo" });
    expect(dueText(timed, "2030-01-10")).toBe("今日 14:00");
    expect(dueText(timed, "2030-01-01")).toBe("1/10 14:00");
    expect(isOverdue(timed, "2030-01-10", new Date("2030-01-10T04:59:00Z"))).toBe(false);
    expect(isOverdue(timed, "2030-01-10", new Date("2030-01-10T05:01:00Z"))).toBe(true);
    const day = task("提出", { due_on: "2030-01-10" });
    expect(tasksForDay([timed, day], "2030-01-10").map((t) => t.title)).toEqual(["提出", "会議"]);
    const chip = taskChip({ id: timed.id, kind: "task", status: "todo", assignee_ids: [], due_on: "2030-01-10", due_at: timed.due_at, owner_id: "u" }, () => null, "2030-01-01");
    expect(chip.text).toBe("タスク · 未着手 · 1/10 14:00 まで");
    expect(taskNoticeText({ kind: "due", data: { task_id: "t", channel_id: null, channel_name: null, title: "会議", due_at: "2030-01-10T05:00:00Z" } }, () => null).body).toBe("14:00 が期限: 会議");
  });

  it("the dialog sends a due time with the device's offset, drops it, or moves the date", () => {
    const plain = task("a", { due_on: "2030-01-10" });
    const draft = { ...draftFromTask(plain), dueTime: "14:30" };
    expect(taskPatch(plain, draft, "Asia/Tokyo")).toEqual({ due_at: "2030-01-10T14:30:00+09:00", tz: "Asia/Tokyo" });
    const timed = task("b", { due_on: "2030-01-10", due_at: "2030-01-10T05:30:00Z", due_tz: "Asia/Tokyo" });
    const same = draftFromTask(timed);
    expect(same.dueTime).toBe("14:30");
    expect(taskPatch(timed, same, "Asia/Tokyo")).toEqual({});
    expect(taskPatch(timed, { ...same, dueTime: "" }, "Asia/Tokyo")).toEqual({ due_at: null });
    expect(taskPatch(timed, { ...same, dueOn: "", dueTime: "" }, "Asia/Tokyo")).toEqual({ due_on: null, tz: "Asia/Tokyo" });
  });
});

describe("repeats and subtasks in the dialog", () => {
  it("creates with a rule, a time and a checklist (blank items left out)", () => {
    const draft = {
      title: "週報",
      notes: "",
      status: "todo" as const,
      dueOn: "2030-01-07",
      ...emptyExtras("2030-01-07"),
      dueTime: "09:00",
      repeat: { ...noRepeat("2030-01-07"), kind: "weekly" as const },
      subtasks: [
        { id: null, title: " まとめる ", done: false },
        { id: null, title: "  ", done: false },
      ],
      assigneeIds: [],
    };
    const body = taskCreateBody(draft, undefined, "me", "k", "Asia/Tokyo");
    expect(body).toMatchObject({ due_on: "2030-01-07", due_at: "2030-01-07T09:00:00+09:00", rrule: "FREQ=WEEKLY;BYDAY=MO", subtasks: [{ title: "まとめる", done: false }] });
    expect(taskDraftProblem({ ...draft, dueOn: "" })).toBe("繰り返すには期限を入れてください");
  });

  it("patches the rule and the list only when they changed", () => {
    const t = task("a", { due_on: "2030-01-07", rrule: "FREQ=WEEKLY", subtasks: [{ id: "s1", title: "x", done: false }] });
    const draft = draftFromTask(t);
    expect(taskPatch(t, draft, "Asia/Tokyo")).toEqual({});
    expect(taskPatch(t, { ...draft, repeat: noRepeat("2030-01-07") }, "Asia/Tokyo")).toEqual({ rrule: null });
    const list = taskPatch(t, { ...draft, subtasks: [...draft.subtasks!, { id: null, title: "y", done: true }] }, "Asia/Tokyo");
    expect(list).toEqual({ subtasks: [{ id: "s1", title: "x", done: false }, { title: "y", done: true }] });
    expect(subtaskProgress(t)).toEqual({ done: 0, total: 1 });
    expect(subtaskProgress(task("none"))).toBeNull();
    // Dropping the due date of a repeating task stops it too.
    expect(taskPatch(t, { ...draft, dueOn: "" }, "Asia/Tokyo")).toMatchObject({ due_on: null, rrule: null });
  });

  it("the weekday seeded from the old date follows a new due date; one the reader picked stays (v0.1.21 check)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T10:00:00+09:00")); // a Saturday
    try {
      // A new task: the draft was seeded from today (Saturday), the due date picked is a Sunday.
      const seeded = emptyExtras("").repeat!;
      expect(seeded.weekdays).toEqual([6]);
      const moved = repeatForDue(seeded, "", "2026-10-04")!;
      expect(moved.weekdays).toEqual([0]);
      expect(taskCreateBody({ title: "発注", notes: "", status: "todo", dueOn: "2026-10-04", ...emptyExtras(""), repeat: { ...moved, kind: "weekly" }, assigneeIds: [] }, undefined, "me", "k", "Asia/Tokyo"))
        .toMatchObject({ rrule: "FREQ=WEEKLY;BYDAY=SU" });
      // Moving the date again (Sunday → Wednesday) follows too; a chosen weekday or several stay.
      expect(repeatForDue({ ...moved, kind: "weekly" }, "2026-10-04", "2026-10-07")!.weekdays).toEqual([3]);
      expect(repeatForDue({ ...moved, kind: "weekly", weekdays: [2] }, "2026-10-04", "2026-10-07")!.weekdays).toEqual([2]);
      expect(repeatForDue({ ...moved, kind: "weekly", weekdays: [0, 3] }, "2026-10-04", "2026-10-07")!.weekdays).toEqual([0, 3]);
      // Cleared date, same date, no repeat: unchanged.
      expect(repeatForDue(moved, "2026-10-04", "")).toBe(moved);
      expect(repeatForDue(moved, "2026-10-04", "2026-10-04")).toBe(moved);
      expect(repeatForDue(undefined, "", "2026-10-04")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

function data(t: TaskOut) {
  const { can_delete: _, ...rest } = t;
  return rest;
}

const serverColumns: TaskColumnOut[] = columns.map((c) => ({ ...c, channel_id: "c-lab" }));

function setup(extra: Partial<Record<keyof TaskApi, unknown>> = {}, board: TaskOut[] = []) {
  const api = {
    listTasks: vi.fn(async () => board),
    myTasks: vi.fn(async () => []),
    dueTasks: vi.fn(async () => []),
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    moveTask: vi.fn(async (id: string, body: { status?: string; column_id?: string }) => ({ ...board.find((t) => t.id === id)!, status: body.status ?? "doing", column_id: body.column_id ?? null, updated_at: "2026-10-03T00:00:00Z" })),
    deleteTask: vi.fn(),
    listTaskColumns: vi.fn(async () => serverColumns),
    createTaskColumn: vi.fn(async () => serverColumns[2]),
    updateTaskColumn: vi.fn(async () => serverColumns[2]),
    deleteTaskColumn: vi.fn(async () => {}),
    updateSubtask: vi.fn(),
    ...extra,
  };
  const hub = new TaskHub({ api: api as unknown as TaskApi, me: () => "u-me" });
  return { api, hub };
}

describe("the hub's columns", () => {
  it("reads a board's columns with it; task.columns.updated replaces them", async () => {
    const { hub } = setup();
    await hub.openBoard("c-lab");
    expect(hub.board("c-lab")?.columns.map((c) => c.id)).toEqual(["col-todo", "col-doing", "col-review", "col-done"]);
    expect(hub.board("c-lab")?.columnsSupported).toBe(true);
    hub.applyEvent("task.columns.updated", { channel_id: "c-lab", columns: [serverColumns[3], serverColumns[0]] });
    expect(hub.board("c-lab")?.columns.map((c) => c.id)).toEqual(["col-todo", "col-done"]);
  });

  it("a server before M81 (no route: 404 / 422) leaves the three built-in columns", async () => {
    for (const err of [new ApiError(404, "not_found", "x"), new ApiError(422, "validation_error", "x")]) {
      const { hub } = setup({ listTaskColumns: vi.fn(async () => Promise.reject(err)) });
      await hub.openBoard("c-lab");
      expect(hub.board("c-lab")).toMatchObject({ state: "ready", columnsSupported: false });
      expect(hub.board("c-lab")?.columns.map((c) => c.id)).toEqual(["todo", "doing", "done"]);
    }
  });

  it("a move into a column sends column_id; a fallback column sends the status", async () => {
    const a = task("a");
    const { hub, api } = setup({}, [a]);
    await hub.openBoard("c-lab");
    await hub.move(a.id, "doing", { after_id: null, before_id: null }, columns[2]);
    expect(api.moveTask).toHaveBeenLastCalledWith(a.id, { column_id: "col-review", after_id: null, before_id: null });
    await hub.move(a.id, "done", { after_id: null, before_id: null }, FALLBACK_COLUMNS[2]);
    expect(api.moveTask).toHaveBeenLastCalledWith(a.id, { status: "done", after_id: null, before_id: null });
  });

  it("a subtask's checkbox shows at once and goes back when refused", async () => {
    const a = task("a", { subtasks: [{ id: "s1", title: "x", done: false }] });
    const refuse = vi.fn(async () => Promise.reject(new ApiError(409, "channel_archived", "x")));
    const { hub } = setup({ updateSubtask: refuse }, [a]);
    await hub.openBoard("c-lab");
    hub.applyEvent("task.updated", { task: data(a), deleter_ids: [] });
    const pending = hub.toggleSubtask(a.id, "s1", true);
    expect(hub.find(a.id)?.subtasks?.[0]?.done).toBe(true);
    await expect(pending).rejects.toThrow();
    expect(hub.find(a.id)?.subtasks?.[0]?.done).toBe(false);
  });
});
