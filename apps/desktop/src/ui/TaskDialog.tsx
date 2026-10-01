/**
 * M55 (TASKS.md §6): a task's dialog — 題名, メモ (Markdown text), 状態, 期限, 担当者 (the channel's members; not for a
 * personal task), the message it came from, 削除. New tasks too (「タスクにする」, 「自分のタスク」), with where they
 * go (a channel's board or 「自分のタスク」). Someone who may not edit the board sees the task read-only.
 */
import { MessageSquareText, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { describeError } from "../api/errors";
import type { TaskCreate, TaskOut, TaskStatus } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { localZone, today as todayKey } from "./calendarDates";
import { useMembers } from "./Dialogs";
import { Button, cn, Field, Input, Modal, Textarea } from "./primitives";
import {
  canEditBoard,
  canEditTask,
  cleanTitle,
  draftFromTask,
  MAX_TASK_NOTES,
  MAX_TASK_TITLE,
  sourceState,
  STATUS_LABELS,
  TASK_STATUSES,
  type TaskCreateInit,
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
  const [draft, setDraft] = useState<TaskDraft>(() =>
    task ? draftFromTask(task) : { title: init?.title ?? "", notes: "", status: init?.status ?? "todo", dueOn: "", assigneeIds: [] },
  );
  /** New: the board ("me" or a channel id). */
  const [board, setBoard] = useState<string>(() => init?.channelId ?? "me");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const clientId = useRef(crypto.randomUUID());
  const channelId = task ? task.channel_id : board === "me" ? null : board;
  const channel = channelId ? store.getChannel(channelId) : undefined;
  const editable = task ? canEditTask(task, channel, controller.isAdmin) : true;
  const problem = editable ? taskDraftProblem(draft) : null;
  const boards = useMemo(() => (init?.boardChoices ?? []).filter((id) => canEditBoard(store.getChannel(id), controller.isAdmin)), [init, store, controller.isAdmin]);
  const set = (patch: Partial<TaskDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
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
        const body: TaskCreate = {
          title: cleanTitle(draft.title),
          status: draft.status,
          client_task_id: clientId.current,
          tz: localZone(),
          ...(channelId ? { channel_id: channelId } : {}),
          ...(draft.notes.trim() ? { notes: draft.notes } : {}),
          ...(draft.dueOn ? { due_on: draft.dueOn } : {}),
          ...(channelId && draft.assigneeIds.length > 0 ? { assignee_ids: draft.assigneeIds } : {}),
          ...(init?.sourceMessageId ? { source_message_id: init.sourceMessageId } : {}),
        };
        await hub.create(body);
        controller.setNotice("タスクを作成しました");
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

  const boardName = (id: string | null) => (id ? `#${store.getChannel(id)?.name ?? task?.channel_name ?? "?"} のボード` : "自分のタスク");
  const title = !task ? "タスクを追加" : editable ? "タスクを編集" : "タスク";
  const source = task ? sourceState(task) : init?.sourceMessageId ? { kind: "link" as const, messageId: init.sourceMessageId, excerpt: init.sourceExcerpt ?? null } : { kind: "none" as const };

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
        {!task && (
          <Field label="追加先">
            <select className={SELECT} aria-label="追加先" value={board} disabled={boards.length === 0} onChange={(e) => { setBoard(e.target.value); set({ assigneeIds: [] }); }}>
              {boards.map((id) => (
                <option key={id} value={id}>{boardName(id)}</option>
              ))}
              <option value="me">自分のタスク (自分だけに表示)</option>
            </select>
          </Field>
        )}
        {task && <div className="text-xs text-muted" data-task-board>{boardName(task.channel_id)}</div>}
        {editable ? (
          <>
            <Field label="題名">
              <Input autoFocus value={draft.title} maxLength={MAX_TASK_TITLE} placeholder="資料をまとめる" onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="メモ">
              <Textarea rows={4} value={draft.notes} maxLength={MAX_TASK_NOTES} placeholder="Markdown で書けます" onChange={(e) => set({ notes: e.target.value })} />
            </Field>
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
                    {STATUS_LABELS[status]}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted">期限</span>
              <div className="flex items-center gap-2">
                <Input type="date" aria-label="期限" className="w-44" value={draft.dueOn} onChange={(e) => set({ dueOn: e.target.value })} />
                {draft.dueOn && (
                  <Button variant="ghost" size="sm" onClick={() => set({ dueOn: "" })}>
                    <X size={14} /> 期限をなくす
                  </Button>
                )}
              </div>
            </div>
            {channelId && <AssigneePicker controller={controller} channelId={channelId} selected={draft.assigneeIds} onChange={(assigneeIds) => set({ assigneeIds })} />}
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
        {!hub?.available && <p className="text-sm text-muted">このサーバはタスクに対応していません</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {confirmDelete ? (
          <div className="flex items-center justify-end gap-2 rounded-lg bg-danger/10 px-3 py-2">
            <span className="mr-auto text-sm">このタスクを削除しますか？</span>
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
              <Button type="submit" disabled={busy || !!problem || !hub?.available}>{task ? "保存" : "追加"}</Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}

/** 担当者: the channel's members, each a toggle (avatars and names; a filter once there are many). */
function AssigneePicker({ controller, channelId, selected, onChange }: {
  controller: AppController;
  channelId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [members] = useMembers(controller, channelId);
  const [query, setQuery] = useState("");
  const users = controller.store.users;
  const me = controller.store.me?.id ?? null;
  const rows = (members ?? [])
    .map((m) => ({ id: m.user_id, name: users.get(m.user_id)?.display_name ?? "?", username: users.get(m.user_id)?.username ?? "" }))
    // Me first, then by name.
    .sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name, "ja"));
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q)) : rows;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted">担当者{selected.length > 0 ? ` (${selected.length} 人)` : ""}</span>
      {members === null ? (
        <p className="text-sm text-muted">読み込み中…</p>
      ) : (
        <>
          {rows.length > 8 && <Input value={query} aria-label="担当者を絞り込む" placeholder="名前で絞り込む" className="h-8 text-sm" onChange={(e) => setQuery(e.target.value)} />}
          <ul role="group" aria-label="担当者" className="max-h-44 divide-y divide-line overflow-y-auto rounded-lg border border-line">
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
        <dd>{STATUS_LABELS[task.status as TaskStatus]}</dd>
        <dt className="text-muted">期限</dt>
        <dd>{task.due_on ? `${task.due_on.replaceAll("-", "/")}${task.due_on === today ? " (今日)" : ""}` : "なし"}</dd>
        {task.channel_id && (
          <>
            <dt className="text-muted">担当者</dt>
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
      <p className="text-xs text-muted">このボードを変更できるのは、チャンネルに投稿できるメンバーです。</p>
    </div>
  );
}
