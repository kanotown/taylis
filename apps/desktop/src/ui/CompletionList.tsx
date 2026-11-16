/**
 * The `@` and `:` candidate lists of the composer and the inline edit box (M187, docs/MOBILE_UI.md §23 and §30): the
 * candidates for what is typed before the caret (`useCompletions`), their list (`CompletionList`) and, for the edit box,
 * the layer that keeps the list in view (`FloatingCompletions`). The rules themselves are in completion.ts.
 */
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AppController } from "../state/app";
import { requestChannelMembers } from "../sync/channelMembers";
import { t } from "../i18n";
import { AiBadge } from "./ai";
import { COMPLETION_LIMIT, completionKey, completionQueries, type CompletionQuery, emojiCompletions, moveActive, type Typed } from "./completion";
import { CustomEmojiImage } from "./customEmoji";
import type { EmojiEntry } from "./emoji";
import { aiBotIds, conversationContext, type MentionCandidate, mentionCandidates } from "./mentions";
import { cn } from "./primitives";

/** What a pick does with each kind of row (`other`: the owner's own list, the composer's `/` commands). */
export interface CompletionPicks<T> {
  mention(candidate: MentionCandidate): void;
  emoji(entry: EmojiEntry): void;
  other?(hit: T): void;
}

export interface Completions<T> {
  /** The `@` query being typed (null when none), else the `:` one. */
  mention: CompletionQuery | null;
  emoji: CompletionQuery | null;
  mentions: MentionCandidate[];
  emojiHits: EmojiEntry[];
  /** The owner's own rows, asked for only while neither query is typed. */
  others: T[];
  /** The rows of the open list (the mentions, else the emoji, else the owner's); 0 when no list is open. */
  length: number;
  /** The highlighted row. */
  active: number;
  select(index: number): void;
  /** ↑ / ↓ / Enter / Tab / Esc in an open list; true when taken (the caller then lets the key go no further). */
  navigate(key: string, pick: CompletionPicks<T>): boolean;
}

/**
 * The candidates for `typed` (null: nothing to read, as with a selection in the rich editor) in the conversation
 * `channelId` (its thread `parentId`): people ranked as MOBILE_UI.md §23 says (the channel's members are read when the
 * `@` list first opens, and it re-ranks when they come), emoji the workspace's first. Esc closes the list for what is
 * typed now; typing on shows it again. `others`: rows of the owner's own for when neither query is typed, and the key of
 * what they are for (Esc closes them the same way).
 */
export function useCompletions<T = never>(controller: AppController, channelId: string, parentId: string | null, typed: Typed | null, others?: { key: string; hits: () => T[] }): Completions<T> {
  const store = controller.store;
  const queries = completionQueries(typed);
  const { mention, emoji } = queries;
  const key = completionKey(queries, others?.key);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const shown = dismissed !== key;
  const mentionOpen = !!mention && shown;
  useEffect(() => {
    if (mentionOpen) requestChannelMembers(store, controller.api, channelId);
  }, [mentionOpen, channelId, store.membersRevision(channelId)]); // eslint-disable-line react-hooks/exhaustive-deps
  const mentions = mention && shown ? mentionCandidates(mention.query, [...store.users.values()], [...store.groups.values()], COMPLETION_LIMIT, aiBotIds(store), conversationContext(store, channelId, parentId)) : [];
  const emojiHits = emoji && shown ? emojiCompletions(emoji.query, store.customEmoji) : [];
  const otherHits = mention || emoji || !shown || !others ? [] : others.hits();
  const length = mentions.length > 0 ? mentions.length : emojiHits.length > 0 ? emojiHits.length : otherHits.length;
  const [selected, setSelected] = useState(0);
  const active = Math.min(selected, Math.max(length - 1, 0));
  const navigate = (pressed: string, pick: CompletionPicks<T>): boolean => {
    if (length === 0) return false;
    const moved = moveActive(pressed, active, length);
    if (pressed === "Escape") setDismissed(key);
    else if (moved !== null) setSelected(moved);
    else if (pressed === "Enter" || pressed === "Tab") {
      const candidate = mentions[active];
      if (candidate) pick.mention(candidate);
      else if (emojiHits[active]) pick.emoji(emojiHits[active]!);
      else if (otherHits[active] !== undefined) pick.other?.(otherHits[active]!);
    } else return false;
    return true;
  };
  return { mention, emoji, mentions, emojiHits, others: otherHits, length, active, select: setSelected, navigate };
}

