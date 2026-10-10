/**
 * The rich composer (「リッチ」 mode, users.composer_mode): a TipTap / ProseMirror editor that writes the same message
 * Markdown as the text area (richMarkdown.ts converts both ways). Loaded lazily (Composer.tsx, Timeline.tsx's edit box):
 * nothing of TipTap is in the main bundle, and the text area stands in while it loads.
 *
 * Only what the dialect holds: bold, italic, strike, inline code (one mark at a time: the dialect does not nest them),
 * links (http / https), `#`–`###` headings, quotes of plain lines, bullet / numbered lists three levels deep, code
 * blocks, TeX math kept as its source (a `math` mark inline, display blocks raw like tables), and tables kept as raw
 * Markdown. Markdown typed here converts as it is typed (`**x**`, `_x_`, `` `x` ``,
 * `- `, `1. `, `> `, `# `, ``` ``` ```, `[label](https://…)`); pasted plain text stays literal (escaped when sent);
 * pasted HTML (web pages, Word, Google Docs) keeps the supported marks and drops the rest; pasted files go to the
 * attachments. The owner decides what Enter does (send or newline) through `onKeyDown`, which ProseMirror never calls
 * during an IME composition.
 */
import { Editor, Mark, markInputRule, Node, type JSONContent } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Bold } from "@tiptap/extension-bold";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Heading } from "@tiptap/extension-heading";
import { Italic } from "@tiptap/extension-italic";
import { Link } from "@tiptap/extension-link";
import { BulletList } from "@tiptap/extension-list/bullet-list";
import { ListItem } from "@tiptap/extension-list/item";
import { OrderedList } from "@tiptap/extension-list/ordered-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Strike } from "@tiptap/extension-strike";
import { Text } from "@tiptap/extension-text";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { Fragment, Slice } from "@tiptap/pm/model";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import { contentLine, keepLineInView, lineHeightOf, settle } from "./composerScroll";
import { docToMarkdown, markdownToDoc, plainTextToNodes, type RichNode } from "./richMarkdown";
import type { RichEditorApi, RichFormat, RichFormatState } from "./richEditorApi";

/** Three levels of lists, as the renderer draws (apps/shared/lists.json). */
const MAX_LIST_DEPTH = 3;
const HTTP_URL = /^https?:\/\//i;

/** One mark at a time: the dialect never nests emphasis (DATA_MODEL.md 「本文の形式」). */
export const OnlyBold = Bold.extend({
  excludes: "_",
  // `**x**` and `*x*` are bold in this dialect; `__x__` is not (dunder names stay as typed).
  addInputRules() {
    return [
      markInputRule({ find: /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/, type: this.type }),
      markInputRule({ find: /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/, type: this.type }),
    ];
  },
});
export const OnlyItalic = Italic.extend({
  excludes: "_",
  addInputRules() {
    return [markInputRule({ find: /(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))$/, type: this.type })];
  },
  addKeyboardShortcuts() {
    return { "Mod-i": () => this.editor.commands.toggleItalic() };
  },
});
export const OnlyStrike = Strike.extend({
  excludes: "_",
  addKeyboardShortcuts() {
    return { "Mod-Shift-x": () => this.editor.commands.toggleStrike(), "Mod-Shift-s": () => this.editor.commands.toggleStrike() };
  },
});
export const InlineCode = Code.extend({
  addKeyboardShortcuts() {
    return { "Mod-e": () => this.editor.commands.toggleCode(), "Mod-Shift-c": () => this.editor.commands.toggleCode() };
  },
});
export const OnlyLink = Link.extend({ excludes: "_" });
/**
 * TeX math within a line (apps/shared/math.json): the formula as typed, shown in its dollars (CSS) and written back
 * between them unchanged. `$x$` typed converts as the code span does; plain text with dollars stays text (escaped).
 */
