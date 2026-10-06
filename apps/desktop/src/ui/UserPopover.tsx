import { Ban, Flag, MessageSquare, Pencil, UserRoundPen } from "lucide-react";
import { Fragment, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import { Avatar, presenceLabel } from "./Avatar";
import { CustomEmojiImage, customEmojiName, splitCustomEmoji } from "./customEmoji";
import { replaceShortcodes } from "./emoji";
import { useStoreUpdates } from "./hooks";
import { displayTitle, supervisorLabel } from "./roster";
import { expiryLabel } from "./users";
import { dndActive, quietHoursLabel } from "./dnd";
import { activeStatus } from "./users";
import { ProblemReportDialog } from "./ModerationDialogs";
import { Button, cn, PopoverAnchor, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import { t } from "../i18n";

/**
 * The profile card (M11d) behind an avatar or a name: display name, @username, title, custom status,
 * presence, and a way to message the person. Opening a DM / the status editor goes through window
 * events so any screen can host the trigger. My own card (M93: also behind my picture in the sidebar header) offers
 * 「ステータスを設定」 and 「プロフィールを編集」 instead.
 */
export function UserPopover({ controller, userId, children, className }: { controller: AppController; userId: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const store = controller.store;
  const user = store.users.get(userId);
  const me = store.me?.id === userId;
  return (
    <>
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40", className)} aria-label={me ? t("popover.myProfile", { name: user?.display_name ?? "" }) : t("popover.profileOf", { name: user?.display_name ?? "?" })}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <UserCard controller={controller} userId={userId} onClose={() => setOpen(false)} onReport={() => { setOpen(false); setReporting(true); }} />
      </PopoverContent>
    </PopoverRoot>
    {reporting && <ProblemReportDialog controller={controller} userId={userId} onClose={() => setReporting(false)} />}
    </>
  );
}

/** How long the pointer rests on a mention before its card opens, and how long the card waits for it to come over. */
export const MENTION_HOVER_MS = 400;
export const MENTION_LEAVE_MS = 200;

/**
 * A user mention in a message body (`<@uuid>` of someone this device knows, 2026-10-06): the same card as an avatar's.
 * Resting the mouse on it opens the card after a moment, and it closes once the pointer has left both (with a short grace
 * to move into the card). A click (Enter / Space from the keyboard) opens it pinned, until a click outside or Esc. Hover
 * never takes the focus (the composer keeps it); a pinned card does, as any popover.
 */
export function MentionCard({ controller, userId, children }: { controller: AppController; userId: string; children: ReactNode }) {
  const [open, setOpen] = useState<"hover" | "pinned" | null>(null);
  const [reporting, setReporting] = useState(false);
  const timer = useRef<number | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const later = (ms: number, next: "hover" | null) => {
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen((now) => (now === "pinned" ? now : next));
    }, ms);
  };
  const mouse = (event: PointerEvent) => event.pointerType === "mouse";
  const name = controller.store.users.get(userId)?.display_name ?? "?";
  const toggle = () => {
    clear();
    setOpen((now) => (now === "pinned" ? null : "pinned"));
  };
  return (
    <>
    <PopoverRoot open={open !== null} onOpenChange={(next) => { clear(); setOpen(next ? "pinned" : null); }}>
      <PopoverAnchor asChild>
        <span
          ref={anchor}
          role="button"
          tabIndex={0}
          className="mention cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-haspopup="dialog"
          aria-expanded={open !== null}
          aria-label={t("popover.profileOf", { name })}
          data-mention-user={userId}
          onPointerEnter={(event) => { if (mouse(event) && open === null) later(MENTION_HOVER_MS, "hover"); else if (mouse(event)) clear(); }}
          onPointerLeave={(event) => { if (!mouse(event)) return; if (open === "hover") later(MENTION_LEAVE_MS, null); else if (open === null) clear(); }}
          onClick={(event) => {
            event.stopPropagation(); // not the row's (a phone's tap opens the thread)
            toggle();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            toggle();
          }}
        >
          {children}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-72 p-0"
        onPointerEnter={(event) => { if (mouse(event)) clear(); }}
        onPointerLeave={(event) => { if (mouse(event) && open === "hover") later(MENTION_LEAVE_MS, null); }}
        onOpenAutoFocus={(event) => { if (open === "hover") event.preventDefault(); }}
        // A click on the mention itself is its own toggle, not a click outside.
        onInteractOutside={(event) => { if (anchor.current?.contains(event.target as Node)) event.preventDefault(); }}
        onCloseAutoFocus={(event) => { if (open !== "pinned") event.preventDefault(); }}
      >
        <UserCard controller={controller} userId={userId} onClose={() => { clear(); setOpen(null); }} onReport={() => { clear(); setOpen(null); setReporting(true); }} />
      </PopoverContent>
    </PopoverRoot>
    {reporting && <ProblemReportDialog controller={controller} userId={userId} onClose={() => setReporting(false)} />}
    </>
  );
}

/**
 * The card's content (UserPopover, MentionCard); `onClose` once it opened the DM or a settings screen. `onReport` (M119,
 * docs/MODERATION.md §3.1): the host closes the card and opens 「〇〇 さんを報告」 (the dialog outlives the card).
 */
function UserCard({ controller, userId, onClose, onReport }: { controller: AppController; userId: string; onClose: () => void; onReport: () => void }) {
  // Its trigger sits in memoized message rows: the open card follows presence and status itself.
  useStoreUpdates(controller, true);
  const store = controller.store;
  const user = store.users.get(userId);
  const me = store.me?.id === userId;
  const presence = store.presenceOf(userId);
  const status = activeStatus(user);
  const line = store.roster.get(userId); // M23
  // The roster label is the title too (LAB.md 「肩書と名簿」): 「M2 · 研究室長」; the roster block keeps the supervisor and the topic.
  const title = displayTitle(user?.title, line);
  const supervisor = line ? supervisorLabel(line, store.users) : null;
  const blocked = store.isBlocked(userId);
  const openDm = async () => {
    const id = await controller.openDmWith(userId);
    if (id) {
      onClose();
      window.dispatchEvent(new CustomEvent("chikuwa:open-channel", { detail: id }));
    }
  };
  return (
    <>
        <div className="flex items-center gap-3 border-b border-line p-4">
          <Avatar id={userId} name={user?.display_name ?? "?"} size={56} className="rounded-2xl text-xl" presence={presence} />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{user?.display_name ?? "?"}</div>
            <div className="truncate text-xs text-muted">@{user?.username ?? ""}{title ? ` · ${title}` : ""}</div>
            {user?.role === "guest" && <div className="mt-0.5 text-xs text-muted">{t("popover.guest")}</div>}
            {user?.role === "bot" && <div className="mt-0.5 text-xs text-muted">{controller.store.aiAgentOf(userId) ? t("ai.badgeTitle") : t("popover.webhookBot")}</div>}
            <div className="mt-0.5 text-xs text-muted">{presenceLabel(presence)}</div>
            {dndActive(user) && (
              <div className="mt-0.5 text-xs text-muted" title={user?.quiet_hours ? t("popover.quietHours", { hours: quietHoursLabel(user.quiet_hours) }) : undefined}>🔕 {t("popover.paused")}</div>
            )}
          </div>
        </div>
        {line && (supervisor || line.research_topic) && (
          <div className="space-y-0.5 border-b border-line px-4 py-2.5 text-xs">
            {supervisor && <div className="font-medium text-ink">{supervisor}</div>}
            {line.research_topic && <div className="text-muted">{t("popover.topic", { topic: line.research_topic })}</div>}
          </div>
        )}
        {status && (
          <div className="border-b border-line px-4 py-2.5 text-sm">
            {status.emoji && <span className="mr-1.5"><StatusGlyph controller={controller} emoji={status.emoji} size={18} /></span>}
            {status.text}
            {expiryLabel(user?.status_expires_at) && <span className="ml-2 text-xs text-muted">{expiryLabel(user?.status_expires_at)}</span>}
          </div>
        )}
        {user?.deactivated_at && <div className="border-b border-line px-4 py-2 text-xs text-muted">{t("popover.deactivated")}</div>}
        {blocked && <div className="border-b border-line px-4 py-2 text-xs text-muted">{t("popover.blocked")}</div>}
        {/* My own card has two actions: stacked full width (side by side they overflowed the 288 px card). */}
        <div className={cn("flex gap-2 p-3", me && "flex-col")}>
          {me ? (
            <>
              <Button size="sm" variant="secondary" className="w-full justify-center" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent("chikuwa:open-status")); }}>
                <Pencil size={14} /> {t("popover.setStatus")}
              </Button>
              <Button size="sm" variant="secondary" className="w-full justify-center" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent("chikuwa:open-profile")); }}>
                <UserRoundPen size={14} /> {t("settings.section.profile")}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" className="flex-1" onClick={() => void openDm()} disabled={!!user?.deactivated_at}>
                <MessageSquare size={14} /> {t("popover.sendMessage")}
              </Button>
              {/* M104 (docs/MODERATION.md §4): private; the person is not told. */}
              {user && (
                <Button
                  size="sm"
                  variant="secondary"
                  title={blocked ? t("popover.unblock") : t("popover.blockTitle")}
                  onClick={() => void controller.setUserBlocked(userId, !blocked)}
                >
                  <Ban size={14} /> {blocked ? t("popover.unblock") : t("popover.block")}
                </Button>
              )}
            </>
          )}
        </div>
        {/* M119: a report about this person (the administrators are told, the person is not). */}
        {!me && user && (
          <div className="-mt-1 px-3 pb-3">
            <Button size="sm" variant="ghost" className="w-full justify-center text-muted" onClick={onReport}>
              <Flag size={14} /> {t("popover.report")}
            </Button>
          </div>
        )}
    </>
  );
}

