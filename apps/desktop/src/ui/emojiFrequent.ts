/**
 * The emoji picker's 「よく使う」 (docs/EMOJI.md §9.4): the emoji I use, ranked by frecency (each use counts 1 and
 * halves every two weeks), kept per device in localStorage. The rule and its cases are shared with iOS and Android:
 * apps/shared/emoji-frequent.json (tests/emojiFrequent.test.ts runs them). The quick reactions keep their own recent
 * list (EmojiPicker's `chikuwa.emoji.recent`, apps/shared/quick-reactions.json).
 */

export interface FrequentEntry {
  glyph: string;
  score: number;
  /** When it was last used (ms since the epoch). */
  last: number;
}

export const FREQUENT_HALF_LIFE_MS = 14 * 24 * 3600 * 1000;
/** Entries remembered; a new one past this replaces the lowest ranked. */
export const FREQUENT_KEPT = 64;
/** Rows 「よく使う」 fills. */
export const FREQUENT_ROWS = 2;
const SEED_STEP_MS = 1000;

const rankKey = (e: FrequentEntry) => Math.log2(e.score) + e.last / FREQUENT_HALF_LIFE_MS;
const byGlyph = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Highest first: the order of the scores decayed to any one moment; then the latest; then the glyph. */
export function rankFrequent(entries: readonly FrequentEntry[]): FrequentEntry[] {
  return [...entries].sort((a, b) => rankKey(b) - rankKey(a) || b.last - a.last || byGlyph(a.glyph, b.glyph));
}

/** One use of `glyph` at `now`. */
export function recordFrequent(entries: readonly FrequentEntry[], glyph: string, now: number): FrequentEntry[] {
  if (!glyph) return [...entries];
  const at = entries.findIndex((e) => e.glyph === glyph);
  if (at >= 0) {
    const e = entries[at]!;
    const decayed = e.score * 2 ** (-Math.max(0, now - e.last) / FREQUENT_HALF_LIFE_MS);
    const next = [...entries];
    next[at] = { glyph, score: decayed + 1, last: Math.max(e.last, now) };
    return next;
  }
  const kept = entries.length >= FREQUENT_KEPT ? rankFrequent(entries).slice(0, FREQUENT_KEPT - 1) : [...entries];
  return [...kept, { glyph, score: 1, last: now }];
}

/** Without a stored list: what was kept before (newest first, a count where known), each once, a second apart. */
export function seedFrequent(legacy: ReadonlyArray<{ glyph: string; count?: number }>, now: number): FrequentEntry[] {
  const seen = new Set<string>();
  const out: FrequentEntry[] = [];
  for (const { glyph, count } of legacy) {
    if (!glyph || seen.has(glyph)) continue;
    seen.add(glyph);
    out.push({ glyph, score: Math.max(1, count ?? 1), last: now - out.length * SEED_STEP_MS });
  }
  return rankFrequent(out).slice(0, FREQUENT_KEPT);
}

/** Cells a pill `pill` wide takes in columns `cell` wide and `gap` apart (n cells span n·cell + (n−1)·gap). */
export function pillSpan(pill: number, cell: number, gap: number, columns: number): number {
  return Math.min(columns, Math.max(1, Math.ceil((pill + gap) / (cell + gap) - 1e-9)));
}

/** A text emoji pill's width / height, estimated from its label (0.6 em a character below U+2E80, else 1 em). */
export function pillAspect(label: string): number {
  let ems = 0;
  for (const ch of label) ems += ch.codePointAt(0)! < 0x2e80 ? 0.6 : 1;
  return Math.max(1, ems * 0.68 + 0.56);
}

/**
 * 「よく使う」's rows: in rank order each item goes in the first row with `span` cells free, and is left out when no
 * row has room, until every row is full — whole rows when there are enough, whatever the pills' widths.
 */
export function fillFrequent<T extends { span?: number }>(items: readonly T[], columns: number, rows = FREQUENT_ROWS): T[][] {
  const free = Array.from({ length: rows }, () => columns);
  const out: T[][] = Array.from({ length: rows }, () => []);
  for (const item of items) {
    if (free.every((f) => f === 0)) break;
    const span = Math.min(columns, Math.max(1, item.span ?? 1));
    const row = free.findIndex((f) => f >= span);
    if (row < 0) continue;
    out[row]!.push(item);
    free[row]! -= span;
  }
  return out.filter((row) => row.length > 0);
}

// --- this device's list ------------------------------------------------------------------------------------------

const KEY = "chikuwa.emoji.frequent";
const LEGACY_RECENT_KEY = "chikuwa.emoji.recent";

let lastRead: { raw: string | null; value: FrequentEntry[]; ranked: string[] } = { raw: null, value: [], ranked: [] };
const listeners = new Set<() => void>();

function parse(raw: string): FrequentEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((e): e is FrequentEntry => !!e && typeof e.glyph === "string" && !!e.glyph && typeof e.score === "number" && e.score > 0 && typeof e.last === "number").slice(0, FREQUENT_KEPT);
  } catch {
    return null;
  }
}

function legacy(raw: string | null): FrequentEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    const list = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    return seedFrequent(list.map((glyph) => ({ glyph })), Date.now());
  } catch {
    return [];
  }
}

function readEntries(): FrequentEntry[] {
  let raw: string | null = null;
  let recentRaw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
    // Never stored yet: started from the recent list (what this device kept before 2026-10-29).
    if (raw === null) recentRaw = localStorage.getItem(LEGACY_RECENT_KEY);
  } catch {
    /* no storage: nothing */
  }
  const cacheKey = raw ?? `legacy:${recentRaw ?? ""}`;
  if (cacheKey === lastRead.raw) return lastRead.value;
  const value = (raw === null ? null : parse(raw)) ?? legacy(recentRaw);
  lastRead = { raw: cacheKey, value, ranked: rankFrequent(value).map((e) => e.glyph) };
  return value;
}

/** The glyphs (and custom `:name:`s), best first; the same array while nothing changed (memoized rows compare it). */
export function readFrequentEmoji(): string[] {
  readEntries();
  return lastRead.ranked;
}

/** Counts one use (EmojiPicker's rememberEmoji: a reaction I add, an emoji put in the composer). */
export function noteFrequentEmoji(glyph: string, now = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(recordFrequent(readEntries(), glyph, now)));
  } catch {
    /* per-device convenience only */
  }
  for (const listener of listeners) listener();
}

export function subscribeFrequentEmoji(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
