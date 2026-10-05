// M55 (TASKS.md): the tasks' pure rules — order, where a dropped card lands, the optimistic move, events, due dates,
// who may edit, 「自分のタスク」's groups, the dialog's patch, 「タスクにする」's prefill, the notifications' wording.
process.env.TZ = "Asia/Tokyo";

import { describe, expect, it } from "vitest";

import type { ChannelOut, UserPublic } from "../src/api/types";
import { Store } from "../src/sync/store";
import {
  applyLocalMove,
  canEditBoard,
  canEditTask,
  computeNeighbors,
  draftFromTask,
  dueLabel,
  filterTasks,
  groupMineByChannel,
  isMine,
  isNoopMove,
  isOverdue,
  messageTaskInit,
  moveWithin,
  removeTask,
  sortColumn,
  sourceState,
  splitOpenDone,
  taskDraftProblem,
  taskFromEvent,
  taskNoticeText,
  taskPatch,
  tasksForDay,
  upsertTask,
} from "../src/ui/tasks";
import { task } from "./taskFixtures";

const ids = (list: { id: string }[]) => list.map((t) => t.id);

describe("a column's order", () => {
  it("is the server's position, then id — never the order held", () => {
    const a = task("a", { position: 2, id: "b-id" });
    const b = task("b", { position: 1 });
    const c = task("c", { position: 2, id: "a-id" });
    const d = task("d", { position: 0, status: "done" });
    expect(ids(sortColumn([a, b, c, d], "todo"))).toEqual([b.id, "a-id", "b-id"]);
    expect(ids(sortColumn([a, b, c, d], "done"))).toEqual([d.id]);
  });
});

describe("where a dropped card lands (after_id = the card above, before_id = the card below)", () => {
  const column = [task("1"), task("2"), task("3")];
  const [one, two, three] = column as [ReturnType<typeof task>, ReturnType<typeof task>, ReturnType<typeof task>];

  it("from another column: top, middle, bottom", () => {
    expect(computeNeighbors(column, "x", 0)).toEqual({ after_id: null, before_id: one.id });
    expect(computeNeighbors(column, "x", 1)).toEqual({ after_id: one.id, before_id: two.id });
    expect(computeNeighbors(column, "x", 3)).toEqual({ after_id: three.id, before_id: null });
  });

  it("into an empty column: neither", () => {
    expect(computeNeighbors([], "x", 0)).toEqual({ after_id: null, before_id: null });
  });

  it("within its column: the card itself is not a neighbour", () => {
    // 1 dragged under 2 (slot 2): between 2 and 3.
    expect(computeNeighbors(column, one.id, 2)).toEqual({ after_id: two.id, before_id: three.id });
    // 3 dragged to the top.
    expect(computeNeighbors(column, three.id, 0)).toEqual({ after_id: null, before_id: one.id });
    // 1 dragged to the bottom.
    expect(computeNeighbors(column, one.id, 3)).toEqual({ after_id: three.id, before_id: null });
    expect(isNoopMove(column, two.id, 1)).toBe(true);
    expect(isNoopMove(column, two.id, 2)).toBe(true);
    expect(isNoopMove(column, two.id, 3)).toBe(false);
  });

  it("上へ / 下へ: one place, nothing past the ends", () => {
    expect(moveWithin(column, two.id, -1)).toEqual({ after_id: null, before_id: one.id });
    expect(moveWithin(column, two.id, 1)).toEqual({ after_id: three.id, before_id: null });
    expect(moveWithin(column, one.id, 1)).toEqual({ after_id: two.id, before_id: three.id });
    expect(moveWithin(column, one.id, -1)).toBeNull();
    expect(moveWithin(column, three.id, 1)).toBeNull();
  });
});

