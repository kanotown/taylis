/**
 * M55 (TASKS.md §6): a task's dialog — 題名, メモ (Markdown text), 状態, 期限, 担当者 (the channel's members; not for a
 * personal task), the message it came from, 削除. New tasks too (「タスクにする」, 「自分のタスク」), with where they
 * go (a channel's board or 「自分のタスク」). Someone who may not edit the board sees the task read-only.
 *
 * L9 (REVIEWS.md §2): 「レビューを依頼」 is the same dialog for a new task of kind review in the message's conversation (a
 * DM too): 依頼先 first, then the title, the notes and 希望日. A DM's 「タスクにする」 offers the DM's members as
 * assignees (chosen: shared in the DM; none: personal). An assignee of an open shared task gets 「対応を始める」 and
 * 「完了にする」 on top.
 *
 * M81 (TASKS.md §11): a time beside the due date (empty: the whole day), 「繰り返し」 once there is a due date (the
 * calendar's picker; completing makes the next occurrence on the server), and 「サブタスク」 (a checklist: a checkbox of a
 * saved task goes at once, the rest with 保存).
 *
 * M85 (docs/DEADLINES.md): a new task on a channel's board may be a 締切 (the 「タスク / 締切」 switch): a date is
 * required, it does not repeat, and 「事前の通知」 picks the days the 「締切」 bot posts in the channel beforehand.
 */
