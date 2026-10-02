/**
 * M55: the tasks on this device (TASKS.md §4). Like the calendar, nothing is kept for long: each screen that shows
 * tasks opens a window — a channel's board, 「自分のタスク」, a calendar range — read from the server, and task.*
 * events update the windows they concern (the rest are dropped: the next read has them). After reconnecting every open
 * window is read again, which fills whatever events were missed.
 *
 * Columns are always ordered by the server's `position` (the server may renumber a column; each renumbered card then
 * arrives as its own task.updated), never by a local index. A move shows at once (a guessed position) and is put back
 * when the server refuses it.
 */
import { ApiError } from "../api/errors";
import type { SubtaskUpdate, TaskAssigned, TaskColumnCreate, TaskColumnOut, TaskColumnsUpdated, TaskColumnUpdate, TaskCreate, TaskDeleted, TaskDue, TaskMove, TaskOut, TaskReviewDone, TaskStatus, TaskUpdate, TaskUpdated } from "../api/types";
import { applyLocalMove, type BoardColumn, dueInRange, FALLBACK_COLUMNS, isMine, isRequestedByMe, type Neighbors, removeTask, sortColumns, taskFromEvent, upsertTask } from "../ui/tasks";

export interface TaskApi {
  listTasks(channelId: string, includeDone?: "recent" | "all"): Promise<TaskOut[]>;
  myTasks(): Promise<TaskOut[]>;
  /** L9 「自分が依頼した」 (GET /tasks/requested). Optional: without it (an older fake) the list is "unsupported". */
  requestedTasks?(): Promise<TaskOut[]>;
  dueTasks(from: string, to: string): Promise<TaskOut[]>;
  /** M85 「締切」 and the header chips (GET /tasks/deadlines). Optional: without it the window is "unsupported". */
  deadlineTasks?(channelId?: string): Promise<TaskOut[]>;
  getTask(taskId: string): Promise<TaskOut>;
  createTask(body: TaskCreate): Promise<TaskOut>;
  updateTask(taskId: string, patch: TaskUpdate): Promise<TaskOut>;
  moveTask(taskId: string, body: TaskMove): Promise<TaskOut>;
  deleteTask(taskId: string): Promise<void>;
  /** M81 (TASKS.md §11). Optional: without them (an older fake) a board has the three built-in columns. */
  updateSubtask?(taskId: string, subtaskId: string, patch: SubtaskUpdate): Promise<TaskOut>;
  listTaskColumns?(channelId: string): Promise<TaskColumnOut[]>;
  createTaskColumn?(body: TaskColumnCreate): Promise<TaskColumnOut>;
  updateTaskColumn?(columnId: string, patch: TaskColumnUpdate): Promise<TaskColumnOut>;
  deleteTaskColumn?(columnId: string): Promise<void>;
}

export type TaskListState = "loading" | "ready" | "failed" | "unsupported";

export interface TaskList {
  state: TaskListState;
  /** Unordered: the screens sort (sortColumn, splitOpenDone, tasksForDay). */
  tasks: TaskOut[];
}

export interface TaskBoard extends TaskList {
  channelId: string;
  /** Every completed card (「完了をすべて表示」), not only the latest 100. */
  allDone: boolean;
  /**
   * M81: the board's columns, left to right. FALLBACK_COLUMNS (ids = statuses) until read, or from a server before M81
   * (`columnsSupported` false: no adding, renaming or moving columns).
   */
  columns: BoardColumn[];
  columnsSupported: boolean;
}

export interface TaskDueWindow extends TaskList {
  /** Dates [from, to). */
  from: string;
  to: string;
}

/** What task.assigned / task.due say to me (the app shows a notification while open). */
export type TaskNotice = { kind: "assigned"; data: TaskAssigned } | { kind: "due"; data: TaskDue } | { kind: "review_done"; data: TaskReviewDone };

