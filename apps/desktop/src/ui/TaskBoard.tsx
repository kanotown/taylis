/**
 * M55 (TASKS.md §6): a channel's 「タスク」 tab — three columns 未着手 / 進行中 / 完了 with their counts, cards dragged
 * between and within them (native drag and drop: a line shows where the card will land), 「＋ 追加」 under each column,
 * and per card a menu (移動 / 上へ / 下へ / 削除) that does the same from the keyboard. Read-only for those who may not
 * post in the channel. The cards (TaskCard) are shared with 「自分のタスク」.
 */
import { CalendarDays, FileText, MessageSquareText, MoreHorizontal, Plus, StickyNote } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { TaskOut, TaskStatus } from "../api/types";
import type { AppController } from "../state/app";
import type { TaskHub } from "../sync/tasks";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { localZone, today as todayKey, type DayKey } from "./calendarDates";
import { Button, cn, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Modal } from "./primitives";
import { TaskDialog } from "./TaskDialog";
import {
  BOARD_DONE_LIMIT,
  CARD_AVATARS,
  canEditBoard,
  cleanTitle,
  computeNeighbors,
  dueLabel,
  isNoopMove,
  isOverdue,
  MAX_TASK_TITLE,
  moveWithin,
  type Neighbors,
  sortColumn,
  sourceState,
  canvasSourceState,
  STATUS_LABELS,
  statusLabel,
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
    <span className="flex shrink-0 items-center -space-x-1.5" title={`担当: ${names}`} aria-label={`担当: ${names}`} data-assignees={ids.length}>
      {shown.map((id) => (
        <Avatar key={id} id={id} name={users.get(id)?.display_name ?? "?"} size={20} className="rounded-full ring-2 ring-canvas" />
      ))}
      {more > 0 && (
        <span className="relative inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-panel-2 px-1 text-[10px] font-semibold text-muted ring-2 ring-canvas" data-more-assignees={more}>
          +{more}
        </span>
      )}
    </span>
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
  const hasMeta = !!place || !!task.due_on || !!task.notes || source.kind === "link" || canvasSource.kind === "link" || task.assignee_ids.length > 0 || (showStatus && task.status === "doing");
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
          {showStatus && task.status === "doing" && <span className="rounded bg-accent-soft px-1.5 py-px text-[11px] font-medium text-accent">{statusLabel(task.kind, "doing")}</span>}
          {place && <span className="min-w-0 truncate" data-task-place>{place}</span>}
          {task.due_on && (
            <span
              data-due={task.due_on}
              data-overdue={overdue || undefined}
              title={`期限 ${task.due_on.replaceAll("-", "/")}${overdue ? " (過ぎています)" : ""}`}
              className={cn("inline-flex items-center gap-0.5 tabular-nums", overdue && "font-semibold text-danger", !overdue && task.due_on === today && !done && "font-semibold text-ink")}
            >
              <CalendarDays size={12} /> {dueLabel(task.due_on, today)}
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
function CardMenu({ task, column, canEdit, onMove, onDelete }: {
  task: TaskOut;
  column: TaskOut[];
  canEdit: boolean;
  onMove: (status: TaskStatus, neighbors: Neighbors) => void;
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
            {TASK_STATUSES.map((status) => (
              <MenuItem key={status} disabled={status === task.status} onSelect={() => onMove(status, { after_id: null, before_id: null })}>
                {STATUS_LABELS[status]}
                {status === task.status && <span className="ml-auto text-xs text-muted">いまここ</span>}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem disabled={!up} onSelect={() => up && onMove(task.status, up)}>上へ</MenuItem>
            <MenuItem disabled={!down} onSelect={() => down && onMove(task.status, down)}>下へ</MenuItem>
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
  const [confirm, setConfirm] = useState<TaskOut | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ status: TaskStatus; index: number } | null>(null);
  useEffect(() => {
    if (!hub) return;
    void hub.openBoard(channel.id);
    return () => hub.closeBoard(channel.id);
  }, [hub, channel.id]);
  const board = hub?.board(channel.id);
  const tasks = board?.tasks ?? [];
  const canEdit = canEditBoard(channel, controller.isAdmin) && !!hub?.available;
  const columns = Object.fromEntries(TASK_STATUSES.map((s) => [s, sortColumn(tasks, s)])) as Record<TaskStatus, TaskOut[]>;
  const note = boardNote(board?.state, channel, canEdit);

  const move = (task: TaskOut, status: TaskStatus, neighbors: Neighbors) => {
    if (!hub) return;
    void hub.move(task.id, status, neighbors).catch((err: unknown) => controller.setError(err));
  };
  const add = async (status: TaskStatus, title: string): Promise<boolean> => {
    if (!hub) return false;
    try {
      await hub.create({ channel_id: channel.id, title, status, kind: "task", client_task_id: crypto.randomUUID(), tz: localZone() });
      return true;
    } catch (err) {
      controller.setError(err);
      return false;
    }
  };
  const endDrag = () => {
    setDragging(null);
    setDrop(null);
  };
  const dropOn = (status: TaskStatus, index: number) => {
    const task = dragging ? tasks.find((t) => t.id === dragging) : undefined;
    endDrag();
    if (!task || !canEdit) return;
    const column = columns[status];
    if (task.status === status && isNoopMove(column, task.id, index)) return;
    move(task, status, computeNeighbors(column, task.id, index));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="タスク">
      {note && <div className="border-b border-line bg-warning/10 px-4 py-1.5 text-xs text-muted">{note}</div>}
      {/* A phone: the columns side by side, scrolled sideways inside the board (snapping to a column). */}
      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden p-3 md:snap-none">
        {TASK_STATUSES.map((status) => {
          const column = columns[status];
          const showIndicator = (i: number) =>
            drop?.status === status && drop.index === i && !(dragging && column.some((t) => t.id === dragging) && isNoopMove(column, dragging, i));
          const doneLimit = status === "done" && !board?.allDone && column.length >= BOARD_DONE_LIMIT;
          return (
            <section
              key={status}
              aria-label={STATUS_LABELS[status]}
              data-column={status}
              className="flex min-h-0 w-[272px] shrink-0 snap-start flex-col rounded-xl bg-panel-2/70 max-md:w-[min(300px,calc(100vw-56px))] md:min-w-[220px] md:flex-1 md:basis-0"
            >
              <h3 className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5 text-[13px] font-semibold">
                <span className={cn("h-2 w-2 rounded-full", status === "todo" ? "bg-muted/60" : status === "doing" ? "bg-accent" : "bg-success")} aria-hidden />
                {STATUS_LABELS[status]}
                <span className="font-normal text-muted" data-count>{column.length}{doneLimit ? "+" : ""}</span>
              </h3>
              <div
                data-drop-zone={status}
                className="flex min-h-[48px] flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-1 pt-1"
                onDragOver={(e) => {
                  if (!dragging || !canEdit) return;
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                  const index = dropSlot(e.currentTarget, e.clientY);
                  if (drop?.status !== status || drop.index !== index) setDrop({ status, index });
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null) && drop?.status === status) setDrop(null);
                }}
                onDrop={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  dropOn(status, dropSlot(e.currentTarget, e.clientY));
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
                      menu={<CardMenu task={task} column={column} canEdit={canEdit} onMove={(s, n) => move(task, s, n)} onDelete={() => setConfirm(task)} />}
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
                {canEdit && <div className="shrink-0 pb-1"><InlineAdd onAdd={(title) => add(status, title)} /></div>}
              </div>
            </section>
          );
        })}
      </div>
      {dialog && <TaskDialog controller={controller} task={hub?.find(dialog.id) ?? dialog} onClose={() => setDialog(null)} onOpenMessage={onOpenMessage} />}
      {confirm && <DeleteTaskConfirm controller={controller} task={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
