/**
 * M151 (WIKI.md §28): HTML pasted into the page editor, from Notion, Word, Google Docs and web pages, made into what the
 * editor's schema reads (ui/pageEditorSchema.ts parse rules) before ProseMirror reads it:
 *
 * - Office's leftovers go: comments (Word's conditional comments too), `<o:p>` and the other namespaced elements
 *   (`o:`, `w:`, `v:`, `m:`; shapes dropped, the rest unwrapped), `<style>`, `<meta>`, `<xml>`.
 * - Google Docs' wrapper `<b style="font-weight:normal" id="docs-internal-guid-…">` is unwrapped (it is not bold). Its
 *   spans' styles (font-weight:700, font-style:italic, text-decoration:line-through) are marks by the marks' own rules.
 * - Word's list paragraphs (`class="MsoListParagraph…"`, `mso-list:l0 level2` in the style, the bullet or number in a
 *   `<span style="mso-list:Ignore">`) become flat list lines of that kind and level; nested `ul` / `ol` (also Google
 *   Docs' `ul` right inside a `ul`, `aria-level`) become flat lines too. Checkboxes (`<input type=checkbox>`,
 *   `aria-checked`, Notion's `checkbox-on` / `checkbox-off`, a leading ☐ / ☒ / `[ ]` / `[x]`) make checklist lines.
 * - Tables (Word's `MsoTable…` with paragraphs in the cells, Google Docs', Notion's, any `<table>`): a grid of one-line
 *   cells, `colspan` / `rowspan` spread over empty cells, the `thead` / `th` row (else the first row) as the header.
 * - Notion's callouts (`<aside>`, the HTML export's `<figure class="callout">` with its `.icon`, a block whose class
 *   names a callout) become callouts with their emoji; `<details><summary>` (Notion's toggles, any page) toggles. One
 *   inside another two deep at most (deeper ones give up their frame, keeping their blocks).
 *
 * Pure DOM work (no editor): tests run it on the clipboard HTML of each source (tests/fixtures/paste/).
 */

const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "BLOCKQUOTE", "PRE", "FIGURE", "ASIDE", "DETAILS", "SECTION", "ARTICLE", "HR"]);
const CHECKED_MARK = /^\s*(?:\[[xX]\]|☒|☑|✅|■)\s*/u;
const OPEN_MARK = /^\s*(?:\[ \]|☐|□)\s*/u;
/** A Word list label that numbers (`1.`, `a)`, `(1)`, `①`, `一、`): a letter alone is a bullet in a symbol font. */
const ORDERED_LABEL = /^(?:[(（]?(?:\d+|[０-９]+|[a-zA-Zａ-ｚＡ-Ｚ]{1,5}|[一二三四五六七八九十]+)[.)．）、]|[(（](?:\d+|[０-９]+|[a-zA-Z]{1,5})[)）]|\d+|[０-９]+|[①-⑳])$/u;
const EMOJI_START = /^\s*((?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:️|‍(?:\p{Extended_Pictographic})|\p{Emoji_Modifier})*)\s*/u;

/** The editor's HTML for pasted HTML (`depth`: callouts / toggles around the caret). */
export function pageHtmlFromPaste(html: string, depth = 0): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  cleanOffice(doc, body);
  unwrapDocsWrapper(body);
  wordLists(doc, body);
  flattenLists(doc, body);
  for (const table of Array.from(body.querySelectorAll("table"))) if (!table.parentElement?.closest("table")) gridTable(doc, table);
  containers(doc, body, depth);
  return body.innerHTML;
}

// --- Office ---------------------------------------------------------------------------------------------------------------

function cleanOffice(doc: Document, body: HTMLElement): void {
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node);
  comments.forEach((node) => node.parentNode?.removeChild(node));
  for (const el of Array.from(body.querySelectorAll("style, meta, link, title, script, xml, colgroup, caption"))) el.remove();
  // Namespaced elements (`o:p`, `w:sdt`, `v:shape`, `m:oMath`): shapes and their data go, the rest keep their text.
  for (const el of Array.from(body.getElementsByTagName("*"))) {
    if (!el.tagName.includes(":") || !el.isConnected) continue;
    if (/^(v|xml):/i.test(el.tagName)) el.remove();
    else unwrap(el);
  }
  // A Word paragraph of only a no-break space is an empty line.
  for (const p of Array.from(body.querySelectorAll("p"))) if (p.textContent?.replace(/ /g, " ").trim() === "" && !p.querySelector("img")) p.textContent = "";
}

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

