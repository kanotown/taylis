/**
 * M85 (L5, docs/DEADLINES.md): 「締切」 in the sidebar (a phone's home tile) — the deadlines of my channels grouped
 * 今週 / 今月 / それ以降 / 過ぎたもの, each card saying its channel, 「＋ 締切を追加」 (a channel I may change the board
 * of) — and the channel header's chip (the channel's next open deadline: 「全国大会 原稿 あと 3 日」; it opens the
 * deadline). Both read the task hub's deadlines window (GET /tasks/deadlines, kept by task.updated / task.deleted).
 */
import { AlarmClock, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { TaskOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { BackButton } from "./compact";
import { deadlineChipText, deadlineGroups, deadlineTone, deadlineWhen, nextDeadline, noticeSummary } from "./deadlines";
import { Button, cn } from "./primitives";
import { TaskCard, useTaskHub, useToday } from "./TaskBoard";
import { TaskDialog } from "./TaskDialog";
import { canEditBoard, hasBoard, type TaskCreateInit } from "./tasks";

/** The channels whose board I may add a deadline to, by name. */
export function deadlineChannels(controller: AppController): string[] {
  return [...controller.store.channels.values()]
    .filter((c) => c.isMember && hasBoard(c) && canEditBoard(c, controller.isAdmin))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"))
    .map((c) => c.id);
}

/** A new deadline's dialog: on `channelId`'s board, or the first of mine. */
export function newDeadlineInit(controller: AppController, channelId: string | null): TaskCreateInit | null {
  const choices = deadlineChannels(controller);
  const board = channelId && choices.includes(channelId) ? channelId : (choices[0] ?? null);
  if (!board) return null;
  return { channelId: board, status: "todo", title: "", kind: "deadline", boardChoices: choices };
}

/** The header's chip: the channel's next open deadline (nothing when it has none). */
export function DeadlineChip({ controller, channel, onOpen }: { controller: AppController; channel: ChannelState; onOpen: (task: TaskOut) => void }) {
  const hub = useTaskHub(controller);
  const today = useToday();
  useEffect(() => {
    if (hub?.available) void hub.openDeadlines();
  }, [hub]);
  const list = hub?.deadlineList();
  const next = list ? nextDeadline(list.tasks, channel.id, today) : null;
  if (!next) return null;
  const tone = deadlineTone(next, today);
  return (
    <button
      type="button"
      data-deadline-chip={next.id}
      title={`締切: ${next.title} (${deadlineWhen(next, today)})`}
      onClick={() => onOpen(next)}
      className={cn(
        "inline-flex min-w-0 max-w-[16rem] shrink-[50] items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "soon" ? "bg-danger/10 text-danger" : tone === "week" ? "bg-warning/15 text-ink" : "bg-panel-2 text-muted",
      )}
    >
      <AlarmClock size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{deadlineChipText(next, today)}</span>
    </button>
  );
}

export function DeadlinesView({ controller }: { controller: AppController }) {
  const hub = useTaskHub(controller);
  const today = useToday();
  const [dialog, setDialog] = useState<TaskOut | null>(null);
  const [creating, setCreating] = useState<TaskCreateInit | null>(null);
  useEffect(() => {
    if (hub?.available) void hub.openDeadlines();
  }, [hub]);
  const store = controller.store;
  const list = hub?.deadlineList();
  const tasks = useMemo(() => (list?.tasks ?? []).filter((t) => !t.channel_id || store.getChannel(t.channel_id)?.isMember !== false), [list, store]);
  const groups = deadlineGroups(tasks, today);
  const loading = !list || list.state === "loading";
  const note =
    list?.state === "unsupported" ? "このサーバは締切に対応していません" : list?.state === "failed" ? "締切を読み込めませんでした。再接続すると読み直します" : !hub?.available ? "このサーバはタスクに対応していません" : null;
  const addInit = newDeadlineInit(controller, null);
  const place = (task: TaskOut) => {
    const channel = task.channel_id ? store.getChannel(task.channel_id) : undefined;
    return `#${channel?.name ?? task.channel_name ?? "?"}`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:px-2">
        <BackButton />
        <span className="text-muted max-md:hidden"><AlarmClock size={18} /></span>
        <strong className="text-[15px]">締切</strong>
        <Button size="sm" className="ml-auto" disabled={!addInit || !hub?.available} onClick={() => setCreating(addInit)} aria-label="締切を追加">
          <Plus size={14} /> <span className="max-md:hidden">締切を追加</span>
        </Button>
      </header>
      {note && <div className="border-b border-line bg-warning/10 px-4 py-1.5 text-xs text-muted">{note}</div>}
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-4 max-md:px-3">
        <div className="mx-auto max-w-2xl space-y-6">
          <p className="text-xs text-muted">参加しているチャンネルの締切です。締切の前に「締切」のボットがチャンネルで知らせます (既定は 7 日前・3 日前・前日・当日の 9:00)。</p>
          {groups.length === 0 && <p className="text-sm text-muted">{loading ? "読み込み中…" : "締切はありません"}</p>}
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label} data-deadline-group={group.key} className="space-y-2">
              <h2 className="text-sm font-semibold">
                {group.label} <span className="ml-1 text-xs font-normal text-muted">{group.tasks.length}</span>
              </h2>
              <ul className="space-y-1.5">
                {group.tasks.map((task) => (
                  <li key={task.id} data-deadline-row={task.id} className="flex items-stretch gap-2">
                    <div
                      className={cn(
                        "w-24 shrink-0 pt-2 text-right text-xs tabular-nums",
                        group.key === "past" ? "text-muted" : deadlineTone(task, today) === "soon" ? "font-semibold text-danger" : "text-ink",
                      )}
                      title={noticeSummary(task.notice_days)}
                    >
                      {deadlineWhen(task, today)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <TaskCard controller={controller} task={task} today={today} place={place(task)} showStatus onOpen={setDialog} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
      {dialog && <TaskDialog controller={controller} task={hub?.find(dialog.id) ?? dialog} onClose={() => setDialog(null)} />}
      {creating && <TaskDialog controller={controller} task={null} init={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}
