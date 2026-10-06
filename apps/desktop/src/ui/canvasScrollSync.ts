/**
 * The canvas editor's scroll sync (CANVAS.md §23): in 「編集」 the editor and the preview beside it scroll together, both
 * ways, matched by source lines as VS Code and GitHub do. The preview's top-level blocks carry the line they start on
 * (`data-line`, ui/CanvasBody.tsx); the editor's lines are measured where they wrap (a mirror of the text area). Each
 * block gives one anchor pair — the editor's scroll position with the block's line at the top edge, and the preview's
 * with the block at the top edge — and a scroll position between two anchors is interpolated between them. The two ends
 * are anchors too ((0, 0) and (end, end)), so both sides reach their top and their bottom together; an anchor past
 * either side's last scroll position is left out (those blocks can no longer reach the top edge). The mapping is
 * monotonic and piecewise linear, so the other direction is its exact inverse.
 *
 * Pure functions here (tests/canvasScrollSync.test.ts); the DOM side is `useCanvasScrollSync` (CanvasScrollSync.ts).
 */

/** A pair of scroll positions that show the same place: the editor's and the preview's. */
export interface ScrollAnchor {
  editor: number;
  preview: number;
}

/** A preview block: the source line it starts on and its top in the preview's scroll content. */
export interface PreviewBlock {
  line: number;
  top: number;
}

/** The last index whose value is ≤ `y` in an ascending array (−1 when `y` is before the first). Binary search. */
export function lastAtOrBefore(values: readonly number[], y: number): number {
  let lo = 0;
  let hi = values.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= y) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The top of source line `line` in the editor's content (`lineTops[k]` is line k's top; `end` the content's bottom). A
 * fractional line is that far into the line's height (a wrapped line is several rows high). Clamped to the ends.
 */
export function offsetOfLine(lineTops: readonly number[], end: number, line: number): number {
  if (lineTops.length === 0) return 0;
  if (line <= 0) return lineTops[0]!;
  const k = Math.floor(line);
  if (k >= lineTops.length) return end;
  const top = lineTops[k]!;
  const next = k + 1 < lineTops.length ? lineTops[k + 1]! : end;
  return top + (line - k) * (next - top);
}

/** The (fractional) source line at `y` of the editor's content: the inverse of `offsetOfLine`. */
export function lineAtOffset(lineTops: readonly number[], end: number, y: number): number {
  if (lineTops.length === 0) return 0;
  if (y <= lineTops[0]!) return 0;
  if (y >= end) return lineTops.length;
  const k = lastAtOrBefore(lineTops, y);
  const top = lineTops[k]!;
  const next = k + 1 < lineTops.length ? lineTops[k + 1]! : end;
  return next > top ? k + (y - top) / (next - top) : k;
}

/**
 * The anchors of one layout. `lineTops` / `editorEnd`: the editor's lines in its scroll content (`editorEnd` its
 * content height); `blocks`: the preview's, in source order; `editorMax` / `previewMax`: the last scroll positions
 * (scrollHeight − clientHeight). A block out of order on either side (a hidden one measured at 0) is left out.
 */
export function buildAnchors(
  lineTops: readonly number[],
  editorEnd: number,
  blocks: readonly PreviewBlock[],
  editorMax: number,
  previewMax: number,
): ScrollAnchor[] {
  const eMax = Math.max(0, editorMax);
  const pMax = Math.max(0, previewMax);
  const anchors: ScrollAnchor[] = [{ editor: 0, preview: 0 }];
  for (const block of blocks) {
    const editor = offsetOfLine(lineTops, editorEnd, block.line);
    const preview = block.top;
    const last = anchors[anchors.length - 1]!;
    // Strictly increasing on both sides and short of both ends (else the end anchor below takes over).
    if (editor <= last.editor || preview <= last.preview) continue;
    if (editor >= eMax || preview >= pMax) break;
    anchors.push({ editor, preview });
  }
  const last = anchors[anchors.length - 1]!;
  if (eMax > last.editor && pMax > last.preview) anchors.push({ editor: eMax, preview: pMax });
  return anchors;
}

/** The other side's scroll position for `position` of side `from`, interpolated between the anchors around it. */
export function mapScroll(anchors: readonly ScrollAnchor[], position: number, from: keyof ScrollAnchor): number {
  const to: keyof ScrollAnchor = from === "editor" ? "preview" : "editor";
  if (anchors.length === 0) return 0;
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  if (position <= first[from]) return first[to];
  if (position >= last[from]) return last[to];
  let lo = 0;
  let hi = anchors.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid]![from] <= position) lo = mid;
    else hi = mid;
  }
  const a = anchors[lo]!;
  const b = anchors[hi]!;
  const span = b[from] - a[from];
  return span > 0 ? a[to] + ((position - a[from]) / span) * (b[to] - a[to]) : a[to];
}

/** The line a block's anchor is on: its first line that is not blank (a paragraph keeps the blank lines before it). */
export function anchorLineOf(lines: readonly string[], from: number, to: number): number {
  for (let k = from; k < to; k++) if ((lines[k] ?? "").trim() !== "") return k;
  return from;
}