export const InlineMath = Mark.create({
  name: "math",
  excludes: "_",
  code: true,
  inclusive: false,
  addAttributes: () => ({
    display: { default: false, parseHTML: (el) => el.getAttribute("data-display") === "true", renderHTML: (attrs) => (attrs.display ? { "data-display": "true" } : {}) },
  }),
  parseHTML: () => [{ tag: "span[data-math]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", { ...HTMLAttributes, "data-math": "", class: "rich-math", spellcheck: "false" }, 0],
  addInputRules() {
    // Pandoc's rule as the renderer reads it: a non-space after the opening `$` and before the closing one.
    return [markInputRule({ find: /(?:^|[^\\$])(\$([^\s$](?:[^$\n]*[^\s$\\])?)\$)$/, type: this.type })];
  },
});
/** A quote holds plain lines: the renderer reads a quote's lines inline (no lists or code inside). */
const PlainQuote = Blockquote.extend({ content: "paragraph+" });
/** A list item is one line, with the lists nested under it. */
const LineItem = ListItem.extend({
  content: "paragraph list*",
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => {
        if (!this.editor.isActive(this.name)) return false;
        const { $from } = this.editor.state.selection;
        let depth = 0;
        for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === this.name) depth++;
        // Deeper than three levels draws as the third: Tab stays in the editor and does nothing.
        return depth >= MAX_LIST_DEPTH ? true : this.editor.commands.sinkListItem(this.name);
      },
      "Shift-Tab": () => this.editor.commands.liftListItem(this.name),
    };
  },
});
/** Shift+Enter is the composer's newline (Composer decides), not a hard break. */
const Break = HardBreak.extend({ addKeyboardShortcuts: () => ({}) });

/** A table (or any Markdown kept as typed): edited as its Markdown text, written back unchanged. */
const RawMarkdown = Node.create({
  name: "rawMarkdown",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML: () => [{ tag: "pre[data-raw-markdown]", preserveWhitespace: "full" }],
  renderHTML: () => ["pre", { "data-raw-markdown": "", class: "rich-raw" }, 0],
});

/** Markdown links typed as `[label](https://…)` become links (the Link extension's rule, http / https only). */
export const extensions = (placeholder: string | (() => string)) => [
  Document,
  Paragraph,
  Text,
  OnlyBold,
  OnlyItalic,
  OnlyStrike,
  InlineCode,
  InlineMath,
  CodeBlock.configure({ defaultLanguage: null, HTMLAttributes: { spellcheck: "false" } }),
  PlainQuote,
  BulletList,
  OrderedList,
  LineItem,
  Heading.configure({ levels: [1, 2, 3] }),
  OnlyLink.configure({
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    markdownLinks: true,
    defaultProtocol: "https",
    isAllowedUri: (url) => HTTP_URL.test(url),
    shouldAutoLink: (url) => HTTP_URL.test(url),
  }),
  Break,
  RawMarkdown,
  UndoRedo,
  Placeholder.configure({ placeholder: typeof placeholder === "function" ? () => placeholder() : placeholder }),
];

export interface RichEditorProps {
  /** The Markdown the editor shows; a change from outside (another channel's draft, a send) replaces the document. */
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  /**
   * How tall it grows before it scrolls (the composer's cap follows a phone's keyboard). With a cap the box scrolls
   * itself, by the caret's line (composerScroll.ts), and nothing around it.
   */
  maxHeight?: number;
  /** A fixed height (the edit box dragged to a size, editBox.ts); with `maxHeight` the box scrolls inside it. */
  height?: number;
  /**
   * How tall the input it replaces was (the composer's text area, also while this editor was loading): the editor is
   * that tall at least until it is built. Empty for a moment, its box would let the list above grow and lose its
   * bottom to the browser's clamping (Composer.tsx, inputHeight).
   */
  holdHeight?: () => number;
  apiRef: RefObject<RichEditorApi | null>;
  /** A key before the editor handles it (never during an IME composition); true when the owner took it. */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  /** The current line up to the caret (mentions, emoji), null with a selection or inside code. */
  onContext?: (context: { text: string; caret: number } | null) => void;
  onFormat?: (state: RichFormatState) => void;
  /** Files pasted (images, documents): the attachments take them. */
  onFiles?: (files: File[]) => void;
  onCompositionEnd?: () => void;
  onFocus?: () => void;
}

