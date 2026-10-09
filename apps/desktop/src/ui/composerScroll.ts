/**
 * The message input's own scrolling (Composer.tsx's text area, RichEditor.tsx's box): it grows with the draft up to a
 * cap, and only above the cap does it scroll, just enough to keep the caret's line in view.
 *
 * Left to the engines, both inputs moved by a few pixels as one typed (user report 2026-10-09): the browser's own reveal
 * (and ProseMirror's) shows the caret's glyph box, not its line, so where the input stopped depended on the font of the
 * character at the caret (a Latin caret is the line's height, a Japanese one or the IME's text a few pixels shorter), the
 * last line stopped short of the bottom padding (18 px of 24 scrolled in the text area, 23 in the rich editor), and the
 * next Backspace snapped it to the end. At a zoom that is not a whole number of device pixels per line (文字の大きさ
 * 90 % or 110 %, WebKit), the height the text area is given from its rounded scrollHeight can also miss its content by a
 * pixel, which the browser's reveal then scrolls while the draft still fits. So the input scrolls to the caret's line
 * (with a few pixels of the next ones, and the padding at the first and last line), and while the draft fits it has
 * nothing to scroll (`overflow-y: hidden`, back at the top if anything scrolled it).
 */

export interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** A line of the input, in the scrolled content's coordinates (0 is the top of its padding). */
export interface Line {
  top: number;
  bottom: number;
}

/** The padding around the text: the first and last lines are shown with it. */
export interface Padding {
  top: number;
  bottom: number;
}

/** WebKit's zoom rounds scrollHeight a pixel above clientHeight while the content fits (110 %: 89 against 88). */
const ROUNDING = 1;
/**
 * Of the lines next to the caret's. Also enough for the engines' own reveal of the caret's glyph (inside the line) and
 * ProseMirror's 5 px around it (half a line's leading inside it), so neither moves the box again.
 */
const MARGIN = 4;

export function fits(box: Pick<ScrollBox, "clientHeight" | "scrollHeight">): boolean {
  return box.scrollHeight <= box.clientHeight + ROUNDING;
}

/**
 * The line box around a caret's (or a glyph's) rectangle: as tall as the line, centred on it. The rectangle's own
 * height depends on the font at the caret, the line's does not.
 */
export function lineAround(rect: Line, lineHeight: number): Line {
  if (!(lineHeight > 0) || rect.bottom - rect.top >= lineHeight) return rect;
  const middle = (rect.top + rect.bottom) / 2;
  return { top: middle - lineHeight / 2, bottom: middle + lineHeight / 2 };
}

/**
 * Where to scroll so `line` is in view with a few pixels of its neighbours, moving as little as possible: not at all
 * while it is in view already, nothing to scroll while the content fits; the first line comes with the padding above it
 * and the last one with the padding below (the end, where typing usually is).
 */
export function revealLine(box: ScrollBox, line: Line, padding: Padding): number {
  if (fits(box)) return 0;
  const max = box.scrollHeight - box.clientHeight;
  let top = line.top - MARGIN;
  let bottom = line.bottom + MARGIN;
  if (line.top <= padding.top + ROUNDING) top = 0;
  if (line.bottom >= box.scrollHeight - padding.bottom - ROUNDING) bottom = box.scrollHeight;
  let next = box.scrollTop;
  if (bottom - top > box.clientHeight) next = top;
  else if (top < next) next = top;
  else if (bottom > next + box.clientHeight) next = bottom - box.clientHeight;
  return Math.min(max, Math.max(0, next));
}

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function paddingOf(element: Element): Padding {
  const style = getComputedStyle(element);
  return { top: px(style.paddingTop), bottom: px(style.paddingBottom) };
}

/** `overflow-y` by whether the content fits, and back at the top when it does (something scrolled it a pixel). */
export function settle(scroller: HTMLElement): boolean {
  const fit = fits(scroller);
  const overflow = fit ? "hidden" : "auto";
  if (scroller.style.overflowY !== overflow) scroller.style.overflowY = overflow;
  if (fit && scroller.scrollTop !== 0) scroller.scrollTop = 0;
  return fit;
}

/** Settles `scroller` and scrolls it to `line` (content coordinates) when the content is taller than it. */
export function keepLineInView(scroller: HTMLElement, line: Line | null): void {
  if (settle(scroller) || !line) return;
  const next = revealLine(scroller, line, paddingOf(scroller));
  if (Math.abs(next - scroller.scrollTop) >= 0.5) scroller.scrollTop = next;
}

/**
 * A viewport rectangle (getBoundingClientRect, ProseMirror's coordsAtPos) in `scroller`'s content coordinates. Viewport
 * pixels and scrollTop's differ under a CSS zoom or a transform (WebKit's `zoom`): the box's two heights give the scale.
 */
export function contentLine(scroller: HTMLElement, rect: Line, lineHeight: number): Line {
  const box = scroller.getBoundingClientRect();
  const scale = scroller.offsetHeight > 0 && box.height > 0 ? box.height / scroller.offsetHeight : 1;
  const at = (y: number) => (y - box.top) / scale - scroller.clientTop + scroller.scrollTop;
  return lineAround({ top: at(rect.top), bottom: at(rect.bottom) }, lineHeight);
}

/** The line height of `element` in px (`normal` taken as 1.2 of the font size). */
export function lineHeightOf(element: Element): number {
  const style = getComputedStyle(element);
  const height = px(style.lineHeight);
  return height > 0 ? height : px(style.fontSize) * 1.2;
}

const MIRRORED = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
  "borderBottomWidth", "borderLeftWidth", "borderStyle", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
  "fontFeatureSettings", "fontKerning", "letterSpacing", "wordSpacing", "lineHeight", "textTransform", "textIndent", "tabSize",
  "whiteSpace", "wordBreak", "overflowWrap", "direction",
] as const;

/**
 * The line of a text area's caret, in its content coordinates: a copy of its text up to the caret laid out in a hidden
 * box of the same width and type (a text area tells nothing of where its caret is).
 */
export function textAreaCaretLine(area: HTMLTextAreaElement): Line {
  const doc = area.ownerDocument;
  const mirror = doc.createElement("div");
  const style = getComputedStyle(area);
  for (const name of MIRRORED) mirror.style[name] = style[name];
  // As wide as the text inside the text area (its scrollbar left out), and wrapping as it does.
  mirror.style.width = `${area.clientWidth + px(style.borderLeftWidth) + px(style.borderRightWidth)}px`;
  mirror.style.whiteSpace = "pre-wrap";
  if (style.overflowWrap === "normal") mirror.style.overflowWrap = "break-word";
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-10000px", height: "auto", overflow: "hidden" });
  const caret = area.selectionDirection === "backward" ? area.selectionStart : area.selectionEnd;
  mirror.textContent = area.value.slice(0, caret);
  const marker = doc.createElement("span");
  // The rest of the line, so the caret's word wraps where it does in the text area.
  marker.textContent = /^[^\s]*/.exec(area.value.slice(caret))?.[0] || "​";
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);
  const top = marker.offsetTop; // from the padding edge, as the text area scrolls
  const height = marker.offsetHeight;
  mirror.remove();
  return lineAround({ top, bottom: top + height }, lineHeightOf(area));
}
