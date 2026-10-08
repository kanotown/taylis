/**
 * M55 (TASKS.md §6): 「タスク」 in the sidebar (a phone's home tile) — 「自分のタスク」, my personal list (a checkbox
 * completes a task, 「＋ 追加」 adds one, the completed ones fold under 「完了 (N)」), and 「自分の担当」, the shared tasks
 * assigned to me, by channel (its name opens that channel's 「タスク」 tab; a DM has no board, its name is only a label).
 * L9 (REVIEWS.md §2.3): 「自分が依頼した」, the shared tasks I made for someone else (my review requests), by due date,
 * each saying where it lives.
 */
import { ChevronDown, ChevronRight, Hash, ListTodo, Lock, MessageCircle, Plus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { TaskOut } from "../api/types";
import type { AppController } from "../state/app";
import { localZone } from "./calendarDates";
import { conversationTitle } from "./channels";
import { BackButton } from "./compact";
import { Button, cn } from "./primitives";
import { InlineAdd, TaskCard, useTaskHub, useToday } from "./TaskBoard";
import { TaskDialog } from "./TaskDialog";
import { canEditTask, groupMineByChannel, hasBoard, sortRequested, splitOpenDone, taskBoardChoices, taskPlace } from "./tasks";
import { t } from "../i18n";

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
    void hub.openRequested();
    return () => {
      hub.closeMine();
      hub.closeRequested();
    };
  }, [hub]);
  const store = controller.store;
  const list = hub?.mineList();
  const requested = hub?.requestedList();
  const me = store.me?.id ?? null;
  /** A DM (no channel name) by its other members. */
  const dmTitle = (id: string) => {
    const channel = store.getChannel(id);
    return channel && !hasBoard(channel) ? conversationTitle(channel, store.users, me, store.me) : null;
  };
  const { personal, groups } = groupMineByChannel(list?.tasks ?? [], me, (id) => store.getChannel(id)?.name || dmTitle(id));
  const loading = !list || list.state === "loading";
  const note = list?.state === "unsupported" ? t("tasks.unsupported") : list?.state === "failed" ? t("tasks.board.loadFailed") : null;

  const toggleDone = (task: TaskOut) => {
    if (!hub) return;
    void hub.update(task.id, { status: task.status === "done" ? "todo" : "done" }).catch((err: unknown) => controller.setError(err));
  };
  const addPersonal = async (title: string): Promise<boolean> => {
    if (!hub) return false;
    try {
      await hub.create({ title, status: "todo", kind: "task", client_task_id: crypto.randomUUID(), tz: localZone() });
      return true;
    } catch (err) {
      controller.setError(err);
      return false;
    }
  };
  const card = (task: TaskOut, options: { checkbox?: boolean; place?: boolean } = {}) => {
    const editable = canEditTask(task, task.channel_id ? store.getChannel(task.channel_id) : undefined, controller.isAdmin);
    return (
      <TaskCard
        key={task.id}
        controller={controller}
        task={task}
        today={today}
        showStatus
        place={options.place ? taskPlace(task, dmTitle) : undefined}
        onOpen={setDialog}
        onOpenMessage={onOpenMessage ?? ((id) => void controller.openPermalink(id))}
        leading={
          options.checkbox === false ? undefined : (
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
              checked={task.status === "done"}
              disabled={!editable || !hub?.available}
              aria-label={task.status === "done" ? t("myTasks.reopen", { title: task.title }) : t("myTasks.complete", { title: task.title })}
              onChange={() => toggleDone(task)}
            />
          )
        }
      />
    );
  };
  const requestedLoading = !requested || requested.state === "loading";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:px-2">
        <BackButton />
        <span className="text-muted max-md:hidden"><ListTodo size={18} /></span>
        <strong className="text-[15px]">{t("nav.tasks")}</strong>
        <Button size="sm" className="ml-auto" disabled={!hub?.available} onClick={() => setCreating(true)} aria-label={t("tasks.dialog.addTask")}>
          <Plus size={14} /> <span className="max-md:hidden">{t("tasks.dialog.addTask")}</span>
        </Button>
      </header>
      {note && <div className="border-b border-line bg-warning/10 px-4 py-1.5 text-xs text-muted">{note}</div>}
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-4 max-md:px-3">
        <div className="mx-auto max-w-2xl space-y-8">
          <section aria-label={t("tasks.myTasks")} className="space-y-2">
            <h2 className="text-sm font-semibold">{t("tasks.myTasks")} <span className="ml-1 text-xs font-normal text-muted">{t("myTasks.onlyYou")}</span></h2>
            <TaskList
              tasks={personal}
              loading={loading}
              empty={t("myTasks.noPersonal")}
              render={(task) => card(task)}
              footer={hub?.available ? <InlineAdd onAdd={addPersonal} /> : null}
            />
          </section>
          <section aria-label={t("myTasks.assigned")} className="space-y-3">
            <h2 className="text-sm font-semibold">{t("myTasks.assigned")}</h2>
            {groups.length === 0 && <p className="text-sm text-muted">{loading ? t("common.loading") : t("myTasks.noAssigned")}</p>}
            {groups.map((group) => {
              const channel = store.getChannel(group.channelId);
              const board = !channel || hasBoard(channel);
              return (
                <div key={group.channelId} className="space-y-1.5" data-mine-group={group.channelId}>
                  {board ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-md text-[13px] font-semibold text-muted hover:text-ink hover:underline"
                      title={t("myTasks.openBoard", { name: group.channelName })}
                      onClick={() => onOpenBoard(group.channelId)}
                    >
                      {channel?.type === "private" ? <Lock size={13} /> : <Hash size={13} />}
                      {group.channelName}
                    </button>
                  ) : (
                    // L9: a DM's tasks (no board to open).
                    <div className="flex items-center gap-1 text-[13px] font-semibold text-muted" data-dm-group>
                      <MessageCircle size={13} /> {group.channelName}
                    </div>
                  )}
                  <TaskList tasks={group.tasks} loading={false} empty="" render={(task) => card(task)} />
                </div>
              );
            })}
          </section>
          {requested?.state !== "unsupported" && (
            <section aria-label={t("myTasks.requested")} className="space-y-2">
              <h2 className="text-sm font-semibold">{t("myTasks.requested")} <span className="ml-1 text-xs font-normal text-muted">{t("myTasks.requestedNote")}</span></h2>
              {requested?.state === "failed" && <p className="text-xs text-muted">{t("myTasks.loadFailed")}</p>}
              <TaskList
                tasks={requested?.tasks ?? []}
                loading={requestedLoading}
                empty={t("myTasks.noRequested")}
                split={sortRequested}
                render={(task) => card(task, { checkbox: false, place: true })}
              />
            </section>
          )}
        </div>
      </div>
      {dialog && <TaskDialog controller={controller} task={hub?.find(dialog.id) ?? dialog} onClose={() => setDialog(null)} onOpenMessage={onOpenMessage} />}
      {creating && <TaskDialog controller={controller} task={null} init={{ channelId: null, status: "todo", title: "", boardChoices: taskBoardChoices(store.channels.values(), controller.isAdmin) }} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Open tasks (by status, then the board's order; or `split`'s), then the completed ones folded under 「完了 (N)」. */
function TaskList({ tasks, loading, empty, render, footer, split = splitOpenDone }: {
  tasks: TaskOut[];
  loading: boolean;
  empty: string;
  render: (task: TaskOut) => ReactNode;
  footer?: ReactNode;
  split?: (tasks: readonly TaskOut[]) => { open: TaskOut[]; done: TaskOut[] };
}) {
  const [showDone, setShowDone] = useState(false);
  const { open, done } = split(tasks);
  return (
    <div className="space-y-1.5">
      {open.length === 0 && done.length === 0 && empty && <p className="text-sm text-muted">{loading ? t("common.loading") : empty}</p>}
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
            {showDone ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t("myTasks.done", { count: done.length })}
          </button>
          {showDone && done.map(render)}
        </>
      )}
    </div>
  );
}
