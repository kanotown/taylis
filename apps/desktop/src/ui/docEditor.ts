/**
 * M121 (WIKI.md §7.3): what a Docs page adds to the canvas editor — `[[` to link a page (`[title](page:<uuid>)`, by id,
 * so renaming never breaks it) and the `/` menu at the start of a line (headings, lists, tasks, table, code, math,
 * divider, image, a page link, a new child page), so nobody needs the Markdown signs. Pure text edits here; the editor
 * (ui/CanvasEditor.tsx) shows the lists and runs the ones that need a dialog or the server.
 */
import type { EditState } from "./composerEdit";
import { insertRule } from "./canvasText";
import { type MessageKey, t } from "../i18n";

/** `[[` before the caret on the same line, with what was typed after it (no `]`, `[` or line break). */
export function pageLinkQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("[[");
  if (at < 0) return null;
  const query = before.slice(at + 2);
  if (query.length > 80 || /[[\]\n]/.test(query)) return null;
  return { start: at, query };
}

/** A page's title as a link label: brackets and line breaks would end the link early. */
export function linkLabel(title: string): string {
  const clean = title.replace(/[[\]]/g, (c) => (c === "[" ? "［" : "］")).replace(/\s*\n\s*/g, " ").trim();
  return clean || t("docs.untitled");
}

/** `[[query` (from `start` to the caret) replaced by the page's link; the caret after it. */
export function insertPageLink(state: EditState, start: number, page: { id: string; title: string }): EditState {
  const link = `[${linkLabel(page.title)}](page:${page.id})`;
  const text = state.text.slice(0, start) + link + state.text.slice(state.start);
  const caret = start + link.length;
  return { text, start: caret, end: caret };
}

/** A link put in at the caret (the `/` menu's 「子ページ」 once the page exists). */
export function insertLinkAt(state: EditState, page: { id: string; title: string }): EditState {
  const link = `[${linkLabel(page.title)}](page:${page.id})`;
  const text = state.text.slice(0, state.start) + link + state.text.slice(state.end);
  const caret = state.start + link.length;
  return { text, start: caret, end: caret };
}

/** `/` typed at the start of a line, with the letters after it (the menu filters by them). */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const match = /^\/([^\s/]{0,20})$/u.exec(text.slice(lineStart, caret));
  return match ? { start: lineStart, query: match[1] ?? "" } : null;
}

export type SlashKey = "h1" | "h2" | "h3" | "bullets" | "numbered" | "tasks" | "quote" | "callout" | "toggle" | "table" | "code" | "math" | "divider" | "image" | "pageLink" | "childPage" | "database" | "embedDatabase";

/** M155 (WIKI.md §30.2): the sections of the page editor's `/` menu (the Markdown editor's list stays flat). */
export type SlashGroup = "basic" | "list" | "media" | "embed" | "advanced";

