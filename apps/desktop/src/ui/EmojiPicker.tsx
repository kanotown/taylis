import { Clock, Search } from "lucide-react";
import { createContext, memo, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { CustomEmojiOut, EmojiPackOut } from "../api/types";
import type { AppController } from "../state/app";
import { CustomEmojiImage, customEmojiName, usePackTabUrl } from "./customEmoji";
import { customEmojiCandidates, EMOJI, EMOJI_CATEGORIES, type EmojiEntry, searchEmoji } from "./emoji";
import { gridChunks, pickerSectionKeys, sectionAt } from "./emojiPickerLayout";
import { cn, Input } from "./primitives";
import { type MessageKey, t } from "../i18n";

/** A cell of the picker's grids (h-8) and a pack's big cell (h-[4.5rem]), in px: the chunks' heights come from them. */
const CELL = 32;
const BIG_CELL = 72;
/** Rows drawn together once near the view: small enough that opening draws little, big enough for few observers. */
const CHUNK_ROWS = 6;
/** Chunks whose (estimated) top is within this many px of the list's top are drawn at once, the rest when near. */
const EAGER_PX = 480;

/** The standard emoji by category, once (the data is in category order). */
const STANDARD = new Map<string, EmojiEntry[]>();
for (const entry of EMOJI) {
  const list = STANDARD.get(entry.category);
  if (list) list.push(entry);
  else STANDARD.set(entry.category, [entry]);
}

type Section =
  | { key: "recent"; kind: "recent"; label: string; items: Array<{ glyph: string; emoji?: CustomEmojiOut }> }
  | { key: string; kind: "custom"; label: string; text: CustomEmojiOut[]; images: CustomEmojiOut[]; big: boolean; empty: string; add: boolean }
  | { key: string; kind: "standard"; label: string; entries: EmojiEntry[] };

/**
 * Emoji picker (M11f): search by shortcode / keyword (en + ja) or browse. Browsing is one scrolling list (2026-10-07,
 * docs/EMOJI.md §6, like Slack): 最近使った絵文字, カスタム, each pack, then the standard categories, each under a
 * header that stays at the top while its section scrolls. A tab jumps to its section; the highlighted tab follows the
 * section in view. Before, each tab was its own page sharing one scroll position (a tab opened mid-way down).
 * `onPick` gets the glyph.
 */
export function EmojiPicker({ onPick, recent = [], custom = [], controller, onAddCustom }: {
  onPick: (entry: EmojiEntry) => void;
  recent?: string[];
  /** M12f: custom emoji shown under 「カスタム」 (M100: the ungrouped ones; a pack's under its own section) and found
   * by name, label and keywords; `glyph` of a pick is `:name:`. */
  custom?: CustomEmojiOut[];
  controller?: AppController;
  onAddCustom?: () => void;
}) {
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  // The sections are memoized and must not redraw when the highlighted tab changes: the callbacks they get are stable.
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const pick = useCallback((entry: EmojiEntry) => pickRef.current(entry), []);
  const addRef = useRef(onAddCustom);
  addRef.current = onAddCustom;
  const add = useCallback(() => addRef.current?.(), []);
  const customByName = useMemo(() => new Map(custom.map((c) => [c.name, c])), [custom]);
  // M100: a section (and tab) per pack, after 「カスタム」; the packs come from the store the controller holds.
  const packList = controller ? controller.store?.sortedEmojiPacks?.() ?? [] : [];
  const packsKey = packList.map((p) => `${p.id}\u0000${p.name}\u0000${p.tab_version ?? ""}`).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- by content: the store hands out a new array each call
  const packs = useMemo(() => packList, [packsKey]);
  // A recent custom emoji shows as its image, and only while it exists (testers, 2026-09-29: 「:hanpen:」 as text, wider
  // than its cell, also for names with no emoji).
  // Each glyph once: they are the row's keys (a stored list from elsewhere may repeat one).
  const recentKey = recent.join("\u0000");
  const recentShown = useMemo(() => [...new Set(recent)].filter((glyph) => {
    if (!glyph) return false;
    const name = customEmojiName(glyph);
    return !name || (!!controller && customByName.has(name));
  }), [recentKey, customByName, controller]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasCustom = custom.length > 0 || !!onAddCustom;
  const sections = useMemo(
    () => buildSections({ recent: recentShown, custom, customByName, packs, hasCustom, add: !!onAddCustom }),
    [recentShown, custom, customByName, packs, hasCustom, onAddCustom !== undefined], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const keys = useMemo(() => sections.map((s) => s.key), [sections]);

  const [active, setActive] = useState<string>("");
  const shownActive = keys.includes(active) ? active : keys[0] ?? "";
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef(new Map<string, HTMLElement>());
  const register = useCallback((key: string, el: HTMLElement | null) => {
    if (el) sectionEls.current.set(key, el);
    else sectionEls.current.delete(key);
  }, []);
  // A tab click scrolls to exactly its section's top: while the list stays where the jump put it, that tab stays
  // highlighted (also when the list cannot scroll that far, its last section being shorter than the view).
  const jumped = useRef<{ key: string; top: number } | null>(null);
  const frame = useRef(0);
  // Chunks of the grids are drawn when near the view (a custom emoji fetches its image when drawn).
  const lazy = useMemo(createLazyRoot, []);
  const jump = (key: string) => {
    const list = scrollRef.current;
    const section = sectionEls.current.get(key);
    if (!list || !section) return;
    list.scrollTop = section.offsetTop;
    jumped.current = { key, top: list.scrollTop };
    // Draw what the jump shows in this same update: the observer would leave the first frame blank.
    lazy.reveal(list);
    setActive(key);
  };
  const onScroll = () => {
    if (frame.current) return;
    frame.current = -1; // scheduled (set before the call: a frame may run at once)
    const id = requestAnimationFrame(() => {
      frame.current = 0;
      const list = scrollRef.current;
      if (!list) return;
      if (jumped.current && Math.abs(list.scrollTop - jumped.current.top) < 1) return;
      jumped.current = null;
      const tops = keys.map((key) => sectionEls.current.get(key)?.offsetTop ?? 0);
      setActive(keys[sectionAt(tops, list.scrollTop)] ?? "");
    });
    if (frame.current) frame.current = id;
  };
  useEffect(() => () => { if (frame.current > 0) cancelAnimationFrame(frame.current); }, []);

  useEffect(() => {
    if (searching) return undefined;
    // Clearing the search comes back to the top of the list (it is a new list), with its first tab.
    setActive("");
    jumped.current = null;
    lazy.attach(scrollRef.current);
    return () => lazy.detach();
  }, [searching, lazy]);

  return (
    // As tall as the popover may be (Radix's available height, less its padding and what a host adds below, such as
    // 「アイコンを外す」): only the list scrolls; the search and the tabs stay (2026-10-04: the picker was cut off by
    // the window when opened low or high, e.g. a sidebar section's icon).
    <div className="flex w-80 max-w-full flex-col" style={{ maxHeight: "calc(var(--radix-popover-content-available-height, 100dvh) - 72px)" }} onKeyDown={(event) => event.stopPropagation()}>
      <div className="relative shrink-0">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <Input value={query} autoFocus placeholder={t("emojiPicker.search")} className="h-8 pl-8 text-sm" onChange={(e) => setQuery(e.target.value)} />
      </div>
      {!searching && (
        <div className="mt-2 flex shrink-0 flex-wrap items-center gap-1" role="tablist" aria-label={t("composer.emoji")}>
          {sections.map((section) => {
            const selected = shownActive === section.key;
            const pack = section.key.startsWith("pack:") ? packs.find((p) => `pack:${p.id}` === section.key) : undefined;
            if (section.kind === "recent") {
              return (
                <button key={section.key} type="button" role="tab" aria-selected={selected} title={section.label} aria-label={section.label} onClick={() => jump(section.key)} className={cn("flex h-6 items-center rounded-md px-1.5", selected ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel hover:text-ink")}>
                  <Clock size={13} />
                </button>
              );
            }
            if (pack && controller) {
              return (
                <button key={section.key} type="button" role="tab" aria-selected={selected} title={pack.name} aria-label={pack.name} onClick={() => jump(section.key)} className={cn("flex h-6 items-center rounded-md px-1", selected ? "bg-accent-soft" : "hover:bg-panel")}>
                  <PackTabIcon controller={controller} pack={pack} first={section.kind === "custom" ? section.images[0] : undefined} />
                </button>
              );
            }
            return (
              <button key={section.key} type="button" role="tab" aria-selected={selected} onClick={() => jump(section.key)} className={cn("rounded-md px-2 py-0.5 text-[11px]", selected ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel hover:text-ink")}>
                {section.label}
              </button>
            );
          })}
        </div>
      )}
      {searching ? (
        <SearchResults query={query} customByName={customByName} controller={controller} pick={pick} />
      ) : (
        <div ref={scrollRef} data-emoji-list="" className="relative mt-2 min-h-16 overflow-y-auto overscroll-contain" style={{ maxHeight: "18rem" }} onScroll={onScroll}>
          <LazyContext.Provider value={lazy}>
            <SectionList sections={sections} controller={controller} pick={pick} add={add} register={register} />
          </LazyContext.Provider>
        </div>
      )}
    </div>
  );
}

function buildSections({ recent, custom, customByName, packs, hasCustom, add }: { recent: string[]; custom: CustomEmojiOut[]; customByName: ReadonlyMap<string, CustomEmojiOut>; packs: EmojiPackOut[]; hasCustom: boolean; add: boolean }): Section[] {
  const ordered = (pick: (c: CustomEmojiOut) => boolean) => custom.filter(pick).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
  const customSection = (key: string, label: string, list: CustomEmojiOut[], big: boolean, empty: string, withAdd: boolean): Section => ({
    key, kind: "custom", label, big, empty, add: withAdd,
    text: list.filter((c) => c.kind === "text"),
    images: list.filter((c) => c.kind !== "text"),
  });
  const standard = EMOJI_CATEGORIES.map(([key]) => key);
  const keys = pickerSectionKeys({ recent: recent.length > 0, custom: hasCustom, packIds: packs.map((p) => p.id), standard });
  return keys.map((key): Section => {
    if (key === "recent") return { key: "recent", kind: "recent", label: t("emojiPicker.recent"), items: recent.map((glyph) => ({ glyph, emoji: customByName.get(customEmojiName(glyph) ?? "") })) };
    if (key === "custom") return customSection(key, t("emoji.category.custom"), ordered((c) => !c.pack_id || !packs.some((p) => p.id === c.pack_id)), false, t("emoji.none"), add);
    if (key.startsWith("pack:")) {
      const pack = packs.find((p) => `pack:${p.id}` === key)!;
      // A pack's emoji are illustrations: twice the cell (M100).
      return customSection(key, pack.name, ordered((c) => c.pack_id === pack.id), true, t("emojiPicker.emptyPack"), false);
    }
    const label = EMOJI_CATEGORIES.find(([k]) => k === key)?.[1] ?? key;
    return { key, kind: "standard", label: CATEGORY_KEYS[key] ? t(CATEGORY_KEYS[key]) : label, entries: STANDARD.get(key) ?? [] };
  });
}

const titleOf = (c: CustomEmojiOut) => (c.label ? `${c.label} :${c.name}:` : `:${c.name}:`);
const entryOf = (c: CustomEmojiOut): EmojiEntry => ({ shortcode: c.name, glyph: `:${c.name}:`, category: "custom", keywords: [c.label ?? "", ...(c.keywords ?? [])].join(" ") });

/** The browsing list: every section, drawn once per picker (the highlighted tab redraws only the tabs). */
const SectionList = memo(function SectionList({ sections, controller, pick, add, register }: {
  sections: Section[];
  controller?: AppController;
  pick: (entry: EmojiEntry) => void;
  add: () => void;
  register: (key: string, el: HTMLElement | null) => void;
}) {
  // A running estimate of where each chunk starts: the ones in the first view are drawn at once (no blank first frame).
  let y = 0;
  const eager = (height: number) => {
    const near = y < EAGER_PX;
    y += height;
    return near;
  };
  return (
    <>
      {sections.map((section) => {
        y += 24;
        let body: ReactNode;
        if (section.kind === "recent") {
          y += Math.ceil(section.items.length / 8) * CELL;
          body = (
            <div className="flex flex-wrap" role="group" aria-label={section.label}>
              {section.items.map(({ glyph, emoji }) => (
                <button key={glyph} type="button" title={emoji ? titleOf(emoji) : undefined} className="flex h-8 min-w-8 items-center justify-center overflow-hidden rounded-md px-0.5 text-xl hover:bg-panel-2" onClick={() => pick({ shortcode: emoji?.name ?? "", glyph, category: emoji ? "custom" : "", keywords: "" })}>
                  {emoji && controller ? <CustomEmojiImage controller={controller} emoji={emoji} size={22} /> : glyph}
                </button>
              ))}
            </div>
          );
        } else if (section.kind === "custom") {
          const cell = section.big ? BIG_CELL : CELL;
          const columns = section.big ? 4 : 8;
          if (section.text.length > 0) y += 40;
          body = (
            <>
              {controller && section.text.length > 0 && (
                // M100: text emoji as pills, as wide as their label, in a row of their own above the images.
                <div className="mb-1 flex flex-wrap gap-1" aria-label={t("feature.textEmoji")}>
                  {section.text.map((emoji) => (
                    <button key={`text:${emoji.name}`} type="button" title={titleOf(emoji)} className="flex h-8 items-center rounded-md px-1 hover:bg-panel-2" onClick={() => pick(entryOf(emoji))}>
                      <CustomEmojiImage controller={controller} emoji={emoji} size={20} />
                    </button>
                  ))}
                </div>
              )}
              {controller && gridChunks(section.images.length, columns, cell, section.big ? 3 : CHUNK_ROWS).map((chunk) => (
                <LazyChunk key={chunk.start} height={chunk.height} eager={eager(chunk.height)} className={section.big ? "grid-cols-4" : "grid-cols-8"}>
                  {section.images.slice(chunk.start, chunk.end).map((emoji) => (
                    <button key={`custom:${emoji.name}`} type="button" title={titleOf(emoji)} className={cn("flex items-center justify-center rounded-md hover:bg-panel-2", section.big ? "h-[4.5rem] w-[4.5rem]" : "h-8 w-8")} onClick={() => pick(entryOf(emoji))}>
                      <CustomEmojiImage controller={controller} emoji={emoji} size={section.big ? 56 : 22} square />
                    </button>
                  ))}
                </LazyChunk>
              ))}
              {(section.images.length === 0 && section.text.length === 0) || !controller ? <div className="py-3 text-center text-xs text-muted">{section.empty}</div> : null}
              {section.add && (
                <button type="button" className="mb-1 mt-1 w-full rounded-lg border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:bg-panel hover:text-ink" onClick={add}>{t("emojiPicker.add")}</button>
              )}
            </>
          );
        } else {
          body = gridChunks(section.entries.length, 8, CELL, CHUNK_ROWS).map((chunk) => (
            <LazyChunk key={chunk.start} height={chunk.height} eager={eager(chunk.height)} className="grid-cols-8">
              {section.entries.slice(chunk.start, chunk.end).map((entry) => (
                <button key={entry.shortcode} type="button" title={`:${entry.shortcode}:`} className="flex h-8 w-8 items-center justify-center rounded-md text-xl hover:bg-panel-2" onClick={() => pick(entry)}>
                  {entry.glyph}
                </button>
              ))}
            </LazyChunk>
          ));
        }
        return (
          <section key={section.key} ref={(el) => register(section.key, el)} data-emoji-section={section.key} aria-label={section.label}>
            {/* Stays at the top while its section scrolls; the next section's header pushes it away. */}
            <div className="sticky top-0 z-[1] flex h-6 items-center bg-canvas text-[11px] font-medium tracking-wide text-muted">{section.label}</div>
            {body}
          </section>
        );
      })}
    </>
  );
});

/** Searching: one flat list of hits (custom first, as before the one-list picker). */
function SearchResults({ query, customByName, controller, pick }: { query: string; customByName: ReadonlyMap<string, CustomEmojiOut>; controller?: AppController; pick: (entry: EmojiEntry) => void }) {
  const hits = useMemo(() => searchEmoji(query), [query]);
  const customHits = controller ? customEmojiCandidates(query, customByName, 40).map((e) => customByName.get(e.shortcode)!).filter(Boolean) : [];
  const textHits = customHits.filter((c) => c.kind === "text");
  const imageHits = customHits.filter((c) => c.kind !== "text");
  return (
    <div className="mt-2 grid min-h-16 grid-cols-8 content-start overflow-y-auto overscroll-contain" style={{ maxHeight: "18rem" }}>
      {controller && textHits.length > 0 && (
        <div className="col-span-full mb-1 flex flex-wrap gap-1" aria-label={t("feature.textEmoji")}>
          {textHits.map((emoji) => (
            <button key={`text:${emoji.name}`} type="button" title={titleOf(emoji)} className="flex h-8 items-center rounded-md px-1 hover:bg-panel-2" onClick={() => pick(entryOf(emoji))}>
              <CustomEmojiImage controller={controller} emoji={emoji} size={20} />
            </button>
          ))}
        </div>
      )}
      {controller && imageHits.map((emoji) => (
        <button key={`custom:${emoji.name}`} type="button" title={titleOf(emoji)} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-panel-2" onClick={() => pick(entryOf(emoji))}>
          <CustomEmojiImage controller={controller} emoji={emoji} size={22} square />
        </button>
      ))}
      {hits.map((entry) => (
        <button key={entry.shortcode} type="button" title={`:${entry.shortcode}:`} className="flex h-8 w-8 items-center justify-center rounded-md text-xl hover:bg-panel-2" onClick={() => pick(entry)}>
          {entry.glyph}
        </button>
      ))}
      {hits.length === 0 && customHits.length === 0 && <div className="col-span-full py-6 text-center text-xs text-muted">{t("workflow.notFound")}</div>}
    </div>
  );
}

interface LazyRoot {
  attach(root: Element | null): void;
  detach(): void;
  observe(el: Element, onNear: () => void): () => void;
  /** Tells every waiting chunk within `root`'s view (and the margin) at once, as the observer would a frame later. */
  reveal(root: Element): void;
}

const MARGIN = 320;

/**
 * One IntersectionObserver for a picker's list: a chunk registers itself and is told once when it comes within a view
 * or so of the visible part. Chunks register before the list attaches (children's effects run first), so they wait.
 */
function createLazyRoot(): LazyRoot {
  let io: IntersectionObserver | null = null;
  const waiting = new Map<Element, () => void>();
  return {
    attach(root) {
      if (typeof IntersectionObserver === "undefined" || !root) {
        for (const near of waiting.values()) near();
        waiting.clear();
        return;
      }
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const near = waiting.get(entry.target);
          waiting.delete(entry.target);
          io?.unobserve(entry.target);
          near?.();
        }
      }, { root, rootMargin: `${MARGIN}px 0px` });
      for (const el of waiting.keys()) io.observe(el);
    },
    detach() {
      io?.disconnect();
      io = null;
    },
    reveal(root) {
      const view = root.getBoundingClientRect();
      for (const [el, near] of [...waiting]) {
        const box = el.getBoundingClientRect();
        if (box.bottom < view.top - MARGIN || box.top > view.bottom + MARGIN) continue;
        waiting.delete(el);
        io?.unobserve(el);
        near();
      }
    },
    observe(el, onNear) {
      waiting.set(el, onNear);
      io?.observe(el);
      return () => {
        waiting.delete(el);
        io?.unobserve(el);
      };
    },
  };
}

const LazyContext = createContext<LazyRoot | null>(null);

/** A run of grid rows: its exact height from the start, its cells drawn once near the view (or at once if `eager`). */
function LazyChunk({ height, eager, className, children }: { height: number; eager: boolean; className: string; children: ReactNode }) {
  const lazy = useContext(LazyContext);
  const [near, setNear] = useState(eager || !lazy || typeof IntersectionObserver === "undefined");
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (near || !lazy || !ref.current) return undefined;
    return lazy.observe(ref.current, () => setNear(true));
  }, [near, lazy]);
  return (
    <div ref={ref} className={cn("grid content-start", className)} style={{ height }}>
      {near ? children : null}
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
