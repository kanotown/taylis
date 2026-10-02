// @vitest-environment jsdom
// M81 (TASKS.md §11.6): the board's added columns (列を追加, the column's ⋯), the cards' time / progress / 🔁, and the
// dialog's time, 繰り返し and サブタスク.
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelOut, TaskColumnOut, TaskOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { type TaskApi, TaskHub } from "../src/sync/tasks";
import { ChannelTasks } from "../src/ui/TaskBoard";
import { TaskDialog } from "../src/ui/TaskDialog";
import { task } from "./taskFixtures";

afterEach(() => {
  cleanup();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const ME = "11111111-1111-4111-8111-111111111111";
const columns: TaskColumnOut[] = [
  { id: "col-todo", channel_id: "c-lab", name: "未着手", status: "todo", builtin: true, position: 1 },
  { id: "col-doing", channel_id: "c-lab", name: "進行中", status: "doing", builtin: true, position: 2 },
  { id: "col-review", channel_id: "c-lab", name: "レビュー待ち", status: "doing", builtin: false, position: 2.5 },
  { id: "col-done", channel_id: "c-lab", name: "完了", status: "done", builtin: true, position: 3 },
];

function setup(board: TaskOut[]) {
  const store = new Store();
  store.setMe({ id: ME, username: "me", display_name: "わたし", notify_tasks: true } as unknown as UserMe);
  store.upsertUser({ id: ME, username: "me", display_name: "わたし" } as UserPublic);
  store.upsertChannel({ id: "c-lab", type: "public", name: "lab", archived: false, posting_policy: "everyone", last_seq: 0, created_at: "2026-01-01T00:00:00Z" } as ChannelOut, { isMember: true, membership: { role: "member" } as never });
  const api = {
    listTasks: vi.fn(async () => board),
    myTasks: vi.fn(async () => []),
    dueTasks: vi.fn(async () => []),
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(async (id: string, patch: Partial<TaskOut>) => ({ ...hub.find(id)!, ...patch, updated_at: "2026-10-03T00:00:00Z" })),
    moveTask: vi.fn(),
    deleteTask: vi.fn(),
    listTaskColumns: vi.fn(async () => columns),
    createTaskColumn: vi.fn(async () => columns[2]),
    updateTaskColumn: vi.fn(async () => columns[2]),
    deleteTaskColumn: vi.fn(async () => {}),
    updateSubtask: vi.fn(async (id: string, sid: string, patch: { done: boolean }) => ({ ...hub.find(id)!, subtasks: hub.find(id)!.subtasks!.map((i) => (i.id === sid ? { ...i, done: patch.done } : i)), updated_at: "2026-10-03T00:00:00Z" })),
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

const column = (id: string) => document.querySelector(`[data-column="${id}"]`) as HTMLElement;

describe("the board's columns", () => {
  it("shows the added column with its cards, the cards' time, progress and 🔁", async () => {
    const a = task("原稿", { status: "doing", column_id: "col-review", due_on: "2030-01-10", due_at: "2030-01-10T05:00:00Z", due_tz: "Asia/Tokyo", subtasks: [{ id: "s1", title: "x", done: true }, { id: "s2", title: "y", done: false }] });
    const b = task("図", { status: "doing", rrule: "FREQ=WEEKLY", due_on: "2030-01-10" });
    const { controller } = setup([a, b]);
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    const names = [...document.querySelectorAll("[data-column-name]")].map((e) => e.textContent);
    expect(names).toEqual(["未着手", "進行中", "レビュー待ち", "完了"]);
    expect(within(column("col-review")).getByText("原稿")).toBeTruthy();
    expect(within(column("doing")).getByText("図")).toBeTruthy();
    const card = document.querySelector(`[data-task-card="${a.id}"]`) as HTMLElement;
    expect(card.querySelector("[data-due]")?.textContent).toContain("1/10 14:00");
    expect(card.querySelector("[data-subtasks]")?.getAttribute("data-subtasks")).toBe("1/2");
    expect(document.querySelector(`[data-task-card="${b.id}"] [data-repeat]`)).toBeTruthy();
    expect(screen.getByRole("button", { name: /列を追加/ })).toBeTruthy();
  });

  it("「列を追加」 sends a name and a kind", async () => {
    const { controller, api } = setup([]);
    render(<ChannelTasks controller={controller} channel={controller.store.getChannel("c-lab")!} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /列を追加/ }));
    fireEvent.change(screen.getByLabelText("名前"), { target: { value: " 見送り " } });
    fireEvent.click(screen.getByLabelText(/完了 \(カードは完了になる\)/));
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await flush();
    expect(api.createTaskColumn).toHaveBeenCalledWith({ channel_id: "c-lab", name: "見送り", status: "done" });
  });
});

describe("the dialog's extras", () => {
  it("a time beside the due date, 繰り返し once dated, and a checklist whose checkbox goes at once", async () => {
    const a = task("報告", { due_on: "2030-01-10", subtasks: [{ id: "s1", title: "集計", done: false }] });
    const { controller, api, hub } = setup([a]);
    await hub.openBoard("c-lab");
    render(<TaskDialog controller={controller} task={a} onClose={() => {}} />);
    expect(screen.getByLabelText("期限の時刻")).toBeTruthy();
    expect(document.querySelector("[data-task-repeat]")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("「集計」を完了"));
    await flush();
    expect(api.updateSubtask).toHaveBeenCalledWith(a.id, "s1", { done: true });
    fireEvent.change(screen.getByLabelText("期限の時刻"), { target: { value: "09:30" } });
    fireEvent.change(screen.getByLabelText("サブタスクを追加"), { target: { value: "送る" } });
    fireEvent.keyDown(screen.getByLabelText("サブタスクを追加"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect(api.updateTask).toHaveBeenCalledWith(a.id, {
      due_at: "2030-01-10T09:30:00+09:00",
      tz: expect.any(String),
      subtasks: [{ id: "s1", title: "集計", done: true }, { title: "送る", done: false }],
    });
  });
});