export interface SlashItem {
  key: SlashKey;
  label: MessageKey;
  /** M155: one line under the label (what the block is for). */
  hint: MessageKey;
  group: SlashGroup;
  /** Typed after `/` to find it (English names and aliases, romaji; the label in the UI language matches too). */
  words: readonly string[];
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  { key: "h1", label: "docs.slash.h1", hint: "docs.slash.hint.h1", group: "basic", words: ["h1", "heading", "title", "midashi", "見出し"] },
  { key: "h2", label: "docs.slash.h2", hint: "docs.slash.hint.h2", group: "basic", words: ["h2", "heading", "midashi", "見出し"] },
  { key: "h3", label: "docs.slash.h3", hint: "docs.slash.hint.h3", group: "basic", words: ["h3", "heading", "midashi", "見出し"] },
  { key: "bullets", label: "docs.slash.bullets", hint: "docs.slash.hint.bullets", group: "list", words: ["list", "bullet", "bulleted", "ul", "risuto", "箇条書き", "リスト"] },
  { key: "numbered", label: "docs.slash.numbered", hint: "docs.slash.hint.numbered", group: "list", words: ["numbered", "ordered", "ol", "number", "bangou", "番号"] },
  { key: "tasks", label: "docs.slash.tasks", hint: "docs.slash.hint.tasks", group: "list", words: ["todo", "to-do", "task", "check", "checkbox", "checklist", "chekku", "チェック", "タスク"] },
  { key: "quote", label: "docs.slash.quote", hint: "docs.slash.hint.quote", group: "basic", words: ["quote", "blockquote", "inyou", "引用"] },
  { key: "callout", label: "docs.slash.callout", hint: "docs.slash.hint.callout", group: "basic", words: ["callout", "note", "info", "warning", "ko-ruauto", "コールアウト", "注意", "メモ"] },
  { key: "toggle", label: "docs.slash.toggle", hint: "docs.slash.hint.toggle", group: "basic", words: ["toggle", "details", "collapse", "fold", "toguru", "トグル", "折りたたみ"] },
  { key: "table", label: "docs.slash.table", hint: "docs.slash.hint.table", group: "media", words: ["table", "grid", "hyou", "表"] },
  { key: "code", label: "docs.slash.code", hint: "docs.slash.hint.code", group: "advanced", words: ["code", "pre", "snippet", "ko-do", "コード"] },
  { key: "math", label: "docs.slash.math", hint: "docs.slash.hint.math", group: "advanced", words: ["math", "equation", "formula", "tex", "latex", "suushiki", "数式"] },
  { key: "divider", label: "docs.slash.divider", hint: "docs.slash.hint.divider", group: "basic", words: ["divider", "rule", "hr", "line", "separator", "kugiri", "区切り"] },
  { key: "image", label: "docs.slash.image", hint: "docs.slash.hint.image", group: "media", words: ["image", "img", "picture", "photo", "gazou", "画像"] },
  { key: "pageLink", label: "docs.slash.pageLink", hint: "docs.slash.hint.pageLink", group: "embed", words: ["link", "page", "rinku", "リンク", "ページ"] },
  { key: "childPage", label: "docs.slash.childPage", hint: "docs.slash.hint.childPage", group: "embed", words: ["page", "child", "subpage", "new", "pe-ji", "子ページ", "ページ"] },
  { key: "database", label: "docs.slash.database", hint: "docs.slash.hint.database", group: "embed", words: ["database", "db", "calendar", "board", "de-tabe-su", "データベース", "カレンダー"] },
  { key: "embedDatabase", label: "docs.slash.embedDatabase", hint: "docs.slash.hint.embedDatabase", group: "embed", words: ["embed", "database", "db", "view", "linked", "umekomi", "埋め込み", "データベース"] },
];

/** The sections of the page editor's `/` menu, in order, with their headings. */
export const SLASH_GROUPS: ReadonlyArray<{ group: SlashGroup; label: MessageKey }> = [
  { group: "basic", label: "docs.slash.group.basic" },
  { group: "list", label: "docs.slash.group.list" },
  { group: "media", label: "docs.slash.group.media" },
  { group: "embed", label: "docs.slash.group.embed" },
  { group: "advanced", label: "docs.slash.group.advanced" },
];

export interface SlashSection {
  group: SlashGroup | "recent";
  label: MessageKey;
  items: SlashItem[];
}

/**
 * M155: the `/` menu's sections for what was typed: 「最近使ったもの」 first (only while nothing is typed), then each group
 * that has a matching item. `keep` leaves items out (a callout where containers go no deeper).
 */
export function slashSections(query: string, recents: readonly SlashKey[], keep: (item: SlashItem) => boolean = () => true): SlashSection[] {
  const matching = slashItems(query).filter(keep);
  const out: SlashSection[] = [];
  if (!query.trim() && recents.length > 0) {
    const items = recents.map((key) => matching.find((item) => item.key === key)).filter((item): item is SlashItem => !!item);
    if (items.length > 0) out.push({ group: "recent", label: "docs.slash.group.recent", items });
  }
  for (const { group, label } of SLASH_GROUPS) {
    const items = matching.filter((item) => item.group === group);
    if (items.length > 0) out.push({ group, label, items });
  }
  return out;
}

/** M155: the `/` items picked most recently on this device (newest first, at most five; localStorage, never the server). */
export const SLASH_RECENT_MAX = 5;
const SLASH_RECENTS_KEY = "taylis.docs.slashRecents";