describe("the optimistic move", () => {
  it("guesses a position between the neighbours, past one, or at the column's end (done: its top)", () => {
    const a = task("a", { position: 1 });
    const b = task("b", { position: 2 });
    const c = task("c", { position: 3, status: "doing" });
    const d = task("d", { position: 5, status: "done" });
    const all = [a, b, c, d];
    const between = applyLocalMove(all, c.id, "todo", { after_id: a.id, before_id: b.id });
    expect(ids(sortColumn(between, "todo"))).toEqual([a.id, c.id, b.id]);
    expect(between.find((t) => t.id === c.id)?.status).toBe("todo");
    const top = applyLocalMove(all, b.id, "todo", { after_id: null, before_id: a.id });
    expect(ids(sortColumn(top, "todo"))).toEqual([b.id, a.id]);
    const bottom = applyLocalMove(all, a.id, "doing", { after_id: null, before_id: null });
    expect(ids(sortColumn(bottom, "doing"))).toEqual([c.id, a.id]);
    const done = applyLocalMove(all, a.id, "done", { after_id: null, before_id: null }, "2026-10-01T03:00:00Z", "u-me");
    expect(ids(sortColumn(done, "done"))).toEqual([a.id, d.id]);
    expect(done.find((t) => t.id === a.id)).toMatchObject({ completed_at: "2026-10-01T03:00:00Z", completed_by: "u-me" });
    const back = applyLocalMove(done, d.id, "todo", { after_id: b.id, before_id: null });
    expect(back.find((t) => t.id === d.id)).toMatchObject({ status: "todo", completed_at: null, completed_by: null });
    expect(ids(sortColumn(back, "todo"))).toEqual([b.id, d.id]);
  });
});

describe("events", () => {
  it("upsert replaces or adds, remove drops, can_delete is deleter_ids holding me", () => {
    const a = task("a");
    const list = upsertTask([a], { ...a, title: "A" });
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("A");
    expect(upsertTask(list, task("b"))).toHaveLength(2);
    expect(removeTask(list, a.id)).toEqual([]);
    const { can_delete: _, ...data } = a;
    expect(taskFromEvent(data, ["u-me"], "u-me").can_delete).toBe(true);
    expect(taskFromEvent(data, ["u-other"], "u-me").can_delete).toBe(false);
  });

  it("「自分のタスク」 holds personal ones and those assigned to me", () => {
    expect(isMine(task("p", { channel_id: null }), "u-me")).toBe(true);
    expect(isMine(task("s", { assignee_ids: ["u-me"] }), "u-me")).toBe(true);
    expect(isMine(task("s", { assignee_ids: ["u-other"] }), "u-me")).toBe(false);
  });
});

describe("due dates", () => {
  it("overdue only when past and not done; 「今日」, M/D, and the year when not this one", () => {
    expect(isOverdue(task("a", { due_on: "2026-09-30" }), "2026-10-01")).toBe(true);
    expect(isOverdue(task("a", { due_on: "2026-09-30", status: "done" }), "2026-10-01")).toBe(false);
    expect(isOverdue(task("a", { due_on: "2026-10-01" }), "2026-10-01")).toBe(false);
    expect(isOverdue(task("a"), "2026-10-01")).toBe(false);
    expect(dueLabel("2026-10-01", "2026-10-01")).toBe("今日");
    expect(dueLabel("2026-10-05", "2026-10-01")).toBe("10/5");
    expect(dueLabel("2027-01-05", "2026-10-01")).toBe("2027/1/5");
  });

  it("a day's tasks: open ones first", () => {
    const a = task("b-open", { due_on: "2026-10-05" });
    const b = task("a-done", { due_on: "2026-10-05", status: "done" });
    const c = task("c", { due_on: "2026-10-06" });
    expect(ids(tasksForDay([b, a, c], "2026-10-05"))).toEqual([a.id, b.id]);
  });
});

function channel(id: string, extra: Partial<ChannelOut> = {}): ChannelOut {
  return { id, type: "public", name: id, topic: null, purpose: null, archived: false, created_at: "2026-01-01T00:00:00Z", last_seq: 0, posting_policy: "everyone", ...extra } as ChannelOut;
}

