/**
 * M55 (TASKS.md): the tasks' pure rules — the columns' order, where a dropped card lands (its neighbours for
 * POST /tasks/{id}/move), the optimistic move, the event reducer, due dates, who may edit a board, and the groups of
 * 「自分のタスク」. No store, no React: the hub (sync/tasks.ts) and the screens share them, and the tests read them.
 */
import type { GroupOut, MessageTaskOut, SubtaskIn, SubtaskOut, TaskColumnOut, TaskCreate, TaskData, TaskOut, TaskStatus, TaskUpdate, UserPublic } from "../api/types";
import type { ChannelState } from "../sync/types";
import { canPostTopLevel } from "./channels";
import { clock, type DayKey, dayKey, isoLocal, parseDay, today as todayKey } from "./calendarDates";
import { noRepeat, type RepeatDraft, repeatProblem, repeatToRrule, ruleChanged, rruleToRepeat } from "./calendarRecurrence";
import { attachmentText, plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { t } from "../i18n";

export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "doing", "done"];
export const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = { get todo() { return t("tasks.status.todo"); }, get doing() { return t("tasks.status.doing"); }, get done() { return t("tasks.status.done"); } };
/** L9 (REVIEWS.md §2.2): a review request's states. */
export const REVIEW_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = { get todo() { return t("tasks.reviewStatus.todo"); }, get doing() { return t("tasks.reviewStatus.doing"); }, get done() { return t("tasks.status.done"); } };
export type TaskKind = TaskOut["kind"];

/** A status in the words of the task's kind (a review request: 依頼中 / 対応中 / 完了). */
export function statusLabel(kind: TaskKind | undefined, status: TaskStatus): string {
  return (kind === "review" ? REVIEW_STATUS_LABELS : STATUS_LABELS)[status];
}
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

// --- columns (M81, TASKS.md §11) -------------------------------------------------------------------

/** A board's column as the screens use it (the server's TaskColumnOut without its channel). */
export type BoardColumn = Pick<TaskColumnOut, "id" | "name" | "status" | "builtin" | "position">;
export const MAX_COLUMN_NAME = 50;
export const MAX_COLUMNS = 20;
export const MAX_SUBTASKS = 50;

/**
 * The three built-in columns before the server's answer, or from a server before M81 (no GET /tasks/columns). Their
 * ids are the statuses: a move into one sends the status alone.
 */
export const FALLBACK_COLUMNS: readonly BoardColumn[] = TASK_STATUSES.map((status, i) => ({ id: status, get name() { return STATUS_LABELS[status]; }, status, builtin: true, position: i + 1 }));

/** Whether a board's columns are the fallback ones (ids = statuses: moves send the status alone). */
export function isFallbackColumns(columns: readonly BoardColumn[]): boolean {
  return columns.every((c) => c.builtin && c.id === c.status);
}

