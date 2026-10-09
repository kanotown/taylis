/**
 * ⌘F / Ctrl+F inside an open Docs page (WIKI.md §29.3): the words found in the page as it shows (reading, the 見たまま
 * editor, or the Markdown editor's preview), as DOM ranges. Nothing in the page is changed: the matches are painted
 * with the CSS Custom Highlight API where it exists (the editor's DOM belongs to ProseMirror and must not be touched),
 * and the current one is otherwise shown by selecting it.
 *
 * The app needs its own: the macOS app's WKWebView has no find bar, and the app's ⌘F opens the message search.
 */

/** Elements that end a run of text: a match never joins the end of one block to the start of the next. */
const BLOCK = "p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,summary,dt,dd,figcaption,div,section,article,tr,table,ul,ol";
/** Not page text: form fields, scripts, and what is hidden from the reader. */
const SKIP = "script,style,noscript,select,textarea,input,[aria-hidden='true'],[data-find-skip]";

export const FIND_HIGHLIGHT = "doc-find";
export const FIND_CURRENT = "doc-find-current";

interface Piece {
  node: Text;
  /** Where this text node starts in the joined text. */
  start: number;
}

function visible(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(element) : true;
}

/** Lower case for matching, keeping each text's length (a letter whose lower case is longer is left as it is). */
function fold(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  return [...text].map((ch) => (ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch)).join("");
}

/** Every match of `query` (case-insensitive, as typed: spaces included) in the text under `root`, in order. */
export function findRanges(root: Element, query: string): Range[] {
  const needle = fold(query);
  if (!needle.trim()) return [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      return visible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const pieces: Piece[] = [];
  let text = "";
  let block: Element | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const here = node.parentElement?.closest(BLOCK) ?? null;
    // A new block: a break no word contains, so nothing matches across it.
    if (pieces.length > 0 && here !== block) text += "\n";
    block = here;
    pieces.push({ node, start: text.length });
    text += fold(node.nodeValue ?? "");
  }
  const ranges: Range[] = [];
  let piece = 0;
  const locate = (offset: number, end: boolean): [Text, number] => {
    // The piece holding `offset` (an end may sit just after a piece's last letter).
    while (piece + 1 < pieces.length && (end ? pieces[piece + 1]!.start < offset : pieces[piece + 1]!.start <= offset)) piece += 1;
    const p = pieces[piece]!;
    return [p.node, Math.min(offset - p.start, p.node.length)];
  };
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    const range = doc.createRange();
    const [startNode, startOffset] = locate(at, false);
    const keep = piece;
    const [endNode, endOffset] = locate(at + needle.length, true);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    ranges.push(range);
    piece = keep;
  }
  return ranges;
}

type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };

function registry(): { highlights: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && Highlight ? { highlights: css.highlights, Highlight } : null;
}

/** Paints the matches and the current one (or clears both with no ranges). Returns false where it cannot paint. */
export function paintMatches(ranges: Range[], current: number): boolean {
  const api = registry();
  if (!api) return false;
  if (ranges.length === 0) {
    api.highlights.delete(FIND_HIGHLIGHT);
    api.highlights.delete(FIND_CURRENT);
    return true;
  }
  api.highlights.set(FIND_HIGHLIGHT, new api.Highlight(...ranges.filter((_, i) => i !== current)));
  const now = ranges[current];
  if (now) api.highlights.set(FIND_CURRENT, new api.Highlight(now));
  else api.highlights.delete(FIND_CURRENT);
  return true;
}

/** The match's place on screen: scrolled into the middle of its scroll box when it is out of sight. */
export function revealRange(range: Range): void {
  const element = range.startContainer.parentElement;
  if (!element) return;
  const box = range.getBoundingClientRect?.();
  const view = element.ownerDocument.defaultView;
  const inSight = box && view && box.height > 0 && box.top >= 0 && box.bottom <= view.innerHeight;
  if (!inSight) element.scrollIntoView?.({ block: "center" });
}

/** The next index after a step (wrapping), or the first match at or after the one shown before a recount. */
export function stepIndex(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}
