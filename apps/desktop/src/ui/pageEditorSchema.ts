/**
 * M150 (WIKI.md §22.6, §27): the 見たまま page editor's nodes, marks, keys and input rules (TipTap 3). The node types
 * are one to one with the blocks ui/pageMarkdown.ts reads; every block node carries its source attributes (`src`,
 * `sig`, `eol`, never drawn, dropped when a node is split off or made anew). Kept apart from PageEditor.tsx so tests
 * can build the editor without React; both are in the editor's lazy chunk.
 *
 * Drawn by the page (React, through portals the host renders: ui/PageEditor.tsx): page links, emoji, images, embedded
 * databases, tables (an atom: 「表を編集」 opens the canvas table dialog), display math's preview and callout icons.
 * Lists are flat lines (`listLine`: bullet / ordered / task, level 0–2) with their markers worked out as the renderer
 * does (pageMarkdown.listRun) and drawn by a decoration.
 */
import { Extension, InputRule, type JSONContent, Node, textblockTypeInputRule, wrappingInputRule, type Editor, type NodeViewRenderer } from "@tiptap/core";
import { Blockquote } from "@tiptap/extension-blockquote";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Document } from "@tiptap/extension-document";
import { Heading } from "@tiptap/extension-heading";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { Fragment, type Node as PMNode, type NodeType, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ReactNode } from "react";

import { calloutTone, listMarker } from "./markdown";
import { stepBlocks } from "./pageEditorBlocks";
import { listRun, pageToDoc, type RichNode, serializePage, type SourceView } from "./pageMarkdown";
import { InlineCode, InlineMath, OnlyBold, OnlyItalic, OnlyLink, OnlyStrike } from "./RichEditor";

/** What the React side keeps of the editor's DOM: an element and what to draw into it (createPortal). */
export class PortalRegistry {
  private readonly items = new Map<string, { dom: HTMLElement; node: ReactNode }>();
  private readonly listeners = new Set<() => void>();
  version = 0;

  set(key: string, dom: HTMLElement, node: ReactNode): void {
    this.items.set(key, { dom, node });
    this.emit();
  }

  delete(key: string): void {
    if (this.items.delete(key)) this.emit();
  }

  entries(): Array<[string, { dom: HTMLElement; node: ReactNode }]> {
    return [...this.items.entries()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/** What the nodes ask of the page around the editor. */
export interface PageEditorHost {
  portals: PortalRegistry;
  /** The originals of the document as read (M151: blocks moved keep their source where it reads the same). */
  sources: SourceMap;
  render: {
    pageLink(id: string, label: string): ReactNode;
    emoji(md: string): ReactNode;
    image(attachmentId: string, alt: string): ReactNode;
    embed(pageId: string, viewId: string | null): ReactNode;
    table(markdown: string, edit: (() => void) | null): ReactNode;
    math(tex: string): ReactNode;
    calloutIcon(icon: string | null): ReactNode;
  };
  /** `@name` of a mention (its Markdown: `<@id>`, `<@group:id>`, `<!channel>`). */
  mentionLabel(md: string): string;
  /** Whether `:name:` is an emoji the renderer draws. */
  isEmoji(name: string): boolean;
  openTable(pos: number): void;
  pickIcon(pos: number, anchor: HTMLElement): void;
  /** ⌘S: save now. */
  save(): void;
  /** ⌘K: the link of the selection. */
  link(): void;
  text: { placeholder: string; editTable: string; raw: string; toggleOpen: string; toggleClose: string; checkbox: string; changeIcon: string; untitledToggle: string };
  /** Whether the editor may change things (false: read only). */
  editable(): boolean;
}

// --- source attributes ------------------------------------------------------------------------------------------------

const sourceAttrs = () => ({
  src: { default: null, rendered: false, keepOnSplit: false },
  sig: { default: null, rendered: false, keepOnSplit: false },
  eol: { default: "\n", rendered: false, keepOnSplit: false },
});
const lineAttrs = () => ({ ...sourceAttrs(), markers: { default: "", rendered: false, keepOnSplit: false } });
const containerAttrs = () => ({
  ...sourceAttrs(),
  openSrc: { default: null, rendered: false, keepOnSplit: false },
  openEol: { default: "\n", rendered: false, keepOnSplit: false },
  closeSrc: { default: null, rendered: false, keepOnSplit: false },
});
/** A node's attributes without the tie to any text it was read from (a new line, a pasted block). */
export function untied(attrs: Record<string, unknown>): Record<string, unknown> {
  const out = { ...attrs };
  for (const key of ["src", "sig", "openSrc", "closeSrc"]) if (key in out) out[key] = null;
  if ("markers" in out) out.markers = "";
  if ("eol" in out) out.eol = "\n";
  if ("openEol" in out) out.openEol = "\n";
  return out;
}

let viewCounter = 0;
const nextKey = () => `pe${(++viewCounter).toString(36)}`;

/** An atom drawn by React into its element (a portal); events inside it are its own. */
function portalView(host: PageEditorHost, tag: "span" | "div", className: string, draw: (node: PMNode, getPos: () => number | undefined) => ReactNode, ownEvents = true): NodeViewRenderer {
  return ({ node, getPos }) => {
    const dom = document.createElement(tag);
    dom.className = className;
    dom.contentEditable = "false";
    const key = nextKey();
    let current = node;
    host.portals.set(key, dom, draw(node, getPos));
    return {
      dom,
      update(next) {
        if (next.type !== current.type) return false;
        if (next.attrs === current.attrs || next.eq(current)) return true;
        current = next;
        host.portals.set(key, dom, draw(next, getPos));
        return true;
      },
      destroy() {
        host.portals.delete(key);
      },
      stopEvent: (event) => ownEvents && !event.type.startsWith("drag") && event.type !== "drop",
      ignoreMutation: () => true,
    };
  };
}

// --- block nodes --------------------------------------------------------------------------------------------------------

const PageParagraph = Paragraph.extend({ addAttributes: lineAttrs });

const PageHeading = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), ...lineAttrs() };
  },
}).configure({ levels: [1, 2, 3] });

