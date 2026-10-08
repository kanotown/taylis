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

interface SlashItem {
  key: SlashKey;
  label: MessageKey;
  /** Typed after `/` to find it (English and romaji; the label in the UI language matches too). */
  words: readonly string[];
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  { key: "h1", label: "docs.slash.h1", words: ["h1", "heading", "midashi", "見出し"] },
  { key: "h2", label: "docs.slash.h2", words: ["h2", "heading", "midashi", "見出し"] },
  { key: "h3", label: "docs.slash.h3", words: ["h3", "heading", "midashi", "見出し"] },
  { key: "bullets", label: "docs.slash.bullets", words: ["list", "bullet", "ul", "risuto", "箇条書き", "リスト"] },
  { key: "numbered", label: "docs.slash.numbered", words: ["numbered", "ol", "number", "bangou", "番号"] },
  { key: "tasks", label: "docs.slash.tasks", words: ["todo", "task", "check", "checklist", "chekku", "チェック", "タスク"] },
  { key: "quote", label: "docs.slash.quote", words: ["quote", "inyou", "引用"] },
  { key: "callout", label: "docs.slash.callout", words: ["callout", "note", "info", "warning", "ko-ruauto", "コールアウト", "注意", "メモ"] },
  { key: "toggle", label: "docs.slash.toggle", words: ["toggle", "details", "collapse", "fold", "toguru", "トグル", "折りたたみ"] },
  { key: "table", label: "docs.slash.table", words: ["table", "hyou", "表"] },
  { key: "code", label: "docs.slash.code", words: ["code", "ko-do", "コード"] },
  { key: "math", label: "docs.slash.math", words: ["math", "equation", "tex", "suushiki", "数式"] },
  { key: "divider", label: "docs.slash.divider", words: ["divider", "rule", "hr", "line", "kugiri", "区切り"] },
  { key: "image", label: "docs.slash.image", words: ["image", "picture", "photo", "gazou", "画像"] },
  { key: "pageLink", label: "docs.slash.pageLink", words: ["link", "page", "rinku", "リンク", "ページ"] },
  { key: "childPage", label: "docs.slash.childPage", words: ["page", "child", "subpage", "new", "pe-ji", "子ページ", "ページ"] },
  { key: "database", label: "docs.slash.database", words: ["database", "db", "calendar", "board", "de-tabe-su", "データベース", "カレンダー"] },
  { key: "embedDatabase", label: "docs.slash.embedDatabase", words: ["embed", "database", "db", "view", "linked", "umekomi", "埋め込み", "データベース"] },
];

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
