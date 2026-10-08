/** M16b: the search screen's conditions, date presets, recent searches and as-you-type suggestions. */
import type { ChannelState, UserPublic } from "../sync/types";
import { t, intlLocale } from "../i18n";

export type HasFlag = "file" | "link" | "pin" | "reaction" | "poll";
export type SearchSort = "relevance" | "newest";
export type DatePreset = "today" | "yesterday" | "week" | "month" | "year";

/** What the results show: the words plus filters picked from menus (typed modifiers stay in `q`). */
export interface SearchParams {
  q: string;
  fromUserId: string | null;
  channelId: string | null;
  /** A preset is resolved when the search runs, so a remembered 「今日」 stays today. */
  date: { preset: DatePreset } | { from: string | null; to: string | null } | null;
  has: HasFlag[];
  isThread: boolean;
  /** L8: only times (`is:times`, TIMES_FEED.md §6), joined or not. Optional: recent searches saved before lack it. */
  isTimes?: boolean;
  sort: SearchSort;
}

export const EMPTY_SEARCH: SearchParams = { q: "", fromUserId: null, channelId: null, date: null, has: [], isThread: false, isTimes: false, sort: "relevance" };

export const HAS_FLAGS: readonly HasFlag[] = ["file", "link", "pin", "reaction", "poll"];

export const HAS_LABELS: Readonly<Record<HasFlag, string>> = {
  get file() { return t("search.has.file"); },
  get link() { return t("search.has.link"); },
  get pin() { return t("main.pins"); },
  get reaction() { return t("search.has.reaction"); },
  get poll() { return t("search.has.poll"); },
};

export const DATE_PRESETS: ReadonlyArray<{ preset: DatePreset; label: string }> = [
  { preset: "today", get label() { return t("common.today"); } },
  { preset: "yesterday", get label() { return t("search.date.yesterday"); } },
  { preset: "week", get label() { return t("search.date.week"); } },
  { preset: "month", get label() { return t("search.date.month"); } },
  { preset: "year", get label() { return t("search.date.year"); } },
];

export function hasFilters(params: SearchParams): boolean {
  return !!(params.fromUserId || params.channelId || params.date || params.has.length > 0 || params.isThread || params.isTimes);
}

/** Nothing to look for: no words and no filters (the server answers 422 empty_query). */
export function isEmptySearch(params: SearchParams): boolean {
  return !params.q.trim() && !hasFilters(params);
}

function midnight(day: Date, offsetDays = 0): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + offsetDays);
}

/** "YYYY-MM-DD" in the local zone → that local midnight; null for anything else. */
function localDay(value: string | null): Date | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? null : day;
}

/** The instants the API filters on: `after` inclusive, `before` exclusive, in the viewer's days. */
export function dateRange(date: SearchParams["date"], now: Date = new Date()): { after: string | null; before: string | null } {
  if (!date) return { after: null, before: null };
  if ("preset" in date) {
    const back = { today: 0, yesterday: 1, week: 6, month: 29, year: 364 }[date.preset];
    return {
      after: midnight(now, -back).toISOString(),
      before: date.preset === "yesterday" ? midnight(now).toISOString() : null,
    };
  }
  const from = localDay(date.from);
  const to = localDay(date.to);
  return { after: from ? from.toISOString() : null, before: to ? midnight(to, 1).toISOString() : null };
}

/** The chip text for the date filter. */
export function dateLabel(date: SearchParams["date"]): string | null {
  if (!date) return null;
  if ("preset" in date) return DATE_PRESETS.find((p) => p.preset === date.preset)?.label ?? null;
  const from = date.from?.replaceAll("-", "/");
  const to = date.to?.replaceAll("-", "/");
  if (from && to) return from === to ? from : `${from} ${t("common.rangeTo")} ${to}`;
  if (from) return t("search.date.since", { date: from });
  if (to) return t("search.date.until", { date: to });
  return null;
}

/** GET /search/messages parameters; searches without words are always newest first. */
export function toQuery(params: SearchParams, now: Date = new Date()): {
  q: string;
  channel_id: string | null;
  from_user_id: string | null;
  after: string | null;
  before: string | null;
  has: HasFlag[];
  is_thread: boolean;
  is_times: boolean;
  sort: SearchSort;
} {
  const q = params.q.trim();
  return {
    q,
    channel_id: params.channelId,
    from_user_id: params.fromUserId,
    ...dateRange(params.date, now),
    has: params.has,
    is_thread: params.isThread,
    is_times: !!params.isTimes,
    sort: q ? params.sort : "newest",
  };
}

