import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { EMOJI_CATEGORIES, type EmojiEntry, searchEmoji } from "./emoji";
import { cn, Input } from "./primitives";

/** Emoji picker (M11f): search by shortcode / keyword (en + ja) or browse by category; `onPick` gets the glyph. */
export function EmojiPicker({ onPick, recent = [] }: { onPick: (entry: EmojiEntry) => void; recent?: string[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(EMOJI_CATEGORIES[0]![0]);
  const hits = useMemo(() => searchEmoji(query), [query]);
  const searching = query.trim().length > 0;
  const shown = searching ? hits : hits.filter((e) => e.category === category);
  return (
    <div className="w-80" onKeyDown={(event) => event.stopPropagation()}>
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <Input value={query} autoFocus placeholder="検索 (例: tada、乾杯)" className="h-8 pl-8 text-sm" onChange={(e) => setQuery(e.target.value)} />
      </div>
      {!searching && (
        <div className="mt-2 flex flex-wrap gap-1">
          {EMOJI_CATEGORIES.map(([key, label]) => (
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
      {!searching && recent.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-muted">最近</div>
          <div className="flex flex-wrap">
            {recent.map((glyph) => (
              <button key={glyph} type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-xl hover:bg-panel-2" onClick={() => onPick({ shortcode: "", glyph, category: "", keywords: "" })}>
                {glyph}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-2 grid max-h-56 grid-cols-8 overflow-y-auto">
        {shown.map((entry) => (
          <button key={entry.shortcode} type="button" title={`:${entry.shortcode}:`} className="flex h-8 w-8 items-center justify-center rounded-md text-xl hover:bg-panel-2" onClick={() => onPick(entry)}>
            {entry.glyph}
          </button>
        ))}
        {shown.length === 0 && <div className="col-span-8 py-6 text-center text-xs text-muted">見つかりません</div>}
      </div>
    </div>
  );
}

const RECENT_KEY = "chikuwa.emoji.recent";

export function readRecentEmoji(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, 16) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(glyph: string): void {
  try {
    const next = [glyph, ...readRecentEmoji().filter((g) => g !== glyph)].slice(0, 16);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* per-viewer convenience only */
  }
}