export function readSlashRecents(): SlashKey[] {
  try {
    const raw = globalThis.localStorage?.getItem(SLASH_RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const known = new Set<string>(SLASH_ITEMS.map((item) => item.key));
    return parsed.filter((key): key is SlashKey => typeof key === "string" && known.has(key)).slice(0, SLASH_RECENT_MAX);
  } catch {
    return [];
  }
}

/** `key` moved to the front of the recents (the list written back; returned for the open menu). */
export function rememberSlashKey(key: SlashKey): SlashKey[] {
  const next = [key, ...readSlashRecents().filter((k) => k !== key)].slice(0, SLASH_RECENT_MAX);
  try {
    globalThis.localStorage?.setItem(SLASH_RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* per-device convenience only */
  }
  return next;
}

/** "\n" when text follows `at` on its line (a container's close must be a line of its own). */
function lineBreakAfter(text: string, at: number): string {
  return at < text.length && text[at] !== "\n" ? "\n" : "";
}

/**
 * M149: `![[` (the `/` menu's 「データベースを埋め込む」, or typed) — the `[[` list then offers databases, and the choice
 * becomes an embed instead of a link.
 */
export function isEmbedQuery(text: string, start: number): boolean {
  return start > 0 && text[start - 1] === "!";
}

/**
 * M149 (WIKI.md §22.5): the embed `![title](page:<id>#view=<view>)` put in at the caret on a line of its own (no view:
 * the database's first), replacing the selection; the caret at the start of the next line.
 */
export function insertEmbed(state: EditState, page: { id: string; title: string }, viewId: string | null): EditState {
  const before = state.text.slice(0, state.start);
  const after = state.text.slice(state.end);
  const embed = `![${linkLabel(page.title)}](page:${page.id}${viewId ? `#view=${viewId}` : ""})`;
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const tail = after.startsWith("\n") ? "" : "\n";
  const text = before + lead + embed + tail + after;
  const caret = before.length + lead.length + embed.length + 1;
  return { text, start: caret, end: caret };
}

/** The items that match what was typed after `/` (all of them for nothing). */
export function slashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SLASH_ITEMS];
  return SLASH_ITEMS.filter((item) => t(item.label).toLowerCase().includes(q) || item.words.some((word) => word.toLowerCase().startsWith(q)));
}

/** What a chosen item does: a text edit, or something the editor runs once `/query` is gone. */
export type SlashResult = { kind: "edit"; state: EditState } | { kind: "table" | "image" | "childPage" | "database"; state: EditState };

/** The `/query` (from `start` to the caret) taken out, then the item applied at that line. */
export function applySlash(state: EditState, start: number, key: SlashKey): SlashResult {
  const text = state.text.slice(0, start) + state.text.slice(state.start);
  const at = start;
  const put = (insert: string, caretOffset = insert.length): SlashResult => ({
    kind: "edit",
    state: { text: text.slice(0, at) + insert + text.slice(at), start: at + caretOffset, end: at + caretOffset },
  });
  switch (key) {
    case "h1":
      return put("# ");
    case "h2":
      return put("## ");
    case "h3":
      return put("### ");
    case "bullets":
      return put("- ");
    case "numbered":
      return put("1. ");
    case "tasks":
      return put("- [ ] ");
    case "quote":
      return put("> ");
    // M149 (WIKI.md §22.5): the close on a line of its own even when text followed the `/` on its line.
    case "callout":
      return put(`::: callout 💡\n\n:::${lineBreakAfter(text, at)}`, "::: callout 💡\n".length);
    case "toggle":
      return put(`::: toggle \n\n:::${lineBreakAfter(text, at)}`, "::: toggle ".length);
    case "embedDatabase":
      return put("![[");
    case "code":
      return put("```\n\n```", 4);
    case "math":
      return put("$$\n\n$$", 3);
    case "pageLink":
      return put("[[");
    case "divider":
      return { kind: "edit", state: insertRule({ text, start: at, end: at }) };
    case "table":
    case "image":
    case "childPage":
    case "database":
      return { kind: key, state: { text, start: at, end: at } };
  }
}