/** Google Docs puts everything in a `<b style="font-weight:normal" id="docs-internal-guid-…">`: not bold. */
function unwrapDocsWrapper(body: HTMLElement): void {
  for (const b of Array.from(body.querySelectorAll('b[id^="docs-internal-guid"]'))) unwrap(b);
}

// --- lists ---------------------------------------------------------------------------------------------------------------

/** A list line element the schema reads (`div[data-list-line]`). */
function listLine(doc: Document, kind: "bullet" | "ordered" | "task", level: number, checked = false, number: number | null = null): HTMLElement {
  const line = doc.createElement("div");
  line.setAttribute("data-list-line", "");
  line.setAttribute("data-kind", kind);
  line.setAttribute("data-level", String(Math.max(0, Math.min(level, kind === "task" ? 1 : 2))));
  if (checked) line.setAttribute("data-checked", "true");
  if (number !== null) line.setAttribute("data-number", String(number));
  return line;
}

/** A leading checkbox sign in a line's text (☐, ☒, `[ ]`, `[x]`): taken out, and whether it was ticked. */
function takeCheckSign(line: Element): boolean | null {
  const walker = line.ownerDocument.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (text.trim() === "") continue;
    const checked = CHECKED_MARK.exec(text);
    const open = checked ? null : OPEN_MARK.exec(text);
    if (!checked && !open) return null;
    node.textContent = text.slice((checked ?? open)![0].length);
    return !!checked;
  }
  return null;
}

/** Word's list paragraphs: `mso-list:lN levelM` in the style, the bullet or number in a `mso-list:Ignore` span. */
function wordLists(doc: Document, body: HTMLElement): void {
  for (const p of Array.from(body.querySelectorAll("p"))) {
    const style = p.getAttribute("style") ?? "";
    const list = /mso-list:\s*l\d+\s+level(\d+)/i.exec(style);
    if (!list && !/MsoListParagraph/i.test(p.className)) continue;
    const ignore = Array.from(p.querySelectorAll("span")).find((span) => /mso-list:\s*ignore/i.test(span.getAttribute("style") ?? ""));
    if (!list && !ignore) continue;
    const label = (ignore?.textContent ?? "").replace(/[ \s]+/g, " ").trim();
    // The span with the label sits in an outer span (Symbol font); both go.
    let drop: Element | undefined = ignore;
    while (drop?.parentElement && drop.parentElement !== p && drop.parentElement.textContent?.trim() === drop.textContent?.trim()) drop = drop.parentElement;
    drop?.remove();
    const level = Math.max(0, Number(list?.[1] ?? 1) - 1);
    const symbolFont = /wingdings|symbol|webdings/i.test(`${ignore?.parentElement?.getAttribute("style") ?? ""} ${ignore?.getAttribute("style") ?? ""}`);
    const ordered = !symbolFont && ORDERED_LABEL.test(label);
    const digits = /\d+|[０-９]+/.exec(label)?.[0];
    const number = ordered && digits ? Number(digits.replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))) : null;
    const tick = label === "☐" || label === "☒" || label === "☑" ? label !== "☐" : null;
    const line = listLine(doc, tick !== null ? "task" : ordered ? "ordered" : "bullet", level, tick === true, number);
    line.append(...Array.from(p.childNodes));
    const own = tick === null ? takeCheckSign(line) : null;
    if (own !== null) {
      line.setAttribute("data-kind", "task");
      line.setAttribute("data-level", String(Math.min(level, 1)));
      if (own) line.setAttribute("data-checked", "true");
      line.removeAttribute("data-number");
    }
    p.replaceWith(line);
  }
}

/**
 * Nested `ul` / `ol` as flat list lines, the marks inside kept: a list inside an item, or right inside a list (Google
 * Docs), is a level deeper; `aria-level` (Google Docs) says the level itself.
 */