/** A list line: `kind` bullet / ordered / task, `level` 0–2 (tasks 0–1), `number` the number a numbered run starts at. */
export const ListLine = Node.create<{ host: PageEditorHost }>({
  name: "listLine",
  group: "block",
  content: "inline*",
  defining: true,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: () => ({
    kind: { default: "bullet", parseHTML: (el) => el.getAttribute("data-kind") ?? "bullet", renderHTML: (attrs) => ({ "data-kind": attrs.kind }) },
    level: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-level") ?? 0) || 0, renderHTML: (attrs) => ({ "data-level": attrs.level }) },
    number: { default: null, keepOnSplit: false, parseHTML: (el) => (el.getAttribute("data-number") ? Number(el.getAttribute("data-number")) : null), renderHTML: (attrs) => (attrs.number != null ? { "data-number": attrs.number } : {}) },
    checked: { default: false, keepOnSplit: false, parseHTML: (el) => el.getAttribute("data-checked") === "true", renderHTML: (attrs) => (attrs.checked ? { "data-checked": "true" } : {}) },
    ...lineAttrs(),
  }),
  parseHTML: () => [{ tag: "div[data-list-line]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", { ...HTMLAttributes, "data-list-line": "" }, 0],
  addNodeView() {
    const host = this.options.host;
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("div") as ListLineElement;
      dom.setAttribute("data-list-line", "");
      const marker = document.createElement("span");
      marker.className = "pe-marker";
      marker.contentEditable = "false";
      const content = document.createElement("div");
      content.className = "pe-line-text";
      dom.append(marker, content);
      let current = node;
      listElements.set(node, dom);
      let box: HTMLInputElement | null = null;
      /** The marker and drawn level the list plugin worked out for this line (as the renderer numbers it). */
      let shown = { marker: "•", level: node.attrs.level as number };
      const place = () => {
        dom.setAttribute("data-level", String(shown.level));
        dom.style.setProperty("--pe-level", String(shown.level));
        if (current.attrs.kind !== "task") marker.textContent = shown.marker;
      };
      dom.pageListMarker = (next) => {
        if (next.marker === shown.marker && next.level === shown.level) return;
        shown = next;
        place();
      };
      const draw = (next: PMNode) => {
        dom.setAttribute("data-kind", next.attrs.kind);
        if (next.attrs.kind === "task") {
          if (!box) {
            marker.textContent = "";
            box = document.createElement("input");
            box.type = "checkbox";
            box.setAttribute("aria-label", host.text.checkbox);
            box.addEventListener("mousedown", (event) => event.preventDefault());
            box.addEventListener("click", (event) => {
              event.preventDefault();
              const pos = getPos();
              if (pos === undefined || !host.editable()) return;
              const at = editor.state.doc.nodeAt(pos);
              if (!at) return;
              editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...at.attrs, checked: !at.attrs.checked }));
            });
            marker.append(box);
          }
          box.checked = !!next.attrs.checked;
          dom.toggleAttribute("data-done", !!next.attrs.checked);
        } else {
          box?.remove();
          box = null;
          dom.removeAttribute("data-done");
        }
        place();
      };
      draw(node);
      return {
        dom,
        contentDOM: content,
        update(next) {
          if (next.type !== current.type) return false;
          const before = current;
          current = next;
          listElements.set(next, dom);
          if (next.attrs !== before.attrs) draw(next);
          return true;
        },
        stopEvent: (event) => event.target instanceof globalThis.Node && marker.contains(event.target),
        ignoreMutation: (mutation) => mutation.type !== "selection" && ((mutation.type === "attributes" && mutation.target === dom) || marker.contains(mutation.target)),
      };
    };
  },
});

