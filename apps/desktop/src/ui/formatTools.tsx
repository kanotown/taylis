/**
 * The formats the composer's format bar offers (and, M187, the inline edit box's 「書式」 menu), in their order: the
 * icon, the label (with its shortcut), the rich editor's format and what it does to Markdown text. `group` starts a
 * group after a divider. The link is the owners' own in the rich editor (the composer asks for the URL).
 */
import { Bold, Code, Heading, Italic, Link as LinkIcon, List, ListOrdered, SquareCode, Strikethrough, TextQuote } from "lucide-react";
import type { ReactNode } from "react";

import { t } from "../i18n";
import { type EditState, insertLink, toggleFence, toggleLinePrefix, toggleWrap } from "./composerEdit";
import { modKey } from "./primitives";
import type { RichFormat } from "./richEditorApi";

export interface FormatTool {
  name: RichFormat | "link";
  icon: ReactNode;
  label: string;
  markdown: (state: EditState) => EditState | null;
  group?: true;
}

export function formatTools(): FormatTool[] {
  return [
    { name: "bold", icon: <Bold size={15} />, label: t("composer.format.boldKey", { key: `${modKey()}+B` }), markdown: (s) => toggleWrap(s, "**") },
    { name: "italic", icon: <Italic size={15} />, label: t("composer.format.italicKey", { key: `${modKey()}+I` }), markdown: (s) => toggleWrap(s, "_") },
    { name: "strike", icon: <Strikethrough size={15} />, label: t("composer.format.strikeKey", { key: `${modKey()}+Shift+X` }), markdown: (s) => toggleWrap(s, "~~") },
    { name: "code", icon: <Code size={15} />, label: t("composer.format.codeKey", { key: `${modKey()}+Shift+C` }), markdown: (s) => toggleWrap(s, "`"), group: true },
    { name: "codeBlock", icon: <SquareCode size={15} />, label: t("composer.format.codeBlock"), markdown: toggleFence },
    { name: "heading", icon: <Heading size={15} />, label: t("composer.format.heading"), markdown: (s) => toggleLinePrefix(s, "## "), group: true },
    { name: "quote", icon: <TextQuote size={15} />, label: t("composer.format.quote"), markdown: (s) => toggleLinePrefix(s, "> ") },
    { name: "bullets", icon: <List size={15} />, label: t("composer.format.bullets"), markdown: (s) => toggleLinePrefix(s, "- ") },
    { name: "numbered", icon: <ListOrdered size={15} />, label: t("composer.format.numbered"), markdown: (s) => toggleLinePrefix(s, (i) => `${i + 1}. `) },
    { name: "link", icon: <LinkIcon size={15} />, label: t("composer.format.linkKey", { key: `${modKey()}+Shift+U` }), markdown: (s) => insertLink(s), group: true },
  ];
}
