/**
 * M55 (TASKS.md): the tasks' pure rules — the columns' order, where a dropped card lands (its neighbours for
 * POST /tasks/{id}/move), the optimistic move, the event reducer, due dates, who may edit a board, and the groups of
 * 「自分のタスク」. No store, no React: the hub (sync/tasks.ts) and the screens share them, and the tests read them.
 */
import type { GroupOut, TaskData, TaskOut, TaskStatus, TaskUpdate, UserPublic } from "../api/types";
import type { ChannelState } from "../sync/types";
import { canPostTopLevel } from "./channels";
import { type DayKey, parseDay } from "./calendarDates";
import { attachmentText, plainText } from "./markdown";
import { mentionsToNames } from "./mentions";

export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "doing", "done"];
export const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = { todo: "未着手", doing: "進行中", done: "完了" };
export const MAX_TASK_TITLE = 200;
export const MAX_TASK_NOTES = 4000;
/** A board brings this many completed cards (then 「完了をすべて表示」 reads them all). */
export const BOARD_DONE_LIMIT = 100;
/** Avatars on a card before 「+N」. */
export const CARD_AVATARS = 3;

/** The server's order inside a column: position, then id. */
export function compareTasks(a: Pick<TaskOut, "position" | "id">, b: Pick<TaskOut, "position" | "id">): number {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** One column of a board, in the server's order (never a local index: the server may renumber). */
export function sortColumn<T extends Pick<TaskOut, "status" | "position" | "id">>(tasks: readonly T[], status: TaskStatus): T[] {
  return tasks.filter((t) => t.status === status).sort(compareTasks);
}

export interface Neighbors {
  after_id: string | null;
  before_id: string | null;
}

/**
 * Where a card dropped into slot `dropIndex` of `column` lands: the card ending up directly above (after_id) and
 * directly below (before_id). `column` is the target column as shown (it may hold the dragged card itself: a move
 * within the column), and `dropIndex` a slot of it, 0 (over the first card) to column.length (under the last).
 */
export function computeNeighbors(column: readonly Pick<TaskOut, "id">[], draggedId: string, dropIndex: number): Neighbors {
  const from = column.findIndex((t) => t.id === draggedId);
  const rest = column.filter((t) => t.id !== draggedId);
  let index = Math.max(0, Math.min(dropIndex, column.length));
  if (from >= 0 && from < index) index -= 1;
  index = Math.min(index, rest.length);
  return { after_id: rest[index - 1]?.id ?? null, before_id: rest[index]?.id ?? null };
}

/** The drop changes nothing (the card back where it was). */
export function isNoopMove(column: readonly Pick<TaskOut, "id">[], draggedId: string, dropIndex: number): boolean {
  const from = column.findIndex((t) => t.id === draggedId);
  return from >= 0 && (dropIndex === from || dropIndex === from + 1);
}

/** 「上へ」 / 「下へ」 within its column: the neighbours one place up or down (null at the top / bottom). */
export function moveWithin(column: readonly Pick<TaskOut, "id">[], taskId: string, direction: -1 | 1): Neighbors | null {
  const from = column.findIndex((t) => t.id === taskId);
  if (from < 0) return null;
  const to = from + direction;
  if (to < 0 || to >= column.length) return null;
  // Up: into the slot over the card above; down: into the slot under the card below.
  return computeNeighbors(column, taskId, direction < 0 ? to : to + 1);
}

/**
 * The position a move would get here (the optimistic guess; the server's answer replaces it): between the neighbours,
 * else past the one given, else the bottom of todo / doing and the top of done (the server's rule without neighbours).
 */
export function guessPosition(tasks: readonly TaskOut[], taskId: string, status: TaskStatus, neighbors: Neighbors): number {
  const column = sortColumn(tasks, status).filter((t) => t.id !== taskId);
  const above = column.find((t) => t.id === neighbors.after_id);
  const below = column.find((t) => t.id === neighbors.before_id);
  if (above && below) return (above.position + below.position) / 2;
  if (above) {
    const next = column[column.indexOf(above) + 1];
    return next ? (above.position + next.position) / 2 : above.position + 1;
  }
  if (below) {
    const previous = column[column.indexOf(below) - 1];
    return previous ? (previous.position + below.position) / 2 : below.position - 1;
  }
  if (column.length === 0) return 0;
  return status === "done" ? column[0]!.position - 1 : column[column.length - 1]!.position + 1;
}

/** The optimistic move: the card in its new column at its guessed position (completion as the server would set it). */
export function applyLocalMove(tasks: readonly TaskOut[], taskId: string, status: TaskStatus, neighbors: Neighbors, now: string = new Date().toISOString(), me: string | null = null): TaskOut[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return [...tasks];
  const position = guessPosition(tasks, taskId, status, neighbors);
  const completion =
    status === task.status ? {} : status === "done" ? { completed_at: now, completed_by: me } : { completed_at: null, completed_by: null };
  return tasks.map((t) => (t.id === taskId ? { ...t, status, position, ...completion } : t));
}

/** A task as it is now (an event, an answer): replaces the one held, or joins the list. */
export function upsertTask(tasks: readonly TaskOut[], task: TaskOut): TaskOut[] {
  const index = tasks.findIndex((t) => t.id === task.id);
  if (index < 0) return [...tasks, task];
  const out = [...tasks];
  out[index] = task;
  return out;
}

export function removeTask(tasks: readonly TaskOut[], taskId: string): TaskOut[] {
  return tasks.filter((t) => t.id !== taskId);
}

/** task.updated's task as TaskOut: `can_delete` is `deleter_ids` holding me. */
export function taskFromEvent(task: TaskData, deleterIds: readonly string[], me: string | null): TaskOut {
  return { ...task, can_delete: me !== null && deleterIds.includes(me) };
}

/** In 「自分のタスク」: personal (mine: only I see them) or assigned to me. */
export function isMine(task: Pick<TaskOut, "channel_id" | "assignee_ids">, me: string | null): boolean {
  return task.channel_id === null || (me !== null && task.assignee_ids.includes(me));
}

// --- due dates -------------------------------------------------------------------------------------

export function isOverdue(task: Pick<TaskOut, "due_on" | "status">, today: DayKey): boolean {
  return !!task.due_on && task.status !== "done" && task.due_on < today;
}

/** A card's due date: 「今日」, else M/D (with the year when not this year's). */
export function dueLabel(dueOn: string, today: DayKey): string {
  if (dueOn === today) return "今日";
  const date = parseDay(dueOn);
  const md = `${date.getMonth() + 1}/${date.getDate()}`;
  return dueOn.slice(0, 4) === today.slice(0, 4) ? md : `${date.getFullYear()}/${md}`;
}

/** The tasks due on a day (the calendar's rows), open ones first, then by title. */
export function tasksForDay<T extends Pick<TaskOut, "due_on" | "status" | "title" | "id">>(tasks: readonly T[], day: DayKey): T[] {
  return tasks
    .filter((t) => t.due_on === day)
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.title.localeCompare(b.title, "ja") || (a.id < b.id ? -1 : 1));
}