function flattenLists(doc: Document, body: HTMLElement): void {
  const flatten = (list: Element, level: number): Element[] => {
    const out: Element[] = [];
    let number = list.tagName === "OL" ? Number(list.getAttribute("start") ?? 1) || 1 : null;
    for (const item of Array.from(list.children)) {
      if (item.tagName === "UL" || item.tagName === "OL") {
        out.push(...flatten(item, level + 1));
        continue;
      }
      if (item.tagName !== "LI") continue;
      // An item holding a toggle, a callout or a table (Notion's toggle lists): its blocks, not a list line.
      if (item.querySelector(":scope > details, :scope > figure, :scope > aside, :scope > table")) {
        out.push(...Array.from(item.children));
        continue;
      }
      const ariaLevel = Number(item.getAttribute("aria-level") ?? 0);
      const at = ariaLevel > 0 ? ariaLevel - 1 : level;
      const box = item.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox], :scope > label > input[type=checkbox]") as HTMLInputElement | null;
      const notionBox = item.querySelector(":scope > .checkbox, :scope > div > .checkbox");
      const aria = item.getAttribute("aria-checked");
      const nested: Element[] = [];
      const line = listLine(doc, list.tagName === "OL" ? "ordered" : "bullet", at, false, number);
      for (const child of Array.from(item.childNodes)) {
        if (child instanceof Element && (child.tagName === "UL" || child.tagName === "OL")) nested.push(child);
        else if (child instanceof Element && (child.tagName === "INPUT" || child === notionBox)) continue;
        else if (child instanceof Element && (child.tagName === "P" || child.tagName === "DIV" || child.tagName === "LABEL" || child.tagName === "SPAN") && !child.querySelector("ul, ol, table")) line.append(...Array.from(child.childNodes).filter((n) => !(n instanceof Element && n.tagName === "INPUT")));
        else line.append(child);
      }
      const sign = box || notionBox || aria !== null ? null : takeCheckSign(line);
      const checked = box ? box.checked || box.hasAttribute("checked") : notionBox ? notionBox.classList.contains("checkbox-on") : aria !== null ? aria === "true" : sign;
      if (box || notionBox || aria !== null || sign !== null) {
        line.setAttribute("data-kind", "task");
        line.setAttribute("data-level", String(Math.min(at, 1)));
        line.removeAttribute("data-number");
        if (checked) line.setAttribute("data-checked", "true");
      }
      if (number !== null) number++;
      out.push(line);
      for (const sub of nested) out.push(...flatten(sub, at + 1));
    }
    return out;
  };
  for (const list of Array.from(body.querySelectorAll("ul, ol"))) {
    if (!list.isConnected || list.parentElement?.closest("ul, ol")) continue;
    list.replaceWith(...flatten(list, 0));
  }
}

// --- tables --------------------------------------------------------------------------------------------------------------

/**
 * A pasted table as a grid the schema reads (`table` > `tr` > `td`): every cell one line (its paragraphs joined by
 * spaces), spans spread over empty cells, the header row first, every row as wide as the widest.
 */
