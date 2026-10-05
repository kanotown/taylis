/**
 * M115 (docs/I18N.md): the UI language. Japanese (the source texts), English or Simplified Chinese.
 *
 * Texts live in a typed dictionary per locale (ja.ts, en.ts, zhHans.ts); `t(key, params)` returns the
 * current locale's text. `{name}` is a parameter; `{count, plural, one {…} other {…}}` picks by the
 * number (`#` inside is the number), as in ICU MessageFormat. The ja dictionary is the type: a key
 * missing from another locale, or one that is not in ja, does not compile.
 *
 * The locale: the person's choice (UserMe.locale, cached here so the next start draws in it at once),
 * else the browser's / OS's language when it is one of ours, else Japanese. A change re-renders the
 * app (App keys its tree by the locale); never call `t` while a module loads (the result would stay
 * in the language of the start) — tests/i18n.test.ts checks that.
 */
import { en } from "./en";
import { ja } from "./ja";
import { zhHans } from "./zhHans";

export type UiLocale = "ja" | "en" | "zh-Hans";
export const UI_LOCALES: readonly UiLocale[] = ["ja", "en", "zh-Hans"];
export type MessageKey = keyof typeof ja;
export type Params = Readonly<Record<string, string | number | null | undefined>>;

const DICTIONARIES: Readonly<Record<UiLocale, Readonly<Record<MessageKey, string>>>> = { ja, en, "zh-Hans": zhHans };
const STORAGE_KEY = "taylis.locale";

/** A language tag as one of ours (ja*, en*, any zh → zh-Hans), else null. */
export function normalizeLocale(tag: string | null | undefined): UiLocale | null {
  if (!tag) return null;
  const primary = tag.trim().replace("_", "-").split("-")[0]!.toLowerCase();
  if (primary === "ja") return "ja";
  if (primary === "en") return "en";
  if (primary === "zh") return "zh-Hans";
  return null;
}

/** The browser's / OS's first language that is one of ours, else Japanese. */
export function deviceLocale(languages: readonly string[] | undefined = typeof navigator === "undefined" ? undefined : navigator.languages): UiLocale {
  for (const tag of languages ?? []) {
    const found = normalizeLocale(tag);
    if (found) return found;
  }
  return "ja";
}

function readStoredPreference(): UiLocale | null {
  try {
    return normalizeLocale(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

let preference: UiLocale | null = readStoredPreference();
let current: UiLocale = preference ?? deviceLocale();
const listeners = new Set<() => void>();

export function getLocale(): UiLocale {
  return current;
}

/** The person's choice (null = follow the device). */
export function getLocalePreference(): UiLocale | null {
  return preference;
}

/** Applies the person's choice (null = the device's language), remembers it for the next start, re-renders. */
export function setLocalePreference(value: string | null | undefined): void {
  preference = normalizeLocale(value);
  try {
    if (preference) globalThis.localStorage?.setItem(STORAGE_KEY, preference);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private window): the choice still applies until the app closes.
  }
  setLocale(preference ?? deviceLocale());
}

/** Switches the locale used by `t` (tests; the app goes through setLocalePreference). */
export function setLocale(locale: UiLocale): void {
  if (locale === current) return;
  current = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The BCP 47 tag for Intl (dates, numbers, collation) in the current locale. */
export function intlLocale(locale: UiLocale = current): string {
  return locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
}

/** A weekday's name in the current locale; `day` counts from Monday (0) like the server's date.weekday(). */
export function weekdayName(day: number, style: "long" | "short" = "short", locale: UiLocale = current): string {
  // 2024-01-01 was a Monday.
  return new Date(Date.UTC(2024, 0, 1 + (((day % 7) + 7) % 7), 12)).toLocaleDateString(intlLocale(locale), { weekday: style, timeZone: "UTC" });
}

/** The value of the Accept-Language header: the server writes errors and notices in it. */
export function acceptLanguage(): string {
  return current;
}

// --- t() ------------------------------------------------------------------------------------------

/** Keys looked up while modules were still loading (tests/i18n.test.ts expects none). */
export const importTimeCalls: string[] = [];
let started = false;
/** main.tsx, before the first render: from now on `t` is called while rendering, not while loading. */
export function markStarted(): void {
  started = true;
}

export function t(key: MessageKey, params?: Params): string {
  if (!started) importTimeCalls.push(key);
  const text = DICTIONARIES[current][key] ?? ja[key] ?? key;
  return params ? format(text, params, current) : text;
}

/** The text of `key` in a given locale (the language picker shows each name in its own language). */
export function tIn(locale: UiLocale, key: MessageKey, params?: Params): string {
  const text = DICTIONARIES[locale][key] ?? ja[key] ?? key;
  return params ? format(text, params, locale) : text;
}

/**
 * A `[value, label]` pair for a module-level option list whose label is looked up when read (`t` at load time would
 * keep the start's language). Destructuring, `.map(([v, l]) => …)` and toEqual see an ordinary pair.
 */
export function labelled<const T>(value: T, key: MessageKey): [T, string] {
  const pair: [T, string] = [value, ""];
  Object.defineProperty(pair, 1, { get: () => t(key), enumerable: true });
  return pair;
}

const pluralRules = new Map<UiLocale, Intl.PluralRules>();

function plural(locale: UiLocale, n: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(intlLocale(locale))));
  return rules.select(n);
}

/** `{name}` parameters and `{n, plural, =0 {…} one {…} other {…}}` (one level; `#` = the number). */
export function format(text: string, params: Params, locale: UiLocale = current): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = matchingBrace(text, open);
    if (close < 0) {
      out += text.slice(open);
      break;
    }
    out += placeholder(text.slice(open + 1, close), params, locale);
    i = close + 1;
  }
  return out;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return j;
  }
  return -1;
}

function placeholder(inner: string, params: Params, locale: UiLocale): string {
  const pluralMatch = /^\s*(\w+)\s*,\s*plural\s*,(.*)$/s.exec(inner);
  if (!pluralMatch) {
    const name = inner.trim();
    return name in params ? String(params[name] ?? "") : `{${inner}}`;
  }
  const name = pluralMatch[1]!;
  const n = Number(params[name] ?? 0);
  const branches = new Map<string, string>();
  const body = pluralMatch[2]!;
  let j = 0;
  while (j < body.length) {
    const sel = /\s*(=\d+|\w+)\s*\{/y;
    sel.lastIndex = j;
    const m = sel.exec(body);
    if (!m) break;
    const open = sel.lastIndex - 1;
    const close = matchingBrace(body, open);
    if (close < 0) break;
    branches.set(m[1]!, body.slice(open + 1, close));
    j = close + 1;
  }
  const chosen = branches.get(`=${n}`) ?? branches.get(plural(locale, n)) ?? branches.get("other") ?? "";
  return format(chosen.replace(/#/g, String(n)), params, locale);
}

if (typeof document !== "undefined") document.documentElement.lang = current;