/** A quote holds lines and list lines (apps/shared/lists.json `quoted`). */
const PageQuote = Blockquote.extend({
  content: "(paragraph | listLine)+",
  addAttributes: sourceAttrs,
});

const PageCode = CodeBlock.extend({
  addAttributes() {
    return { ...this.parent?.(), ...sourceAttrs() };
  },
}).configure({ defaultLanguage: null, HTMLAttributes: { spellcheck: "false" } });

/** Display math: its TeX edited as text, the formula drawn under it. */
export const MathBlock = Node.create<{ host: PageEditorHost }>({
  name: "mathBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: sourceAttrs,
  parseHTML: () => [{ tag: "div[data-math-block]", preserveWhitespace: "full", contentElement: "pre" }],
  renderHTML: () => ["div", { "data-math-block": "" }, ["pre", 0]],
  addNodeView() {
    const host = this.options.host;
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "pe-math";
      dom.setAttribute("data-math-block", "");
      const pre = document.createElement("pre");
      pre.spellcheck = false;
      const preview = document.createElement("div");
      preview.className = "pe-math-preview";
      preview.contentEditable = "false";
      dom.append(pre, preview);
      const key = nextKey();
      let current = node;
      host.portals.set(key, preview, host.render.math(node.textContent));
      return {
        dom,
        contentDOM: pre,
        update(next) {
          if (next.type !== current.type) return false;
          if (next.textContent !== current.textContent) host.portals.set(key, preview, host.render.math(next.textContent));
          current = next;
          return true;
        },
        destroy: () => host.portals.delete(key),
        ignoreMutation: (mutation) => mutation.type !== "selection" && preview.contains(mutation.target),
      };
    };
  },
});

/** Markdown the editor keeps as typed (what it cannot show as itself), edited as text. */
export const RawMarkdown = Node.create<{ host: PageEditorHost }>({
  name: "rawMarkdown",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: sourceAttrs,
  parseHTML: () => [{ tag: "pre[data-raw-markdown]", preserveWhitespace: "full" }],
  renderHTML() {
    return ["pre", { "data-raw-markdown": "", class: "pe-raw", "data-label": this.options.host?.text.raw ?? "Markdown", spellcheck: "false" }, 0];
  },
});

export const HorizontalRule = Node.create({
  name: "horizontalRule",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: sourceAttrs,
  parseHTML: () => [{ tag: "hr" }],
  renderHTML: () => ["div", { class: "pe-hr", "data-rule": "" }, ["hr"]],
});

export const PageImage = Node.create<{ host: PageEditorHost }>({
  name: "image",
  group: "block",
  atom: true,
  selectable: true,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: () => ({ attachmentId: { default: "" }, alt: { default: "" }, ...sourceAttrs() }),
  parseHTML: () => [{ tag: "div[data-page-image]", getAttrs: (el) => ({ attachmentId: el.getAttribute("data-page-image") ?? "", alt: el.getAttribute("data-alt") ?? "" }) }],
  renderHTML: ({ node }) => ["div", { "data-page-image": node.attrs.attachmentId, "data-alt": node.attrs.alt }],
  renderText: ({ node }) => `![${node.attrs.alt}](attachment:${node.attrs.attachmentId})`,
  addNodeView() {
    const host = this.options.host;
    return portalView(host, "div", "pe-atom pe-image", (node) => host.render.image(node.attrs.attachmentId, node.attrs.alt), false);
  },
});

export const PageEmbed = Node.create<{ host: PageEditorHost }>({
  name: "embed",
  group: "block",
  atom: true,
  selectable: true,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: () => ({ pageId: { default: "" }, viewId: { default: null }, label: { default: "" }, ...sourceAttrs() }),
  parseHTML: () => [{ tag: "div[data-page-embed]", getAttrs: (el) => ({ pageId: el.getAttribute("data-page-embed") ?? "", viewId: el.getAttribute("data-view") || null, label: el.getAttribute("data-label") ?? "" }) }],
  renderHTML: ({ node }) => ["div", { "data-page-embed": node.attrs.pageId, "data-view": node.attrs.viewId ?? "", "data-label": node.attrs.label }],
  renderText: ({ node }) => `![${node.attrs.label}](page:${node.attrs.pageId}${node.attrs.viewId ? `#view=${node.attrs.viewId}` : ""})`,
  addNodeView() {
    const host = this.options.host;
    return portalView(host, "div", "pe-atom pe-embed", (node) => host.render.embed(node.attrs.pageId, node.attrs.viewId));
  },
});

