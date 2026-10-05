import { Check, CheckCheck, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { compactNames } from "./format";
import { cn, HoverList } from "./primitives";
import { AcksDialog } from "./WhoDialogs";

/**
 * 「3/8 人が確認」 when who is still to confirm is known (`pending`), else 「3 人が確認」; nothing yet and no total:
 * 「まだ誰も確認していません」.
 */
export function ackCountLabel(acked: number, pending: number | null): string {
  if (pending === null) return acked === 0 ? "まだ誰も確認していません" : `${acked} 人が確認`;
  return `${acked}/${acked + pending} 人が確認`;
}

/**
 * Who has not confirmed, for the total in the row: loaded once per set of acknowledgements and kept across remounts
 * (rows scroll in and out), quietly (a failure leaves the total out, no toast).
 */
const pendingCaches = new WeakMap<AppController, Map<string, { key: string; ids: string[] }>>();

function usePendingAcks(controller: AppController, message: MessageState, enabled: boolean): string[] | null {
  const key = (message.acks ?? []).map((a) => a.user_id).join(",");
  const pendingCache = pendingCaches.get(controller) ?? new Map<string, { key: string; ids: string[] }>();
  pendingCaches.set(controller, pendingCache);
  const cached = pendingCache.get(message.id);
  const [ids, setIds] = useState<string[] | null>(cached && cached.key === key ? cached.ids : null);
  useEffect(() => {
    if (!enabled) return;
    const hit = pendingCache.get(message.id);
    if (hit && hit.key === key) { setIds(hit.ids); return; }
    let current = true;
    void controller.ackPending(message, { quiet: true }).then((loaded) => {
      if (!loaded) return;
      pendingCache.set(message.id, { key, ids: loaded });
      if (current) setIds(loaded);
    });
    return () => { current = false; };
  }, [controller, message.id, key, enabled]);
  // Until the new list comes, someone who has just confirmed no longer counts as pending.
  return enabled && ids ? ids.filter((id) => !(message.acks ?? []).some((a) => a.user_id === id)) : null;
}

/**
 * M15e, reworked 2026-10-05 (「確認を求める」 was easy to miss): a row of its own under the message,
 * 「✓ 確認のお願い · 3/8 人が確認 · 山田、佐藤…」 with a prominent 「確認しました」 for a reader who has not yet (「確認済み」,
 * pressed, once they have; a second press takes it back, as before). The author and an admin also see 「未確認 5 人」; the
 * count and that open the list (AcksDialog: who confirmed, who has not, the reminder). `readOnly` (a channel read before
 * joining): the count and names only. The server's rules are unchanged.
 */
export function AckBar({ controller, message, readOnly }: { controller: AppController; message: MessageState; readOnly: boolean }) {
  const store = controller.store;
  const me = store.me;
  const acks = message.acks ?? [];
  const mine = !!me && acks.some((a) => a.user_id === me.id);
  const own = me?.id === message.sender_id;
  const canChase = !readOnly && (own || !!controller.isAdmin);
  const names = acks.map((a) => store.users.get(a.user_id)?.display_name ?? "?");
  const pending = usePendingAcks(controller, message, !readOnly);
  const [listOpen, setListOpen] = useState(false);
  const state = own ? "author" : mine ? "done" : "todo";
  const label = ackCountLabel(acks.length, pending ? pending.length : null);
  const count = (
    <>
      <span className="font-semibold text-ink">{label}</span>
      {names.length > 0 && <span className="min-w-0 truncate text-muted">· {compactNames(names)}</span>}
    </>
  );
  return (
    <div
      role="group"
      aria-label="確認のお願い"
      data-ack-row={state}
      className={cn(
        "mt-1.5 flex min-w-0 max-w-xl flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border px-2.5 py-1.5 text-xs",
        state === "todo" && !readOnly ? "border-accent/40 bg-accent-soft" : "border-line bg-panel",
      )}
    >
      <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-accent">
        <CheckCircle2 size={14} aria-hidden /> 確認のお願い
      </span>
      {readOnly ? (
        <span className="flex min-w-0 items-center gap-1">{count}</span>
      ) : (
        <HoverList content={names.join("、")}>
          <button
            type="button"
            data-ack-count=""
            className="flex min-w-0 items-center gap-1 rounded text-left hover:underline"
            aria-label={acks.length > 0 ? `確認した人 (${acks.length} 人)` : undefined}
            onClick={() => setListOpen(true)}
          >
            {count}
          </button>
        </HoverList>
      )}
      {canChase && pending && pending.length > 0 && (
        <button type="button" data-ack-pending="" className="inline-flex shrink-0 items-center gap-1 rounded font-medium text-ink hover:underline" onClick={() => setListOpen(true)}>
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />未確認 {pending.length} 人
        </button>
      )}
      {pending && pending.length === 0 && acks.length > 0 && <span className="shrink-0 font-medium text-muted">全員が確認済み</span>}
      {!own && !readOnly && (
        <button
          type="button"
          aria-pressed={mine}
          title={mine ? "もう一度押すと取り消します" : undefined}
          className={cn(
            "ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
            mine ? "border border-accent/40 bg-canvas text-accent hover:bg-accent-soft" : "bg-accent-solid text-white shadow-sm hover:bg-accent-solid/90",
          )}
          onClick={() => void controller.toggleAck(message)}
        >
          {mine ? <Check size={14} aria-hidden /> : <CheckCheck size={14} aria-hidden />} {mine ? "確認済み" : "確認しました"}
        </button>
      )}
      {listOpen && <AcksDialog controller={controller} message={message} readOnly={readOnly} onClose={() => setListOpen(false)} />}
    </div>
  );
}