export default function RichEditor({ value, onChange, placeholder = "", ariaLabel, autoFocus = false, className, maxHeight, height, holdHeight, apiRef, onKeyDown, onContext, onFormat, onFiles, onCompositionEnd, onFocus }: RichEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const emitted = useRef(value);
  // Part of the first render, so it is there before anything lays the page out (another composer building its editor).
  const [held] = useState(() => holdHeight?.() ?? 0);
  // The latest callbacks, read by the editor's handlers (created once).
  const props = useRef({ onChange, onKeyDown, onContext, onFormat, onFiles, onCompositionEnd, onFocus, placeholder });
  props.current = { onChange, onKeyDown, onContext, onFormat, onFiles, onCompositionEnd, onFocus, placeholder };
  const capped = maxHeight !== undefined;
  const cappedRef = useRef(capped);
  cappedRef.current = capped;

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    // Again when the effect runs a second time (React's strict mode); let go of below, once the editor is in.
    if (held > 0) element.style.minHeight = `${held}px`;
    const editor = new Editor({
      element,
      extensions: extensions(() => props.current.placeholder),
      content: markdownToDoc(value) as JSONContent,
      autofocus: autoFocus ? "end" : false,
      enablePasteRules: ["link"],
      editorProps: {
        attributes: { "aria-label": ariaLabel, "aria-multiline": "true", role: "textbox", class: "body rich-editor", "data-composer-input": "" },
        handleKeyDown: (_view, event) => props.current.onKeyDown?.(event) ?? false,
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0) return false;
          props.current.onFiles?.(files);
          return true;
        },
        // Files dropped go to the composer's own drop handler (the event goes on up); nothing lands in the text.
        handleDrop: (_view, event) => (event.dataTransfer?.files.length ?? 0) > 0,
        clipboardTextParser: (text, _context, _plain, view) => {
          const nodes = plainTextToNodes(text).map((node) => view.state.schema.nodeFromJSON(node));
          return new Slice(Fragment.fromArray(nodes), 1, 1);
        },
        // In the capped box, by the caret's line rather than ProseMirror's glyph box and margin (composerScroll.ts).
        handleScrollToSelection: (view) => {
          const box = host.current;
          if (!box || !cappedRef.current) return false;
          keepLineInView(box, () => caretLine(box, view));
          return true;
        },
        handleDOMEvents: {
          compositionend: () => {
            props.current.onCompositionEnd?.();
            return false;
          },
        },
      },
      onUpdate: ({ editor }) => {
        const markdown = docToMarkdown(editor.getJSON() as RichNode);
        if (markdown === emitted.current) return;
        emitted.current = markdown;
        props.current.onChange(markdown);
      },
      onTransaction: ({ editor }) => report(editor),
      onFocus: () => props.current.onFocus?.(),
    });
    element.style.minHeight = "";
    editorRef.current = editor;
    apiRef.current = apiFor(editor, (markdown) => (emitted.current = markdown));
    report(editor);
    return () => {
      apiRef.current = null;
      editorRef.current = null;
      editor.destroy();
    };
    // Created once; value and callbacks are followed below and through `props`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A draft changed from outside (a send cleared it, a template replaced it, another device's draft arrived).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(markdownToDoc(value) as JSONContent, { emitUpdate: false });
    if (editor.isFocused) editor.commands.focus("end");
  }, [value]);

  useEffect(() => {
    const dom = editorRef.current?.view.dom;
    if (dom) dom.setAttribute("aria-label", ariaLabel);
  }, [ariaLabel]);

  // The capped box has nothing to scroll while the draft fits: no scrollbar, and back at the top if the browser's own
  // reveal (the IME's, at a zoom that rounds) moved it a pixel. Again whenever the text or the cap changes its height.
  useLayoutEffect(() => {
    const box = host.current;
    const dom = editorRef.current?.view.dom;
    if (!box || !dom || !capped) return;
    settle(box);
    const onScroll = () => settle(box);
    box.addEventListener("scroll", onScroll);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => settle(box));
    observer?.observe(box);
    observer?.observe(dom);
    return () => {
      box.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [capped]);

  function report(editor: Editor) {
    const { onContext: context, onFormat: format } = props.current;
    if (format) format(formatState(editor));
    if (context) {
      const { selection } = editor.state;
      const { $from } = selection;
      if (!selection.empty || $from.parent.type.spec.code || editor.isActive("code")) context(null);
      else {
        const text = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
        context({ text, caret: text.length });
      }
    }
  }

  return <div ref={host} className={className} style={{ maxHeight, height, minHeight: held > 0 ? held : undefined }} />;
}