/** A table: drawn as the page draws it, its Markdown edited in the table dialog (cells in place: M151). */
export const PageTable = Node.create<{ host: PageEditorHost }>({
  name: "table",
  group: "block",
  atom: true,
  selectable: true,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: () => ({ markdown: { default: "" }, ...sourceAttrs() }),
  parseHTML: () => [{ tag: "div[data-page-table]", getAttrs: (el) => ({ markdown: el.getAttribute("data-page-table") ?? "" }) }],
  renderHTML: ({ node }) => ["div", { "data-page-table": node.attrs.markdown }],
  renderText: ({ node }) => node.attrs.markdown,
  addNodeView() {
    const host = this.options.host;
    return portalView(host, "div", "pe-atom pe-table", (node, getPos) => host.render.table(node.attrs.markdown, host.editable() ? () => {
      const pos = getPos();
      if (pos !== undefined) host.openTable(pos);
    } : null));
  },
});

/** A callout (`::: callout 💡`): its icon (a button that changes it) and its blocks. */
export const Callout = Node.create<{ host: PageEditorHost }>({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: () => ({ icon: { default: "💡", parseHTML: (el) => el.getAttribute("data-icon") || null, renderHTML: (attrs) => ({ "data-icon": attrs.icon ?? "" }) }, ...containerAttrs() }),
  parseHTML: () => [{ tag: "div[data-callout]", contentElement: "[data-callout-body]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", { ...HTMLAttributes, "data-callout": "" }, ["div", { "data-callout-body": "" }, 0]],
  addNodeView() {
    const host = this.options.host;
    return ({ node, getPos }) => {
      const dom = document.createElement("div");
      dom.className = "callout pe-callout";
      dom.setAttribute("data-callout", "");
      const icon = document.createElement("button");
      icon.type = "button";
      icon.className = "pe-callout-icon";
      icon.contentEditable = "false";
      icon.setAttribute("aria-label", host.text.changeIcon);
      icon.title = host.text.changeIcon;
      icon.addEventListener("mousedown", (event) => event.preventDefault());
      icon.addEventListener("click", () => {
        const pos = getPos();
        if (pos !== undefined && host.editable()) host.pickIcon(pos, icon);
      });
      const body = document.createElement("div");
      body.className = "pe-callout-body";
      dom.append(icon, body);
      const key = nextKey();
      let current = node;
      const draw = (next: PMNode) => {
        dom.setAttribute("data-tone", calloutTone(next.attrs.icon ?? null));
        host.portals.set(key, icon, host.render.calloutIcon(next.attrs.icon ?? null));
      };
      draw(node);
      return {
        dom,
        contentDOM: body,
        update(next) {
          if (next.type !== current.type) return false;
          if (next.attrs.icon !== current.attrs.icon) draw(next);
          current = next;
          return true;
        },
        destroy: () => host.portals.delete(key),
        stopEvent: (event) => event.target instanceof globalThis.Node && icon.contains(event.target),
        ignoreMutation: (mutation) => mutation.type !== "selection" && ((mutation.type === "attributes" && mutation.target === dom) || icon.contains(mutation.target)),
      };
    };
  },
});

/** A toggle's title (the opener line's text). */
export const ToggleTitle = Node.create({
  name: "toggleTitle",
  content: "inline*",
  defining: true,
  parseHTML: () => [{ tag: "div[data-toggle-title]" }],
  renderHTML: () => ["div", { "data-toggle-title": "", class: "pe-toggle-title" }, 0],
});

/** Which toggles are open on this screen (never written to the body): by the node's tie, else open. */
const openToggles = new Map<string, boolean>();

/** A toggle (`::: toggle 見出し`): its title and its blocks, which show while it is open. */
export const Toggle = Node.create<{ host: PageEditorHost }>({
  name: "toggle",
  group: "block",
  content: "toggleTitle block+",
  defining: true,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: containerAttrs,
  parseHTML: () => [{ tag: "div[data-toggle]" }],
  renderHTML: () => ["div", { "data-toggle": "" }, 0],
  addNodeView() {
    const host = this.options.host;
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "pe-toggle";
      dom.setAttribute("data-toggle", "");
      const chevron = document.createElement("button");
      chevron.type = "button";
      chevron.className = "pe-toggle-chevron";
      chevron.contentEditable = "false";
      const body = document.createElement("div");
      body.className = "pe-toggle-body";
      dom.append(chevron, body);
      const id = typeof node.attrs.sig === "string" ? node.attrs.sig : nextKey();
      // Read from the page: closed as the page shows it; made here: open to be written in.
      let open = openToggles.get(id) ?? node.attrs.src == null;
      const draw = () => {
        dom.toggleAttribute("data-open", open);
        chevron.setAttribute("aria-expanded", String(open));
        chevron.setAttribute("aria-label", open ? host.text.toggleClose : host.text.toggleOpen);
      };
      chevron.addEventListener("mousedown", (event) => event.preventDefault());
      chevron.addEventListener("click", () => {
        open = !open;
        openToggles.set(id, open);
        draw();
      });
      draw();
      let current = node;
      return {
        dom,
        contentDOM: body,
        update(next) {
          if (next.type !== current.type) return false;
          current = next;
          return true;
        },
        stopEvent: (event) => event.target instanceof globalThis.Node && chevron.contains(event.target),
        ignoreMutation: (mutation) => mutation.type !== "selection" && (mutation.target === dom || chevron.contains(mutation.target)),
      };
    };
  },
});

