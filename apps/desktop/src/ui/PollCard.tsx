import { CheckCircle2, EyeOff } from "lucide-react";

import type { PollOut } from "../api/types";
import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { compactNames } from "./format";
import { Button, cn } from "./primitives";

/**
 * The server makes a poll's text 「📊 質問」 for previews, pushes and search (DATA_MODEL.md); under it the card shows the
 * question again, and testers saw it twice in a row (2026-09-29). Text the author wrote stays.
 */
export function pollHidesBody(message: { body: string; poll?: PollOut | null }): boolean {
  return !!message.poll && message.body.trim() === `📊 ${message.poll.question}`.trim();
}

/**
 * How many voted for each option: the server's `counts` (M27), else the voters listed. An anonymous poll lists nobody,
 * and a server before M27 (or a row stored before it) sends no counts.
 */
export function pollCounts(poll: PollOut): number[] {
  return poll.options.map((_, index) => poll.counts?.[index] ?? poll.votes[index]?.length ?? 0);
}

/**
 * The options I voted for: the server's `mine` (in responses to me, M27; the store keeps it across events, which carry
 * null), else what the voters of a named poll say. An anonymous poll without `mine` says nothing about me.
 */
export function pollMine(poll: PollOut, meId: string | null | undefined): number[] {
  if (poll.mine != null) return poll.mine;
  if (poll.anonymous || !meId) return [];
  return poll.votes.flatMap((voters, index) => (voters.includes(meId) ? [index] : []));
}

/**
 * A poll under a message (M14b): options with counts and bars; a click votes, only its author can close it. A named
 * poll says who voted for each option (M27; a few names, all of them on hover); an anonymous one shows 「匿名」 and no
 * names. `readOnly`: a channel read before joining (SYNC_PROTOCOL.md §7.6.1), where nobody votes.
 */
export function PollCard({ poll, message, controller, readOnly = false }: { poll: PollOut; message: MessageState; controller: AppController; readOnly?: boolean }) {
  const me = controller.store.me?.id;
  const counts = pollCounts(poll);
  const mine = new Set(pollMine(poll, me));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const closed = !!poll.closed_at;
  const canClose = !readOnly && !closed && message.sender_id === me; // not an admin either (testers, 2026-09-29)
  const names = (voters: string[]) => voters.map((id) => controller.store.users.get(id)?.display_name ?? "?");
  return (
    <div className="mt-1.5 max-w-xl rounded-xl border border-line bg-panel/60 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-semibold">📊 {poll.question}</span>
        {poll.anonymous && (
          <span className="inline-flex items-center gap-1 self-center rounded-md bg-panel-2 px-1.5 py-px text-[11px] font-medium text-muted" title="誰が投票したかは表示されません">
            <EyeOff size={11} /> 匿名
          </span>
        )}
        {poll.multiple && <span className="text-xs text-muted">複数選択可</span>}
      </div>
      <ul className="mt-2 space-y-1.5">
        {poll.options.map((option, index) => {
          const count = counts[index] ?? 0;
          const chosen = mine.has(index);
          const share = total === 0 ? 0 : count / total;
          const voters = poll.anonymous ? [] : names(poll.votes[index] ?? []);
          return (
            <li key={index}>
              <button
                type="button"
                disabled={readOnly || closed || !!message.pending}
                title={voters.length > 0 ? voters.join("、") : undefined}
                onClick={() => void controller.vote(message, index, !chosen)}
                className={cn("block w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors", chosen ? "border-accent bg-accent-soft/60" : "border-line bg-canvas hover:border-accent/50", (readOnly || closed) && "cursor-default opacity-90 hover:border-line")}
              >
                <div className="flex items-center gap-2">
                  {chosen && <CheckCircle2 size={14} className="shrink-0 text-accent" />}
                  <span className="flex-1 truncate">{option}</span>
                  <span className="text-xs text-muted">{count}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-2">
                  <div className={cn("h-full rounded-full", chosen ? "bg-accent" : "bg-muted/60")} style={{ width: `${Math.round(share * 100)}%` }} />
                </div>
                {voters.length > 0 && <div className="mt-1 truncate text-[11px] text-muted">{compactNames(voters)}</div>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex items-center justify-between text-xs text-muted">
        <span>{closed ? `締め切りました · ${total} 票` : `${total} 票`}</span>
        {canClose && (
          <Button size="sm" variant="ghost" onClick={() => void controller.closePoll(message)}>締め切る</Button>
        )}
      </div>
    </div>
  );
}
