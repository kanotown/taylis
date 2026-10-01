/**
 * M55 (TASKS.md §6): 「タスク」 in the sidebar (a phone's home tile) — 「自分のタスク」, my personal list (a checkbox
 * completes a task, 「＋ 追加」 adds one, the completed ones fold under 「完了 (N)」), and 「自分の担当」, the shared tasks
 * assigned to me, by channel (its name opens that channel's 「タスク」 tab).
 */
import { ChevronDown, ChevronRight, Hash, ListTodo, Lock, Plus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { TaskOut } from "../api/types";
import type { AppController } from "../state/app";
import { localZone } from "./calendarDates";
import { BackButton } from "./compact";
import { Button, cn } from "./primitives";
import { InlineAdd, TaskCard, useTaskHub, useToday } from "./TaskBoard";
import { TaskDialog } from "./TaskDialog";
import { canEditTask, groupMineByChannel, splitOpenDone } from "./tasks";

export function MyTasksView({ controller, onOpenBoard, onOpenMessage }: {
  controller: AppController;
  /** A channel's 「タスク」 tab. */
  onOpenBoard: (channelId: string) => void;
  onOpenMessage?: (messageId: string) => void;
}) {
  const hub = useTaskHub(controller);
  const today = useToday();
  const [dialog, setDialog] = useState<TaskOut | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!hub) return;
    void hub.openMine();
    return () => hub.closeMine();
  }, [hub]);
  const list = hub?.mineList();
  const me = controller.store.me?.id ?? null;
  const { personal, groups } = groupMineByChannel(list?.tasks ?? [], me, (id) => controller.store.getChannel(id)?.name ?? null);
  const loading = !list || list.state === "loading";
  const note = list?.state === "unsupported" ? "このサーバはタスクに対応していません" : list?.state === "failed" ? "タスクを読み込めませんでした。再接続すると読み直します" : null;

  const toggleDone = (task: TaskOut) => {
    if (!hub) return;
    void hub.update(task.id, { status: task.status === "done" ? "todo" : "done" }).catch((err: unknown) => controller.setError(err));
  };
  const addPersonal = async (title: string): Promise<boolean> => {
    if (!hub) return false;
    try {
      await hub.create({ title, status: "todo", client_task_id: crypto.randomUUID(), tz: localZone() });
      return true;
    } catch (err) {
      controller.setError(err);
      return false;
    }
  };
  const card = (task: TaskOut, showStatus = true) => {
    const editable = canEditTask(task, task.channel_id ? controller.store.getChannel(task.channel_id) : undefined, controller.isAdmin);
    return (
      <TaskCard
        key={task.id}
        controller={controller}
        task={task}
        today={today}
        showStatus={showStatus}
        onOpen={setDialog}
        onOpenMessage={onOpenMessage ?? ((id) => void controller.openPermalink(id))}
        leading={
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
            checked={task.status === "done"}
            disabled={!editable || !hub?.available}
            aria-label={task.status === "done" ? `「${task.title}」を未完了に戻す` : `「${task.title}」を完了にする`}
            onChange={() => toggleDone(task)}
          />
        }
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:px-2">
        <BackButton />
        <span className="text-muted max-md:hidden"><ListTodo size={18} /></span>
        <strong className="text-[15px]">タスク</strong>
        <Button size="sm" className="ml-auto" disabled={!hub?.available} onClick={() => setCreating(true)} aria-label="タスクを追加">
          <Plus size={14} /> <span className="max-md:hidden">タスクを追加</span>
        </Button>
      </header>
      {note && <div className="border-b border-line bg-warning/10 px-4 py-1.5 text-xs text-muted">{note}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 max-md:px-3">
        <div className="mx-auto max-w-2xl space-y-8">
          <section aria-label="自分のタスク" className="space-y-2">
            <h2 className="text-sm font-semibold">自分のタスク <span className="ml-1 text-xs font-normal text-muted">自分だけに表示</span></h2>
            <TaskList
              tasks={personal}
              loading={loading}
              empty="個人用のタスクはまだありません"
              render={(task) => card(task)}
              footer={hub?.available ? <InlineAdd onAdd={addPersonal} /> : null}
            />
          </section>
          <section aria-label="自分の担当" className="space-y-3">
            <h2 className="text-sm font-semibold">自分の担当</h2>
            {groups.length === 0 && <p className="text-sm text-muted">{loading ? "読み込み中…" : "担当のタスクはありません"}</p>}
            {groups.map((group) => {
              const channel = controller.store.getChannel(group.channelId);
              return (
                <div key={group.channelId} className="space-y-1.5" data-mine-group={group.channelId}>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-md text-[13px] font-semibold text-muted hover:text-ink hover:underline"
                    title={`#${group.channelName} のタスクを開く`}
                    onClick={() => onOpenBoard(group.channelId)}
                  >
                    {channel?.type === "private" ? <Lock size={13} /> : <Hash size={13} />}
                    {group.channelName}
                  </button>
                  <TaskList tasks={group.tasks} loading={false} empty="" render={(task) => card(task)} />
                </div>
              );
            })}
          </section>
        </div>
      </div>
      {dialog && <TaskDialog controller={controller} task={hub?.find(dialog.id) ?? dialog} onClose={() => setDialog(null)} onOpenMessage={onOpenMessage} />}
      {creating && <TaskDialog controller={controller} task={null} init={{ channelId: null, status: "todo", title: "" }} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Open tasks (by status, then the board's order), then the completed ones folded under 「完了 (N)」. */
function TaskList({ tasks, loading, empty, render, footer }: {
  tasks: TaskOut[];
  loading: boolean;
  empty: string;
  render: (task: TaskOut) => ReactNode;
  footer?: ReactNode;
}) {
  const [showDone, setShowDone] = useState(false);
  const { open, done } = splitOpenDone(tasks);
  return (
    <div className="space-y-1.5">
      {open.length === 0 && done.length === 0 && empty && <p className="text-sm text-muted">{loading ? "読み込み中…" : empty}</p>}
      {open.map(render)}
      {footer}
      {done.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showDone}
            className={cn("flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-muted hover:text-ink")}
            onClick={() => setShowDone((v) => !v)}
          >
            {showDone ? <ChevronDown size={13} /> : <ChevronRight size={13} />} 完了 ({done.length})
          </button>
          {showDone && done.map(render)}
        </>
      )}
    </div>
  );
}
