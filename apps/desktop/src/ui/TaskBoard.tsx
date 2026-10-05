/**
 * M55 (TASKS.md §6): a channel's 「タスク」 tab — three columns 未着手 / 進行中 / 完了 with their counts, cards dragged
 * between and within them (native drag and drop: a line shows where the card will land), 「＋ 追加」 under each column,
 * and per card a menu (移動 / 上へ / 下へ / 削除) that does the same from the keyboard. Read-only for those who may not
 * post in the channel. The cards (TaskCard) are shared with 「自分のタスク」.
 *
 * M81 (TASKS.md §11): the board's columns come from GET /tasks/columns (each belongs to a status; the built-in three
 * stay, renamed and moved; added ones are deleted from the column's ⋯), 「＋ 列を追加」 at the right end, and on the
 * cards the due time, the checklist's progress and 🔁 for a repeating task.
 *
 * M85 (docs/DEADLINES.md): a deadline's card has ⏰; 「＋ 締切を追加」 above the columns opens the dialog as a 締切.
 */
import { AlarmClock, CalendarDays, CheckSquare, FileText, MessageSquareText, MoreHorizontal, Plus, Repeat, StickyNote } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { describeError } from "../api/errors";

import type { TaskOut, TaskStatus } from "../api/types";
import { describeRrule } from "./calendarRecurrence";
import type { AppController } from "../state/app";
import type { TaskHub } from "../sync/tasks";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { localZone, today as todayKey, type DayKey } from "./calendarDates";
import { Button, cn, Field, HoverList, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Modal } from "./primitives";
import { TaskDialog } from "./TaskDialog";
import {
  BOARD_DONE_LIMIT,
  type BoardColumn,
  builtinFor,
  CARD_AVATARS,
  canEditBoard,
  cleanTitle,
  COLUMN_KIND_LABELS,
  columnMoveTarget,
  columnNameProblem,
  computeNeighbors,
  dueDay,
  dueText,
  FALLBACK_COLUMNS,
  isNoopMove,
  isOverdue,
  MAX_COLUMN_NAME,
  MAX_COLUMNS,
  MAX_TASK_TITLE,
  moveWithin,
  type Neighbors,
  sortBoardColumn,
  sortColumns,
  sourceState,
  canvasSourceState,
  statusLabel,
  subtaskProgress,
  TASK_STATUSES,
} from "./tasks";

export function useTaskHub(controller: AppController): TaskHub | null {
  const hub = controller.engine?.tasks ?? null;
  useSyncExternalStore(
    (listener) => (hub ? hub.subscribe(listener) : () => {}),
    () => hub?.version ?? 0,
  );
  return hub;
}

/** Re-render when the day changes (overdue, 「今日」). */
export function useToday(): DayKey {
  const [day, setDay] = useState(() => todayKey());
  useEffect(() => {
    const timer = setInterval(() => setDay((current) => (current === todayKey() ? current : todayKey())), 60_000);
    return () => clearInterval(timer);
  }, []);
  return day;
}

/** Assignees as overlapping avatars, three at most, then 「+N」. */
export function AssigneeStack({ controller, ids }: { controller: AppController; ids: readonly string[] }) {
  if (ids.length === 0) return null;
  const users = controller.store.users;
  const shown = ids.slice(0, CARD_AVATARS);
  const more = ids.length - shown.length;
  const names = ids.map((id) => users.get(id)?.display_name ?? "?").join("、");
  return (
    <HoverList content={`担当: ${names}`}>
    <span className="flex shrink-0 items-center -space-x-1.5" aria-label={`担当: ${names}`} data-assignees={ids.length}>
      {shown.map((id) => (
        <Avatar key={id} id={id} name={users.get(id)?.display_name ?? "?"} size={20} className="rounded-full ring-2 ring-canvas" />
      ))}
      {more > 0 && (
        <span className="relative inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-panel-2 px-1 text-[10px] font-semibold text-muted ring-2 ring-canvas" data-more-assignees={more}>
          +{more}
        </span>
      )}
    </span>
    </HoverList>
  );
}