/** The line of the selection's head, in the box's content coordinates; null when ProseMirror cannot place it. */
function caretLine(box: HTMLElement, view: Editor["view"]): { top: number; bottom: number } | null {
  try {
    const head = view.state.selection.head;
    const rect = view.coordsAtPos(head);
    const { node } = view.domAtPos(head);
    const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
    return contentLine(box, rect, lineHeightOf(element ?? view.dom));
  } catch {
    return null;
  }
}

function formatState(editor: Editor): RichFormatState {
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    codeBlock: editor.isActive("codeBlock"),
    heading: editor.isActive("heading"),
    quote: editor.isActive("blockquote"),
    bullets: editor.isActive("bulletList"),
    numbered: editor.isActive("orderedList"),
    link: editor.isActive("link"),
  };
}

function apiFor(editor: Editor, remember: (markdown: string) => void): RichEditorApi {
  const run = (format: RichFormat) => {
    const chain = editor.chain().focus();
    switch (format) {
      case "bold":
        return chain.toggleBold().run();
      case "italic":
        return chain.toggleItalic().run();
      case "strike":
        return chain.toggleStrike().run();
      case "code":
        return chain.toggleCode().run();
      case "codeBlock":
        return chain.toggleCodeBlock().run();
      case "heading":
        return chain.toggleHeading({ level: 2 }).run();
      case "quote":
        return chain.toggleBlockquote().run();
      case "bullets":
        return chain.toggleBulletList().run();
      case "numbered":
        return chain.toggleOrderedList().run();
    }
  };
  return {
    focus: (at = "end") => {
      editor.commands.focus(at === "keep" ? undefined : at);
    },
    setMarkdown: (markdown) => {
      remember(markdown);
      editor.chain().setContent(markdownToDoc(markdown) as JSONContent, { emitUpdate: false }).focus("end").run();
      return markdown;
    },
    replaceBeforeCaret: (length, text) => {
      const { from } = editor.state.selection;
      editor.chain().focus().command(({ tr }) => {
        tr.insertText(text, Math.max(from - length, 0), from);
        return true;
      }).run();
    },
    insertText: (text) => {
      editor.chain().focus().command(({ tr }) => {
        tr.insertText(text);
        return true;
      }).run();
    },
    run,
    link: () => (editor.isActive("link") ? String(editor.getAttributes("link").href ?? "") : null),
    setLink: (href) => {
      if (!href) {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
        return;
      }
      const { empty } = editor.state.selection;
      if (empty && !editor.isActive("link")) {
        editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
        return;
      }
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    },
    selectedText: () => {
      const { from, to } = editor.state.selection;
      return editor.state.doc.textBetween(from, to, "\n");
    },
    isEmpty: () => editor.isEmpty,
    inCodeBlock: () => editor.isActive("codeBlock") || editor.isActive("rawMarkdown"),
    composing: () => editor.view.composing,
    newline: () =>
      editor.commands.first(({ commands }) => [
        () => commands.splitListItem("listItem"),
        () => commands.newlineInCode(),
        () => commands.createParagraphNear(),
        () => commands.liftEmptyBlock(),
        () => commands.splitBlock(),
      ]),
    undo: () => editor.commands.undo(),
    redo: () => editor.commands.redo(),
  };
}
