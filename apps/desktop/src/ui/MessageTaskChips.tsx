/**
 * L9 (REVIEWS.md §2.2): one chip per shared task made from a message, under it — 「レビュー依頼 · 加納 · 依頼中 · 10/9
 * まで」. It reads only the message (`tasks`, changed through message.updated change="tasks") and the users (the row's
 * `rowsVersion`), so the memoized row re-renders it when it changes. A click opens the task's dialog (read from the
 * server: the chip carries only what it shows).
 */
import { ClipboardCheck, ListTodo } from "lucide-react";
import { useState } from "react";

import type { MessageTaskOut, TaskOut } from "../api/types";
import type { AppController } from "../state/app";
import { today as todayKey } from "./calendarDates";
import { cn } from "./primitives";
import { TaskDialog } from "./TaskDialog";
import { taskChip } from "./tasks";
import { t } from "../i18n";

const TONES = {
  open: "border-line bg-panel text-ink hover:border-accent/50",
  overdue: "border-danger/40 bg-danger/10 text-danger hover:border-danger/70",
  done: "border-line bg-panel-2 text-muted hover:text-ink",
} as const;

export function MessageTaskChips({ controller, tasks, readOnly = false }: { controller: AppController; tasks: readonly MessageTaskOut[]; readOnly?: boolean }) {
  const [open, setOpen] = useState<TaskOut | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const users = controller.store.users;
  const today = todayKey();
  const show = async (taskId: string) => {
    if (loading) return;
    setLoading(taskId);
    try {
      const task = await controller.loadTask(taskId);
      if (task) setOpen(task);
    } finally {
      setLoading(null);
    }
  };
  return (
    <>
      <div className="mt-1 flex flex-wrap gap-1" data-message-tasks>
        {tasks.map((task) => {
          const chip = taskChip(task, (id) => users.get(id)?.display_name ?? null, today);
          const Icon = task.kind === "review" ? ClipboardCheck : ListTodo;
          return (
            <button
              key={task.id}
              type="button"
              data-task-chip={task.id}
              data-tone={chip.tone}
              disabled={readOnly}
              aria-busy={loading === task.id || undefined}
              title={readOnly ? chip.text : t("chips.openDetails", { text: chip.text })}
              className={cn("inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2 text-xs transition-colors disabled:cursor-default", TONES[chip.tone])}
              onClick={() => void show(task.id)}
            >
              <Icon size={12} className="shrink-0" />
              <span className="truncate">{chip.text}</span>
            </button>
          );
        })}
      </div>
      {open && <TaskDialog controller={controller} task={controller.engine?.tasks?.find(open.id) ?? open} onClose={() => setOpen(null)} />}
    </>
  );
}
