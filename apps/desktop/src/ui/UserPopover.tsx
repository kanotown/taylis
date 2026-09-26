import { MessageSquare, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { AppController } from "../state/app";
import { Avatar, presenceLabel } from "./Avatar";
import { expiryLabel } from "./users";
import { dndActive, quietHoursLabel } from "./dnd";
import { activeStatus } from "./users";
import { Button, cn, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";

/**
 * The profile card (M11d) behind an avatar or a name: display name, @username, title, custom status,
 * presence, and a way to message the person. Opening a DM / the status editor goes through window
 * events so any screen can host the trigger.
 */
export function UserPopover({ controller, userId, children, className }: { controller: AppController; userId: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const store = controller.store;
  const user = store.users.get(userId);
  const me = store.me?.id === userId;
  const presence = store.presenceOf(userId);
  const status = activeStatus(user);
  const openDm = async () => {
    const id = await controller.openDmWith(userId);
    if (id) {
      setOpen(false);
      window.dispatchEvent(new CustomEvent("chikuwa:open-channel", { detail: id }));
    }
  };
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40", className)} aria-label={`${user?.display_name ?? "?"} のプロフィール`}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="flex items-center gap-3 border-b border-line p-4">
          <Avatar id={userId} name={user?.display_name ?? "?"} size={56} className="rounded-2xl text-xl" presence={presence} />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{user?.display_name ?? "?"}</div>
            <div className="truncate text-xs text-muted">@{user?.username ?? ""}{user?.title ? ` · ${user.title}` : ""}</div>
            <div className="mt-0.5 text-xs text-muted">{presenceLabel(presence)}</div>
            {dndActive(user) && (
              <div className="mt-0.5 text-xs text-muted" title={user?.quiet_hours ? `おやすみ時間 ${quietHoursLabel(user.quiet_hours)}` : undefined}>🔕 通知を一時停止中</div>
            )}
          </div>
        </div>
        {status && (
          <div className="border-b border-line px-4 py-2.5 text-sm">
            <span className="mr-1.5">{status.emoji}</span>
            {status.text}
            {expiryLabel(user?.status_expires_at) && <span className="ml-2 text-xs text-muted">{expiryLabel(user?.status_expires_at)}</span>}
          </div>
        )}
        {user?.deactivated_at && <div className="border-b border-line px-4 py-2 text-xs text-muted">無効化されたアカウント</div>}
        <div className="flex gap-2 p-3">
          {me ? (
            <Button size="sm" variant="secondary" className="flex-1" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent("chikuwa:open-status")); }}>
              <Pencil size={14} /> ステータスを設定
            </Button>
          ) : (
            <Button size="sm" className="flex-1" onClick={() => void openDm()} disabled={!!user?.deactivated_at}>
              <MessageSquare size={14} /> メッセージを送る
            </Button>
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/** The status emoji shown next to a name when the person has an active custom status. */
export function StatusEmoji({ controller, userId, className }: { controller: AppController; userId: string; className?: string }) {
  const status = activeStatus(controller.store.users.get(userId));
  const quiet = dndActive(controller.store.users.get(userId));
  if (!status?.emoji && !quiet) return null;
  const label = [status?.text, quiet ? "通知を一時停止中" : null].filter(Boolean).join(" · ");
  return (
    <span className={cn("text-[13px] leading-none", className)} title={label} aria-label={label}>
      {status?.emoji}
      {quiet && "🔕"}
    </span>
  );
}
