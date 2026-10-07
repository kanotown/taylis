/**
 * 操作ボタン (M143, docs/ACTIONS.md §9.1): the grouped buttons (the 「操作」 page, the top of 在室状況) and the press: the
 * confirmation (when the button asks for one) → a spinner on the button → a toast with the relay's message or the reason.
 */
import { Loader2, RefreshCw, Zap } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { ApiError, describeError } from "../api/errors";
import type { ActionOut, ActionStatusOut, ActionStatusTone } from "../api/types";
import type { AppController } from "../state/app";
import { type ActionGroup, actionTitle, checkedLabel, confirmText, groupActions, invokeOnce, refusalText, resultText, statusDetails, statusFailureText, statusKey } from "./actions";
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

/** How often the state is read again while the page is visible (the server answers from its cache in between). */
export const STATUS_POLL_MS = 60_000;

/** The state of the groups' devices as a page shows it (docs/ACTIONS.md §12). */
export interface StatusFeed {
  statuses: ReadonlyMap<string, ActionStatusOut>;
  /** The first read is under way (nothing to show yet). */
  loading: boolean;
  /** A refresh the person asked for is under way. */
  refreshing: boolean;
  /** Why the last read failed as a whole (no answer from our server, 429…), or null. */
  error: string | null;
  refresh: () => void;
  /** Ticks every half minute, for 「◯分前に確認」. */
  now: Date;
}

/**
 * The state of the groups of these buttons: read when the page opens, every minute while it is visible (and on coming
 * back to it), and updated by actions.status_updated (the store). `refresh` asks the relays now.
 */
export function useActionStatuses(controller: AppController, actions: readonly ActionOut[]): StatusFeed {
  const active = actions.length > 0;
  const [loading, setLoading] = useState(active);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const lastRead = useRef(0);

  const read = useCallback(
    async (refresh: boolean) => {
      const api = controller.api;
      if (!api?.actionStatuses) return;
      lastRead.current = Date.now();
      if (refresh) setRefreshing(true);
      try {
        controller.store.setActionStatuses(await api.actionStatuses(refresh));
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError && err.status === 429 ? t("actions.error.tooFast") : describeError(err));
      } finally {
        setLoading(false);
        if (refresh) setRefreshing(false);
        setNow(new Date());
      }
    },
    [controller],
  );

  useEffect(() => {
    if (!active) return;
    void read(false);
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const poll = setInterval(() => {
      if (visible()) void read(false);
    }, STATUS_POLL_MS);
    const tick = setInterval(() => setNow(new Date()), 30_000);
    const onVisible = () => {
      if (visible() && Date.now() - lastRead.current >= STATUS_POLL_MS) void read(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, read]);

  return { statuses: controller.store.actionStatuses, loading, refreshing, error, refresh: () => void read(true), now };
}

const TONE_DOT: Record<ActionStatusTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  alert: "bg-rose-500",
  neutral: "bg-zinc-400",
};

/** One group's state: a tone dot, the text, the details, 「◯分前に確認」 and the refresh button; or why it is missing. */
function StatusLine({ feed, status, label, expected }: { feed: StatusFeed; status: ActionStatusOut | undefined; label?: string; expected: boolean }) {
  let body: ReactNode;
  let tone: ActionStatusTone = "neutral";
  if (status?.ok && status.status) {
    tone = status.status.tone;
    const details = statusDetails(status);
    body = (
      <>
        <span className="font-medium" data-action-status-text>{status.status.text}</span>
        {details && <span className="text-muted">{details}</span>}
      </>
    );
  } else if (status) {
    body = <span className="text-danger">{statusFailureText(status)}</span>;
  } else if (feed.error && expected) {
    body = <span className="text-danger">{t("actions.status.failed", { reason: feed.error })}</span>;
  } else if (feed.loading && expected) {
    body = <span className="text-muted">{t("actions.status.loading")}</span>;
  } else {
    return null;
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]" data-action-status={status?.action_id ?? ""} data-tone={status?.ok ? tone : undefined} aria-live="polite">
      <span aria-hidden className={cn("h-2.5 w-2.5 shrink-0 rounded-full", status?.ok ? TONE_DOT[tone] : "bg-zinc-300")} />
      {label && <span className="text-muted">{label}：</span>}
      {body}
      {status && <span className="text-xs text-muted" data-action-status-checked>{checkedLabel(status.fetched_at, feed.now)}</span>}
      <button
        type="button"
        onClick={feed.refresh}
        disabled={feed.refreshing}
        aria-label={t("actions.status.refresh")}
        title={t("actions.status.refresh")}
        className="rounded p-1 text-muted hover:bg-panel-2 disabled:cursor-progress"
        data-action-status-refresh
      >
        <RefreshCw aria-hidden size={13} className={cn(feed.refreshing && "animate-spin")} />
      </button>
    </div>
  );
}

/** The state lines of a group: one for a named group; one per button that provides its own for the ungrouped ones. */
function GroupStatus({ feed, group }: { feed: StatusFeed; group: ActionGroup }) {
  if (group.label) {
    const first = group.actions[0]!;
    const status = feed.statuses.get(statusKey(group.label, first.id));
    return <StatusLine feed={feed} status={status} expected={group.actions.some((a) => a.provides_status)} />;
  }
  return (
    <>
      {group.actions.map((action) => (
        <StatusLine key={action.id} feed={feed} status={feed.statuses.get(statusKey(null, action.id))} label={action.name} expected={!!action.provides_status} />
      ))}
    </>
  );
}

/** The buttons in their groups (a heading per group, its state, its buttons side by side; the ungrouped ones last). */
export function ActionButtons({ controller, actions, compact = false, feed }: { controller: AppController; actions: readonly ActionOut[]; compact?: boolean; feed?: StatusFeed }) {
  const { press, busy, dialog } = useActionPress(controller);
  const groups = groupActions(actions);
  if (!groups.length) return null;
  return (
    <div className={cn("flex flex-col", compact ? "gap-2" : "gap-4")} data-action-buttons>
      {groups.map((group) => (
        <section key={group.label ?? "\u0000"} aria-label={group.label ?? t("nav.actions")} data-action-group={group.label ?? ""}>
          {group.label && <h3 className={cn("mb-1.5 font-semibold text-muted", compact ? "text-[12px]" : "text-[13px]")}>{group.label}</h3>}
          {feed && <GroupStatus feed={feed} group={group} />}
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
