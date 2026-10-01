// M55 (TASKS.md §4): the tasks on this device — windows read from the server, task.* events, the optimistic move and
// its undo, reading again after reconnecting, and the notices of task.assigned / task.due.
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { TaskOut } from "../src/api/types";
import { type TaskApi, TaskHub, type TaskNotice } from "../src/sync/tasks";
import { sortColumn } from "../src/ui/tasks";
import { task } from "./taskFixtures";

function data(t: TaskOut) {
  const { can_delete: _, ...rest } = t;
  return rest;
}

function setup(initial: { board?: TaskOut[]; mine?: TaskOut[]; due?: TaskOut[] } = {}) {
  const api = {
    listTasks: vi.fn(async () => initial.board ?? []),
    myTasks: vi.fn(async () => initial.mine ?? []),
    dueTasks: vi.fn(async () => initial.due ?? []),
    getTask: vi.fn(async (id: string) => task("read", { id })),
    createTask: vi.fn(async (body: { title: string; channel_id?: string | null }) => task(body.title, { channel_id: body.channel_id ?? null })),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    deleteTask: vi.fn(async () => {}),
  };
  const notices: TaskNotice[] = [];
  const hub = new TaskHub({ api: api as unknown as TaskApi, me: () => "u-me", onNotice: (n) => notices.push(n) });
  return { api, hub, notices };
}

describe("the board", () => {
  it("reads a channel's board; task.updated adds and changes, task.deleted removes", async () => {
    const a = task("a", { position: 1 });
    const { hub, api } = setup({ board: [a] });
    await hub.openBoard("c-lab");
    expect(api.listTasks).toHaveBeenCalledWith("c-lab", "recent");
    expect(hub.board("c-lab")?.state).toBe("ready");
    const b = task("b", { position: 2 });
    hub.applyEvent("task.updated", { task: data(b), deleter_ids: ["u-other"] });
    expect(hub.board("c-lab")?.tasks.map((t) => t.title)).toEqual(["a", "b"]);
    expect(hub.find(b.id)?.can_delete).toBe(false);
    hub.applyEvent("task.updated", { task: { ...data(a), title: "A", updated_at: "2026-10-01T01:00:00Z" }, deleter_ids: ["u-me"] });
    expect(hub.find(a.id)).toMatchObject({ title: "A", can_delete: true });
    hub.applyEvent("task.deleted", { id: a.id, channel_id: "c-lab" });
    expect(hub.board("c-lab")?.tasks.map((t) => t.title)).toEqual(["b"]);
    // Another channel's task: not on this board.
    hub.applyEvent("task.updated", { task: data(task("x", { channel_id: "c-other" })), deleter_ids: [] });
    expect(hub.board("c-lab")?.tasks).toHaveLength(1);
  });

  it("a renumbered column arrives card by card; the order follows the positions", async () => {
    const [a, b, c] = [task("a", { position: 1 }), task("b", { position: 1.0000001 }), task("c", { position: 1.0000002 })];
    const { hub } = setup({ board: [a, b, c] });
    await hub.openBoard("c-lab");
    const later = "2026-10-01T02:00:00Z";
    hub.applyEvent("task.updated", { task: { ...data(c), position: 1024, updated_at: later }, deleter_ids: [] });
    hub.applyEvent("task.updated", { task: { ...data(a), position: 2048, updated_at: later }, deleter_ids: [] });
    hub.applyEvent("task.updated", { task: { ...data(b), position: 3072, updated_at: later }, deleter_ids: [] });
    expect(sortColumn(hub.board("c-lab")!.tasks, "todo").map((t) => t.title)).toEqual(["c", "a", "b"]);
    // An older copy (a late answer) does not undo a newer one.
    hub.put({ ...a, position: 0 });
    expect(sortColumn(hub.board("c-lab")!.tasks, "todo").map((t) => t.title)).toEqual(["c", "a", "b"]);
  });

  it("「完了をすべて表示」 reads with include_done=all; reconnecting reads every open window again", async () => {
    const { hub, api } = setup();
    await hub.openBoard("c-lab");
    await hub.openBoard("c-lab", true);
    expect(api.listTasks).toHaveBeenLastCalledWith("c-lab", "all");
    await hub.openMine();
    await hub.openDue("calendar", "2026-09-27", "2026-11-01");
    api.listTasks.mockClear();
    hub.online();
    await Promise.resolve();
    expect(api.listTasks).toHaveBeenCalledWith("c-lab", "all");
    expect(api.myTasks).toHaveBeenCalledTimes(2);
    expect(api.dueTasks).toHaveBeenLastCalledWith("2026-09-27", "2026-11-01");
  });

  it("a server before M55: unsupported", async () => {
    const { hub, api } = setup();
    api.listTasks.mockRejectedValueOnce(new ApiError(404, "not_found", "Not Found"));
    await hub.openBoard("c-lab");
    expect(hub.board("c-lab")?.state).toBe("unsupported");
  });
});