import { ArrowDown, ArrowUp, CheckCircle2, FileText, MessageSquareText, PlayCircle, Plus, Repeat, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { describeError } from "../api/errors";
import type { TaskOut, TaskStatus } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { localZone, today as todayKey } from "./calendarDates";
import { RepeatPicker } from "./CalendarEventDialog";
import { describeRrule } from "./calendarRecurrence";
import { DEFAULT_NOTICE_DAYS, noticeLabel, NOTICE_CHOICES, noticeSummary } from "./deadlines";
import { conversationTitle } from "./channels";
import { useMembers } from "./Dialogs";
import { Button, cn, Field, Input, Modal, Textarea } from "./primitives";
import {
  canEditBoard,
  canEditTask,
  canvasSourceState,
  draftFromTask,
  dueText,
  emptyExtras,
  hasBoard,
  MAX_SUBTASKS,
  subtaskProgress,
  type SubtaskDraft,
  MAX_TASK_NOTES,
  MAX_TASK_TITLE,
  newTaskChannel,
  sourceState,
  statusLabel,
  TASK_STATUSES,
  type TaskCreateInit,
  taskCreateBody,
  type TaskDraft,
  taskDraftProblem,
  taskPatch,
} from "./tasks";

const SELECT =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60";

export function TaskDialog({ controller, task, init, onClose, onOpenMessage }: {
  controller: AppController;
  /** The task opened; null makes a new one from `init`. */
  task: TaskOut | null;
  init?: TaskCreateInit;
  onClose: () => void;
  /** 「メッセージを開く」 (default: the permalink's way to the message). */
  onOpenMessage?: (messageId: string) => void;
}) {
  const hub = controller.engine?.tasks ?? null;
  const store = controller.store;
  const me = store.me?.id ?? null;
  const [draft, setDraft] = useState<TaskDraft>(() =>
    task
      ? draftFromTask(task)
      : { title: init?.title ?? "", notes: "", status: init?.status ?? "todo", dueOn: init?.dueOn ?? "", ...emptyExtras(init?.dueOn ?? ""), assigneeIds: [...(init?.assigneeIds ?? [])] },
  );
  /** New: the board ("me" or a channel id). */
  const [board, setBoard] = useState<string>(() => init?.channelId ?? "me");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const clientId = useRef(crypto.randomUUID());
  /** M85: a new task's kind (the 「タスク / 締切」 switch). */
  const [newKind, setNewKind] = useState(init?.kind ?? "task");
  const kind = task ? task.kind : newKind;
  const review = kind === "review";
  const deadline = kind === "deadline";
  const creatingReview = !task && review;
  const channelId = task ? task.channel_id : newTaskChannel(init, board, draft.assigneeIds);
  /** Whose members the assignee picker offers: the task's conversation, the board chosen, or the DM it may be shared in. */
  const pickerChannelId = task ? task.channel_id : board !== "me" ? board : (init?.shareChannelId ?? null);
  const channel = channelId ? store.getChannel(channelId) : undefined;
  const editable = task ? canEditTask(task, channel, controller.isAdmin) : true;
  const problem = editable ? (creatingReview && draft.assigneeIds.length === 0 ? "依頼先を選んでください" : taskDraftProblem(draft, kind)) : null;
  const boards = useMemo(() => (init?.boardChoices ?? []).filter((id) => canEditBoard(store.getChannel(id), controller.isAdmin)), [init, store, controller.isAdmin]);
  // M85: a deadline is a channel board's (not from a message, a canvas or a DM).
  const canBeDeadline = !task && !review && !init?.shareChannelId && !init?.sourceMessageId && !init?.sourceCanvasId && boards.length > 0;
  const chooseKind = (next: "task" | "deadline") => {
    setNewKind(next);
    if (next === "deadline") {
      if (board === "me" && boards[0]) {
        setBoard(boards[0]);
        set({ assigneeIds: [] });
      }
      set({ noticeDays: draft.noticeDays ?? [...DEFAULT_NOTICE_DAYS], repeat: draft.repeat ? { ...draft.repeat, kind: "none" } : draft.repeat });
    }
  };
  // L9: an assignee of an open shared task acts on it in one click.
  const actsOn = !!task && editable && task.channel_id !== null && me !== null && task.assignee_ids.includes(me) && task.status !== "done";
  const set = (patch: Partial<TaskDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  /** M81: a saved item's checkbox goes at once (one item: another person's edit of the list is not undone). */
  const toggleSubtask = (index: number) => {
    const items = draft.subtasks ?? [];
    const item = items[index];
    if (!item) return;
    const next = items.map((i, k) => (k === index ? { ...i, done: !i.done } : i));
    set({ subtasks: next });
    const saved = task && item.id && (task.subtasks ?? []).some((i) => i.id === item.id);
    if (hub && task && saved && item.id) void hub.toggleSubtask(task.id, item.id, !item.done).catch((err: unknown) => setError(describeError(err)));
  };
  const openMessage = (messageId: string) => {
    onClose();
    if (onOpenMessage) onOpenMessage(messageId);
    else void controller.openPermalink(messageId);
  };

  const save = async () => {
    if (!hub || busy) return;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      if (!task) {
        await hub.create(taskCreateBody(draft, { ...(init ?? { channelId: null, status: draft.status, title: "" }), kind: newKind }, board, clientId.current, localZone()));
        controller.setNotice(creatingReview ? "レビューを依頼しました" : deadline ? "締切を追加しました" : "タスクを作成しました");
      } else {
        const patch = taskPatch(task, draft, localZone());
        if (Object.keys(patch).length > 0) await hub.update(task.id, patch);
      }
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  /** 「対応を始める」 / 「完了にする」: the status alone, at once (the other fields as they were). */
  const setStatus = async (status: TaskStatus) => {
    if (!hub || !task || busy) return;
    setBusy(true);
    try {
      await hub.update(task.id, { status });
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!hub || !task || busy) return;
    setBusy(true);
    try {
      await hub.remove(task.id);
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  const boardName = (id: string | null) => {
    if (!id) return "自分のタスク";
    const conversation = store.getChannel(id);
    // L9: a DM's task (no board): the DM by its other members.
    if (conversation && !hasBoard(conversation)) return `${conversationTitle(conversation, store.users, me, store.me)} との DM`;
    if (!conversation && task?.channel_id === id && !task.channel_name) return "DM";
    return `#${conversation?.name ?? task?.channel_name ?? "?"} のボード`;
  };
  const title = creatingReview
    ? "レビューを依頼"
    : !task
      ? deadline ? "締切を追加" : "タスクを追加"
      : review
        ? (editable ? "レビュー依頼を編集" : "レビュー依頼")
        : deadline
          ? (editable ? "締切を編集" : "締切")
          : editable ? "タスクを編集" : "タスク";
  const dueName = review ? "希望日" : deadline ? "締切日" : "期限";
  const source = task ? sourceState(task) : init?.sourceMessageId ? { kind: "link" as const, messageId: init.sourceMessageId, excerpt: init.sourceExcerpt ?? null } : { kind: "none" as const };
  // M72 (CANVAS.md §18.3): the canvas a task came from (a one-way link).
  const canvasSource = task ? canvasSourceState(task) : init?.sourceCanvasId ? { kind: "link" as const, canvasId: init.sourceCanvasId, excerpt: init.sourceCanvasExcerpt ?? null } : { kind: "none" as const };
  const canvasTitle = canvasSource.kind === "link" ? store.canvasMeta(canvasSource.canvasId)?.title ?? null : null;
  const openCanvas = (canvasId: string) => {
    onClose();
    void controller.openCanvasLink(canvasId);
  };
  const assigneeLabel = review ? "依頼先" : "担当者";
  const picker = pickerChannelId && (
    <AssigneePicker
      controller={controller}
      channelId={pickerChannelId}
      label={assigneeLabel}
      excludeMe={creatingReview}
      selected={draft.assigneeIds}
      onChange={(assigneeIds) => set({ assigneeIds })}
    />
  );

  return (
    <Modal onClose={onClose} title={title} className="w-[520px]">
      <form
        className="mt-4 space-y-3"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {canBeDeadline && (
          <div role="radiogroup" aria-label="種類" className="flex w-full rounded-lg bg-panel-2 p-0.5 text-sm font-medium" data-task-kind>
            {(["task", "deadline"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={newKind === value}
                onClick={() => chooseKind(value)}
                className={cn("flex-1 rounded-md px-2.5 py-1.5 transition-colors", newKind === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
              >
                {value === "task" ? "タスク" : "⏰ 締切"}
              </button>
            ))}
          </div>
        )}
        {!task && !review && !init?.shareChannelId && (
          <Field label="追加先">
            <select className={SELECT} aria-label="追加先" value={board} disabled={boards.length === 0} onChange={(e) => { setBoard(e.target.value); set({ assigneeIds: [] }); }}>
              {boards.map((id) => (
                <option key={id} value={id}>{boardName(id)}</option>
              ))}
              {!deadline && <option value="me">自分のタスク (自分だけに表示)</option>}
            </select>
          </Field>
        )}
        {!task && (creatingReview || init?.shareChannelId) && (
          <div className="text-xs text-muted" data-task-board>
            {creatingReview ? `${boardName(init?.channelId ?? null)} で共有` : draft.assigneeIds.length > 0 ? `${boardName(init?.shareChannelId ?? null)} で共有` : "担当者を選ぶとこの DM のメンバーに共有します。選ばなければ自分のタスクになります"}
          </div>
        )}
        {task && <div className="text-xs text-muted" data-task-board>{boardName(task.channel_id)}</div>}
        {actsOn && (
          <div className="flex gap-2" data-assignee-actions>
            {task.status === "todo" && (
              <Button type="button" variant="secondary" className="h-11 flex-1 text-[15px]" disabled={busy} onClick={() => void setStatus("doing")}>
                <PlayCircle size={18} /> 対応を始める
              </Button>
            )}
            <Button type="button" className="h-11 flex-1 text-[15px]" disabled={busy} onClick={() => void setStatus("done")}>
              <CheckCircle2 size={18} /> 完了にする
            </Button>
          </div>
        )}
        {editable ? (
          <>
            {creatingReview && picker}
            <Field label="題名">
              <Input autoFocus={!creatingReview} value={draft.title} maxLength={MAX_TASK_TITLE} placeholder="資料をまとめる" onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="メモ">
              <Textarea rows={creatingReview ? 3 : 4} value={draft.notes} maxLength={MAX_TASK_NOTES} placeholder={review ? "見てほしいところなど (Markdown で書けます)" : "Markdown で書けます"} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
            {!creatingReview && (
              <div className="space-y-1">
                <span className="text-xs font-medium text-muted">状態</span>
                <div role="radiogroup" aria-label="状態" className="flex w-full rounded-lg bg-panel-2 p-0.5 text-sm font-medium">
                  {TASK_STATUSES.map((status) => (
                    <button
                      key={status}
                      type="button"
                      role="radio"
                      aria-checked={draft.status === status}
                      onClick={() => set({ status })}
                      className={cn("flex-1 rounded-md px-2.5 py-1.5 transition-colors", draft.status === status ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
                    >
                      {statusLabel(kind, status)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted">{dueName}</span>
              <div className="flex flex-wrap items-center gap-2">
                <Input type="date" aria-label={dueName} className="w-44" value={draft.dueOn} onChange={(e) => set({ dueOn: e.target.value, ...(e.target.value ? {} : { dueTime: "" }) })} />
                {draft.dueOn && (
                  <Input type="time" aria-label="期限の時刻" title="時刻 (空なら終日)" className="w-32" value={draft.dueTime ?? ""} onChange={(e) => set({ dueTime: e.target.value })} />
                )}
                {draft.dueOn && !deadline && (
                  <Button variant="ghost" size="sm" onClick={() => set({ dueOn: "", dueTime: "", repeat: draft.repeat ? { ...draft.repeat, kind: "none" } : draft.repeat })}>
                    <X size={14} /> {review ? "希望日をなくす" : "期限をなくす"}
                  </Button>
                )}
              </div>
            </div>
            {deadline && <NoticeDaysPicker days={draft.noticeDays ?? [...DEFAULT_NOTICE_DAYS]} onChange={(noticeDays) => set({ noticeDays })} />}
            {!review && !deadline && draft.dueOn && draft.repeat && (
              <div className="space-y-1" data-task-repeat>
                <span className="text-xs font-medium text-muted">繰り返し</span>
                <RepeatPicker repeat={draft.repeat} start={draft.dueOn} onChange={(repeat) => set({ repeat })} />
                {draft.repeat.kind !== "none" && <p className="text-xs text-muted">完了にすると、次の回のタスクができます</p>}
              </div>
            )}
            {!creatingReview && <SubtaskEditor items={draft.subtasks ?? []} onChange={(subtasks) => set({ subtasks })} onToggle={toggleSubtask} />}
            {!creatingReview && picker}
          </>
        ) : (
          task && <ReadOnlyTask controller={controller} task={task} />
        )}
        {source.kind === "link" && (
          <div className="flex items-start gap-2 rounded-lg bg-panel-2 px-3 py-2 text-sm" data-task-source>
            <MessageSquareText size={15} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-muted">元のメッセージ</div>
              {source.excerpt && <div className="line-clamp-2 break-words">{source.excerpt}</div>}
            </div>
            {task && (
              <Button variant="secondary" size="sm" className="shrink-0" onClick={() => openMessage(source.messageId)}>
                メッセージを開く
              </Button>
            )}
          </div>
        )}
        {source.kind === "deleted" && (
          <div className="flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-2 text-sm text-muted" data-task-source>
            <MessageSquareText size={15} className="shrink-0" /> 元のメッセージは削除されました
          </div>
        )}
        {canvasSource.kind !== "none" && (
          <div className="flex items-start gap-2 rounded-lg bg-panel-2 px-3 py-2 text-sm" data-task-canvas-source>
            <FileText size={15} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-muted">
                {canvasSource.kind === "deleted" ? "元のキャンバスは削除されました" : canvasTitle ? `元のキャンバス: ${canvasTitle}` : "元のキャンバス"}
              </div>
              {canvasSource.excerpt && <div className="line-clamp-2 break-words">{canvasSource.excerpt}</div>}
            </div>
            {task && canvasSource.kind === "link" && (
              <Button variant="secondary" size="sm" className="shrink-0" onClick={() => openCanvas(canvasSource.canvasId)}>
                キャンバスを開く
              </Button>
            )}
          </div>
        )}
        {!hub?.available && <p className="text-sm text-muted">このサーバはタスクに対応していません</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {confirmDelete ? (
          <div className="flex items-center justify-end gap-2 rounded-lg bg-danger/10 px-3 py-2">
            <span className="mr-auto text-sm">{review ? "このレビュー依頼を削除しますか？" : deadline ? "この締切を削除しますか？ (前もっての通知も止まります)" : "このタスクを削除しますか？"}</span>
            <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>キャンセル</Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>削除する</Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 pt-1">
            {task?.can_delete && (
              <Button variant="ghost" className="mr-auto text-danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} /> 削除
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>{editable ? "キャンセル" : "閉じる"}</Button>
            {editable && (
              <Button type="submit" disabled={busy || !!problem || !hub?.available}>{task ? "保存" : creatingReview ? "依頼する" : "追加"}</Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}

/** 担当者 (a review request: 依頼先): the conversation's members, each a toggle (avatars and names; a filter once there are many). */
function AssigneePicker({ controller, channelId, label, excludeMe = false, selected, onChange }: {
  controller: AppController;
  channelId: string;
  label: string;
  /** A new review request: asking myself makes no sense. */
  excludeMe?: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [members] = useMembers(controller, channelId);
  const [query, setQuery] = useState("");
  const users = controller.store.users;
  const me = controller.store.me?.id ?? null;
  const rows = (members ?? [])
    .filter((m) => !excludeMe || m.user_id !== me)
    .map((m) => ({ id: m.user_id, name: users.get(m.user_id)?.display_name ?? "?", username: users.get(m.user_id)?.username ?? "" }))
    // Me first, then by name.
    .sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name, "ja"));
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q)) : rows;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted">{label}{selected.length > 0 ? ` (${selected.length} 人)` : ""}</span>
      {members === null ? (
        <p className="text-sm text-muted">読み込み中…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">選べる人がいません</p>
      ) : (
        <>
          {rows.length > 8 && <Input value={query} aria-label={`${label}を絞り込む`} placeholder="名前で絞り込む" className="h-8 text-sm" onChange={(e) => setQuery(e.target.value)} />}
          <ul role="group" aria-label={label} className="max-h-44 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {shown.map((row) => (
              <li key={row.id}>
                <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-panel">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={selected.includes(row.id)} onChange={() => toggle(row.id)} aria-label={row.name} />
                  <Avatar id={row.id} name={row.name} size={22} />
                  <span className="min-w-0 flex-1 truncate">
                    {row.name}
                    {row.id === me && <span className="ml-1 text-xs text-muted">(自分)</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** What someone who may not change the task sees of it. */
function ReadOnlyTask({ controller, task }: { controller: AppController; task: TaskOut }) {
  const users = controller.store.users;
  const today = todayKey();
  return (
    <div className="space-y-2.5">
      <div className={cn("break-words text-[15px] font-semibold", task.status === "done" && "text-muted line-through")}>{task.title}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted">状態</dt>
        <dd>{statusLabel(task.kind, task.status as TaskStatus)}</dd>
        <dt className="text-muted">{task.kind === "review" ? "希望日" : task.kind === "deadline" ? "締切日" : "期限"}</dt>
        <dd>{task.due_on ? `${dueText(task, "")}${task.due_on === today ? " (今日)" : ""}` : "なし"}</dd>
        {task.kind === "deadline" && (
          <>
            <dt className="text-muted">事前の通知</dt>
            <dd>{noticeSummary(task.notice_days)}</dd>
          </>
        )}
        {task.rrule && (
          <>
            <dt className="text-muted">繰り返し</dt>
            <dd className="inline-flex items-center gap-1"><Repeat size={13} /> {describeRrule(task.rrule, task.due_on ?? today)}</dd>
          </>
        )}
        {subtaskProgress(task) && (
          <>
            <dt className="text-muted">サブタスク</dt>
            <dd>
              <ul className="space-y-0.5">
                {(task.subtasks ?? []).map((item) => (
                  <li key={item.id} className={cn(item.done && "text-muted line-through")}>{item.done ? "☑" : "☐"} {item.title}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {task.channel_id && (
          <>
            <dt className="text-muted">{task.kind === "review" ? "依頼先" : "担当者"}</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1">
              {task.assignee_ids.length === 0 && "なし"}
              {task.assignee_ids.map((id) => (
                <span key={id} className="inline-flex items-center gap-1">
                  <Avatar id={id} name={users.get(id)?.display_name ?? "?"} size={18} />
                  {users.get(id)?.display_name ?? "?"}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
      {task.notes && <p className="whitespace-pre-wrap break-words rounded-lg bg-panel-2 px-3 py-2 text-sm">{task.notes}</p>}
      <p className="text-xs text-muted">{task.channel_id && task.channel_name ? "このボードを変更できるのは、チャンネルに投稿できるメンバーです。" : "変更できるのは、この会話のメンバーです。"}</p>
    </div>
  );
}

/** M81: 「サブタスク」 — checkboxes, editable titles, ↑ / ↓, × and 「＋ サブタスクを追加」 (Enter adds the next one). */
function SubtaskEditor({ items, onChange, onToggle }: { items: SubtaskDraft[]; onChange: (items: SubtaskDraft[]) => void; onToggle: (index: number) => void }) {
  const [adding, setAdding] = useState("");
  const done = items.filter((i) => i.done).length;
  const update = (index: number, patch: Partial<SubtaskDraft>) => onChange(items.map((i, k) => (k === index ? { ...i, ...patch } : i)));
  const swap = (index: number, to: number) => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    [next[index], next[to]] = [next[to]!, next[index]!];
    onChange(next);
  };
  const add = () => {
    const title = adding.trim();
    if (!title || items.length >= MAX_SUBTASKS) return;
    onChange([...items, { id: null, title, done: false }]);
    setAdding("");
  };
  return (
    <div className="space-y-1" data-subtask-editor>
      <span className="text-xs font-medium text-muted">サブタスク{items.length > 0 ? ` (${done}/${items.length})` : ""}</span>
      {items.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {items.map((item, index) => (
            <li key={item.id ?? `new-${index}`} className="group/sub flex items-center gap-2 px-2 py-1" data-subtask>
              <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--accent)]" checked={item.done} aria-label={`「${item.title}」を完了`} onChange={() => onToggle(index)} />
              <input
                className={cn("min-w-0 flex-1 bg-transparent text-sm outline-none", item.done && "text-muted line-through")}
                value={item.title}
                maxLength={MAX_TASK_TITLE}
                aria-label="サブタスクの題名"
                onChange={(e) => update(index, { title: e.target.value })}
              />
              <span className="flex shrink-0 items-center opacity-60 group-hover/sub:opacity-100">
                <button type="button" className="rounded p-0.5 hover:bg-ink/6 disabled:opacity-30" aria-label="上へ" disabled={index === 0} onClick={() => swap(index, index - 1)}><ArrowUp size={13} /></button>
                <button type="button" className="rounded p-0.5 hover:bg-ink/6 disabled:opacity-30" aria-label="下へ" disabled={index === items.length - 1} onClick={() => swap(index, index + 1)}><ArrowDown size={13} /></button>
                <button type="button" className="rounded p-0.5 hover:bg-ink/6" aria-label="サブタスクを削除" onClick={() => onChange(items.filter((_, k) => k !== index))}><X size={13} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {items.length < MAX_SUBTASKS && (
        <div className="flex items-center gap-1">
          <Plus size={14} className="shrink-0 text-muted" />
          <input
            className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted focus:bg-panel"
            value={adding}
            maxLength={MAX_TASK_TITLE}
            placeholder="サブタスクを追加 (Enter)"
            aria-label="サブタスクを追加"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
          />
        </div>
      )}
    </div>
  );
}

/** M85: 「事前の通知」 — the days before a deadline the 「締切」 bot posts in its channel (at 9:00). */
function NoticeDaysPicker({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  // The usual choices, and any other day the deadline already has (set elsewhere).
  const choices = [...new Set([...NOTICE_CHOICES, ...days])].sort((a, b) => b - a);
  const toggle = (day: number) => onChange(days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => b - a));
  return (
    <div className="space-y-1" data-notice-days>
      <span className="text-xs font-medium text-muted">事前の通知</span>
      <div role="group" aria-label="事前の通知" className="flex flex-wrap gap-x-3 gap-y-1">
        {choices.map((day) => (
          <label key={day} className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={days.includes(day)} onChange={() => toggle(day)} />
            {noticeLabel(day)}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted">{days.length === 0 ? "チャンネルには知らせません" : "「締切」のボットがこのチャンネルに、その日の 9:00 に投稿します (時刻付きの締切は、その時刻より前のものだけ)"}</p>
    </div>
  );
}