/** The status emoji shown next to a name when the person has an active custom status. */
export function StatusEmoji({ controller, userId, className }: { controller: AppController; userId: string; className?: string }) {
  const status = activeStatus(controller.store.users.get(userId));
  const quiet = dndActive(controller.store.users.get(userId));
  if (!status?.emoji && !quiet) return null;
  const label = [status?.text, quiet ? t("popover.paused") : null].filter(Boolean).join(" · ");
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

/**
 * A line with a status or a message excerpt in it (a DM's subtitle, the directory, the activity, pins, search …): custom
 * emoji as their images and standard `:shortcode:`s as their glyphs, as in a message (2026-10-05: an excerpt showed
 * `:ckw-yay:`). The images are inline fixed boxes (customEmoji.tsx), so the row never jumps when they load.
 */
export function EmojiText({ controller, text, size = "1.15em" }: { controller: AppController; text: string; size?: number | string }) {
  const custom = controller.store.customEmoji;
  return (
    <>
      {splitCustomEmoji(replaceShortcodes(text), custom).map((piece, index) => {
        if (typeof piece === "string") return <Fragment key={index}>{piece}</Fragment>;
        const emoji = custom.get(piece.name);
        return emoji ? <CustomEmojiImage key={index} controller={controller} emoji={emoji} size={size} inline /> : <Fragment key={index}>:{piece.name}:</Fragment>;
      })}
    </>
  );
}