/** One card: title, assignees, due date (red when overdue), notes and source marks. */
export function TaskCard({ controller, task, today, onOpen, onOpenMessage, menu, leading, showStatus = false, place, draggable = false, dragging = false, onDragStart, onDragEnd }: {
  controller: AppController;
  task: TaskOut;
  today: DayKey;
  onOpen: (task: TaskOut) => void;
  onOpenMessage?: (messageId: string) => void;
  menu?: ReactNode;
  /** 「自分のタスク」: the checkbox. */
  leading?: ReactNode;
  /** 「自分のタスク」: 「進行中」 on the card (the board has columns). */
  showStatus?: boolean;
  /** L9 「自分が依頼した」: where the task lives (「#lab」, a DM's other member). */
  place?: string;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
}) {
  const done = task.status === "done";
  const overdue = isOverdue(task, today);
  const source = sourceState(task);
  const canvasSource = canvasSourceState(task);
  const progress = subtaskProgress(task);
  const due = dueDay(task);
  const deadline = task.kind === "deadline";
  const hasMeta = deadline || !!place || !!task.due_on || !!task.notes || !!progress || !!task.rrule || source.kind === "link" || canvasSource.kind === "link" || task.assignee_ids.length > 0 || (showStatus && task.status === "doing");
  return (
    <div
      data-task-card={task.id}
      draggable={draggable || undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group/card rounded-lg border border-line bg-canvas px-2.5 py-2 shadow-sm transition-[opacity,box-shadow] hover:shadow",
        draggable && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-2">
        {leading}
        <button type="button" className="min-w-0 flex-1 text-left text-sm leading-snug" onClick={() => onOpen(task)}>
          <span className={cn("break-words", done && "text-muted line-through")} data-task-title>{task.title}</span>
        </button>
        {menu}
      </div>
      {hasMeta && (
        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-xs text-muted">
          {deadline && (
            <span className="inline-flex items-center gap-0.5 font-medium text-warning" title="締切 (前もってチャンネルに知らせます)" aria-label="締切" data-deadline>
              <AlarmClock size={12} />
            </span>
          )}
          {showStatus && task.status === "doing" && <span className="rounded bg-accent-soft px-1.5 py-px text-[11px] font-medium text-accent">{statusLabel(task.kind, "doing")}</span>}
          {place && <span className="min-w-0 truncate" data-task-place>{place}</span>}
          {due && (
            <span
              data-due={task.due_on}
              data-overdue={overdue || undefined}
              title={`${deadline ? "締切" : "期限"} ${dueText(task, "")}${overdue ? " (過ぎています)" : ""}`}
              className={cn("inline-flex items-center gap-0.5 tabular-nums", overdue && "font-semibold text-danger", !overdue && due === today && !done && "font-semibold text-ink")}
            >
              <CalendarDays size={12} /> {dueText(task, today)}
            </span>
          )}
          {task.rrule && (
            <span title={`繰り返し: ${describeRrule(task.rrule, task.due_on ?? today)}`} aria-label="繰り返し" data-repeat>
              <Repeat size={12} />
            </span>
          )}
          {progress && (
            <span
              data-subtasks={`${progress.done}/${progress.total}`}
              title={`サブタスク ${progress.done}/${progress.total}`}
              className={cn("inline-flex items-center gap-0.5 tabular-nums", progress.done === progress.total && "text-success")}
            >
              <CheckSquare size={12} /> {progress.done}/{progress.total}
            </span>
          )}
          {task.notes && (
            <span title="メモあり" aria-label="メモあり" data-has-notes>
              <StickyNote size={12} />
            </span>
          )}
          {source.kind === "link" && onOpenMessage && (
            <button
              type="button"
              title="元のメッセージを開く"
              aria-label="元のメッセージを開く"
              className="rounded p-0.5 hover:bg-ink/6 hover:text-ink"
              onClick={(e) => {
                e.stopPropagation();
                onOpenMessage(source.messageId);
              }}
            >
              <MessageSquareText size={12} />
            </button>
          )}
          {canvasSource.kind === "link" && (
            <button
              type="button"
              title="元のキャンバスを開く"
              aria-label="元のキャンバスを開く"
              data-canvas-source
              className="rounded p-0.5 hover:bg-ink/6 hover:text-ink"
              onClick={(e) => {
                e.stopPropagation();
                void controller.openCanvasLink(canvasSource.canvasId);
              }}
            >
              <FileText size={12} />
            </button>
          )}
          <span className="ml-auto" />
          <AssigneeStack controller={controller} ids={task.assignee_ids} />
        </div>
      )}
    </div>
  );
}

/** The slot a pointer at `clientY` points to among the cards of a column (0: over the first, n: under the last). */
export function dropSlot(container: HTMLElement, clientY: number): number {
  const cards = [...container.querySelectorAll<HTMLElement>("[data-task-card]")];
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i]!.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

/** 「＋ 追加」: a title field at the bottom of a column; Enter adds and keeps it open for the next one, Esc closes it. */
export function InlineAdd({ label = "追加", placeholder = "題名を入力して Enter", onAdd }: { label?: string; placeholder?: string; onAdd: (title: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const close = () => {
    setOpen(false);
    setTitle("");
  };
  const submit = async () => {
    const text = cleanTitle(title);
    if (!text || busy) return;
    setBusy(true);
    const ok = await onAdd(text);
    setBusy(false);
    if (ok) {
      setTitle("");
      input.current?.focus();
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing) return; // IME conversion (Japanese input)
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      // Not the screen's Esc (back to 「メッセージ」).
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-ink/6 hover:text-ink">
        <Plus size={14} /> {label}
      </button>
    );
  }
  return (
    <input
      ref={input}
      autoFocus
      value={title}
      maxLength={MAX_TASK_TITLE}
      disabled={busy}
      aria-label="新しいタスクの題名"
      placeholder={placeholder}
      className="w-full rounded-lg border border-accent bg-canvas px-2.5 py-1.5 text-sm text-ink outline-none ring-2 ring-accent/30 placeholder:text-muted"
      onChange={(e) => setTitle(e.target.value)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={onKeyDown}
      onBlur={() => { if (!cleanTitle(title)) close(); }}
    />
  );
}

/** The card's ⋯: 移動 (another column), 上へ / 下へ, 削除 (who may). The keyboard's way to do what dragging does. */
function CardMenu({ task, column, current, columns, canEdit, onMove, onDelete }: {
  task: TaskOut;
  column: TaskOut[];
  /** M81: the card's column and the board's columns (移動 lists them). */
  current: BoardColumn;
  columns: readonly BoardColumn[];
  canEdit: boolean;
  onMove: (target: BoardColumn, neighbors: Neighbors) => void;
  onDelete: () => void;
}) {
  if (!canEdit && !task.can_delete) return null;
  const up = moveWithin(column, task.id, -1);
  const down = moveWithin(column, task.id, 1);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`「${task.title}」の操作`}
          title="操作"
          className="-mr-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-60 hover:bg-ink/6 hover:text-ink group-hover/card:opacity-100 focus-visible:opacity-100"
        >
          <MoreHorizontal size={15} />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="min-w-40">
        {canEdit && (
          <>
            <MenuLabel>移動</MenuLabel>
            {columns.map((target) => (
              <MenuItem key={target.id} disabled={target.id === current.id} onSelect={() => onMove(target, { after_id: null, before_id: null })}>
                {target.name}
                {target.id === current.id && <span className="ml-auto text-xs text-muted">いまここ</span>}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem disabled={!up} onSelect={() => up && onMove(current, up)}>上へ</MenuItem>
            <MenuItem disabled={!down} onSelect={() => down && onMove(current, down)}>下へ</MenuItem>
          </>
        )}
        {task.can_delete && (
          <>
            {canEdit && <MenuSeparator />}
            <MenuItem className="text-danger" onSelect={onDelete}>削除</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

/** Asked before a card is deleted from its menu (the dialog asks in place). */
export function DeleteTaskConfirm({ controller, task, onClose }: { controller: AppController; task: TaskOut; onClose: () => void }) {
  const hub = controller.engine?.tasks ?? null;
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={onClose} title="このタスクを削除しますか？" className="w-[420px]">
      <p className="mt-2 break-words text-sm text-muted">「{task.title}」</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>キャンセル</Button>
        <Button
          variant="danger"
          disabled={busy || !hub}
          onClick={() => {
            if (!hub) return;
            setBusy(true);
            void hub.remove(task.id).then(onClose, (err: unknown) => {
              setBusy(false);
              controller.setError(err);
            });
          }}
        >
          削除する
        </Button>
      </div>
    </Modal>
  );
}

function boardNote(state: string | undefined, channel: ChannelState, canEdit: boolean): string | null {
  if (state === "unsupported") return "このサーバはタスクに対応していません";
  if (state === "failed") return "タスクを読み込めませんでした。再接続すると読み直します";
  if (canEdit) return null;
  if (channel.archived) return "アーカイブされたチャンネルのタスクは変更できません";
  if (!channel.isMember) return null;
  return "このボードを変更できるのは、チャンネルのオーナーと管理者だけです";
}

/** A channel's board (its 「タスク」 tab). */
export function ChannelTasks({ controller, channel, onOpenMessage }: {
  controller: AppController;
  channel: ChannelState;
  onOpenMessage?: (messageId: string) => void;
}) {
  const hub = useTaskHub(controller);
  const today = useToday();
  const [dialog, setDialog] = useState<TaskOut | null>(null);
  /** M85: 「＋ 締切を追加」. */
  const [addingDeadline, setAddingDeadline] = useState(false);
  const [confirm, setConfirm] = useState<TaskOut | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ column: string; index: number } | null>(null);
  const [columnDialog, setColumnDialog] = useState<{ mode: "add" } | { mode: "rename"; column: BoardColumn } | null>(null);
  const [deleting, setDeleting] = useState<BoardColumn | null>(null);
  useEffect(() => {
    if (!hub) return;
    void hub.openBoard(channel.id);
    return () => hub.closeBoard(channel.id);
  }, [hub, channel.id]);
  const board = hub?.board(channel.id);
  const tasks = board?.tasks ?? [];
  const canEdit = canEditBoard(channel, controller.isAdmin) && !!hub?.available;
  const boardColumns = sortColumns(board?.columns ?? FALLBACK_COLUMNS);
  const cardsOf = Object.fromEntries(boardColumns.map((c) => [c.id, sortBoardColumn(tasks, c, boardColumns)])) as Record<string, TaskOut[]>;
  const columnOf = (task: TaskOut) => boardColumns.find((c) => cardsOf[c.id]?.some((t) => t.id === task.id)) ?? boardColumns[0]!;
  const note = boardNote(board?.state, channel, canEdit);
  const canChangeColumns = canEdit && !!board?.columnsSupported;
  const doneCount = tasks.filter((t) => t.status === "done").length;

  const move = (task: TaskOut, target: BoardColumn, neighbors: Neighbors) => {
    if (!hub) return;
    void hub.move(task.id, target.status, neighbors, target).catch((err: unknown) => controller.setError(err));
  };
  const add = async (target: BoardColumn, title: string): Promise<boolean> => {
    if (!hub) return false;
    try {
      const created = await hub.create({ channel_id: channel.id, title, status: target.status, kind: "task", client_task_id: crypto.randomUUID(), tz: localZone() });
      // M81: a card added under an added column goes there (it was made in the built-in column of that status).
      if (!target.builtin && board?.columnsSupported) await hub.move(created.id, target.status, { after_id: null, before_id: null }, target);
      return true;
    } catch (err) {
      controller.setError(err);
      return false;
    }
  };
  const moveColumn = (column: BoardColumn, direction: -1 | 1) => {
    const after = columnMoveTarget(boardColumns, column.id, direction);
    if (!hub || after === undefined) return;
    void hub.changeColumn(channel.id, column.id, { after_id: after }).catch((err: unknown) => controller.setError(err));
  };
  const endDrag = () => {
    setDragging(null);
    setDrop(null);
  };
  const dropOn = (target: BoardColumn, index: number) => {
    const task = dragging ? tasks.find((t) => t.id === dragging) : undefined;
    endDrag();
    if (!task || !canEdit) return;
    const column = cardsOf[target.id] ?? [];
    if (columnOf(task).id === target.id && isNoopMove(column, task.id, index)) return;
    move(task, target, computeNeighbors(column, task.id, index));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="タスク">
      {note && <div className="border-b border-line bg-warning/10 px-4 py-1.5 text-xs text-muted">{note}</div>}
      {canEdit && (
        <div className="flex shrink-0 justify-end px-3 pt-2">
          <Button variant="secondary" size="sm" onClick={() => setAddingDeadline(true)} aria-label="締切を追加">
            <AlarmClock size={14} /> 締切を追加
          </Button>
        </div>
      )}
      {/* A phone: the columns side by side, scrolled sideways inside the board (snapping to a column). */}
      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden p-3 md:snap-none">
        {boardColumns.map((target) => {
          const status: TaskStatus = target.status;
          const column = cardsOf[target.id] ?? [];
          const showIndicator = (i: number) =>
            drop?.column === target.id && drop.index === i && !(dragging && column.some((t) => t.id === dragging) && isNoopMove(column, dragging, i));
          const doneLimit = status === "done" && !board?.allDone && doneCount >= BOARD_DONE_LIMIT && column.length > 0;
          return (
            <section
              key={target.id}
              aria-label={target.name}
              data-column={target.builtin ? status : target.id}
              data-column-status={status}
              className="flex min-h-0 w-[272px] shrink-0 snap-start flex-col rounded-xl bg-panel-2/70 max-md:w-[min(300px,calc(100vw-56px))] md:min-w-[220px] md:flex-1 md:basis-0"
            >
              <h3 className="group/col flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5 text-[13px] font-semibold">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", status === "todo" ? "bg-muted/60" : status === "doing" ? "bg-accent" : "bg-success")} aria-hidden />
                <span className="min-w-0 truncate" data-column-name>{target.name}</span>
                <span className="font-normal text-muted" data-count>{column.length}{doneLimit ? "+" : ""}</span>
                {canChangeColumns && (
                  <ColumnMenu
                    column={target}
                    columns={boardColumns}
                    onRename={() => setColumnDialog({ mode: "rename", column: target })}
                    onMove={(direction) => moveColumn(target, direction)}
                    onDelete={() => setDeleting(target)}
                  />
                )}
              </h3>
              <div
                data-drop-zone={target.builtin ? status : target.id}
                className="flex min-h-[48px] flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-1 pt-1"
                onDragOver={(e) => {
                  if (!dragging || !canEdit) return;
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                  const index = dropSlot(e.currentTarget, e.clientY);
                  if (drop?.column !== target.id || drop.index !== index) setDrop({ column: target.id, index });
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null) && drop?.column === target.id) setDrop(null);
                }}
                onDrop={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  dropOn(target, dropSlot(e.currentTarget, e.clientY));
                }}
              >
                {board?.state === "loading" && column.length === 0 && <p className="px-1 py-2 text-xs text-muted">読み込み中…</p>}
                {column.map((task, i) => (
                  <div key={task.id} className="contents">
                    {showIndicator(i) && <div data-drop-indicator aria-hidden className="-my-1 h-0.5 shrink-0 rounded-full bg-accent" />}
                    <TaskCard
                      controller={controller}
                      task={task}
                      today={today}
                      onOpen={setDialog}
                      onOpenMessage={onOpenMessage ?? ((id) => void controller.openPermalink(id))}
                      draggable={canEdit}
                      dragging={dragging === task.id}
                      onDragStart={(e) => {
                        if (!canEdit) return;
                        if (e.dataTransfer) {
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", task.id);
                        }
                        setDragging(task.id);
                      }}
                      onDragEnd={endDrag}
                      menu={<CardMenu task={task} column={column} current={target} columns={boardColumns} canEdit={canEdit} onMove={(c, n) => move(task, c, n)} onDelete={() => setConfirm(task)} />}
                    />
                  </div>
                ))}
                {showIndicator(column.length) && <div data-drop-indicator aria-hidden className="-mt-1 h-0.5 shrink-0 rounded-full bg-accent" />}
                {board?.state === "ready" && column.length === 0 && !drop && !canEdit && <p className="px-1 py-2 text-center text-xs text-muted/80">なし</p>}
                {/* Right under the last card (Trello), inside the column's scroll. */}
                {doneLimit && (
                  <button type="button" className="w-full shrink-0 rounded-md px-2 py-1 text-left text-xs font-medium text-accent hover:underline" onClick={() => void hub?.openBoard(channel.id, true)}>
                    完了をすべて表示
                  </button>
                )}
                {canEdit && <div className="shrink-0 pb-1"><InlineAdd onAdd={(title) => add(target, title)} /></div>}
              </div>
            </section>
          );
        })}
        {canChangeColumns && boardColumns.length < MAX_COLUMNS && (
          <div className="w-[200px] shrink-0 snap-start pt-1 md:w-[180px]">
            <button
              type="button"
              className="flex w-full items-center gap-1 rounded-xl border border-dashed border-line px-3 py-2 text-left text-sm text-muted hover:bg-ink/6 hover:text-ink"
              onClick={() => setColumnDialog({ mode: "add" })}
            >
              <Plus size={14} /> 列を追加
            </button>
          </div>
        )}
      </div>
      {columnDialog && hub && (
        <ColumnDialog
          mode={columnDialog.mode}
          column={columnDialog.mode === "rename" ? columnDialog.column : null}
          onClose={() => setColumnDialog(null)}
          onSave={async (name, status) => {
            if (columnDialog.mode === "rename") await hub.changeColumn(channel.id, columnDialog.column.id, { name });
            else await hub.addColumn({ channel_id: channel.id, name, status });
          }}
        />
      )}
      {deleting && hub && (
        <Modal onClose={() => setDeleting(null)} title={`列「${deleting.name}」を削除しますか？`} className="w-[420px]">
          <p className="mt-2 text-sm text-muted">
            この列のカードは「{builtinFor(boardColumns, deleting.status)?.name ?? statusLabel("task", deleting.status)}」へ移ります (状態は変わりません)。
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>キャンセル</Button>
            <Button
              variant="danger"
              onClick={() => {
                const column = deleting;
                setDeleting(null);
                void hub.removeColumn(channel.id, column.id).catch((err: unknown) => controller.setError(err));
              }}
            >
              削除する
            </Button>
          </div>
        </Modal>
      )}
      {dialog && <TaskDialog controller={controller} task={hub?.find(dialog.id) ?? dialog} onClose={() => setDialog(null)} onOpenMessage={onOpenMessage} />}
      {confirm && <DeleteTaskConfirm controller={controller} task={confirm} onClose={() => setConfirm(null)} />}
      {addingDeadline && (
        <TaskDialog
          controller={controller}
          task={null}
          init={{ channelId: channel.id, status: "todo", title: "", kind: "deadline", boardChoices: [channel.id] }}
          onClose={() => setAddingDeadline(false)}
          onOpenMessage={onOpenMessage}
        />
      )}
    </div>
  );
}

/** M81: a column's ⋯ — 名前を変更, 左へ / 右へ, 削除 (an added column only). */
function ColumnMenu({ column, columns, onRename, onMove, onDelete }: {
  column: BoardColumn;
  columns: readonly BoardColumn[];
  onRename: () => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  const left = columnMoveTarget(columns, column.id, -1) !== undefined;
  const right = columnMoveTarget(columns, column.id, 1) !== undefined;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`列「${column.name}」の操作`}
          title="列の操作"
          className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-normal text-muted opacity-60 hover:bg-ink/6 hover:text-ink group-hover/col:opacity-100 focus-visible:opacity-100"
        >
          <MoreHorizontal size={15} />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="min-w-40">
        <MenuItem onSelect={onRename}>名前を変更</MenuItem>
        <MenuItem disabled={!left} onSelect={() => onMove(-1)}>左へ</MenuItem>
        <MenuItem disabled={!right} onSelect={() => onMove(1)}>右へ</MenuItem>
        {!column.builtin && (
          <>
            <MenuSeparator />
            <MenuItem className="text-danger" onSelect={onDelete}>列を削除</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

/** M81: 「列を追加」 (a name and the status its cards take) and 「名前を変更」. */
function ColumnDialog({ mode, column, onClose, onSave }: {
  mode: "add" | "rename";
  column: BoardColumn | null;
  onClose: () => void;
  onSave: (name: string, status: TaskStatus) => Promise<void>;
}) {
  const [name, setName] = useState(column?.name ?? "");
  const [status, setStatus] = useState<TaskStatus>(column?.status ?? "doing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = columnNameProblem(name);
  const save = async () => {
    if (busy || problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await onSave(cleanTitle(name), status);
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={mode === "add" ? "列を追加" : "列の名前を変更"} className="w-[420px]">
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="名前">
          <Input autoFocus value={name} maxLength={MAX_COLUMN_NAME} placeholder="レビュー待ち" onChange={(e) => { setName(e.target.value); setError(null); }} />
        </Field>
        {mode === "add" && (
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted">種類</span>
            <div role="radiogroup" aria-label="種類" className="space-y-1 text-sm">
              {TASK_STATUSES.map((s) => (
                <label key={s} className="flex cursor-pointer items-center gap-2">
                  <input type="radio" name="column-kind" className="accent-[var(--accent)]" checked={status === s} onChange={() => setStatus(s)} />
                  {COLUMN_KIND_LABELS[s]}
                </label>
              ))}
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button type="submit" disabled={busy || !!problem}>{mode === "add" ? "追加" : "保存"}</Button>
        </div>
      </form>
    </Modal>
  );
}
