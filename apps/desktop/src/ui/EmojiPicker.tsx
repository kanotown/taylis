import { Search } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";

import type { CustomEmojiOut } from "../api/types";
import type { AppController } from "../state/app";
import { CustomEmojiImage, customEmojiName } from "./customEmoji";
import { customEmojiCandidates, EMOJI_CATEGORIES, type EmojiEntry, searchEmoji } from "./emoji";
import { cn, Input } from "./primitives";

/** Emoji picker (M11f): search by shortcode / keyword (en + ja) or browse by category; `onPick` gets the glyph. */
export function EmojiPicker({ onPick, recent = [], custom = [], controller, onAddCustom }: {
  onPick: (entry: EmojiEntry) => void;
  recent?: string[];
  /** M12f: custom emoji shown under 「カスタム」 and found by name; `glyph` of a pick is `:name:`. */
  custom?: CustomEmojiOut[];
  controller?: AppController;
  onAddCustom?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(EMOJI_CATEGORIES[0]![0]);
  const hits = useMemo(() => searchEmoji(query), [query]);
  const searching = query.trim().length > 0;
  const customByName = useMemo(() => new Map(custom.map((c) => [c.name, c])), [custom]);
  const customHits = searching ? customEmojiCandidates(query, customByName, 16) : category === "custom" ? custom.map((c) => ({ shortcode: c.name, glyph: `:${c.name}:`, category: "custom", keywords: c.name })) : [];
  const categories: Array<readonly [string, string]> = custom.length > 0 || onAddCustom ? [...EMOJI_CATEGORIES, ["custom", "カスタム"] as const] : [...EMOJI_CATEGORIES];
  const shown = searching ? hits : category === "custom" ? [] : hits.filter((e) => e.category === category);
  // A recent custom emoji shows as its image, and only while it exists (testers, 2026-09-29: 「:hanpen:」 as text, wider
  // than its cell, also for names with no emoji).
  // Each glyph once: they are the row's keys (a stored list from elsewhere may repeat one).
  const recentShown = [...new Set(recent)].filter((glyph) => {
    if (!glyph) return false;
    const name = customEmojiName(glyph);
    return !name || (!!controller && customByName.has(name));
  });
  const recentRow = !searching && recentShown.length > 0 && (
    // Pinned above the categories (2026-10-04): what I used last is there without scrolling, whatever the category.
    <div className="mt-2 shrink-0" role="group" aria-label="最近使った絵文字">
      <div className="text-[10px] tracking-wide text-muted">最近使った絵文字</div>
      <div className="flex max-h-16 flex-wrap overflow-hidden">
        {recentShown.map((glyph) => {
          const emoji = customByName.get(customEmojiName(glyph) ?? "");
          return (
            <button key={glyph} type="button" title={emoji ? glyph : undefined} className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-md text-xl hover:bg-panel-2" onClick={() => onPick({ shortcode: emoji?.name ?? "", glyph, category: emoji ? "custom" : "", keywords: "" })}>
              {emoji && controller ? <CustomEmojiImage controller={controller} emoji={emoji} size={22} /> : glyph}
            </button>
          );
        })}
      </div>
    </div>
  );
  return (
    // As tall as the popover may be (Radix's available height, less its padding and what a host adds below, such as
    // 「アイコンを外す」): only the grid scrolls; the search, the recent row and the categories stay (2026-10-04: the
    // picker was cut off by the window when opened low or high, e.g. a sidebar section's icon).
    <div className="flex w-80 max-w-full flex-col" style={{ maxHeight: "calc(var(--radix-popover-content-available-height, 100dvh) - 72px)" }} onKeyDown={(event) => event.stopPropagation()}>
      <div className="relative shrink-0">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <Input value={query} autoFocus placeholder="検索 (例: tada、乾杯)" className="h-8 pl-8 text-sm" onChange={(e) => setQuery(e.target.value)} />
      </div>
      {recentRow}
      {!searching && (
        <div className="mt-2 flex shrink-0 flex-wrap gap-1">
          {categories.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setCategory(key)}
              className={cn("rounded-md px-2 py-0.5 text-[11px]", category === key ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 grid max-h-56 min-h-16 grid-cols-8 overflow-y-auto">
        {controller && customHits.map((entry) => {
          const emoji = customByName.get(entry.shortcode);
          return emoji ? (
            <button key={`custom:${entry.shortcode}`} type="button" title={`:${entry.shortcode}:`} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-panel-2" onClick={() => onPick(entry)}>
              <CustomEmojiImage controller={controller} emoji={emoji} size={22} />
            </button>
          ) : null;
        })}
        {shown.map((entry) => (
          <button key={entry.shortcode} type="button" title={`:${entry.shortcode}:`} className="flex h-8 w-8 items-center justify-center rounded-md text-xl hover:bg-panel-2" onClick={() => onPick(entry)}>
            {entry.glyph}
          </button>
        ))}
        {shown.length === 0 && customHits.length === 0 && <div className="col-span-8 py-6 text-center text-xs text-muted">{category === "custom" && !searching ? "カスタム絵文字はまだありません" : "見つかりません"}</div>}
      </div>
      {onAddCustom && (!searching && category === "custom") && (
        <button type="button" className="mt-2 w-full shrink-0 rounded-lg border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:bg-panel hover:text-ink" onClick={onAddCustom}>＋ 絵文字を追加…</button>
      )}
    </div>
  );
}

const RECENT_KEY = "chikuwa.emoji.recent";

/** The last read, kept as one array while the stored value is the same: rows memoized on it (M21) compare it by identity. */
let lastRead: { raw: string | null; value: string[] } = { raw: null, value: [] };
const recentListeners = new Set<() => void>();

export function readRecentEmoji(): string[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(RECENT_KEY);
  } catch {
    /* no storage: nothing recent */
  }
  if (raw === lastRead.raw) return lastRead.value;
  let value: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    value = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, 16) : [];
  } catch {
    /* a corrupt value counts as none */
  }
  lastRead = { raw, value };
  return value;
}

export function rememberEmoji(glyph: string): void {
  try {
    const next = [glyph, ...readRecentEmoji().filter((g) => g !== glyph)].slice(0, 16);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* per-viewer convenience only */
  }
  for (const listener of recentListeners) listener();
}

/** Re-renders with the recent emoji: a pick in one message row moves the quick reactions of every row (M28b). */
export function useRecentEmoji(): string[] {
  return useSyncExternalStore(subscribeRecentEmoji, readRecentEmoji);
}

function subscribeRecentEmoji(listener: () => void): () => void {
  recentListeners.add(listener);
  return () => {
    recentListeners.delete(listener);
  };
}