/** Whether a task is due inside [from, to) (dates; the calendar's window). */
export function dueInRange(task: Pick<TaskOut, "due_on">, from: DayKey, to: DayKey): boolean {
  return !!task.due_on && from <= task.due_on && task.due_on < to;
}

// --- permissions -----------------------------------------------------------------------------------

/** Public and private channels have a board; DMs and group DMs do not (TASKS.md §2). */
export function hasBoard(channel: Pick<ChannelState, "type">): boolean {
  return channel.type === "public" || channel.type === "private";
}

/**
 * Whether I may add, change and move a board's cards: the composer's rule (a member, not archived, and in an
 * announcement channel only owners and admins). The server checks it again (403 posting_restricted, 409 channel_archived).
 */
export function canEditBoard(channel: ChannelState | undefined, isAdmin: boolean): boolean {
  return !!channel && channel.isMember && hasBoard(channel) && !channel.archived && canPostTopLevel(channel, isAdmin);
}

/** A task I may change: a personal one always (only I see it), a shared one when I may edit its board. */
export function canEditTask(task: Pick<TaskOut, "channel_id">, channel: ChannelState | undefined, isAdmin: boolean): boolean {
  return task.channel_id === null || canEditBoard(channel, isAdmin);
}

// --- 「自分のタスク」 -------------------------------------------------------------------------------