// --- inline atoms ---------------------------------------------------------------------------------------------------------

export const Mention = Node.create<{ host: PageEditorHost }>({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  marks: "",
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: () => ({ md: { default: "" }, kind: { default: "user" }, id: { default: "" } }),
  parseHTML: () => [{ tag: "span[data-mention]", getAttrs: (el) => ({ md: el.getAttribute("data-mention") ?? "", kind: el.getAttribute("data-kind") ?? "user", id: el.getAttribute("data-id") ?? "" }) }],
  renderHTML: ({ node }) => ["span", { "data-mention": node.attrs.md, "data-kind": node.attrs.kind, "data-id": node.attrs.id, class: "mention" }, node.attrs.md],
  renderText: ({ node }) => node.attrs.md,
  addNodeView() {
    const host = this.options.host;
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "mention";
      dom.contentEditable = "false";
      dom.textContent = host.mentionLabel(node.attrs.md);
      return { dom, ignoreMutation: () => true };
    };
  },
});

export const PageLink = Node.create<{ host: PageEditorHost }>({
  name: "pageLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  marks: "",
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: () => ({ id: { default: "" }, label: { default: "" } }),
  parseHTML: () => [{ tag: "span[data-page-link-atom]", getAttrs: (el) => ({ id: el.getAttribute("data-page-link-atom") ?? "", label: el.textContent ?? "" }) }],
  renderHTML: ({ node }) => ["span", { "data-page-link-atom": node.attrs.id }, node.attrs.label],
  renderText: ({ node }) => `[${node.attrs.label}](page:${node.attrs.id})`,
  addNodeView() {
    const host = this.options.host;
    return portalView(host, "span", "pe-inline-atom", (node) => host.render.pageLink(node.attrs.id, node.attrs.label));
  },
});

export const Emoji = Node.create<{ host: PageEditorHost }>({
  name: "emoji",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addAttributes: () => ({ md: { default: "" } }),
  parseHTML: () => [{ tag: "span[data-emoji]", getAttrs: (el) => ({ md: el.getAttribute("data-emoji") ?? "" }) }],
  renderHTML: ({ node }) => ["span", { "data-emoji": node.attrs.md }, node.attrs.md],
  renderText: ({ node }) => node.attrs.md,
  addNodeView() {
    const host = this.options.host;
    return portalView(host, "span", "pe-inline-atom", (node) => host.render.emoji(node.attrs.md), false);
  },
  addInputRules() {
    const host = this.options.host;
    return [
      new InputRule({
        find: /:([a-z0-9][a-z0-9_+-]{0,31}):$/,
        handler: ({ state, range, match }) => {
          if (!host.isEmoji(match[1]!) || state.selection.$from.parent.type.spec.code) return null;
          state.tr.replaceWith(range.from, range.to, this.type.create({ md: match[0] }));
        },
      }),
    ];
  },
});

// --- list markers, keys and input rules -----------------------------------------------------------------------------------

/** A list line's element: the list plugin tells it its marker and drawn level. */
type ListLineElement = HTMLDivElement & { pageListMarker?: (shown: { marker: string; level: number }) => void };
/** Each list line's element by the node it shows now (`view.nodeDOM` per line would walk the page each time). */
const listElements = new WeakMap<PMNode, ListLineElement>();

const listKey = new PluginKey<number>("pageListMarkers");

