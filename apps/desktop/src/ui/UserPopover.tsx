import { MessageSquare, Pencil } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import type { AppController } from "../state/app";
import { Avatar, presenceLabel } from "./Avatar";
import { CustomEmojiImage, customEmojiName, splitCustomEmoji } from "./customEmoji";
import { useStoreUpdates } from "./hooks";
import { rosterSummary } from "./roster";
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
  // Its trigger sits in memoized message rows: the open card follows presence and status itself.
  useStoreUpdates(controller, open);
  const store = controller.store;
  const user = store.users.get(userId);
  const me = store.me?.id === userId;
  const presence = store.presenceOf(userId);
  const status = activeStatus(user);
  const line = store.roster.get(userId); // M23
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
            {user?.role === "guest" && <div className="mt-0.5 text-xs text-muted">ゲスト (参加したチャンネルだけ見えます)</div>}
            {user?.role === "bot" && <div className="mt-0.5 text-xs text-muted">{controller.store.aiAgentOf(userId) ? "AI のボット (メンションすると返事をします)" : "受信 Webhook の bot"}</div>}
            <div className="mt-0.5 text-xs text-muted">{presenceLabel(presence)}</div>
            {dndActive(user) && (
              <div className="mt-0.5 text-xs text-muted" title={user?.quiet_hours ? `おやすみ時間 ${quietHoursLabel(user.quiet_hours)}` : undefined}>🔕 通知を一時停止中</div>
            )}
          </div>
        </div>
        {line && (
          <div className="space-y-0.5 border-b border-line px-4 py-2.5 text-xs">
            <div className="font-medium text-ink">{rosterSummary(line, store.users)}</div>
            {line.research_topic && <div className="text-muted">研究テーマ: {line.research_topic}</div>}
          </div>
        )}
        {status && (
          <div className="border-b border-line px-4 py-2.5 text-sm">
            {status.emoji && <span className="mr-1.5"><StatusGlyph controller={controller} emoji={status.emoji} size={18} /></span>}
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
      {status?.emoji && <StatusGlyph controller={controller} emoji={status.emoji} size={14} />}
      {quiet && "🔕"}
    </span>
  );
}

/** The custom emoji a status emoji is (`:name:`, picked from the emoji picker), when this workspace has it. */
export function statusCustomEmoji(controller: AppController, emoji: string) {
  const name = customEmojiName(emoji.trim());
  return name ? controller.store.customEmoji.get(name) : undefined;
}

/**
 * A status emoji: a custom one as its image, as on a reaction (2026-10-02: it showed as its `:name:`); a standard one,
 * or a name this workspace does not have, as text.
 */
export function StatusGlyph({ controller, emoji, size = 14 }: { controller: AppController; emoji: string; size?: number | string }) {
  const custom = statusCustomEmoji(controller, emoji);
  return custom ? <CustomEmojiImage controller={controller} emoji={custom} size={size} /> : <>{emoji}</>;
}

/** A line with a status in it (a DM's subtitle, the directory): custom emoji as their images, as in a message. */
export function EmojiText({ controller, text, size = "1.15em" }: { controller: AppController; text: string; size?: number | string }) {
  const custom = controller.store.customEmoji;
  return (
    <>
      {splitCustomEmoji(text, custom).map((piece, index) => {
        if (typeof piece === "string") return <Fragment key={index}>{piece}</Fragment>;
        const emoji = custom.get(piece.name);
        return emoji ? <CustomEmojiImage key={index} controller={controller} emoji={emoji} size={size} /> : <Fragment key={index}>:{piece.name}:</Fragment>;
      })}
    </>
  );
}