const LIST = "w-72 rounded-xl border border-line bg-canvas p-1 shadow-xl";
const ROW = "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm";

/**
 * The emoji or the people offered (at most one of the two has rows), the highlighted row tinted. A row is picked on
 * mouse down, which keeps the focus (and the caret) in the input. `className` places the list.
 */
export function CompletionList<T>({ controller, completion, pick, className }: { controller: AppController; completion: Completions<T>; pick: CompletionPicks<T>; className?: string }) {
  const custom = controller.store.customEmoji;
  return (
    <>
      {completion.emojiHits.length > 0 && (
        <ul className={cn(className, LIST)} aria-label={t("composer.emojiSuggestions")}>
          {completion.emojiHits.map((entry, index) => {
            const emoji = entry.category === "custom" ? custom.get(entry.shortcode) : undefined;
            return (
              <li
                key={entry.shortcode}
                className={cn(ROW, index === completion.active ? "bg-accent-soft" : "hover:bg-panel")}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick.emoji(entry);
                }}
              >
                {emoji ? <CustomEmojiImage controller={controller} emoji={emoji} size={20} /> : <span className="text-lg leading-none">{entry.glyph}</span>}{" "}
                <span className="truncate text-muted">:{entry.shortcode}:</span>
                {emoji?.label && <span className="ml-auto shrink-0 truncate text-xs text-muted">{emoji.label}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {completion.mentions.length > 0 && (
        <ul className={cn(className, LIST)}>
          {completion.mentions.map((candidate, index) => (
            <li
              key={candidate.username}
              className={cn(ROW, index === completion.active ? "bg-accent-soft" : "hover:bg-panel")}
              onMouseDown={(event) => {
                event.preventDefault();
                pick.mention(candidate);
              }}
            >
              <strong>@{candidate.username}</strong> <span className="text-muted">{candidate.label}</span>{candidate.kind === "group" && <span className="ml-auto rounded bg-accent-soft px-1.5 text-[10px] text-accent">{t("composer.group")}</span>}{candidate.ai && <AiBadge className="ml-auto" />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Space between the list and the box, and kept from the window's edges. */
const GAP = 4;
const EDGE = 8;

/**
 * The edit box's list (M187) in a layer of its own, fixed to the window: above the box, or below it when the window has
 * no room above. The box sits in a conversation that scrolls, which would cut off a list placed inside it; this one
 * follows the box as the conversation scrolls or the window changes.
 */
export function FloatingCompletions({ anchor, open, children }: { anchor: RefObject<HTMLElement | null>; open: boolean; children: ReactNode }) {
  const layer = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const reposition = useRef(() => {});
  reposition.current = () => {
    const box = anchor.current?.getBoundingClientRect();
    const el = layer.current;
    if (!box || !el) return;
    const height = el.offsetHeight;
    const bottom = window.innerHeight - EDGE;
    const top = box.top - GAP - height >= EDGE ? box.top - GAP - height : Math.max(EDGE, Math.min(box.bottom + GAP, bottom - height));
    const left = Math.max(EDGE, Math.min(box.left, window.innerWidth - el.offsetWidth - EDGE));
    setPlace((was) => (was && was.left === left && was.top === top ? was : { left, top }));
  };
  // Every render while open: the rows (and so the height) change as the query does.
  useLayoutEffect(() => {
    if (open) reposition.current();
  });
  useEffect(() => {
    if (!open) return;
    const follow = () => reposition.current();
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div ref={layer} data-edit-completions="" className="fixed z-50" style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}