/** Every run of list lines with the markers (• ◦ ▪, 1. a. i.) and drawn levels the renderer gives them. */
export function listMarkers(doc: PMNode): Array<{ node: PMNode; pos: number; marker: string; level: number }> {
  const out: Array<{ node: PMNode; pos: number; marker: string; level: number }> = [];
  const scan = (parent: PMNode, start: number) => {
    let run: Array<{ node: PMNode; pos: number }> = [];
    const flush = () => {
      if (run.length === 0) return;
      const marks = listRun(run.map(({ node }) => ({ kind: node.attrs.kind, level: node.attrs.level, number: node.attrs.number })));
      run.forEach(({ node, pos }, k) => {
        const mark = marks[k]!;
        out.push({ node, pos, level: mark.level, marker: node.attrs.kind === "task" ? "" : listMarker(node.attrs.kind === "ordered", mark.level, mark.number) });
      });
      run = [];
    };
    parent.forEach((child, offset) => {
      const pos = start + offset;
      if (child.type.name === "listLine") {
        run.push({ node: child, pos });
        return;
      }
      flush();
      if (child.type.name === "blockquote" || child.type.name === "callout" || child.type.name === "toggle") scan(child, pos + 1);
    });
    flush();
  };
  scan(doc, 0);
  return out;
}

/**
 * The list lines' markers, put on their elements after every change of the blocks (not decorations: thousands of
 * node decorations at the top level make every key slow on a long page; WIKI.md §27). Typing inside a line changes
 * no marker, so nothing runs then.
 */
const ListMarkers = Extension.create({
  name: "pageListMarkers",
  addProseMirrorPlugins: () => [
    new Plugin<number>({
      key: listKey,
      state: {
        init: () => 0,
        apply: (tr, changes) => (!tr.docChanged || withinLines(tr) ? changes : changes + 1),
      },
      view: (view) => {
        let seen = -1;
        const mark = () => {
          seen = listKey.getState(view.state) ?? 0;
          for (const { node, marker, level } of listMarkers(view.state.doc)) listElements.get(node)?.pageListMarker?.({ marker, level });
        };
        mark();
        return {
          update: () => {
            if ((listKey.getState(view.state) ?? 0) !== seen) mark();
          },
        };
      },
    }),
  ],
});

/** Whether a transaction only changed text and marks inside lines (no block made, removed, split or retyped). */
function withinLines(tr: Transaction): boolean {
  return tr.steps.every((step, index) => {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    const doc = tr.docs[index]!;
    const json = step.toJSON() as { from: number; to: number };
    const $from = doc.resolve(json.from);
    const $to = doc.resolve(json.to);
    const slice = step.slice;
    return $from.parent.isTextblock && $from.sameParent($to) && slice.openStart === 0 && slice.openEnd === 0 && (slice.content.childCount === 0 || slice.content.firstChild!.isInline);
  });
}

/**
 * The placeholder of the empty line the caret is on (the stock extension walks the whole document on every change,
 * which a long page feels on every key).
 */
const CaretPlaceholder = Extension.create<{ host: PageEditorHost }>({
  name: "pagePlaceholder",
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addProseMirrorPlugins() {
    const host = this.options.host;
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const { selection } = state;
            const { $from } = selection;
            const parent = $from.parent;
            if (!selection.empty || parent.content.size > 0 || (parent.type.name !== "paragraph" && parent.type.name !== "toggleTitle")) return null;
            const text = parent.type.name === "paragraph" ? host.text.placeholder : host.text.untitledToggle;
            return DecorationSet.create(state.doc, [Decoration.node($from.before(), $from.after(), { class: "is-empty", "data-placeholder": text })]);
          },
        },
      }),
    ];
  },
});

/** The deepest a list line may go here: one past the line before (a list line), at most 2 (tasks 1). */
function maxLevel(editor: Editor, kind: string): number {
  const { $from } = editor.state.selection;
  const index = $from.index($from.depth - 1);
  const parent = $from.node($from.depth - 1);
  const before = index > 0 ? parent.child(index - 1) : null;
  const cap = kind === "task" ? 1 : 2;
  if (!before || before.type.name !== "listLine") return 0;
  return Math.min(cap, (before.attrs.level as number) + 1);
}

