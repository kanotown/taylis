/**
 * 操作ボタン (M143, docs/ACTIONS.md §9.1): the grouped buttons (the 「操作」 page, the top of 在室状況) and the press: the
 * confirmation (when the button asks for one) → a spinner on the button → a toast with the relay's message or the reason.
 */
import { Loader2, Zap } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

import type { ActionOut } from "../api/types";
import type { AppController } from "../state/app";
import { actionTitle, confirmText, groupActions, invokeOnce, refusalText, resultText } from "./actions";
import { attendanceIcon } from "./attendanceIcons";
import { Button, cn, Modal } from "./primitives";
import { t } from "../i18n";

/** A button's picture: its icon (the 在室状況 set), else its emoji, else a bolt. Decorative. */
export function ActionGlyph({ action, size = 16, className }: { action: Pick<ActionOut, "icon" | "emoji">; size?: number; className?: string }) {
  const Icon = attendanceIcon(action.icon);
  if (Icon) return <Icon aria-hidden size={size} strokeWidth={2.25} className={cn("shrink-0", className)} data-action-icon={action.icon} />;
  if (action.emoji) {
    return (
      <span aria-hidden className={cn("shrink-0 leading-none", className)} style={{ fontSize: size }} data-action-emoji>
        {action.emoji}
      </span>
    );
  }
  return <Zap aria-hidden size={size} className={cn("shrink-0", className)} />;
}

/**
 * Pressing, shared by every place a button shows: `press(action)` asks first when the button wants it, then calls the
 * relay once; `busy` holds the buttons being sent (pressing one again meanwhile does nothing); `dialog` is the
 * confirmation to render (outside any popover, which closes when the dialog opens).
 */
export function useActionPress(controller: AppController): { press: (action: ActionOut) => void; busy: ReadonlySet<string>; dialog: ReactNode } {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<ActionOut | null>(null);

  const run = useCallback(
    async (action: ActionOut) => {
      const api = controller.api;
      if (!api) return;
      setBusy((now) => new Set(now).add(action.id));
      try {
        const out = await invokeOnce((id, key) => api.invokeAction(id, key), action.id);
        const result = resultText(out, action);
        if (result.ok) controller.setNotice(result.text);
        else controller.setError(result.text);
      } catch (error) {
        controller.setError(refusalText(error));
      } finally {
        setBusy((now) => {
          const next = new Set(now);
          next.delete(action.id);
          return next;
        });
      }
    },
    [controller],
  );

  const press = useCallback(
    (action: ActionOut) => {
      if (busy.has(action.id)) return;
      if (action.confirm) setAsking(action);
      else void run(action);
    },
    [busy, run],
  );

  const dialog = asking ? (
    <Modal onClose={() => setAsking(null)} title={actionTitle(asking)} className="w-[400px]">
      <p className="mt-3 whitespace-pre-wrap text-sm" data-action-confirm>{confirmText(asking)}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => setAsking(null)}>{t("common.cancel")}</Button>
        <Button
          autoFocus
          data-action-run
          onClick={() => {
            const action = asking;
            setAsking(null);
            void run(action);
          }}
        >
          {t("actions.run")}
        </Button>
      </div>
    </Modal>
  ) : null;

  return { press, busy, dialog };
}

/** The buttons in their groups (a heading per group, its buttons side by side; the ungrouped ones last). */
export function ActionButtons({ controller, actions, compact = false }: { controller: AppController; actions: readonly ActionOut[]; compact?: boolean }) {
  const { press, busy, dialog } = useActionPress(controller);
  const groups = groupActions(actions);
  if (!groups.length) return null;
  return (
    <div className={cn("flex flex-col", compact ? "gap-2" : "gap-4")} data-action-buttons>
      {groups.map((group) => (
        <section key={group.label ?? "\u0000"} aria-label={group.label ?? t("nav.actions")} data-action-group={group.label ?? ""}>
          {group.label && <h3 className={cn("mb-1.5 font-semibold text-muted", compact ? "text-[12px]" : "text-[13px]")}>{group.label}</h3>}
          <div className="flex flex-wrap gap-2">
            {group.actions.map((action) => {
              const sending = busy.has(action.id);
              return (
                <button
                  key={action.id}
                  type="button"
                  data-action={action.id}
                  aria-busy={sending || undefined}
                  disabled={sending}
                  onClick={() => press(action)}
                  title={actionTitle(action)}
                  className={cn(
                    "inline-flex min-h-11 min-w-[7rem] items-center justify-center gap-2 rounded-xl border border-line bg-panel px-4 text-sm font-medium transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-progress disabled:opacity-70",
                    compact && "min-h-9 min-w-0 px-3",
                  )}
                >
                  {sending ? <Loader2 aria-hidden size={16} className="shrink-0 animate-spin" /> : <ActionGlyph action={action} />}
                  <span className="truncate">{action.name}</span>
                  {sending && <span className="sr-only">{t("actions.sending")}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {dialog}
    </div>
  );
}
