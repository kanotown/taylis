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
import type { TaskAssigned, TaskCreate, TaskDeleted, TaskDue, TaskMove, TaskOut, TaskReviewDone, TaskStatus, TaskUpdate, TaskUpdated } from "../api/types";
import { applyLocalMove, dueInRange, isMine, isRequestedByMe, type Neighbors, removeTask, taskFromEvent, upsertTask } from "../ui/tasks";

export interface TaskApi {
  listTasks(channelId: string, includeDone?: "recent" | "all"): Promise<TaskOut[]>;
  myTasks(): Promise<TaskOut[]>;
  /** L9 「自分が依頼した」 (GET /tasks/requested). Optional: without it (an older fake) the list is "unsupported". */
  requestedTasks?(): Promise<TaskOut[]>;
  dueTasks(from: string, to: string): Promise<TaskOut[]>;
  getTask(taskId: string): Promise<TaskOut>;
  createTask(body: TaskCreate): Promise<TaskOut>;
  updateTask(taskId: string, patch: TaskUpdate): Promise<TaskOut>;
  moveTask(taskId: string, body: TaskMove): Promise<TaskOut>;
  deleteTask(taskId: string): Promise<void>;
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

export class TaskHub {
  private readonly boards = new Map<string, TaskBoard>();
  private mine: TaskList | null = null;
  /** L9 「自分が依頼した」. */
  private requested: TaskList | null = null;
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

  dueWindow(key: string): TaskDueWindow | undefined {
    return this.due.get(key);
  }

  // --- windows -------------------------------------------------------------------------------------

  /** A channel's 「タスク」 tab is on screen: read its board. */
  async openBoard(channelId: string, allDone = false): Promise<void> {
    const current = this.boards.get(channelId);
    if (current && current.state === "ready" && current.allDone === allDone) return;
    this.boards.set(channelId, { channelId, allDone, state: "loading", tasks: current?.tasks ?? [] });
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
      const tasks = await api.listTasks(channelId, board.allDone ? "all" : "recent");
      const now = this.boards.get(channelId);
      if (this.reads.get(key) !== ticket || !now) return;
      this.boards.set(channelId, { ...now, state: "ready", tasks });
    } catch (err) {
      const now = this.boards.get(channelId);
      if (this.reads.get(key) !== ticket || !now) return;
      this.boards.set(channelId, { ...now, state: this.failure(err) });
    }
    this.changed();
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
  async move(taskId: string, status: TaskStatus, neighbors: Neighbors): Promise<TaskOut> {
    const api = this.requireApi();
    const before = this.find(taskId);
    if (before) this.putLocalMove(before, status, neighbors);
    try {
      const task = await api.moveTask(taskId, { status, after_id: neighbors.after_id, before_id: neighbors.before_id });
      this.put(task);
      return task;
    } catch (err) {
      if (before) this.put(before); // unless a newer copy came meanwhile
      throw err;
    }
  }

  private putLocalMove(task: TaskOut, status: TaskStatus, neighbors: Neighbors): void {
    // The guess is made among the cards of the window that holds the task (its board, else 「自分のタスク」).
    const pool = (task.channel_id ? this.boards.get(task.channel_id)?.tasks : undefined) ?? this.mine?.tasks ?? [task];
    const moved = applyLocalMove(pool.some((t) => t.id === task.id) ? pool : [...pool, task], task.id, status, neighbors, this.deps.now?.() ?? new Date().toISOString(), this.deps.me());
    const local = moved.find((t) => t.id === task.id);
    if (local) this.put(local);
  }

  async remove(taskId: string): Promise<void> {
    await this.requireApi().deleteTask(taskId);
    this.drop(taskId);
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
    const mine = this.mine?.tasks.find((t) => t.id === taskId) ?? this.requested?.tasks.find((t) => t.id === taskId);
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
    for (const key of this.due.keys()) void this.readDue(key);
  }

  /** I left the channel (or was removed): its board closes and its tasks leave the other windows. */
  removeChannel(channelId: string): void {
    this.boards.delete(channelId);
    if (this.mine) this.mine = { ...this.mine, tasks: this.mine.tasks.filter((t) => t.channel_id !== channelId) };
    if (this.requested) this.requested = { ...this.requested, tasks: this.requested.tasks.filter((t) => t.channel_id !== channelId) };
    for (const [key, window] of this.due) this.due.set(key, { ...window, tasks: window.tasks.filter((t) => t.channel_id !== channelId) });
    this.changed();
  }

  stop(): void {
    this.boards.clear();
    this.mine = null;
    this.requested = null;
    this.due.clear();
    this.changed();
  }
}