describe("moving", () => {
  it("shows the move at once, then the server's place", async () => {
    const [a, b] = [task("a", { position: 1 }), task("b", { position: 2 })];
    const { hub, api } = setup({ board: [a, b] });
    await hub.openBoard("c-lab");
    let answer!: (t: TaskOut) => void;
    api.moveTask.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const moving = hub.move(b.id, "todo", { after_id: null, before_id: a.id });
    expect(api.moveTask).toHaveBeenCalledWith(b.id, { status: "todo", after_id: null, before_id: a.id });
    expect(sortColumn(hub.board("c-lab")!.tasks, "todo").map((t) => t.title)).toEqual(["b", "a"]); // at once
    answer({ ...b, position: 0.5, updated_at: "2026-10-01T05:00:00Z" });
    await moving;
    expect(hub.find(b.id)?.position).toBe(0.5);
  });

  it("puts the card back when the server refuses", async () => {
    const a = task("a", { position: 1 });
    const { hub, api } = setup({ board: [a] });
    await hub.openBoard("c-lab");
    api.moveTask.mockRejectedValueOnce(new ApiError(403, "posting_restricted", "no"));
    await expect(hub.move(a.id, "doing", { after_id: null, before_id: null })).rejects.toThrow();
    expect(hub.find(a.id)).toMatchObject({ status: "todo", position: 1 });
  });
});

describe("「自分のタスク」 and the calendar", () => {
  it("keeps what is personal or assigned to me, and drops a task once it is not", async () => {
    const mine = task("mine", { assignee_ids: ["u-me"] });
    const { hub } = setup({ mine: [mine] });
    await hub.openMine();
    hub.applyEvent("task.updated", { task: { ...data(mine), assignee_ids: ["u-other"], updated_at: "2026-10-02T00:00:00Z" }, deleter_ids: [] });
    expect(hub.mineList()?.tasks).toEqual([]);
    hub.applyEvent("task.updated", { task: data(task("p", { channel_id: null })), deleter_ids: ["u-me"] });
    hub.applyEvent("task.updated", { task: data(task("theirs", { assignee_ids: ["u-other"] })), deleter_ids: [] });
    expect(hub.mineList()?.tasks.map((t) => t.title)).toEqual(["p"]);
  });

  it("a calendar range holds the tasks due in it ([from, to)): in when due there, out when not", async () => {
    const t = task("t", { due_on: "2026-10-05" });
    const { hub } = setup({ due: [t] });
    await hub.openDue("calendar", "2026-10-01", "2026-10-08");
    hub.applyEvent("task.updated", { task: { ...data(t), due_on: "2026-10-08", updated_at: "2026-10-02T00:00:00Z" }, deleter_ids: [] });
    expect(hub.dueWindow("calendar")?.tasks).toEqual([]);
    hub.applyEvent("task.updated", { task: data(task("n", { due_on: "2026-10-07" })), deleter_ids: [] });
    hub.applyEvent("task.updated", { task: data(task("none")), deleter_ids: [] });
    expect(hub.dueWindow("calendar")?.tasks.map((x) => x.title)).toEqual(["n"]);
  });

  it("leaving a channel takes its tasks off every window", async () => {
    const { hub } = setup({ board: [task("a")], mine: [task("m", { assignee_ids: ["u-me"] }), task("p", { channel_id: null })] });
    await hub.openBoard("c-lab");
    await hub.openMine();
    hub.removeChannel("c-lab");
    expect(hub.board("c-lab")).toBeUndefined();
    expect(hub.mineList()?.tasks.map((t) => t.title)).toEqual(["p"]);
  });
});

describe("notices", () => {
  it("task.assigned and task.due go to the app (it shows them while open)", () => {
    const { hub, notices } = setup();
    hub.applyEvent("task.assigned", { task_id: "t1", channel_id: "c-lab", channel_name: "lab", title: "資料", by_user_id: "u-bob" });
    hub.applyEvent("task.due", { task_id: "t2", channel_id: null, channel_name: null, title: "買い物", due_on: "2026-10-01" });
    expect(notices.map((n) => n.kind)).toEqual(["assigned", "due"]);
  });
});
