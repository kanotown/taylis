import { CheckCircle2 } from "lucide-react";

import type { PollOut } from "../api/types";
import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { Button, cn } from "./primitives";

/** A poll under a message (M14b): options with counts and bars; a click votes, the author or an admin can close it. */
export function PollCard({ poll, message, controller }: { poll: PollOut; message: MessageState; controller: AppController }) {
  const me = controller.store.me?.id;
  const total = poll.votes.reduce((sum, voters) => sum + voters.length, 0);
  const closed = !!poll.closed_at;
  const canClose = !closed && (message.sender_id === me || controller.isAdmin);
  const names = (voters: string[]) => voters.map((id) => controller.store.users.get(id)?.display_name ?? "?").join(", ");
  return (
    <div className="mt-1.5 max-w-xl rounded-xl border border-line bg-panel/60 p-3 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">📊 {poll.question}</span>
        {poll.multiple && <span className="text-xs text-muted">複数選択可</span>}
      </div>
      <ul className="mt-2 space-y-1.5">
        {poll.options.map((option, index) => {
          const voters = poll.votes[index] ?? [];
          const mine = !!me && voters.includes(me);
          const share = total === 0 ? 0 : voters.length / total;
          return (
            <li key={index}>
              <button
                type="button"
                disabled={closed || !!message.pending}
                title={voters.length > 0 ? names(voters) : undefined}
                onClick={() => void controller.vote(message, index, !mine)}
                className={cn("block w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors", mine ? "border-accent bg-accent-soft/60" : "border-line bg-canvas hover:border-accent/50", closed && "cursor-default opacity-90")}
              >
                <div className="flex items-center gap-2">
                  {mine && <CheckCircle2 size={14} className="shrink-0 text-accent" />}
                  <span className="flex-1 truncate">{option}</span>
                  <span className="text-xs text-muted">{voters.length}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-2">
                  <div className={cn("h-full rounded-full", mine ? "bg-accent" : "bg-muted/60")} style={{ width: `${Math.round(share * 100)}%` }} />
                </div>
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
