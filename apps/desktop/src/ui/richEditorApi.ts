/**
 * What the composer and the edit box ask of the rich editor (RichEditor.tsx), kept apart so they do not load TipTap
 * before rich mode is used.
 */
import { lazy } from "react";

export type RichFormat = "bold" | "italic" | "strike" | "code" | "codeBlock" | "heading" | "quote" | "bullets" | "numbered";

/** Which formats apply at the caret (the format bar shows them pressed). */
export type RichFormatState = Record<RichFormat | "link", boolean>;

export const NO_FORMAT: RichFormatState = { bold: false, italic: false, strike: false, code: false, codeBlock: false, heading: false, quote: false, bullets: false, numbered: false, link: false };

export interface RichEditorApi {
  focus(at?: "start" | "end" | "keep"): void;
  /** Replaces the document (a template, a slash command) and puts the caret at its end; returns the Markdown kept. */
  setMarkdown(markdown: string): string;
  /** Replaces the `length` characters before the caret (a mention or emoji being completed) with `text`. */
  replaceBeforeCaret(length: number, text: string): void;
  insertText(text: string): void;
  run(format: RichFormat): void;
  /** The link at the caret, null when there is none. */
  link(): string | null;
  /** Links the selection (or inserts the URL as a link); null or "" removes the link at the caret. */
  setLink(href: string | null): void;
  selectedText(): string;
  isEmpty(): boolean;
  inCodeBlock(): boolean;
  composing(): boolean;
  /** The editor's own newline: a new line, list item or code line (an empty item or quote line ends it). */
  newline(): boolean;
  undo(): boolean;
  redo(): boolean;
}

/** The editor itself, loaded on first use (its own chunk). */
export const LazyRichEditor = lazy(() => import("./RichEditor"));

/** Composition and the Enter that WebKit sends right after it (confirming a conversion) never send or format. */
export const IME_COMMIT_GRACE_MS = 100;

export function isImeKey(event: { isComposing?: boolean; keyCode?: number }, composing: boolean, composedAt: number, now = Date.now()): boolean {
  return Boolean(event.isComposing) || composing || event.keyCode === 229 || now - composedAt < IME_COMMIT_GRACE_MS;
}