describe("who may edit a board (the composer's rule)", () => {
  it("members of a public or private channel that is not archived, owners and admins in an announcement one", () => {
    const store = new Store();
    store.upsertChannel(channel("lab"), { isMember: true, membership: { role: "member" } as never });
    store.upsertChannel(channel("news", { posting_policy: "owners" }), { isMember: true, membership: { role: "member" } as never });
    store.upsertChannel(channel("own", { posting_policy: "owners" }), { isMember: true, membership: { role: "owner" } as never });
    store.upsertChannel(channel("old", { archived: true }), { isMember: true, membership: { role: "member" } as never });
    store.upsertChannel(channel("dm", { type: "dm", name: null }), { isMember: true });
    store.upsertChannel(channel("other"), { isMember: false });
    const can = (id: string, admin = false) => canEditBoard(store.getChannel(id), admin);
    expect([can("lab"), can("news"), can("own"), can("old"), can("dm"), can("other"), can("gone")]).toEqual([true, false, true, false, false, false, false]);
    expect(can("news", true)).toBe(true);
    // A personal task is always mine to change.
    expect(canEditTask(task("p", { channel_id: null }), undefined, false)).toBe(true);
    expect(canEditTask(task("s", { channel_id: "news" }), store.getChannel("news"), false)).toBe(false);
  });
});

describe("「自分のタスク」", () => {
  it("personal ones apart, the assigned ones by channel (by name), open ones by status then order, done ones newest first", () => {
    const p1 = task("p1", { channel_id: null, channel_name: null, status: "doing", position: 1 });
    const p2 = task("p2", { channel_id: null, channel_name: null, status: "todo", position: 9 });
    const p3 = task("p3", { channel_id: null, channel_name: null, status: "done", completed_at: "2026-09-01T00:00:00Z" });
    const p4 = task("p4", { channel_id: null, channel_name: null, status: "done", completed_at: "2026-09-20T00:00:00Z" });
    const s1 = task("s1", { channel_id: "c-zoo", channel_name: "zoo", assignee_ids: ["u-me"] });
    const s2 = task("s2", { channel_id: "c-lab", channel_name: "lab", assignee_ids: ["u-me", "u-other"] });
    const s3 = task("s3", { channel_id: "c-lab", channel_name: "lab", assignee_ids: ["u-other"] });
    const { personal, groups } = groupMineByChannel([s1, p1, s2, p2, s3, p3, p4], "u-me");
    expect(ids(personal)).toEqual([p1.id, p2.id, p3.id, p4.id]);
    expect(groups.map((g) => [g.channelName, ids(g.tasks)])).toEqual([["lab", [s2.id]], ["zoo", [s1.id]]]);
    const { open, done } = splitOpenDone(personal);
    expect(ids(open)).toEqual([p2.id, p1.id]);
    expect(ids(done)).toEqual([p4.id, p3.id]);
  });
});

describe("the dialog", () => {
  it("sends only what changed (the title as the server keeps it; tz with a new due date; assignees replaced)", () => {
    const t = task("資料", { notes: "メモ", due_on: "2026-10-05", assignee_ids: ["u-a"] });
    const draft = draftFromTask(t);
    expect(taskPatch(t, draft, "Asia/Tokyo")).toEqual({});
    expect(taskPatch(t, { ...draft, title: "  資料  を 作る " }, "Asia/Tokyo")).toEqual({ title: "資料 を 作る" });
    expect(taskPatch(t, { ...draft, notes: "  " }, "Asia/Tokyo")).toEqual({ notes: null });
    expect(taskPatch(t, { ...draft, dueOn: "" }, "Asia/Tokyo")).toEqual({ due_on: null, tz: "Asia/Tokyo" });
    expect(taskPatch(t, { ...draft, status: "done", assigneeIds: ["u-b", "u-a"] }, "Asia/Tokyo")).toEqual({ status: "done", assignee_ids: ["u-a", "u-b"] });
    // A personal task has no assignees to send.
    const p = task("p", { channel_id: null });
    expect(taskPatch(p, { ...draftFromTask(p), assigneeIds: ["u-a"] }, "Asia/Tokyo")).toEqual({});
    expect(taskDraftProblem({ ...draft, title: "   " })).toBe("題名を入れてください");
    expect(taskDraftProblem(draft)).toBeNull();
  });

  it("the source: a link while the message exists, 「削除されました」 once gone", () => {
    expect(sourceState(task("a"))).toEqual({ kind: "none" });
    expect(sourceState(task("a", { source: { message_id: "m1", channel_id: "c-lab", excerpt: "抜粋" } }))).toEqual({ kind: "link", messageId: "m1", excerpt: "抜粋" });
    expect(sourceState(task("a", { source: { message_id: "m1", channel_id: "c-lab", excerpt: null } }))).toEqual({ kind: "link", messageId: "m1", excerpt: null });
    expect(sourceState(task("a", { source: { message_id: null, channel_id: "c-lab", excerpt: null } }))).toEqual({ kind: "deleted" });
  });
});