/** Left to right (position, then id). */
export function sortColumns<T extends Pick<BoardColumn, "position" | "id">>(columns: readonly T[]): T[] {
  return [...columns].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The column a card is in: its added column, else (or when that column is unknown here) the built-in one of its status. */
export function columnOfTask(task: Pick<TaskOut, "status"> & { column_id?: string | null }, columns: readonly BoardColumn[]): BoardColumn | undefined {
  const own = task.column_id ? columns.find((c) => c.id === task.column_id && !c.builtin) : undefined;
  return own ?? columns.find((c) => c.builtin && c.status === task.status);
}

/** A column's cards in the server's order. */
export function sortBoardColumn<T extends Pick<TaskOut, "status" | "position" | "id"> & { column_id?: string | null }>(tasks: readonly T[], column: BoardColumn, columns: readonly BoardColumn[]): T[] {
  return tasks.filter((t) => columnOfTask(t, columns)?.id === column.id).sort(compareTasks);
}

/** The task's column_id once in `column` (null: a built-in one). */
export function columnIdFor(column: BoardColumn): string | null {
  return column.builtin ? null : column.id;
}

/** The built-in column a deleted column's cards go to. */
export function builtinFor(columns: readonly BoardColumn[], status: TaskStatus): BoardColumn | undefined {
  return columns.find((c) => c.builtin && c.status === status);
}

/** What the 「種類」 of a new column says (a column of a status). */
export const COLUMN_KIND_LABELS: Readonly<Record<TaskStatus, string>> = { get todo() { return t("tasks.columnKind.todo"); }, get doing() { return t("tasks.status.doing"); }, get done() { return t("tasks.columnKind.done"); } };

export function columnNameProblem(name: string): string | null {
  const cleaned = cleanTitle(name);
  if (!cleaned) return t("tasks.check.columnName");
  if (cleaned.length > MAX_COLUMN_NAME) return t("tasks.check.columnNameTooLong", { max: MAX_COLUMN_NAME });
  return null;
}

/** 「左へ」 / 「右へ」: the column to go right of (null: the left end), or undefined when it cannot move that way. */
export function columnMoveTarget(columns: readonly BoardColumn[], columnId: string, direction: -1 | 1): string | null | undefined {
  const sorted = sortColumns(columns);
  const index = sorted.findIndex((c) => c.id === columnId);
  if (index < 0) return undefined;
  const to = index + direction;
  if (to < 0 || to >= sorted.length) return undefined;
  const rest = sorted.filter((c) => c.id !== columnId);
  return to === 0 ? null : rest[to - 1]!.id;
}

/** M81: a card's checklist progress (「2/5」), or null without one. */
export function subtaskProgress(task: { subtasks?: readonly SubtaskOut[] | null }): { done: number; total: number } | null {
  const items = task.subtasks ?? [];
  if (items.length === 0) return null;
  return { done: items.filter((i) => i.done).length, total: items.length };
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
export function guessPosition(tasks: readonly TaskOut[], taskId: string, status: TaskStatus, neighbors: Neighbors, columnId?: string | null): number {
  // M81: within an added column (or a built-in one: null) when one is given, else the whole status.
  const inColumn = columnId === undefined ? tasks : tasks.filter((t) => (t.column_id ?? null) === columnId);
  const column = sortColumn(inColumn, status).filter((t) => t.id !== taskId);
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
export function applyLocalMove(tasks: readonly TaskOut[], taskId: string, status: TaskStatus, neighbors: Neighbors, now: string = new Date().toISOString(), me: string | null = null, columnId?: string | null): TaskOut[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return [...tasks];
  // M81: the server's rule for a move without a column: the card's column while the status stays, else the built-in one.
  const column = columnId !== undefined ? columnId : status === task.status ? (task.column_id ?? null) : null;
  const position = guessPosition(tasks, taskId, status, neighbors, column);
  const completion =
    status === task.status ? {} : status === "done" ? { completed_at: now, completed_by: me } : { completed_at: null, completed_by: null };
  return tasks.map((t) => (t.id === taskId ? { ...t, status, position, column_id: column, ...completion } : t));
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

/** Past due while open: a due time once it has passed (M81), a date once the day is over. */
export function isOverdue(task: Pick<TaskOut, "due_on" | "status"> & { due_at?: string | null }, today: DayKey, now: Date = new Date()): boolean {
  if (!task.due_on || task.status === "done") return false;
  if (task.due_at) return new Date(task.due_at).getTime() < now.getTime();
  return task.due_on < today;
}

/** The local day a task is due on: a due time's local date (M81), else due_on. */
export function dueDay(task: Pick<TaskOut, "due_on"> & { due_at?: string | null }): DayKey | null {
  if (task.due_at) return dayKey(new Date(task.due_at));
  return task.due_on ?? null;
}

/** A card's due: 「今日」 / 「10/9」, with the time when it has one (「今日 14:00」, 「10/9 14:00」). */
export function dueText(task: Pick<TaskOut, "due_on"> & { due_at?: string | null }, today: DayKey): string {
  const day = dueDay(task);
  if (!day) return "";
  const label = dueLabel(day, today);
  return task.due_at ? `${label} ${clock(task.due_at)}` : label;
}

/** A card's due date: 「今日」, else M/D (with the year when not this year's). */
export function dueLabel(dueOn: string, today: DayKey): string {
  if (dueOn === today) return t("common.today");
  const date = parseDay(dueOn);
  const md = `${date.getMonth() + 1}/${date.getDate()}`;
  return dueOn.slice(0, 4) === today.slice(0, 4) ? md : `${date.getFullYear()}/${md}`;
}

/** The tasks due on a day (the calendar's rows), open ones first, then by title. */
export function tasksForDay<T extends Pick<TaskOut, "due_on" | "status" | "title" | "id"> & { due_at?: string | null }>(tasks: readonly T[], day: DayKey): T[] {
  // M81: those with a due time after those without, by time.
  const time = (t: T) => (t.due_at ? new Date(t.due_at).getTime() : -1);
  return tasks
    .filter((t) => t.due_on === day)
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || time(a) - time(b) || a.title.localeCompare(b.title, "ja") || (a.id < b.id ? -1 : 1));
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

/**
 * Whether I may add and change the tasks of a conversation: a board's rule for a channel; in a DM or a group DM (L9: its
 * messages' shared tasks, no board) being a member of a conversation not archived.
 */
export function canEditConversationTasks(channel: ChannelState | undefined, isAdmin: boolean): boolean {
  if (!channel) return false;
  if (hasBoard(channel)) return canEditBoard(channel, isAdmin);
  return channel.isMember && !channel.archived;
}

/**
 * A conversation with someone besides me: my own DM (only me in `dm_user_ids`) has nobody to share a task with or to ask
 * for a review, so its tasks stay personal (2026-10-09). Unknown members (an older server) count as others.
 */
export function hasOthers(channel: Pick<ChannelState, "type" | "dm_user_ids"> | undefined): boolean {
  const ids = channel?.dm_user_ids;
  return !channel || channel.type !== "dm" || !ids || new Set(ids).size > 1;
}

/** Where a task can be shared from a message (L9): a board I may add to, or a DM / group DM with someone else in it. */
export function canShareConversationTask(channel: ChannelState | undefined, isAdmin: boolean): boolean {
  return canEditConversationTasks(channel, isAdmin) && hasOthers(channel);
}

/** 「自分のタスク」's ＋ (TASKS.md §6): the boards I may add a task to, by name — offered beside 「自分のタスク」. */
export function taskBoardChoices(channels: Iterable<ChannelState>, isAdmin: boolean): string[] {
  return [...channels]
    .filter((c) => canEditBoard(c, isAdmin))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"))
    .map((c) => c.id);
}

/** A task I may change: a personal one always (only I see it), a shared one when I may edit its conversation's tasks. */
export function canEditTask(task: Pick<TaskOut, "channel_id">, channel: ChannelState | undefined, isAdmin: boolean): boolean {
  return task.channel_id === null || canEditConversationTasks(channel, isAdmin);
}

/**
 * Where a task lives, in a line: 「#lab」, a DM by its other members (L9: a DM's task has no channel_name), or
 * 「自分のタスク」. `dmTitle` names a DM from the store; without it (or the DM unknown) a DM's task says 「DM」.
 */
export function taskPlace(task: Pick<TaskOut, "channel_id" | "channel_name">, dmTitle?: (channelId: string) => string | null): string {
  if (task.channel_id === null) return t("tasks.myTasks");
  if (task.channel_name) return `#${task.channel_name}`;
  return dmTitle?.(task.channel_id) ?? "DM";
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

/** 「自分が依頼した」 (L9): shared tasks I made with someone besides me assigned (GET /tasks/requested's rule). */
export function isRequestedByMe(task: Pick<TaskOut, "channel_id" | "owner_id" | "assignee_ids">, me: string | null): boolean {
  return me !== null && task.channel_id !== null && task.owner_id === me && task.assignee_ids.some((id) => id !== me);
}

/** 「自分が依頼した」's order (the server's): open ones by due date (none last), then the completed ones, newest first. */
export function sortRequested<T extends Pick<TaskOut, "status" | "due_on" | "created_at" | "completed_at" | "id">>(tasks: readonly T[]): { open: T[]; done: T[] } {
  const byId = (a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const open = tasks
    .filter((t) => t.status !== "done")
    .sort((a, b) => (a.due_on ?? "9999-99-99").localeCompare(b.due_on ?? "9999-99-99") || a.created_at.localeCompare(b.created_at) || byId(a, b));
  const done = tasks.filter((t) => t.status === "done").sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "") || byId(a, b));
  return { open, done };
}

// --- the chip under a message (L9, REVIEWS.md §2.2) ------------------------------------------------

export type TaskChipTone = "open" | "overdue" | "done";

/**
 * A message's task as its chip says it: 「レビュー依頼 · 加納 · 依頼中 · 10/9 まで」 (a task: 「タスク · … · 未着手」):
 * the assignees by name (two, then 「他 N 人」, as on the phones), the status in the kind's words, the due date while open (「今日まで」).
 * Done is grey, an open one past its due date red.
 */
export function taskChip(task: MessageTaskOut, nameOf: (userId: string) => string | null, today: DayKey): { text: string; tone: TaskChipTone } {
  const parts = [task.kind === "review" ? t("tasks.review") : t("tasks.task")];
  const names = task.assignee_ids.map((id) => nameOf(id) ?? "?");
  if (names.length > 0) parts.push(names.length > 2 ? t("tasks.namesAndOthers", { names: names.slice(0, 2).join(t("common.listSeparator")), count: names.length - 2 }) : names.join(t("common.listSeparator")));
  parts.push(statusLabel(task.kind, task.status));
  if (task.due_on && task.status !== "done") {
    const due = dueText(task, today);
    parts.push(due === t("common.today") ? t("tasks.dueToday") : t("tasks.dueBy", { due }));
  }
  const tone: TaskChipTone = task.status === "done" ? "done" : isOverdue(task, today) ? "overdue" : "open";
  return { text: parts.join(" · "), tone };
}

// --- the detail dialog -----------------------------------------------------------------------------

/** M81: a checklist item in the dialog (id null: new). */
export interface SubtaskDraft {
  id: string | null;
  title: string;
  done: boolean;
}

export interface TaskDraft {
  title: string;
  notes: string;
  status: TaskStatus;
  dueOn: string;
  /** M81: "HH:MM" (local), "" for the whole day. */
  dueTime?: string;
  /** M81: 「繰り返し」 (needs a due date). */
  repeat?: RepeatDraft;
  /** M81: 「サブタスク」. */
  subtasks?: SubtaskDraft[];
  /** M85: a deadline's 「事前の通知」 (days before; the server's default for a new one is 7, 3, 1 and 0). */
  noticeDays?: number[];
  assigneeIds: string[];
}

function hhmmLocal(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function draftFromTask(task: TaskOut): TaskDraft {
  const dueOn = dueDay(task) ?? "";
  return {
    title: task.title,
    notes: task.notes ?? "",
    status: task.status,
    dueOn,
    dueTime: task.due_at ? hhmmLocal(task.due_at) : "",
    repeat: rruleToRepeat(task.rrule ?? null, dueOn || todayKey()),
    subtasks: (task.subtasks ?? []).map((i) => ({ id: i.id, title: i.title, done: i.done })),
    ...(task.notice_days ? { noticeDays: [...task.notice_days] } : {}),
    assigneeIds: [...task.assignee_ids],
  };
}

/** A new task's empty extras (no time, no repeat, no checklist). */
export function emptyExtras(dueOn: string): Pick<TaskDraft, "dueTime" | "repeat" | "subtasks"> {
  return { dueTime: "", repeat: noRepeat(dueOn || todayKey()), subtasks: [] };
}

/**
 * The repeat after the due date moves from `before` to `after`. The draft's weekday was seeded from the old date (today
 * when there was none), so a new task due on a Sunday offered 「毎週 土曜日」 on a Saturday (v0.1.21 check): while it is
 * still the old date's weekday alone, it follows the date (as a calendar does); other or more weekdays stay.
 */
export function repeatForDue(repeat: RepeatDraft | undefined, before: string, after: string): RepeatDraft | undefined {
  if (!repeat || !after || before === after) return repeat;
  const seeded = noRepeat(before || todayKey()).weekdays;
  if (repeat.weekdays.length !== 1 || repeat.weekdays[0] !== seeded[0]) return repeat;
  return { ...repeat, weekdays: noRepeat(after).weekdays };
}

/** The due time as the server takes it: the local wall-clock time with the device's offset. */
export function dueAtOf(draft: Pick<TaskDraft, "dueOn" | "dueTime">): string | null {
  if (!draft.dueOn || !draft.dueTime) return null;
  return isoLocal(new Date(`${draft.dueOn}T${draft.dueTime}:00`));
}

/** The checklist as sent (blank items left out). */
export function subtasksBody(items: readonly SubtaskDraft[] | undefined): SubtaskIn[] {
  return (items ?? [])
    .map((i) => ({ ...i, title: cleanTitle(i.title) }))
    .filter((i) => i.title)
    .map((i) => (i.id ? { id: i.id, title: i.title, done: i.done } : { title: i.title, done: i.done }));
}

function repeatRule(draft: TaskDraft): string | null {
  return draft.dueOn && draft.repeat ? repeatToRrule(draft.repeat, draft.dueOn) : null;
}

/** The title as the server keeps it (whitespace collapsed). */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

export function taskDraftProblem(draft: TaskDraft, kind: TaskKind = "task"): string | null {
  const title = cleanTitle(draft.title);
  if (!title) return t("tasks.check.title");
  // M85: a deadline has a date (and never repeats: the dialog offers no 「繰り返し」).
  if (kind === "deadline" && !draft.dueOn) return t("tasks.check.deadlineDate");
  if (title.length > MAX_TASK_TITLE) return t("tasks.check.titleTooLong", { max: MAX_TASK_TITLE });
  if (draft.notes.length > MAX_TASK_NOTES) return t("tasks.check.notesTooLong", { max: MAX_TASK_NOTES });
  if (draft.repeat && draft.repeat.kind !== "none") {
    if (!draft.dueOn) return t("tasks.check.repeatNeedsDue");
    const problem = repeatProblem(draft.repeat, draft.dueOn);
    if (problem) return problem;
  }
  if (subtasksBody(draft.subtasks).length > MAX_SUBTASKS) return t("tasks.check.subtasksMany", { max: MAX_SUBTASKS });
  if ((draft.subtasks ?? []).some((i) => cleanTitle(i.title).length > MAX_TASK_TITLE)) return t("tasks.check.subtaskTooLong", { max: MAX_TASK_TITLE });
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
  const dueAt = dueAtOf(draft);
  if (dueAt) {
    // M81: a due time (the server takes its date from it).
    if (!task.due_at || new Date(task.due_at).getTime() !== new Date(dueAt).getTime()) {
      patch.due_at = dueAt;
      patch.tz = tz;
    }
  } else {
    if (due !== (dueDay(task) ?? null)) {
      patch.due_on = due;
      patch.tz = tz;
    }
    if (due && task.due_at) patch.due_at = null; // back to the whole day
  }
  if (draft.noticeDays && task.kind === "deadline") {
    const days = [...new Set(draft.noticeDays)].sort((a, b) => b - a);
    if (JSON.stringify(days) !== JSON.stringify(task.notice_days ?? [])) patch.notice_days = days;
  }
  if (draft.repeat && task.kind !== "deadline") {
    const changed = due ? ruleChanged(draft.repeat, due, task.rrule ?? null) : !!task.rrule;
    if (changed) patch.rrule = repeatRule(draft);
  }
  if (draft.subtasks) {
    const before = JSON.stringify((task.subtasks ?? []).map((i) => [i.id, i.title, i.done]));
    const body = subtasksBody(draft.subtasks);
    if (JSON.stringify(body.map((i) => [i.id ?? null, i.title, i.done ?? false])) !== before) patch.subtasks = body;
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

/**
 * M72 (CANVAS.md §18.3): what a task says of the canvas it came from: a link while the canvas is there (`canvas_id`),
 * 「元のキャンバスは削除されました」 once it was purged (`canvas_id` null), nothing for a task not made from one.
 */
export function canvasSourceState(task: Pick<TaskOut, "canvas_source">): { kind: "none" } | { kind: "deleted"; excerpt: string | null } | { kind: "link"; canvasId: string; excerpt: string | null } {
  const source = task.canvas_source;
  if (!source) return { kind: "none" };
  if (!source.canvas_id) return { kind: "deleted", excerpt: source.excerpt ?? null };
  return { kind: "link", canvasId: source.canvas_id, excerpt: source.excerpt ?? null };
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
  /**
   * L9: a DM's (or group DM's) message: the DM whose members may be assigned. With assignees the task is shared in the
   * DM; without, it stays personal (TASKS.md §6's rule).
   */
  shareChannelId?: string | null;
  /** L9 「レビューを依頼」: kind review, in the message's conversation (channelId), with at least one 依頼先. */
  kind?: TaskKind;
  /** M72 (CANVAS.md §18.3): a canvas's checklist item — the canvas, the line as in its body, the item's text. */
  sourceCanvasId?: string | null;
  sourceCanvasLine?: string | null;
  sourceCanvasExcerpt?: string | null;
  /** M72: a due date and assignees to start with (the item's `📅` and mentions). */
  dueOn?: string;
  assigneeIds?: string[];
}

/** Where a new task goes: the board chosen, else a DM shared once someone is assigned, else 「自分のタスク」 (null). */
export function newTaskChannel(init: TaskCreateInit | undefined, board: string, assigneeIds: readonly string[]): string | null {
  if (board !== "me") return board;
  return init?.shareChannelId && assigneeIds.length > 0 ? init.shareChannelId : null;
}

/** POST /tasks for the dialog's draft. */
export function taskCreateBody(draft: TaskDraft, init: TaskCreateInit | undefined, board: string, clientTaskId: string, tz: string): TaskCreate {
  const channelId = newTaskChannel(init, board, draft.assigneeIds);
  const kind = init?.kind ?? "task";
  const deadline = kind === "deadline";
  return {
    title: cleanTitle(draft.title),
    status: draft.status,
    kind,
    client_task_id: clientTaskId,
    tz,
    ...(channelId ? { channel_id: channelId } : {}),
    ...(draft.notes.trim() ? { notes: draft.notes } : {}),
    ...(draft.dueOn ? { due_on: draft.dueOn } : {}),
    ...(dueAtOf(draft) ? { due_at: dueAtOf(draft) } : {}),
    ...(!deadline && repeatRule(draft) ? { rrule: repeatRule(draft) } : {}),
    // M85: the server's default (7, 3, 1, 0) unless the dialog chose others.
    ...(deadline && draft.noticeDays ? { notice_days: [...new Set(draft.noticeDays)].sort((a, b) => b - a) } : {}),
    ...(subtasksBody(draft.subtasks).length > 0 ? { subtasks: subtasksBody(draft.subtasks) } : {}),
    ...(channelId && draft.assigneeIds.length > 0 ? { assignee_ids: [...new Set(draft.assigneeIds)] } : {}),
    ...(init?.sourceMessageId ? { source_message_id: init.sourceMessageId } : {}),
    ...(init?.sourceCanvasId && init.sourceCanvasLine ? { source_canvas_id: init.sourceCanvasId, source_canvas_line: init.sourceCanvasLine } : {}),
  };
}

/**
 * 「レビューを依頼」 (REVIEWS.md §2.3): 「レビュー: <the message's one line>」 (200 characters in all), the message as its
 * source, in the message's conversation (a DM too).
 */
export function messageReviewInit(
  message: { id: string; channel_id: string; body: string; attachments?: ReadonlyArray<{ content_type: string }> },
  users: Map<string, UserPublic>,
  groups: ReadonlyMap<string, GroupOut>,
): TaskCreateInit {
  const prefix = t("tasks.reviewPrefix");
  const excerpt = plainText(mentionsToNames(message.body, users, groups), MAX_TASK_TITLE - prefix.length) || attachmentText(message.attachments);
  return {
    channelId: message.channel_id,
    status: "todo",
    title: `${prefix}${excerpt}`.trim(),
    sourceMessageId: message.id,
    sourceExcerpt: excerpt || null,
    boardChoices: [message.channel_id],
    kind: "review",
  };
}

/**
 * 「タスクにする」 (TASKS.md §6): the message's one-line text (the notifications' and the DM list's rule, cut to the
 * title's 200) as the title, the message as the source, and its channel's board — or 「自分のタスク」 for a DM, a group
 * DM, or a board I may not add to (switchable to 「自分のタスク」 from a channel's). L9: a DM's message may be shared in
 * the DM by choosing assignees (`shareChannelId`).
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
  // L9: a DM's message may be shared with the DM's members (assignees chosen).
  const share = channel && !hasBoard(channel) && canShareConversationTask(channel, isAdmin) ? channel.id : null;
  return { channelId: board, status: "todo", title, sourceMessageId: message.id, sourceExcerpt: title || null, boardChoices: board ? [board] : [], shareChannelId: share };
}

/** The calendar's filter (すべて / 自分 / #channel) on tasks: 「自分」 is 「自分のタスク」 (personal and assigned to me). */
export function filterTasks<T extends Pick<TaskOut, "channel_id" | "assignee_ids">>(tasks: readonly T[], filter: string, me: string | null): T[] {
  if (filter === "all") return [...tasks];
  if (filter === "me") return tasks.filter((t) => isMine(t, me));
  return tasks.filter((t) => t.channel_id === filter);
}

// --- notifications ---------------------------------------------------------------------------------

type ByNotice = { task_id: string; channel_id: string; channel_name: string; title: string; by_user_id: string };

/**
 * The open app's notification for task.assigned / task.due / task.review_done (TASKS.md §5, REVIEWS.md §4, the push's
 * wording): 「<name> がタスクを割り当てました: <title> (#<channel>)」 (a review request: 「<name> がレビューを依頼しました:
 * <title>」), 「<name> がレビューを完了しました: <title>」, 「今日が期限: <title>」 (+ 「 (#<channel>)」 for a shared one;
 * a DM has no channel name and adds nothing), and the task to open on a click.
 */
export function taskNoticeText(
  notice:
    | { kind: "assigned"; data: ByNotice & { kind?: TaskKind } }
    | { kind: "review_done"; data: ByNotice }
    | { kind: "due"; data: { task_id: string; channel_id: string | null; channel_name: string | null; title: string; due_at?: string | null } },
  nameOf: (userId: string) => string | null,
): { body: string; taskId: string; channelId: string | null } {
  const where = (name: string | null | undefined) => (name ? ` (#${name})` : "");
  if (notice.kind === "assigned" || notice.kind === "review_done") {
    const { data } = notice;
    const key = notice.kind === "review_done" ? "tasks.notice.reviewDone" : notice.data.kind === "review" ? "tasks.notice.reviewRequested" : "tasks.notice.assigned";
    return { body: t(key, { who: nameOf(data.by_user_id) ?? t("common.member"), title: data.title }) + where(data.channel_name), taskId: data.task_id, channelId: data.channel_id };
  }
  const { data } = notice;
  // M81: a due time (the notification went out at it): 「14:00 が期限: …」.
  const when = data.due_at ? t("tasks.notice.dueAt", { time: clock(data.due_at) }) : t("tasks.notice.dueToday");
  return { body: `${when}${t("tasks.notice.colon")}${data.title}${data.channel_id ? where(data.channel_name) : ""}`, taskId: data.task_id, channelId: data.channel_id };
}
