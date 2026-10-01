/**
 * Keeping the timeline still while its content changes height (testers, 2026-10-01: "when opening a channel the
 * scroll position sometimes suddenly jumps a lot", more in channels with images and links).
 *
 * Rows grow after they are drawn: a link card appears when its preview arrives, a video tile takes the clip's shape
 * once it loads, a photo without a known size takes its own. WebKit (the macOS app, Safari) has no CSS scroll anchoring,
 * so a row growing above the viewport pushed everything on screen down, and the view lost the first unread row it had
 * landed on; at the bottom, a scroll event measured mid-growth took the reader for having scrolled away and the view
 * stopped following the bottom. The timeline therefore anchors itself, the same way on every engine (Chromium's own
 * anchoring is switched off on the scroller): at the bottom it stays at the bottom until the reader scrolls up;
 * elsewhere the topmost row on screen keeps its place. The decisions are here, apart from the DOM, to be tested.
 */

/** Within this distance of the end the list counts as at the bottom. */
export const BOTTOM_SLACK_PX = 48;

/**
 * Whether the list is still at the bottom after a scroll event. Near the end it is. Further away it stays at the bottom
 * only when it was there and the scroll did not go up: content grew under it (an image, a card), which is no move of
 * the reader's, and the resize observer brings it back down. Scrolling up is the reader's (the view never scrolls up
 * from the bottom by itself, except for a landing, which goes up and so counts as leaving).
 */
export function stillAtBottom(wasAtBottom: boolean, previousTop: number, top: number, distance: number): boolean {
  if (distance < BOTTOM_SLACK_PX) return true;
  return wasAtBottom && top >= previousTop - 1;
}

/**
 * The first of `count` rows (in order, top to bottom) whose bottom edge is below `viewTop` (with a pixel of slack), by
 * bisection; -1 when none is. That row is the anchor: the topmost one the reader sees.
 */
export function firstRowBelow(count: number, bottomOf: (index: number) => number, viewTop: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (bottomOf(middle) > viewTop + 1) high = middle;
    else low = middle + 1;
  }
  return low < count ? low : -1;
}

/** What to add to scrollTop so the anchor row is back at `offset` from the top (0 within a pixel: rounding). */
export function anchorCorrection(offset: number, currentOffset: number): number {
  const delta = currentOffset - offset;
  return Math.abs(delta) < 1 ? 0 : delta;
}