/** Enter, Backspace, Tab on list lines and lines; ⌘S / ⌘K. */
const PageKeys = Extension.create<{ host: PageEditorHost }>({
  name: "pageKeys",
  priority: 1000,
  addOptions: () => ({ host: null as unknown as PageEditorHost }),
  addKeyboardShortcuts() {
    const editor = this.editor;
    const host = this.options.host;
    const lineHere = () => {
      const { $from } = editor.state.selection;
      return $from.parent;
    };
    const moveStep = (direction: -1 | 1) => {
      if (!host.editable()) return true;
      const tr = stepBlocks(editor.state, direction, host.sources, { emoji: host.isEmoji });
      if (tr) editor.view.dispatch(tr);
      return true;
    };
    return {
      Enter: () => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        const node = $from.parent;
        if (node.type.name === "toggleTitle") {
          // Into the toggle's first block.
          const after = $from.after();
          return editor.chain().setTextSelection(after + 1).run();
        }
        if (node.type.name === "listLine") {
          if (empty && node.content.size === 0) {
            // An empty item ends the list (a nested one goes up a level first).
            if (node.attrs.level > 0) return editor.commands.updateAttributes("listLine", { level: node.attrs.level - 1 });
            return editor.commands.setNode("paragraph");
          }
          const tr = state.tr.deleteSelection();
          const at = tr.mapping.map($from.pos);
          tr.split(at, 1, [{ type: node.type, attrs: { ...untied(node.attrs), eol: node.attrs.eol || "\n", checked: false, number: null } }]);
          editor.view.dispatch(tr.scrollIntoView());
          return true;
        }
        if (node.type.name === "paragraph" && empty && node.content.size === 0 && $from.depth > 1) {
          // An empty last line in a quote, callout or toggle leaves it: the caret goes to a new line under it.
          const container = $from.node($from.depth - 1);
          const index = $from.index($from.depth - 1);
          if (index === container.childCount - 1 && container.type.name !== "doc") {
            const tr = state.tr;
            const after = $from.after($from.depth - 1);
            if (container.childCount > 1) tr.delete($from.before(), $from.after());
            const at = tr.mapping.map(after);
            tr.insert(at, state.schema.nodes.paragraph!.create());
            tr.setSelection(TextSelection.create(tr.doc, at + 1));
            editor.view.dispatch(tr.scrollIntoView());
            return true;
          }
        }
        if (node.type.name === "paragraph" || node.type.name === "heading") {
          // A new line without the old one's tie or hidden markers; after a heading's end, a paragraph.
          const atEnd = $from.parentOffset === node.content.size;
          const type = node.type.name === "heading" && atEnd ? state.schema.nodes.paragraph! : node.type;
          const tr = state.tr.deleteSelection();
          const at = tr.mapping.map($from.pos);
          tr.split(at, 1, [{ type, attrs: type === node.type ? { ...untied(node.attrs), eol: node.attrs.eol || "\n" } : { eol: node.attrs.eol || "\n" } }]);
          editor.view.dispatch(tr.scrollIntoView());
          return true;
        }
        return false;
      },
      Backspace: () => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        const node = lineHere();
        if (node.type.name === "listLine") {
          if (node.attrs.level > 0) return editor.commands.updateAttributes("listLine", { level: node.attrs.level - 1 });
          return editor.commands.setNode("paragraph");
        }
        if (node.type.name === "heading") return editor.commands.setNode("paragraph");
        return false;
      },
      Tab: () => {
        const node = lineHere();
        if (node.type.name !== "listLine") return false;
        const max = maxLevel(editor, node.attrs.kind);
        if (node.attrs.level < max) editor.commands.updateAttributes("listLine", { level: node.attrs.level + 1 });
        return true;
      },
      "Shift-Tab": () => {
        const node = lineHere();
        if (node.type.name !== "listLine") return false;
        if (node.attrs.level > 0) editor.commands.updateAttributes("listLine", { level: node.attrs.level - 1 });
        return true;
      },
      // M151: the caret's block (or the selected blocks) one step up / down.
      "Mod-Shift-ArrowUp": () => moveStep(-1),
      "Mod-Shift-ArrowDown": () => moveStep(1),
      "Mod-s": () => {
        host.save();
        return true;
      },
      "Mod-k": () => {
        host.link();
        return true;
      },
    };
  },
  addInputRules() {
    const type = (name: string) => this.editor.schema.nodes[name] as NodeType;
    const lineRule = (find: RegExp, attrs: (match: RegExpMatchArray) => Record<string, unknown>) =>
      new InputRule({
        find,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          const parent = $from.parent;
          if (parent.type.name !== "paragraph" && parent.type.name !== "listLine") return null;
          // Only at the start of the line (the rule's text is all there is before the caret).
          if ($from.parentOffset !== 0) return null;
          const inQuote = $from.depth > 1 && $from.node($from.depth - 1).type.name === "blockquote";
          const next = attrs(match);
          if (inQuote && next.kind === "task") return null;
          // A bullet made a checklist item (or back) keeps its level.
          if (parent.type.name === "listLine") next.level = Math.min(parent.attrs.level, next.kind === "task" ? 1 : 2);
          state.tr.delete(range.from, range.to).setBlockType(range.from, range.from, type("listLine"), { ...next, eol: parent.attrs.eol ?? "\n" });
        },
      });
    return [
      lineRule(/^\s*[-*•]\s$/, () => ({ kind: "bullet", level: 0 })),
      lineRule(/^(\d{1,3})\.\s$/, (match) => ({ kind: "ordered", level: 0, number: Number(match[1]) })),
      lineRule(/^\[([ xX]?)\]\s$/, (match) => ({ kind: "task", level: 0, checked: /x/i.test(match[1] ?? "") })),
      wrappingInputRule({ find: /^\s*>\s$/, type: type("blockquote") }),
      textblockTypeInputRule({ find: /^\$\$\s$/, type: type("mathBlock") }),
      new InputRule({
        // `---` (or `—-` after smart dashes) on a line of its own: a rule, the caret on a new line under it.
        find: /^(?:---|—-|___\s|\*\*\*\s)$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== "paragraph" || $from.parent.content.size !== range.to - range.from) return null;
          const start = $from.before();
          const end = $from.after();
          const tr = state.tr.replaceWith(start, end, [type("horizontalRule").create(), type("paragraph").create()]);
          tr.setSelection(TextSelection.create(tr.doc, start + 2));
        },
      }),
    ];
  },
});