/** Open ones by status (todo, doing) then the server's order; completed ones apart, newest first. */
export function splitOpenDone<T extends Pick<TaskOut, "status" | "position" | "id" | "completed_at">>(tasks: readonly T[]): { open: T[]; done: T[] } {
  const rank = (s: TaskStatus) => TASK_STATUSES.indexOf(s);
  const open = tasks.filter((t) => t.status !== "done").sort((a, b) => rank(a.status) - rank(b.status) || compareTasks(a, b));
  const done = tasks.filter((t) => t.status === "done").sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "") || compareTasks(a, b));
  return { open, done };
}

export interface MineGroup {
  channelId: string;
  channelName: string;
  tasks: TaskOut[];
}

/** 「自分のタスク」 (personal) and 「自分の担当」 by channel (channels by name). */
export function groupMineByChannel(tasks: readonly TaskOut[], me: string | null, channelName: (id: string) => string | null = () => null): { personal: TaskOut[]; groups: MineGroup[] } {
  const personal = tasks.filter((t) => t.channel_id === null);
  const byChannel = new Map<string, MineGroup>();
  for (const task of tasks) {
    if (task.channel_id === null || me === null || !task.assignee_ids.includes(me)) continue;
    let group = byChannel.get(task.channel_id);
    if (!group) {
      group = { channelId: task.channel_id, channelName: channelName(task.channel_id) ?? task.channel_name ?? "?", tasks: [] };
      byChannel.set(task.channel_id, group);
    }
    group.tasks.push(task);
  }
  const groups = [...byChannel.values()].sort((a, b) => a.channelName.localeCompare(b.channelName, "ja"));
  return { personal, groups };
}

// --- the detail dialog -----------------------------------------------------------------------------

export interface TaskDraft {
  title: string;
  notes: string;
  status: TaskStatus;
  dueOn: string;
  assigneeIds: string[];
}

export function draftFromTask(task: TaskOut): TaskDraft {
  return { title: task.title, notes: task.notes ?? "", status: task.status, dueOn: task.due_on ?? "", assigneeIds: [...task.assignee_ids] };
}

/** The title as the server keeps it (whitespace collapsed). */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

export function taskDraftProblem(draft: TaskDraft): string | null {
  const title = cleanTitle(draft.title);
  if (!title) return "題名を入れてください";
  if (title.length > MAX_TASK_TITLE) return `題名は ${MAX_TASK_TITLE} 文字までです`;
  if (draft.notes.length > MAX_TASK_NOTES) return `メモは ${MAX_TASK_NOTES} 文字までです`;
  return null;
}

/** PATCH /tasks/{id} with only what changed (`tz` with a new due date: its notification is read in my zone). */
export function taskPatch(task: TaskOut, draft: TaskDraft, tz: string): TaskUpdate {
  const patch: TaskUpdate = {};
  const title = cleanTitle(draft.title);
  if (title !== task.title) patch.title = title;
  const notes = draft.notes.trim() ? draft.notes : null;
  if (notes !== (task.notes ?? null)) patch.notes = notes;
  if (draft.status !== task.status) patch.status = draft.status;
  const due = draft.dueOn || null;
  if (due !== (task.due_on ?? null)) {
    patch.due_on = due;
    patch.tz = tz;
  }
  if (task.channel_id !== null) {
    const before = [...task.assignee_ids].sort();
    const after = [...new Set(draft.assigneeIds)].sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) patch.assignee_ids = after;
  }
  return patch;
}