function gridTable(doc: Document, table: HTMLTableElement): void {
  const rows = Array.from(table.querySelectorAll("tr")).filter((tr) => tr.closest("table") === table);
  if (rows.length === 0) {
    table.remove();
    return;
  }
  const grid: Array<Array<Element | null>> = [];
  rows.forEach((tr, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of Array.from(tr.children)) {
      if (cell.tagName !== "TD" && cell.tagName !== "TH") continue;
      while (grid[r]![c] !== undefined) c++;
      const colspan = Math.max(1, Math.min(Number(cell.getAttribute("colspan") ?? 1) || 1, 50));
      const rowspan = Math.max(1, Math.min(Number(cell.getAttribute("rowspan") ?? 1) || 1, rows.length - r));
      for (let dr = 0; dr < rowspan; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < colspan; dc++) grid[r + dr]![c + dc] = dr === 0 && dc === 0 ? cell : null;
      }
      c += colspan;
    }
  });
  const width = Math.max(1, ...grid.map((row) => row.length));
  // The header: the rows in `thead` or of `th` cells at the top (the first of them), else the first row.
  const headerIndex = Math.max(0, rows.findIndex((tr) => tr.parentElement?.tagName === "THEAD" || (Array.from(tr.children).length > 0 && Array.from(tr.children).every((cell) => cell.tagName === "TH"))));
  const order = [headerIndex, ...grid.keys()].filter((r, k, all) => all.indexOf(r) === k);
  const out = doc.createElement("table");
  const tbody = doc.createElement("tbody");
  out.append(tbody);
  for (const r of order) {
    const tr = doc.createElement("tr");
    for (let c = 0; c < width; c++) {
      const td = doc.createElement("td");
      const source = grid[r]?.[c] ?? null;
      if (source) {
        const align = (source as HTMLElement).style?.textAlign || source.getAttribute("align") || alignInside(source);
        if (align === "left" || align === "center" || align === "right") td.setAttribute("align", align);
        td.append(...cellLine(doc, source));
        // The header is drawn bold anyway: its cells' own bold (Word's <b>, Google Docs' font-weight:700) goes.
        if (r === headerIndex) {
          for (const bold of Array.from(td.querySelectorAll("b, strong"))) unwrap(bold);
          for (const styled of Array.from(td.querySelectorAll<HTMLElement>("[style*='font-weight']"))) styled.style.removeProperty("font-weight");
        }
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.replaceWith(out);
}

/** A Word cell's alignment is on its paragraph. */
function alignInside(cell: Element): string {
  const p = cell.querySelector("p, div");
  return (p as HTMLElement | null)?.style?.textAlign || p?.getAttribute("align") || "";
}

/** A cell's content as one line: its blocks' inline content joined by spaces, nested tables as their text. */
function cellLine(doc: Document, cell: Element): Node[] {
  const out: Node[] = [];
  const space = () => {
    const last = out[out.length - 1];
    if (out.length > 0 && !(last?.nodeType === 3 && /\s$/.test(last.textContent ?? ""))) out.push(doc.createTextNode(" "));
  };
  const walk = (node: Node) => {
    if (node instanceof Element && (node.tagName === "TABLE" || node.tagName === "IMG" || node.tagName === "INPUT")) {
      if (node.tagName === "TABLE") {
        space();
        out.push(doc.createTextNode((node.textContent ?? "").replace(/\s+/g, " ").trim()));
      }
      return;
    }
    if (node instanceof Element && node.tagName === "BR") return space();
    if (node instanceof Element && (BLOCK_TAGS.has(node.tagName) || node.hasAttribute("data-list-line"))) {
      space();
      node.childNodes.forEach(walk);
      return space();
    }
    if (node instanceof Element && node.querySelector("p, div, br, ul, ol, table, li, [data-list-line]")) {
      // An inline wrapper around blocks (a span around paragraphs): its blocks, its marks lost.
      node.childNodes.forEach(walk);
      return;
    }
    out.push(node);
  };
  Array.from(cell.childNodes).forEach(walk);
  while (out.length > 0 && out[0]!.nodeType === 3 && (out[0]!.textContent ?? "").trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1]!.nodeType === 3 && (out[out.length - 1]!.textContent ?? "").trim() === "") out.pop();
  return out;
}

// --- callouts and toggles -----------------------------------------------------------------------------------------------

/** Notion's callouts and `<details>` toggles as the schema's; two deep at most (with the caret's `depth`). */
function containers(doc: Document, body: HTMLElement, depth: number): void {
  const framed = (el: Element) => el.tagName === "ASIDE" || (el.tagName === "FIGURE" && el.classList.contains("callout")) || (typeof el.className === "string" && /(^|[\s-])callout(-block)?($|\s)/.test(el.className)) || el.getAttribute("role") === "note";
  // A frame whose only content is another frame (Notion's page: a callout block around a `role="note"`) is one callout.
  const isCallout = (el: Element) => framed(el) && !(el.children.length === 1 && framed(el.children[0]!) && (el.textContent ?? "").trim() === (el.children[0]!.textContent ?? "").trim());
  const convert = (el: Element, around: number) => {
    // Decided before the inner ones are made over; those first (their frames are given up when too deep).
    const frame = isCallout(el) || el.tagName === "DETAILS";
    for (const child of Array.from(el.children)) convert(child, around + (frame ? 1 : 0));
    if (!el.isConnected || !frame) return;
    if (around >= 2) {
      // Too deep for the dialect: the blocks stay, the frame goes.
      if (el.tagName === "DETAILS") el.querySelector(":scope > summary")?.replaceWith(paragraphOf(doc, el.querySelector(":scope > summary")!));
      unwrap(el);
      return;
    }
    if (el.tagName === "DETAILS") toggleOf(doc, el);
    else calloutOf(doc, el);
  };
  for (const child of Array.from(body.children)) convert(child, depth);
}

function paragraphOf(doc: Document, el: Element): HTMLElement {
  const p = doc.createElement("p");
  p.append(...Array.from(el.childNodes));
  return p;
}

/** The blocks of a container's content: loose inline content (text, spans) put in paragraphs. */
function blocksOf(doc: Document, nodes: readonly Node[]): Node[] {
  const out: Node[] = [];
  let loose: HTMLElement | null = null;
  for (const node of nodes) {
    const block = node instanceof Element && (BLOCK_TAGS.has(node.tagName) || node.hasAttribute("data-list-line") || node.hasAttribute("data-callout") || node.hasAttribute("data-toggle"));
    if (block) {
      loose = null;
      out.push(node);
      continue;
    }
    if (node.nodeType === 3 && (node.textContent ?? "").trim() === "" && !loose) continue;
    if (node instanceof Element && node.tagName === "BR") {
      loose = null;
      continue;
    }
    if (!loose) {
      loose = doc.createElement("p");
      out.push(loose);
    }
    loose.append(node);
  }
  return out.length > 0 ? out : [doc.createElement("p")];
}

function calloutOf(doc: Document, el: Element): void {
  // The icon: Notion's `.icon` (an emoji, or an image with its emoji as alt), else an emoji the text starts with.
  let icon: string | null = null;
  const iconEl = el.querySelector(".icon, .notion-record-icon, [class*='callout-icon']");
  if (iconEl) {
    icon = (iconEl.textContent ?? "").trim() || iconEl.querySelector("img")?.getAttribute("alt")?.trim() || null;
    // The icon's own wrapper (Notion's export: a div around it) goes with it.
    let drop: Element = iconEl;
    while (drop.parentElement && drop.parentElement !== el && (drop.parentElement.textContent ?? "").trim() === (drop.textContent ?? "").trim()) drop = drop.parentElement;
    drop.remove();
  }
  if (!icon) {
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (text.trim() === "") continue;
      const match = EMOJI_START.exec(text);
      if (match) {
        icon = match[1]!;
        node.textContent = text.slice(match[0].length);
      }
      break;
    }
  }
  // Notion's export puts the content in one div beside the icon: its children are the blocks.
  let content = Array.from(el.childNodes);
  if (content.filter((n) => !(n.nodeType === 3 && (n.textContent ?? "").trim() === "")).length === 1 && content.find((n) => n instanceof Element)?.nodeName === "DIV") {
    const only = content.find((n) => n instanceof Element) as Element;
    if (!only.hasAttribute("data-list-line")) content = Array.from(only.childNodes);
  }
  const callout = doc.createElement("div");
  callout.setAttribute("data-callout", "");
  callout.setAttribute("data-icon", icon ?? "💡");
  const inner = doc.createElement("div");
  inner.setAttribute("data-callout-body", "");
  inner.append(...blocksOf(doc, content));
  callout.append(inner);
  el.replaceWith(callout);
}

function toggleOf(doc: Document, el: Element): void {
  const summary = el.querySelector(":scope > summary");
  const toggle = doc.createElement("div");
  toggle.setAttribute("data-toggle", "");
  const title = doc.createElement("div");
  title.setAttribute("data-toggle-title", "");
  if (summary) {
    // The title is one line: a summary's blocks give their inline content.
    for (const node of Array.from(summary.childNodes)) {
      if (node instanceof Element && BLOCK_TAGS.has(node.tagName)) title.append(...Array.from(node.childNodes), doc.createTextNode(" "));
      else title.append(node);
    }
    summary.remove();
  }
  toggle.append(title, ...blocksOf(doc, Array.from(el.childNodes)));
  el.replaceWith(toggle);
}
