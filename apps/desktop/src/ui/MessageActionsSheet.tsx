import { AlarmClock, SmilePlus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { EmojiPicker, readRecentEmoji, rememberEmoji } from "./EmojiPicker";
import { type MessageActionKey, messageActions } from "./messageActions";
import { cn } from "./primitives";
import { reminderPresets, scheduleLabel, toLocalInput } from "./schedule";
import { t } from "../i18n";

/** The default quick reactions of the phone sheet, the same six as iOS and Android (M25). */
export const SHEET_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

/** M50: at most this many chosen quick reactions (UserMe.quick_reactions, 「リアクションの候補」 in the settings). */
export const MAX_QUICK_REACTIONS = 6;

/**
 * The quick reactions (apps/shared/quick-reactions.json). M50: the ones I chose (`chosen`, UserMe.quick_reactions),
 * exactly and in their order; the hover bar takes the first `count`. Not chosen (null): the ones I used last first, then
 * the defaults (tester request, 2026-09-28; the same rule on iOS and Android). Custom emoji stay in the picker: the quick
 * row shows plain emoji.
 */
export function quickReactions(recent: readonly string[], count = 6, chosen?: readonly string[] | null): string[] {
  if (chosen && chosen.length > 0) return chosen.slice(0, count);
  const custom = /^:[^:\s]+:$/;
  return [...new Set([...recent.filter((glyph) => !custom.test(glyph)), ...SHEET_REACTIONS])].slice(0, count);
}

/** A press this long on a message row opens the sheet (touch screens; a mouse has the hover bar). */
export const LONG_PRESS_MS = 450;

/**
 * The long-press sheet on a phone (M25, MUI-1): quick reactions, then the actions in the order iOS (MessageActions.swift)
 * and Android (MessageActions.kt) show them. Each action closes the sheet; the delete asks once more in place.
 */
export function MessageActionsSheet({ controller, message, initialView = "actions", onClose, onOpenThread, onShare, onReport, onShowReactions, onMakeTask, onRequestReview, unreadOffered, saved, isAdmin, canEdit }: {
  controller: AppController;
  message: MessageState;
  /** "emoji": straight to the picker (the 「＋」 after the reactions). */
  initialView?: "actions" | "emoji";
  onClose: () => void;
  onOpenThread?: (id: string) => void;
  onShare: () => void;
  /** M104 「報告する」: the report dialog. */
  onReport?: () => void;
  /** M27 「リアクションした人」: offered while the message has reactions (a phone has no hover names). */
  onShowReactions?: () => void;
  /** M55 「タスクにする」 (offered when the server has tasks). */
  onMakeTask?: () => void;
  /** L9 「レビューを依頼」 (offered where I may add the conversation's tasks). */
  onRequestReview?: () => void;
  unreadOffered: boolean;
  saved: boolean;
  isAdmin: boolean;
  /** Editing in place is offered (my own message with its conversation open); my own message when left out. */
  canEdit?: boolean;
}) {
  const store = controller.store;
  const me = store.me;
  const mine = me?.id === message.sender_id;
  const reacted = new Set((message.reactions ?? []).filter((r) => !!me && r.user_ids.includes(me.id)).map((r) => r.emoji));
  const [view, setView] = useState<"actions" | "emoji" | "remind" | "delete">(initialView);
  // The finger that opened the sheet lifts over it: a tap in the first moments is that finger, not a choice.
  const [openedAt] = useState(() => Date.now());
  const settled = () => Date.now() - openedAt > 350;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const then = (work: () => void) => () => {
    if (!settled()) return;
    onClose();
    work();
  };
  // 「リマインド…」: its note and a time of my own (M12e), besides the presets.
  const [remindNote, setRemindNote] = useState("");
  const [remindAt, setRemindAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const remind = (at: Date) => void controller.setReminder(message.id, at, remindNote.trim() || null);
  // The same list as the hover bar and its 「その他」 menu (messageActions.ts), in the phone apps' order.
  const actions = messageActions({
    message, mine, isAdmin, saved, thread: !!onOpenThread, editable: canEdit ?? mine, showReactions: !!onShowReactions,
    canMakeTask: !!onMakeTask, canRequestReview: !!onRequestReview, unreadOffered,
  });
  const run: Record<MessageActionKey, () => void> = {
    reactions: then(() => onShowReactions?.()),
    thread: then(() => onOpenThread?.(message.parent_id ?? message.id)),
    edit: then(() => controller.setEditing(message.id)),
    copyText: then(() => void controller.copyMessageText(message.body)),
    save: then(() => void controller.toggleBookmark(message)),
    remind: () => { if (settled()) setView("remind"); },
    task: then(() => onMakeTask?.()),
    review: then(() => onRequestReview?.()),
    unread: then(() => controller.engine?.markUnread(message.channel_id, message.seq!)),
    copyLink: then(() => void controller.copyPermalink(message.id)),
    share: then(onShare),
    pin: then(() => void controller.togglePin(message)),
    report: then(() => onReport?.()),
    delete: () => { if (settled()) setView("delete"); },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/35" onClick={() => { if (settled()) onClose(); }} role="presentation">
      <div
        role="dialog"
        aria-label={t("sheet.actions")}
        // Every item fits at once on a small phone (testers: ピン留め and 削除 were cut off on iOS); it scrolls only
        // with very large text.
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-canvas pb-[max(env(safe-area-inset-bottom),12px)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mb-2 mt-2 h-1 w-10 rounded-full bg-line" aria-hidden />
        {view === "emoji" ? (
          <div className="px-3 pb-3">
            <EmojiPicker
              recent={readRecentEmoji()}
              custom={[...store.customEmoji.values()]}
              controller={controller}
              onPick={(entry) => {
                onClose();
                rememberEmoji(entry.glyph);
                void controller.toggleReaction(message, entry.glyph);
              }}
            />
          </div>
        ) : view === "remind" ? (
          // A note (the API's `note`, as on Android) goes with the preset or the chosen time; the fields are finger-sized.
          <div className="px-2 pb-2">
            <input
              value={remindNote}
              maxLength={200}
              placeholder={t("timeline.remindNote")}
              aria-label={t("timeline.remindNoteLabel")}
              className="mb-1 h-11 w-full rounded-xl border border-line bg-canvas px-3 text-[15px]"
              onChange={(event) => setRemindNote(event.target.value)}
            />
            <ul>
              {reminderPresets().map((preset) => (
                <li key={preset.key}>
                  <SheetButton icon={<AlarmClock size={18} />} onClick={then(() => remind(preset.at))}>
                    {preset.label} {scheduleLabel(preset.at.toISOString()) !== preset.label && <span className="ml-auto text-xs text-muted">{scheduleLabel(preset.at.toISOString())}</span>}
                  </SheetButton>
                </li>
              ))}
            </ul>
            <div className="mt-1 flex items-center gap-2 border-t border-line px-1 pt-2">
              <input type="datetime-local" value={remindAt} aria-label={t("settings.pause.custom")} className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 text-[15px]" onChange={(event) => setRemindAt(event.target.value)} />
              <button
                type="button"
                className="h-11 shrink-0 rounded-xl border border-line px-4 text-[15px] active:bg-panel"
                onClick={() => {
                  const at = new Date(remindAt);
                  if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) {
                    controller.setError(t("composer.pickLater"));
                    return;
                  }
                  then(() => remind(at))();
                }}
              >
                {t("timeline.set")}
              </button>
            </div>
          </div>
        ) : view === "delete" ? (
          <div className="space-y-3 px-4 pb-3 pt-1">
            <div className="text-sm font-medium">{t("timeline.deleteTitle")}</div>
            <div className="text-xs text-muted">{t("timeline.deleteNote")}</div>
            <div className="flex gap-2">
              <button type="button" className="h-11 flex-1 rounded-xl border border-line text-sm" onClick={() => setView("actions")}>{t("common.cancel")}</button>
              <button type="button" className="h-11 flex-1 rounded-xl bg-danger text-sm font-medium text-white" onClick={then(() => void controller.deleteMessage(message.id))}>{t("common.deleteConfirm")}</button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex justify-center gap-2 px-3 pb-2 pt-1">
              {quickReactions(readRecentEmoji(), 6, me?.quick_reactions).map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={t("timeline.reactWith", { emoji })}
                  className={cn("flex h-11 w-11 items-center justify-center rounded-full text-2xl", reacted.has(emoji) ? "bg-accent-soft ring-1 ring-accent" : "bg-panel")}
                  onClick={then(() => void controller.toggleReaction(message, emoji))}
                >
                  {emoji}
                </button>
              ))}
              <button type="button" aria-label={t("sheet.moreReactions")} className="flex h-11 w-11 items-center justify-center rounded-full bg-panel text-muted" onClick={() => { if (settled()) setView("emoji"); }}>
                <SmilePlus size={20} />
              </button>
            </div>
            <ul className="px-2 pb-1">
              {actions.map((action) => (
                <li key={action.key}>
                  <SheetButton danger={action.danger} icon={<action.icon size={18} />} onClick={run[action.key]}>{action.label}</SheetButton>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function SheetButton({ icon, children, onClick, danger = false }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] active:bg-panel", danger ? "text-danger" : "text-ink")}>
      <span className={cn("shrink-0", danger ? "text-danger" : "text-muted")}>{icon}</span>
      {children}
    </button>
  );
}