describe("「タスクにする」", () => {
  const users = new Map<string, UserPublic>([["0b0b0b0b-0000-4000-8000-000000000001", { id: "0b0b0b0b-0000-4000-8000-000000000001", display_name: "ボブ", username: "bob" } as UserPublic]]);

  it("a channel message: its one-line text as the title, its board (switchable to mine)", () => {
    const store = new Store();
    store.upsertChannel(channel("lab"), { isMember: true, membership: { role: "member" } as never });
    const init = messageTaskInit({ id: "m1", body: "**明日** までに\n<@0b0b0b0b-0000-4000-8000-000000000001> と資料" }, store.getChannel("lab"), users, new Map(), false);
    expect(init).toMatchObject({ channelId: "lab", title: "明日 までに @ボブ と資料", sourceMessageId: "m1", boardChoices: ["lab"] });
  });

  it("a DM (or a board I may not add to): 「自分のタスク」; a long body is cut to 200", () => {
    const store = new Store();
    store.upsertChannel(channel("dm", { type: "dm", name: null }), { isMember: true });
    store.upsertChannel(channel("news", { posting_policy: "owners" }), { isMember: true, membership: { role: "member" } as never });
    const dm = messageTaskInit({ id: "m1", body: "あ".repeat(300) }, store.getChannel("dm"), users, new Map(), false);
    expect(dm.channelId).toBeNull();
    expect(dm.boardChoices).toEqual([]);
    expect(dm.title.length).toBe(200);
    expect(messageTaskInit({ id: "m2", body: "x" }, store.getChannel("news"), users, new Map(), false).channelId).toBeNull();
    // No text: what the attachments were.
    expect(messageTaskInit({ id: "m3", body: "", attachments: [{ content_type: "image/png" }] }, store.getChannel("dm"), users, new Map(), false).title).toMatch(/画像/);
  });
});

describe("the calendar's filter", () => {
  it("すべて, 自分 (personal and assigned to me), one channel", () => {
    const p = task("p", { channel_id: null });
    const a = task("a", { assignee_ids: ["u-me"] });
    const o = task("o", { channel_id: "c-other" });
    expect(filterTasks([p, a, o], "all", "u-me")).toHaveLength(3);
    expect(ids(filterTasks([p, a, o], "me", "u-me"))).toEqual([p.id, a.id]);
    expect(ids(filterTasks([p, a, o], "c-other", "u-me"))).toEqual([o.id]);
  });
});

describe("notifications while the app is open", () => {
  it("words them like the push", () => {
    const nameOf = (id: string) => (id === "0b0b0b0b-0000-4000-8000-000000000001" ? "ボブ" : null);
    expect(taskNoticeText({ kind: "assigned", data: { task_id: "t1", channel_id: "c-lab", channel_name: "lab", title: "資料", by_user_id: "0b0b0b0b-0000-4000-8000-000000000001" } }, nameOf)).toEqual({
      body: "ボブ がタスクを割り当てました：資料 (#lab)",
      taskId: "t1",
      channelId: "c-lab",
    });
    expect(taskNoticeText({ kind: "due", data: { task_id: "t2", channel_id: null, channel_name: null, title: "買い物" } }, nameOf).body).toBe("今日が期限：買い物");
    expect(taskNoticeText({ kind: "due", data: { task_id: "t3", channel_id: "c-lab", channel_name: "lab", title: "発表" } }, nameOf).body).toBe("今日が期限：発表 (#lab)");
  });
});
