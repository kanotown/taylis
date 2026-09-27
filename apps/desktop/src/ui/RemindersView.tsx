import { AlarmClock, Check, X } from "lucide-react";

import type { ReminderOut } from "../api/types";
import type { AppController } from "../state/app";
import { channelTitle } from "./MainScreen";
import { BackButton } from "./compact";
import { Button } from "./primitives";
import { scheduleLabel } from "./schedule";

/** 「リマインダー」 (M12e): fired nudges wait for 完了 on top; pending ones list their time. */
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
            <li key={row.id} className="flex items-start gap-3 px-3 py-2.5">
              <button type="button" className="min-w-0 flex-1 text-left" title="メッセージを表示" onClick={() => onOpen(row)}>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="font-medium text-ink">{channel ? channelTitle(channel, controller) : "?"}</span>
                  <span>· {row.status === "fired" ? `${scheduleLabel(row.remind_at)} にリマインド` : `${scheduleLabel(row.remind_at)} にリマインド予定`}</span>
                </div>
                {row.note && <div className="mt-0.5 text-sm font-medium text-ink">{row.note}</div>}
                <div className="mt-0.5 line-clamp-2 text-sm text-muted">{row.preview}</div>
              </button>
              <Button size="sm" variant={action === "done" ? "secondary" : "ghost"} onClick={() => void controller.closeReminder(row)}>
                {action === "done" ? <><Check size={14} /> 完了</> : <><X size={14} /> 取り消し</>}
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
        <strong className="shrink-0 whitespace-nowrap text-[15px]">リマインダー</strong>
        <span className="min-w-0 truncate text-xs text-muted">{rows.length} 件</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">リマインダーはありません。メッセージの「リマインド」から設定できます。</div>
        ) : (
          <>
            {fired.length > 0 && section("届いたリマインド", fired, "done")}
            {pending.length > 0 && section("予定", pending, "cancel")}
          </>
        )}
      </div>
    </div>
  );
}