function dayString(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * M70 (docs/AI.md §13.1): the question for 「AI に聞く」: the words as typed, and the filters picked from menus as the
 * modifiers the server reads (`from:@name`, `after:` / `before:` in the viewer's days, `has:`, `is:thread`, `is:times`).
 * The conversation goes apart, as `channel_id`.
 */
export function askQuery(params: SearchParams, usernameOf: (userId: string) => string | undefined, now: Date = new Date()): string {
  const parts = [params.q.trim()];
  const username = params.fromUserId ? usernameOf(params.fromUserId) : undefined;
  if (username) parts.push(`from:@${username}`);
  const date = params.date;
  if (date) {
    // `after:D` is from the day after D, `before:D` until D (exclusive), as in the search box.
    let first: Date | null = null;
    let last: Date | null = null;
    if ("preset" in date) {
      const back = { today: 0, yesterday: 1, week: 6, month: 29, year: 364 }[date.preset];
      first = midnight(now, -back);
      if (date.preset === "yesterday") last = midnight(now, -1);
    } else {
      first = localDay(date.from);
      last = localDay(date.to);
    }
    if (first) parts.push(`after:${dayString(midnight(first, -1))}`);
    if (last) parts.push(`before:${dayString(midnight(last, 1))}`);
  }
  for (const flag of params.has) parts.push(`has:${flag}`);
  if (params.isThread) parts.push("is:thread");
  if (params.isTimes) parts.push("is:times");
  return parts.filter(Boolean).join(" ");
}

/** 「123 件」, or 「1,000 件以上」 when the server stopped counting. */
export function totalLabel(total: number, capped: boolean): string {
  return capped ? t("search.countCapped", { count: total.toLocaleString(intlLocale()) }) : t("search.count", { count: total.toLocaleString(intlLocale()) });
}

// ---- recent searches (per workspace and account, this device only) ----

const RECENT_MAX = 10;

export function recentKey(account: string): string {
  return `chikuwa.search.recent:${account}`;
}

function sameSearch(a: SearchParams, b: SearchParams): boolean {
  return JSON.stringify({ ...a, sort: null }) === JSON.stringify({ ...b, sort: null });
}

export function readRecent(key: string): SearchParams[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is Partial<SearchParams> => typeof entry === "object" && entry !== null && typeof (entry as SearchParams).q === "string")
      .map((entry) => ({ ...EMPTY_SEARCH, ...entry, has: Array.isArray(entry.has) ? entry.has.filter((f) => HAS_FLAGS.includes(f)) : [] }))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Newest first, without duplicates; returns the new list. */
export function pushRecent(key: string, params: SearchParams): SearchParams[] {
  if (isEmptySearch(params)) return readRecent(key);
  const entry = { ...params, q: params.q.trim() };
  const next = [entry, ...readRecent(key).filter((old) => !sameSearch(old, entry))].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* a convenience only */
  }
  return next;
}

export function removeRecent(key: string, params: SearchParams): SearchParams[] {
  const next = readRecent(key).filter((old) => !sameSearch(old, params));
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* a convenience only */
  }
  return next;
}

export function clearRecent(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* a convenience only */
  }
}

// ---- suggestions under the search box ----

export type Suggestion =
  | { kind: "search"; q: string }
  | { kind: "recent"; params: SearchParams }
  | { kind: "user"; user: UserPublic }
  | { kind: "channel"; channel: ChannelState }
  | { kind: "has"; flag: HasFlag }
  | { kind: "thread" }
  /** L8: 「is:times」 (TIMES_FEED.md §6). */
  | { kind: "times" };

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/**
 * Empty box: recent searches, then quick filters. While typing: people (→ 送信者) and conversations (→ チャンネル)
 * whose names match, matching recent searches, and last 「「語」のすべての結果を見る」 (the results page; the search box
 * puts its live message results just above it).
 */
export function suggestions(
  input: string,
  context: {
    users: Iterable<UserPublic>;
    channels: Iterable<ChannelState>;
    recent: readonly SearchParams[];
    channelTitle: (channel: ChannelState) => string;
  },
): Suggestion[] {
  const text = input.trim();
  if (!text) {
    return [
      ...context.recent.slice(0, RECENT_MAX).map((params): Suggestion => ({ kind: "recent", params })),
      ...HAS_FLAGS.slice(0, 3).map((flag): Suggestion => ({ kind: "has", flag })),
      { kind: "thread" },
      { kind: "times" },
    ];
  }
  const needle = fold(text.replace(/^[@#]/, ""));
  const users = [...context.users]
    .filter((u) => !u.deactivated_at && (fold(u.display_name).includes(needle) || fold(u.username).includes(needle)))
    .sort((a, b) => Number(!fold(a.username).startsWith(needle)) - Number(!fold(b.username).startsWith(needle)) || a.display_name.localeCompare(b.display_name, "ja"))
    .slice(0, 4)
    .map((user): Suggestion => ({ kind: "user", user }));
  const channels = [...context.channels]
    .filter((c) => c.isMember && fold(context.channelTitle(c)).includes(needle))
    .sort((a, b) => context.channelTitle(a).localeCompare(context.channelTitle(b), "ja"))
    .slice(0, 4)
    .map((channel): Suggestion => ({ kind: "channel", channel }));
  const recent = context.recent
    .filter((params) => params.q && fold(params.q).includes(fold(text)) && params.q !== text)
    .slice(0, 3)
    .map((params): Suggestion => ({ kind: "recent", params }));
  return [...users, ...channels, ...recent, { kind: "search", q: text }];
}
