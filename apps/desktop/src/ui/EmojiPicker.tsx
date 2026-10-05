import { Search } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";

import type { CustomEmojiOut, EmojiPackOut } from "../api/types";
import type { AppController } from "../state/app";
import { CustomEmojiImage, customEmojiName, usePackTabUrl } from "./customEmoji";
import { customEmojiCandidates, EMOJI_CATEGORIES, type EmojiEntry, searchEmoji } from "./emoji";
import { cn, Input } from "./primitives";
import { type MessageKey, t } from "../i18n";

/** Emoji picker (M11f): search by shortcode / keyword (en + ja) or browse by category; `onPick` gets the glyph. */
export function EmojiPicker({ onPick, recent = [], custom = [], controller, onAddCustom }: {
  onPick: (entry: EmojiEntry) => void;
  recent?: string[];
  /** M12f: custom emoji shown under 「カスタム」 (M100: the ungrouped ones; a pack's under its own tab) and found by name,
   * label and keywords; `glyph` of a pick is `:name:`. */
  custom?: CustomEmojiOut[];
  controller?: AppController;
  onAddCustom?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(EMOJI_CATEGORIES[0]![0]);
  const hits = useMemo(() => searchEmoji(query), [query]);
  const searching = query.trim().length > 0;
  const customByName = useMemo(() => new Map(custom.map((c) => [c.name, c])), [custom]);
  // M100: a tab per pack (its tab icon), after 「カスタム」; the packs come from the store the controller holds.
  const packs = controller?.store?.sortedEmojiPacks?.() ?? [];
  const packId = category.startsWith("pack:") ? category.slice(5) : null;
  const pack = packId ? packs.find((p) => p.id === packId) : undefined;
  const tabCustom = (pick: (c: CustomEmojiOut) => boolean) => custom.filter(pick).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
  const browsed: CustomEmojiOut[] = searching ? [] : category === "custom" ? tabCustom((c) => !c.pack_id || !packs.some((p) => p.id === c.pack_id)) : pack ? tabCustom((c) => c.pack_id === pack.id) : [];
  const customHits: CustomEmojiOut[] = searching ? customEmojiCandidates(query, customByName, 40).map((e) => customByName.get(e.shortcode)!).filter(Boolean) : browsed;
  const textHits = customHits.filter((c) => c.kind === "text");
  const imageHits = customHits.filter((c) => c.kind !== "text");
  const categories: Array<readonly [string, string]> = (custom.length > 0 || onAddCustom ? [...EMOJI_CATEGORIES, ["custom", ""] as const] : [...EMOJI_CATEGORIES]).map(([key, label]) => [key, CATEGORY_KEYS[key] ? t(CATEGORY_KEYS[key]) : label] as const);
  const shown = searching ? hits : category === "custom" || pack ? [] : hits.filter((e) => e.category === category);
  const entryOf = (c: CustomEmojiOut): EmojiEntry => ({ shortcode: c.name, glyph: `:${c.name}:`, category: "custom", keywords: [c.label ?? "", ...(c.keywords ?? [])].join(" ") });
  const titleOf = (c: CustomEmojiOut) => (c.label ? `${c.label} :${c.name}:` : `:${c.name}:`);
  // A pack's emoji are illustrations: twice the cell (M100).
  const big = !!pack && !searching;
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
    <div className="mt-2 shrink-0" role="group" aria-label={t("emojiPicker.recent")}>
      <div className="text-[10px] tracking-wide text-muted">{t("emojiPicker.recent")}</div>
      <div className="flex max-h-16 flex-wrap overflow-hidden">
        {recentShown.map((glyph) => {
          const emoji = customByName.get(customEmojiName(glyph) ?? "");
          return (
            <button key={glyph} type="button" title={emoji ? titleOf(emoji) : undefined} className="flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-md px-0.5 text-xl hover:bg-panel-2" onClick={() => onPick({ shortcode: emoji?.name ?? "", glyph, category: emoji ? "custom" : "", keywords: "" })}>
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
        <Input value={query} autoFocus placeholder={t("emojiPicker.search")} className="h-8 pl-8 text-sm" onChange={(e) => setQuery(e.target.value)} />
      </div>
      {recentRow}
      {!searching && (
        <div className="mt-2 flex shrink-0 flex-wrap items-center gap-1">
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
          {controller && packs.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.name}
              aria-label={p.name}
              aria-pressed={category === `pack:${p.id}`}
              onClick={() => setCategory(`pack:${p.id}`)}
              className={cn("flex h-6 items-center rounded-md px-1", category === `pack:${p.id}` ? "bg-accent-soft" : "hover:bg-panel")}
            >
              <PackTabIcon controller={controller} pack={p} first={custom.filter((c) => c.pack_id === p.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]} />
            </button>
          ))}
        </div>
      )}
      <div className={cn("mt-2 grid min-h-16 content-start overflow-y-auto", big ? "grid-cols-4" : "grid-cols-8")} style={{ maxHeight: big ? "18rem" : "14rem" }}>
          {controller && textHits.length > 0 && (
            // M100: text emoji as pills, as wide as their label, in a row of their own above the images.
            <div className="col-span-full mb-1 flex flex-wrap gap-1" aria-label={t("feature.textEmoji")}>
              {textHits.map((emoji) => (
                <button key={`text:${emoji.name}`} type="button" title={titleOf(emoji)} className="flex h-8 items-center rounded-md px-1 hover:bg-panel-2" onClick={() => onPick(entryOf(emoji))}>
                  <CustomEmojiImage controller={controller} emoji={emoji} size={20} />
                </button>
              ))}
            </div>
          )}
          {controller && imageHits.map((emoji) => (
            <button key={`custom:${emoji.name}`} type="button" title={titleOf(emoji)} className={cn("flex items-center justify-center rounded-md hover:bg-panel-2", big ? "h-[4.5rem] w-[4.5rem]" : "h-8 w-8")} onClick={() => onPick(entryOf(emoji))}>
              <CustomEmojiImage controller={controller} emoji={emoji} size={big ? 56 : 22} square />
            </button>
          ))}
          {shown.map((entry) => (
            <button key={entry.shortcode} type="button" title={`:${entry.shortcode}:`} className="flex h-8 w-8 items-center justify-center rounded-md text-xl hover:bg-panel-2" onClick={() => onPick(entry)}>
              {entry.glyph}
            </button>
          ))}
          {shown.length === 0 && customHits.length === 0 && <div className="col-span-full py-6 text-center text-xs text-muted">{category === "custom" && !searching ? t("emoji.none") : pack && !searching ? t("emojiPicker.emptyPack") : t("workflow.notFound")}</div>}
      </div>
      {onAddCustom && (!searching && category === "custom") && (
        <button type="button" className="mt-2 w-full shrink-0 rounded-lg border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:bg-panel hover:text-ink" onClick={onAddCustom}>{t("emojiPicker.add")}</button>
      )}
    </div>
  );
}

/** A pack's tab (M100): its tab icon, or its first emoji while it has none. */
function PackTabIcon({ controller, pack, first }: { controller: AppController; pack: EmojiPackOut; first?: CustomEmojiOut }) {
  const url = usePackTabUrl(controller, pack);
  if (url) return <img src={url} alt="" className="h-5 w-auto max-w-10 object-contain" draggable={false} />;
  if (first) return <CustomEmojiImage controller={controller} emoji={first} size={18} square />;
  return <span className="text-[11px] text-muted">{pack.name}</span>;
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

/** The picker's category names in the UI language (emojiData.ts keeps the generated Japanese ones). */
const CATEGORY_KEYS: Readonly<Record<string, MessageKey>> = {
  smileys: "emoji.category.smileys",
  people: "emoji.category.people",
  nature: "emoji.category.nature",
  food: "emoji.category.food",
  travel: "emoji.category.travel",
  activities: "emoji.category.activities",
  objects: "emoji.category.objects",
  symbols: "emoji.category.symbols",
  flags: "emoji.category.flags",
  custom: "emoji.category.custom",
};
