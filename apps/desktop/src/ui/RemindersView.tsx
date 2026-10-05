import { AlarmClock, Check, X } from "lucide-react";

import type { ReminderOut } from "../api/types";
import type { AppController } from "../state/app";
import { channelTitle } from "./MainScreen";
import { BackButton } from "./compact";
import { Badge, Button } from "./primitives";
import { scheduleLabel } from "./schedule";
import { t } from "../i18n";

/** 「リマインダー」 (M12e): fired nudges wait for 完了 on top; pending ones list their time; 「確認のお願い」 marked (L4). */
export function RemindersView({ controller, onOpen }: { controller: AppController; onOpen: (row: ReminderOut) => void }) {
  const store = controller.store;
  const rows = store.listReminders();
  const fired = rows.filter((r) => r.status === "fired");
  const pending = rows.filter((r) => r.status === "pending");
  const section = (title: string, items: ReminderOut[], action: "done" | "cancel") => (
    <div className="mx-auto mb-4 max-w-3xl">
      <div className="mb-1.5 text-xs font-semibold text-muted">{title}</div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {items.map((row) => {
          const channel = store.getChannel(row.channel_id);
          return (
            <li key={row.id} data-row-key={row.id} className="flex items-start gap-3 px-3 py-2.5">
              <button type="button" className="min-w-0 flex-1 text-left" title={t("files.showMessage")} onClick={() => onOpen(row)}>
                <div className="flex items-center gap-2 text-xs text-muted">
                  {/* L4: asked by the author or an admin (the note names who). */}
                  {row.kind === "ack" && <Badge tone="accent">{t("reminders.ack")}</Badge>}
                  <span className="font-medium text-ink">{channel ? channelTitle(channel, controller) : "?"}</span>
                  <span>· {row.status === "fired" ? t("reminders.fired", { when: scheduleLabel(row.remind_at) }) : t("reminders.pending", { when: scheduleLabel(row.remind_at) })}</span>
                </div>
                {row.note && <div className="mt-0.5 text-sm font-medium text-ink">{row.note}</div>}
                <div className="mt-0.5 line-clamp-2 text-sm text-muted">{row.preview}</div>
              </button>
              <Button size="sm" variant={action === "done" ? "secondary" : "ghost"} onClick={() => void controller.closeReminder(row)}>
                {action === "done" ? <><Check size={14} /> {t("table.done")}</> : <><X size={14} /> {t("drafts.cancel")}</>}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4">
        <BackButton />
        <span className="text-muted max-md:hidden"><AlarmClock size={18} /></span>
        <strong className="shrink-0 whitespace-nowrap text-[15px]">{t("nav.reminders")}</strong>
        <span className="min-w-0 truncate text-xs text-muted">{t("common.count", { count: rows.length })}</span>
      </header>
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">{t("reminders.none")}</div>
        ) : (
          <>
            {fired.length > 0 && section(t("reminders.firedHeading"), fired, "done")}
            {pending.length > 0 && section(t("reminders.pendingHeading"), pending, "cancel")}
          </>
        )}
      </div>
    </div>
  );
}
