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
 * elsewhere the topmost row on screen keeps its place. The decisions are here, apart from the DOM, to be tested; the
 * DOM side (ListAnchor) is shared by every message list: the timeline, a thread, the preview of a channel.
 */

import { type RefObject, useEffect, useState } from "react";

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

/**
 * The DOM side for one scroller whose rows (`selector`, top to bottom) keep their place: the channel timeline, a thread
 * (its parent and replies), the preview of a channel and its threads. `remember` / `keep` hold the topmost row on
 * screen; the rest is the bottom rule for the lists that need no more (the timeline has its own, around the keyboard on
 * a phone and its landings, and uses only `remember` / `keep`).
 */
export class ListAnchor {
  /** At the end: content growing keeps the list there, until the reader scrolls up or the view lands elsewhere. */
  atBottom = true;
  /** scrollTop at the last scroll event (or the view's own move): what a scroll up is measured from. */
  private lastTop = 0;
  /** The topmost row on screen, how far below the top of the list it was and the list's scrollTop then. */
  private row: { row: HTMLElement; offset: number; top: number } | null = null;

  constructor(
    private readonly scroller: () => HTMLElement | null,
    private readonly selector: string,
  ) {}

  /** Takes the topmost row on screen as the anchor (the rows are in order: found by bisection). */
  remember(): void {
    const el = this.scroller();
    if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>(this.selector);
    const viewTop = el.getBoundingClientRect().top;
    const index = firstRowBelow(rows.length, (i) => rows[i]!.getBoundingClientRect().bottom, viewTop);
    const row = index < 0 ? null : rows[index]!;
    this.row = row ? { row, offset: row.getBoundingClientRect().top - viewTop, top: el.scrollTop } : null;
  }

  /**
   * Content changed height: the anchor row goes back where it was. Only while the list has not scrolled since the anchor
   * was taken (a row growing moves no scrollTop); otherwise the reader moved, and the anchor is only taken again.
   */
  keep(): void {
    const el = this.scroller();
    const anchor = this.row;
    if (!el) return;
    if (anchor && el.contains(anchor.row) && Math.abs(el.scrollTop - anchor.top) < 1) {
      const delta = anchorCorrection(anchor.offset, anchor.row.getBoundingClientRect().top - el.getBoundingClientRect().top);
      if (delta !== 0) el.scrollTop += delta;
    }
    this.remember();
  }

  /** The view's own move to the end (opening, following a new row): it stays there while content grows. */
  toBottom(): void {
    const el = this.scroller();
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    this.atBottom = true;
    this.lastTop = el.scrollTop;
    this.remember();
  }

  /**
   * The view put a row somewhere itself (a landing on 「新しい返信」, a search hit centred): rows may have come above in
   * the same breath, so how far scrollTop moved says nothing; only the distance to the end counts.
   */
  placed(): void {
    const el = this.scroller();
    if (!el) return;
    this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    this.lastTop = el.scrollTop;
    this.remember();
  }

  /**
   * A scroll event. Away from the bottom, a scroll of the view's own (a correction) left the list where the anchor was
   * taken: growth since, not yet seen by the resize observer, is made up for rather than taken as the new place.
   */
  scrolled(): void {
    const el = this.scroller();
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.atBottom = stillAtBottom(this.atBottom, this.lastTop, el.scrollTop, distance);
    this.lastTop = el.scrollTop;
    if (this.atBottom) this.remember();
    else this.keep();
  }

  /** Content or the scroller changed height (rows came or went, a card or a photo arrived, the composer grew). */
  resized(): void {
    if (this.atBottom) this.toBottom();
    else this.keep();
  }

  /** M75: the topmost row on screen now (its element id) and its offset from the top of the viewport, to come back to. */
  snapshot(): { id: string; offset: number } | null {
    this.remember();
    const anchor = this.row;
    return anchor && anchor.row.id ? { id: anchor.row.id, offset: anchor.offset } : null;
  }

  /**
   * M75: the view puts `row` back at `offset` below the top of the viewport (a remembered position coming back); it is
   * then the anchor, as after a landing.
   */
  placeAt(row: HTMLElement, offset: number): void {
    const el = this.scroller();
    if (!el) return;
    const delta = anchorCorrection(offset, row.getBoundingClientRect().top - el.getBoundingClientRect().top);
    if (delta !== 0) el.scrollTop += delta;
    this.placed();
  }

  /** Another conversation in the same scroller: at the end until it places itself. */
  reset(): void {
    this.atBottom = true;
    this.lastTop = 0;
    this.row = null;
  }
}

/**
 * A ListAnchor for `scroller`, told by a resize observer whenever the scroller or `content` (the one child holding its
 * rows) changes height. Both elements are there from the first render.
 */
export function useListAnchor(scroller: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, selector: string): ListAnchor {
  const [anchor] = useState(() => new ListAnchor(() => scroller.current, selector));
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => anchor.resized());
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [anchor]);
  return anchor;
}