// --- the editor's extensions -----------------------------------------------------------------------------------------------

/** The page editor's extensions (`host`: the page around it). */
export function pageExtensions(host: PageEditorHost) {
  return [
    Document,
    Text,
    PageParagraph,
    PageHeading,
    ListLine.configure({ host }),
    PageQuote,
    PageCode,
    MathBlock.configure({ host }),
    RawMarkdown.configure({ host }),
    HorizontalRule,
    PageImage.configure({ host }),
    PageEmbed.configure({ host }),
    PageTable.configure({ host }),
    Callout.configure({ host }),
    ToggleTitle,
    Toggle.configure({ host }),
    Mention.configure({ host }),
    PageLink.configure({ host }),
    Emoji.configure({ host }),
    OnlyBold,
    OnlyItalic,
    OnlyStrike,
    InlineCode,
    InlineMath,
    OnlyLink.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: "https",
      isAllowedUri: (url) => /^(?:https?:\/\/|attachment:)/i.test(url),
      shouldAutoLink: (url) => /^https?:\/\//i.test(url),
    }),
    ListMarkers,
    PageKeys.configure({ host }),
    UndoRedo,
    CaretPlaceholder.configure({ host }),
  ];
}

// --- the editor's document and Markdown ------------------------------------------------------------------------------------

/** The originals of a document just read: each node with a tie, by its tie (the writer's "untouched" test). */
export class SourceMap {
  private readonly nodes = new Map<string, PMNode>();

  /** Remembers the tied nodes under `node` (a document read, or blocks a merge brought in). */
  add(node: PMNode): void {
    const walk = (n: PMNode) => {
      const sig = n.attrs.sig;
      if (typeof sig === "string") this.nodes.set(sig, n);
      if (!n.isLeaf && !n.type.spec.code) n.forEach(walk);
    };
    walk(node);
  }

  clear(): void {
    this.nodes.clear();
  }

  /** Whether `node` is still exactly what was read (identity first: an untouched node is the same object). */
  original(node: PMNode): boolean {
    const sig = node.attrs.sig;
    if (typeof sig !== "string") return false;
    const read = this.nodes.get(sig);
    return !!read && (read === node || read.eq(node));
  }

  view(): SourceView<PMNode> {
    return {
      type: (node) => node.type.name,
      attrs: (node) => node.attrs,
      children: (node) => {
        const out: PMNode[] = [];
        node.forEach((child) => out.push(child));
        return out;
      },
      inline: (node) => (node.content.toJSON() as RichNode[] | null) ?? [],
      text: (node) => node.textContent,
      original: (node) => this.original(node),
    };
  }
}

/** The Markdown of the editor's document (untouched blocks as they were read). */
export function editorMarkdown(doc: PMNode, sources: SourceMap): { text: string; starts: number[] } {
  return serializePage(doc, sources.view());
}

/** Text pasted into the page editor: read as page Markdown (new blocks, tied to nothing). */
export function markdownSlice(editor: Editor, text: string, isEmoji: (name: string) => boolean): Slice {
  const doc = pageToDoc(text.replace(/\r\n?/g, "\n"), { emoji: isEmoji });
  const untie = (node: RichNode): RichNode => ({ ...node, ...(node.attrs ? { attrs: untied(node.attrs) } : {}), ...(node.content ? { content: node.content.map(untie) } : {}) });
  const nodes = (doc.content ?? []).map(untie).map((node) => editor.schema.nodeFromJSON(node as JSONContent));
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  return new Slice(Fragment.fromArray(nodes), first?.isTextblock ? 1 : 0, last?.isTextblock ? 1 : 0);
}