const MINE = "mine";
const REQUESTED = "requested";
const DEADLINES = "deadlines";
/** GET /tasks/deadlines brings the deadlines due from this many days ago on (the server's rule). */
export const DEADLINES_PAST_DAYS = 30;

/** M85: whether a task belongs in the deadlines window (a live channel deadline due from 30 days ago on). */
export function inDeadlineWindow(task: Pick<TaskOut, "kind" | "channel_id" | "due_on">, now: Date = new Date()): boolean {
  if (task.kind !== "deadline" || !task.channel_id || !task.due_on) return false;
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - DEADLINES_PAST_DAYS);
  const key = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
  return task.due_on >= key;
}

export class TaskHub {
  private readonly boards = new Map<string, TaskBoard>();
  private mine: TaskList | null = null;
  /** L9 「自分が依頼した」. */
  private requested: TaskList | null = null;
  /**
   * M85: my channels' deadlines (「締切」 and every channel header's chip). Opened once the app is online and kept
   * (unlike the other windows) while it runs: the chip of whichever channel is open reads it.
   */
  private deadlines: TaskList | null = null;
  private readonly due = new Map<string, TaskDueWindow>();
  /** A read in flight per window: an older answer never replaces a newer one. */
  private readonly reads = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  version = 0;

  constructor(
    private readonly deps: {
      api: TaskApi | null;
      /** My user id (can_delete is `deleter_ids` holding it; 「自分の担当」 is assignee_ids holding it). */
      me: () => string | null;
      onNotice?: (notice: TaskNotice) => void;
      now?: () => string;
    },
  ) {}

  get available(): boolean {
    return this.deps.api !== null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  board(channelId: string): TaskBoard | undefined {
    return this.boards.get(channelId);
  }

  mineList(): TaskList | null {
    return this.mine;
  }

  requestedList(): TaskList | null {
    return this.requested;
  }

  deadlineList(): TaskList | null {
    return this.deadlines;
  }

  dueWindow(key: string): TaskDueWindow | undefined {
    return this.due.get(key);
  }

  // --- windows -------------------------------------------------------------------------------------

  /** A channel's 「タスク」 tab is on screen: read its board. */
  async openBoard(channelId: string, allDone = false): Promise<void> {
    const current = this.boards.get(channelId);
    if (current && current.state === "ready" && current.allDone === allDone) return;
    this.boards.set(channelId, {
      channelId,
      allDone,
      state: "loading",
      tasks: current?.tasks ?? [],
      columns: current?.columns ?? [...FALLBACK_COLUMNS],
      columnsSupported: current?.columnsSupported ?? false,
    });
    this.changed();
    await this.readBoard(channelId);
  }

  closeBoard(channelId: string): void {
    if (this.boards.delete(channelId)) this.changed();
  }

  async openMine(): Promise<void> {
    if (this.mine?.state === "ready") return;
    this.mine = { state: "loading", tasks: this.mine?.tasks ?? [] };
    this.changed();
    await this.readMine();
  }

  closeMine(): void {
    if (!this.mine) return;
    this.mine = null;
    this.changed();
  }

  /** L9 「自分が依頼した」 is on screen. */
  async openRequested(): Promise<void> {
    if (this.requested?.state === "ready") return;
    this.requested = { state: "loading", tasks: this.requested?.tasks ?? [] };
    this.changed();
    await this.readRequested();
  }

  closeRequested(): void {
    if (!this.requested) return;
    this.requested = null;
    this.changed();
  }

  /** M85: 「締切」 or a channel's header chip is on screen (read once; kept up to date by the events). */
  async openDeadlines(): Promise<void> {
    if (this.deadlines && this.deadlines.state !== "failed") return;
    this.deadlines = { state: "loading", tasks: this.deadlines?.tasks ?? [] };
    this.changed();
    await this.readDeadlines();
  }

  /** A calendar shows the dates [from, to): the tasks due then. */
  async openDue(key: string, from: string, to: string): Promise<void> {
    const current = this.due.get(key);
    const same = current && current.from === from && current.to === to;
    if (same && current.state === "ready") return;
    this.due.set(key, { from, to, state: "loading", tasks: same ? current.tasks : [] });
    this.changed();
    await this.readDue(key);
  }

  closeDue(key: string): void {
    if (this.due.delete(key)) this.changed();
  }

  private ticket(key: string): number {
    const ticket = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, ticket);
    return ticket;
  }