/**
 * What a task says of the message it came from: a link while the message exists (`message_id`; its excerpt may be null
 * when I can no longer read it), 「元のメッセージは削除されました」 once it is gone (`message_id` null), nothing without one.
 */
export function sourceState(task: Pick<TaskOut, "source">): { kind: "none" } | { kind: "deleted" } | { kind: "link"; messageId: string; excerpt: string | null } {
  const source = task.source;
  if (!source) return { kind: "none" };
  if (!source.message_id) return { kind: "deleted" };
  return { kind: "link", messageId: source.message_id, excerpt: source.excerpt ?? null };
}

// --- creating --------------------------------------------------------------------------------------

/** What the dialog starts a new task with. `channelId` null: 「自分のタスク」. */
export interface TaskCreateInit {
  channelId: string | null;
  status: TaskStatus;
  title: string;
  /** 「タスクにする」: the message, its one-line excerpt, and its channel's board when I may add to it. */
  sourceMessageId?: string | null;
  sourceExcerpt?: string | null;
  /** The boards offered besides 「自分のタスク」 (a channel message: its channel's; none from a DM). */
  boardChoices?: string[];
}

/**
 * 「タスクにする」 (TASKS.md §6): the message's one-line text (the notifications' and the DM list's rule, cut to the
 * title's 200) as the title, the message as the source, and its channel's board — or 「自分のタスク」 for a DM, a group
 * DM, or a board I may not add to (switchable to 「自分のタスク」 from a channel's).
 */
export function messageTaskInit(
  message: { id: string; body: string; attachments?: ReadonlyArray<{ content_type: string }> },
  channel: ChannelState | undefined,
  users: Map<string, UserPublic>,
  groups: ReadonlyMap<string, GroupOut>,
  isAdmin: boolean,
): TaskCreateInit {
  const title = plainText(mentionsToNames(message.body, users, groups), MAX_TASK_TITLE) || attachmentText(message.attachments);
  const board = channel && canEditBoard(channel, isAdmin) ? channel.id : null;
  return { channelId: board, status: "todo", title, sourceMessageId: message.id, sourceExcerpt: title || null, boardChoices: board ? [board] : [] };
}

/** The calendar's filter (すべて / 自分 / #channel) on tasks: 「自分」 is 「自分のタスク」 (personal and assigned to me). */
export function filterTasks<T extends Pick<TaskOut, "channel_id" | "assignee_ids">>(tasks: readonly T[], filter: string, me: string | null): T[] {
  if (filter === "all") return [...tasks];
  if (filter === "me") return tasks.filter((t) => isMine(t, me));
  return tasks.filter((t) => t.channel_id === filter);
}

// --- notifications ---------------------------------------------------------------------------------

/**
 * The open app's notification for task.assigned / task.due (TASKS.md §5, the push's wording): 「<name> がタスクを割り当て
 * ました: <title> (#<channel>)」 / 「今日が期限: <title>」 (+ 「 (#<channel>)」 for a shared one), and the task to open on
 * a click.
 */
export function taskNoticeText(
  notice: { kind: "assigned"; data: { task_id: string; channel_id: string; channel_name: string; title: string; by_user_id: string } } | { kind: "due"; data: { task_id: string; channel_id: string | null; channel_name: string | null; title: string } },
  nameOf: (userId: string) => string | null,
): { body: string; taskId: string; channelId: string | null } {
  if (notice.kind === "assigned") {
    const { data } = notice;
    return { body: `${nameOf(data.by_user_id) ?? "メンバー"} がタスクを割り当てました: ${data.title} (#${data.channel_name})`, taskId: data.task_id, channelId: data.channel_id };
  }
  const { data } = notice;
  return { body: `今日が期限: ${data.title}${data.channel_id && data.channel_name ? ` (#${data.channel_name})` : ""}`, taskId: data.task_id, channelId: data.channel_id };
}
