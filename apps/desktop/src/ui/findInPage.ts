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

/**
 * Every match of `query` (case-insensitive, as typed: spaces included) in the text under `root`, in order. The text
 * nodes are walked (skipped parts and hidden elements left out with their subtrees); a `<br>` is walked too, as the
 * hard break it is.
 */
export function findRanges(root: Element, query: string): Range[] {
  const needle = fold(query);
  if (!needle.trim() || root.closest(SKIP)) return [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (element.matches(SKIP) || !visible(element)) return NodeFilter.FILTER_REJECT;
        return element.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const pieces: Piece[] = [];
  let text = "";
  let block: Element | null = null;
  // A break no word contains, so nothing matches across it: a new block, or a <br> inside one.
  const breakText = () => {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  };
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      breakText();
      continue;
    }
    const here = node.parentElement?.closest(BLOCK) ?? null;
    if (pieces.length > 0 && here !== block) breakText();
    block = here;
    pieces.push({ node: node as Text, start: text.length });
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

/** A rectangle's vertical extent on screen. */
export interface Band {
  top: number;
  bottom: number;
}

/** How close to the edge of the view a match may sit and still count as in view. */
export const REVEAL_MARGIN = 8;

/**
 * What of a scroll box is in view: an element floating over it (`covers`: the find bar, over its top right) takes its
 * overlap off the edge it sits nearer, so a match under it is not in view.
 */
export function visibleBand(box: Band, covers: Band[]): Band {
  let { top, bottom } = box;
  for (const cover of covers) {
    if (cover.bottom <= box.top || cover.top >= box.bottom) continue;
    if ((cover.top + cover.bottom) / 2 < (box.top + box.bottom) / 2) top = Math.max(top, cover.bottom);
    else bottom = Math.min(bottom, cover.top);
  }
  return { top, bottom };
}

/**
 * How far down a box scrolls so `match` shows inside `view` (what of the box is in view): nothing while it is in view
 * clear of the edges, else to the middle; a match taller than the view starts at its top.
 */
export function revealDelta(match: Band, view: Band, margin = REVEAL_MARGIN): number {
  if (match.top >= view.top + margin && match.bottom <= view.bottom - margin) return 0;
  if (match.bottom - match.top > view.bottom - view.top - 2 * margin) return match.top - view.top - margin;
  return (match.top + match.bottom) / 2 - (view.top + view.bottom) / 2;
}

/** The boxes that scroll from `from` up to `root` (a database's table, an embedded page) and `root` itself, innermost first. */
function scrollBoxes(from: Element, root: Element): HTMLElement[] {
  const boxes: HTMLElement[] = [];
  const view = root.ownerDocument.defaultView;
  for (let element: Element | null = from; element; element = element.parentElement) {
    if (element === root) {
      boxes.push(root as HTMLElement);
      break;
    }
    if (!(element instanceof HTMLElement) || !view) continue;
    const overflow = view.getComputedStyle(element).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight) boxes.push(element);
  }
  return boxes;
}

/**
 * The match's place on screen: its scroll box (`data-find-root`) is scrolled by the difference between the match's
 * own rectangle (not its block's: a match deep in a tall paragraph or cell would stay out of view) and what of the box
 * is in view, with `covers` floating over the box (the find bar) taken off, so a match clipped at the box's edge or
 * under the bar comes to the middle. A box scrolling inside the root is scrolled first, by the same measure.
 */
export function revealRange(range: Range, covers: Element[] = []): void {
  const start = range.startContainer;
  const element = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
  if (!element) return;
  const root = element.closest("[data-find-root]");
  if (!root) {
    element.scrollIntoView?.({ block: "center" });
    return;
  }
  const floating = covers.map((cover) => cover.getBoundingClientRect());
  for (const box of scrollBoxes(element, root)) {
    const match = range.getBoundingClientRect?.();
    if (!match || match.bottom <= match.top) return; // not laid out: nothing to go by
    const over = box === root ? floating.filter((cover) => cover.right > match.left && cover.left < match.right) : [];
    const view = visibleBand(box.getBoundingClientRect(), over);
    if (view.bottom <= view.top) continue;
    const delta = revealDelta(match, view);
    if (delta !== 0) box.scrollTop += delta;
  }
}

/** The next index after a step (wrapping), or the first match at or after the one shown before a recount. */
export function stepIndex(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}