  private failure(err: unknown): TaskListState {
    console.warn("could not read the tasks", err);
    // A server from before M55 has no such route (404 not_found).
    return err instanceof ApiError && err.status === 404 && err.code === "not_found" ? "unsupported" : "failed";
  }

  private async readBoard(channelId: string): Promise<void> {
    const api = this.deps.api;
    const board = this.boards.get(channelId);
    if (!api || !board) return;
    const key = `board:${channelId}`;
    const ticket = this.ticket(key);
    try {
      const [tasks, columns] = await Promise.all([api.listTasks(channelId, board.allDone ? "all" : "recent"), this.readColumns(channelId)]);
      const now = this.boards.get(channelId);
      if (this.reads.get(key) !== ticket || !now) return;
      this.boards.set(channelId, { ...now, state: "ready", tasks, columns: columns ?? [...FALLBACK_COLUMNS], columnsSupported: columns !== null });
    } catch (err) {
      const now = this.boards.get(channelId);
      if (this.reads.get(key) !== ticket || !now) return;
      this.boards.set(channelId, { ...now, state: this.failure(err) });
    }
    this.changed();
  }

  /** M81: a board's columns; null from a server (or fake) without them. */
  private async readColumns(channelId: string): Promise<BoardColumn[] | null> {
    const api = this.deps.api;
    if (!api?.listTaskColumns) return null;
    try {
      return sortColumns(await api.listTaskColumns(channelId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null; // before M81 (or a route the server lacks)
      if (err instanceof ApiError && err.status === 422) return null; // before M81: "columns" read as a task id
      throw err;
    }
  }

  private async readMine(): Promise<void> {
    const api = this.deps.api;
    if (!api || !this.mine) return;
    const ticket = this.ticket(MINE);
    try {
      const tasks = await api.myTasks();
      if (this.reads.get(MINE) !== ticket || !this.mine) return;
      this.mine = { state: "ready", tasks };
    } catch (err) {
      if (this.reads.get(MINE) !== ticket || !this.mine) return;
      this.mine = { ...this.mine, state: this.failure(err) };
    }
    this.changed();
  }

  private async readRequested(): Promise<void> {
    const api = this.deps.api;
    if (!api || !this.requested) return;
    const ticket = this.ticket(REQUESTED);
    try {
      if (!api.requestedTasks) throw new ApiError(404, "not_found", "GET /tasks/requested is not available");
      const tasks = await api.requestedTasks();
      if (this.reads.get(REQUESTED) !== ticket || !this.requested) return;
      this.requested = { state: "ready", tasks };
    } catch (err) {
      if (this.reads.get(REQUESTED) !== ticket || !this.requested) return;
      this.requested = { ...this.requested, state: this.failure(err) };
    }
    this.changed();
  }

  private async readDeadlines(): Promise<void> {
    const api = this.deps.api;
    if (!api || !this.deadlines) return;
    const ticket = this.ticket(DEADLINES);
    try {
      if (!api.deadlineTasks) throw new ApiError(404, "not_found", "GET /tasks/deadlines is not available");
      const tasks = await api.deadlineTasks();
      if (this.reads.get(DEADLINES) !== ticket || !this.deadlines) return;
      this.deadlines = { state: "ready", tasks };
    } catch (err) {
      if (this.reads.get(DEADLINES) !== ticket || !this.deadlines) return;
      // Before M85 the route is /tasks/{task_id}: "deadlines" is no task id (422).
      const old = err instanceof ApiError && err.status === 422;
      this.deadlines = { ...this.deadlines, state: old ? "unsupported" : this.failure(err) };
    }
    this.changed();
  }

  private async readDue(key: string): Promise<void> {
    const api = this.deps.api;
    const window = this.due.get(key);
    if (!api || !window) return;
    const ticket = this.ticket(`due:${key}`);
    try {
      const tasks = await api.dueTasks(window.from, window.to);
      const now = this.due.get(key);
      if (this.reads.get(`due:${key}`) !== ticket || !now || now.from !== window.from || now.to !== window.to) return;
      this.due.set(key, { ...now, state: "ready", tasks });
    } catch (err) {
      const now = this.due.get(key);
      if (this.reads.get(`due:${key}`) !== ticket || !now) return;
      this.due.set(key, { ...now, state: this.failure(err) });
    }
    this.changed();
  }

  // --- changes made here ---------------------------------------------------------------------------

  async create(body: TaskCreate): Promise<TaskOut> {
    const task = await this.requireApi().createTask(body);
    this.put(task);
    return task;
  }

  async update(taskId: string, patch: TaskUpdate): Promise<TaskOut> {
    const task = await this.requireApi().updateTask(taskId, patch);
    this.put(task);
    return task;
  }

  /**
   * Into `status` between `neighbors`: shown at once at a guessed place, then where the server put it. A refusal puts
   * the card back and throws (the screen says why).
   */
  async move(taskId: string, status: TaskStatus, neighbors: Neighbors, column?: BoardColumn): Promise<TaskOut> {
    const api = this.requireApi();
    const before = this.find(taskId);
    // M81: into a column of the board (a fallback column, id = its status, sends the status alone).
    const columnId = column && column.id !== column.status ? column.id : undefined;
    if (before) this.putLocalMove(before, status, neighbors, column ? (column.builtin ? null : column.id) : undefined);
    try {
      const body: TaskMove = columnId ? { column_id: columnId, after_id: neighbors.after_id, before_id: neighbors.before_id } : { status, after_id: neighbors.after_id, before_id: neighbors.before_id };
      const task = await api.moveTask(taskId, body);
      this.put(task);
      return task;
    } catch (err) {
      if (before) this.put(before); // unless a newer copy came meanwhile
      throw err;
    }
  }

  private putLocalMove(task: TaskOut, status: TaskStatus, neighbors: Neighbors, columnId?: string | null): void {
    // The guess is made among the cards of the window that holds the task (its board, else 「自分のタスク」).
    const pool = (task.channel_id ? this.boards.get(task.channel_id)?.tasks : undefined) ?? this.mine?.tasks ?? [task];
    const moved = applyLocalMove(pool.some((t) => t.id === task.id) ? pool : [...pool, task], task.id, status, neighbors, this.deps.now?.() ?? new Date().toISOString(), this.deps.me(), columnId);
    const local = moved.find((t) => t.id === task.id);
    if (local) this.put(local);
  }

  async remove(taskId: string): Promise<void> {
    await this.requireApi().deleteTask(taskId);
    this.drop(taskId);
  }

  /** M81: one checklist item's checkbox (shown at once, put back when refused). */
  async toggleSubtask(taskId: string, subtaskId: string, done: boolean): Promise<TaskOut> {
    const api = this.requireApi();
    if (!api.updateSubtask) throw new Error("Subtasks are not available");
    const before = this.find(taskId);
    if (before) this.put({ ...before, subtasks: (before.subtasks ?? []).map((i) => (i.id === subtaskId ? { ...i, done } : i)) });
    try {
      const task = await api.updateSubtask(taskId, subtaskId, { done });
      this.put(task);
      return task;
    } catch (err) {
      if (before) this.put(before);
      throw err;
    }
  }

  // --- columns (M81) -------------------------------------------------------------------------------

  async addColumn(body: TaskColumnCreate): Promise<TaskColumnOut> {
    const api = this.requireApi();
    if (!api.createTaskColumn) throw new Error("Columns are not available");
    const column = await api.createTaskColumn(body);
    await this.refreshColumns(body.channel_id);
    return column;
  }

  async changeColumn(channelId: string, columnId: string, patch: TaskColumnUpdate): Promise<void> {
    const api = this.requireApi();
    if (!api.updateTaskColumn) throw new Error("Columns are not available");
    await api.updateTaskColumn(columnId, patch);
    await this.refreshColumns(channelId);
  }

  /** An added column; its cards come back (task.updated) in the built-in column of their status. */
  async removeColumn(channelId: string, columnId: string): Promise<void> {
    const api = this.requireApi();
    if (!api.deleteTaskColumn) throw new Error("Columns are not available");
    await api.deleteTaskColumn(columnId);
    await this.refreshColumns(channelId);
  }

  /** After my own change (the event comes too; whichever lands last is the same list). */
  private async refreshColumns(channelId: string): Promise<void> {
    if (!this.boards.has(channelId)) return;
    const columns = await this.readColumns(channelId);
    const board = this.boards.get(channelId);
    if (!board || !columns) return;
    this.boards.set(channelId, { ...board, columns, columnsSupported: true });
    this.changed();
  }

  /** The task as held here, else read (a notification, a calendar row outside every window). */
  async load(taskId: string): Promise<TaskOut> {
    return this.find(taskId) ?? (await this.requireApi().getTask(taskId));
  }

  private requireApi(): TaskApi {
    if (!this.deps.api) throw new Error("Tasks are not available");
    return this.deps.api;
  }

  // --- events (§4) ---------------------------------------------------------------------------------

  applyEvent(event: string, data: unknown): void {
    if (event === "task.updated") {
      const { task, deleter_ids: deleters } = data as TaskUpdated;
      this.put(taskFromEvent(task, deleters ?? [], this.deps.me()));
    } else if (event === "task.deleted") {
      this.drop((data as TaskDeleted).id);
    } else if (event === "task.assigned") {
      this.deps.onNotice?.({ kind: "assigned", data: data as TaskAssigned });
    } else if (event === "task.due") {
      this.deps.onNotice?.({ kind: "due", data: data as TaskDue });
    } else if (event === "task.review_done") {
      this.deps.onNotice?.({ kind: "review_done", data: data as TaskReviewDone });
    } else if (event === "task.columns.updated") {
      const { channel_id: channelId, columns } = data as TaskColumnsUpdated;
      const board = this.boards.get(channelId);
      if (board) {
        this.boards.set(channelId, { ...board, columns: sortColumns(columns), columnsSupported: true });
        this.changed();
      }
    }
  }

  /**
   * A task as it is now, into every window it belongs to (out of those it left): its board, 「自分のタスク」 when
   * personal or assigned to me, 「自分が依頼した」 when I made it for someone else, a calendar range holding its due date. An older copy (updated_at) never replaces a newer
   * one (the optimistic copy keeps the held updated_at, so the server's answer or a refusal's undo replaces it).
   */
  put(task: TaskOut): void {
    const newer = (list: readonly TaskOut[]) => {
      const held = list.find((t) => t.id === task.id);
      return !held || held.updated_at <= task.updated_at;
    };
    if (task.channel_id) {
      const board = this.boards.get(task.channel_id);
      if (board && newer(board.tasks)) this.boards.set(task.channel_id, { ...board, tasks: upsertTask(board.tasks, task) });
    }
    if (this.mine && newer(this.mine.tasks)) {
      this.mine = { ...this.mine, tasks: isMine(task, this.deps.me()) ? upsertTask(this.mine.tasks, task) : removeTask(this.mine.tasks, task.id) };
    }
    if (this.requested && newer(this.requested.tasks)) {
      this.requested = { ...this.requested, tasks: isRequestedByMe(task, this.deps.me()) ? upsertTask(this.requested.tasks, task) : removeTask(this.requested.tasks, task.id) };
    }
    if (this.deadlines && newer(this.deadlines.tasks)) {
      const fits = inDeadlineWindow(task, this.deps.now ? new Date(this.deps.now()) : new Date());
      if (fits || this.deadlines.tasks.some((t) => t.id === task.id)) {
        this.deadlines = { ...this.deadlines, tasks: fits ? upsertTask(this.deadlines.tasks, task) : removeTask(this.deadlines.tasks, task.id) };
      }
    }
    for (const [key, window] of this.due) {
      if (!newer(window.tasks)) continue;
      const fits = dueInRange(task, window.from, window.to);
      if (!fits && !window.tasks.some((t) => t.id === task.id)) continue;
      this.due.set(key, { ...window, tasks: fits ? upsertTask(window.tasks, task) : removeTask(window.tasks, task.id) });
    }
    this.changed();
  }

  private drop(taskId: string): void {
    for (const [channelId, board] of this.boards) {
      if (board.tasks.some((t) => t.id === taskId)) this.boards.set(channelId, { ...board, tasks: removeTask(board.tasks, taskId) });
    }
    if (this.mine?.tasks.some((t) => t.id === taskId)) this.mine = { ...this.mine, tasks: removeTask(this.mine.tasks, taskId) };
    if (this.requested?.tasks.some((t) => t.id === taskId)) this.requested = { ...this.requested, tasks: removeTask(this.requested.tasks, taskId) };
    if (this.deadlines?.tasks.some((t) => t.id === taskId)) this.deadlines = { ...this.deadlines, tasks: removeTask(this.deadlines.tasks, taskId) };
    for (const [key, window] of this.due) {
      if (window.tasks.some((t) => t.id === taskId)) this.due.set(key, { ...window, tasks: removeTask(window.tasks, taskId) });
    }
    this.changed();
  }

  find(taskId: string): TaskOut | undefined {
    for (const board of this.boards.values()) {
      const task = board.tasks.find((t) => t.id === taskId);
      if (task) return task;
    }
    const mine = this.mine?.tasks.find((t) => t.id === taskId) ?? this.requested?.tasks.find((t) => t.id === taskId) ?? this.deadlines?.tasks.find((t) => t.id === taskId);
    if (mine) return mine;
    for (const window of this.due.values()) {
      const task = window.tasks.find((t) => t.id === taskId);
      if (task) return task;
    }
    return undefined;
  }

  // --- lifecycle -----------------------------------------------------------------------------------

  /** After (re)connecting: every open window is read again (events missed while away, §4). */
  online(): void {
    for (const channelId of this.boards.keys()) void this.readBoard(channelId);
    if (this.mine) void this.readMine();
    if (this.requested) void this.readRequested();
    if (this.deadlines) void this.readDeadlines();
    for (const key of this.due.keys()) void this.readDue(key);
  }

  /** I left the channel (or was removed): its board closes and its tasks leave the other windows. */
  removeChannel(channelId: string): void {
    this.boards.delete(channelId);
    if (this.mine) this.mine = { ...this.mine, tasks: this.mine.tasks.filter((t) => t.channel_id !== channelId) };
    if (this.requested) this.requested = { ...this.requested, tasks: this.requested.tasks.filter((t) => t.channel_id !== channelId) };
    if (this.deadlines) this.deadlines = { ...this.deadlines, tasks: this.deadlines.tasks.filter((t) => t.channel_id !== channelId) };
    for (const [key, window] of this.due) this.due.set(key, { ...window, tasks: window.tasks.filter((t) => t.channel_id !== channelId) });
    this.changed();
  }

  stop(): void {
    this.boards.clear();
    this.mine = null;
    this.requested = null;
    this.deadlines = null;
    this.due.clear();
    this.changed();
  }
}
