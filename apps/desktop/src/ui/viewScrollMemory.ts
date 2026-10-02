import { type RefObject, useEffect } from "react";

import { anchorCorrection, BOTTOM_SLACK_PX, firstRowBelow } from "./scrollAnchor";
import { restoreDecision, type SavedPosition, type ScrollMemory } from "./scrollMemory";

/**
 * M75: the DOM side of scrollMemory.ts for the centre views (threads, saved, activity, search results, files …). The
 * view's list is the element marked `data-scroll-memory` under `root`; its rows carry `data-row-key` (or are message rows
 * with an id). The topmost row on screen is recorded on every scroll; when the place comes back through back / forward,
 * that row is put back at its offset once the view has drawn it (the lists load after they mount). A list without keyed
 * rows gets its scrollTop back instead.
 */

export const SCROLL_MEMORY_ATTR = "data-scroll-memory";
const ROW_SELECTOR = "[data-row-key], article[id]";
/** How long a view may take to draw the row it comes back to (its list loading). */
export const RESTORE_WAIT_MS = 3000;
/** After that row is placed, rows still growing above it (images, cards) keep it in place this long. */
const SETTLE_MS = 1500;

const keyOf = (row: HTMLElement) => row.dataset["rowKey"] ?? row.id;

/** The topmost row on screen in `scroller` and the position to save. */
export function capturePosition(scroller: HTMLElement): SavedPosition {
  const rows = scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR);
  const viewTop = scroller.getBoundingClientRect().top;
  const index = firstRowBelow(rows.length, (i) => rows[i]!.getBoundingClientRect().bottom, viewTop);
  const row = index < 0 ? null : rows[index]!;
  const key = row ? keyOf(row) : "";
  return {
    rowKey: key || null,
    offset: row ? row.getBoundingClientRect().top - viewTop : 0,
    scrollTop: scroller.scrollTop,
    atBottom: false, // a view comes back at its row even at its end (its list may have grown meanwhile)
  };
}

function findRow(scroller: HTMLElement, key: string): HTMLElement | null {
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) if (keyOf(row) === key) return row;
  return null;
}

/**
 * Records the position of the view's list under `root` for `key` (null: nothing to record, a conversation is on
 * screen), and puts it back when `restore` says the place came back (read once, when the key changes).
 */
export function useViewScrollMemory(root: RefObject<HTMLElement | null>, memory: ScrollMemory, key: string | null, restore: () => boolean): void {
  useEffect(() => {
    const host = root.current;
    if (!host || !key) return;
    const decision = restoreDecision(memory.get(key), { explicit: false, requested: restore() });
    let pending = decision.kind === "anchor" || decision.kind === "scrollTop";
    const deadline = Date.now() + RESTORE_WAIT_MS;
    let placedAt = 0;
    const scroller = () => host.querySelector<HTMLElement>(`[${SCROLL_MEMORY_ATTR}]`);

    /** One try: true once the row is where it was (or the scrollTop fits). */
    const place = (): boolean => {
      const el = scroller();
      if (!el) return false;
      if (decision.kind === "anchor") {
        const row = findRow(el, decision.rowKey);
        if (!row) return false;
        const delta = anchorCorrection(decision.offset, row.getBoundingClientRect().top - el.getBoundingClientRect().top);
        if (delta !== 0) el.scrollTop += delta;
        return true;
      }
      if (decision.kind === "scrollTop") {
        if (el.scrollHeight - el.clientHeight + BOTTOM_SLACK_PX < decision.scrollTop) return false;
        el.scrollTop = decision.scrollTop;
        return true;
      }
      return false;
    };
    const attempt = () => {
      if (!pending) return;
      const now = Date.now();
      if (now > deadline && placedAt === 0) {
        pending = false;
        return;
      }
      if (placedAt !== 0 && now - placedAt > SETTLE_MS) {
        pending = false;
        return;
      }
      if (place() && placedAt === 0) placedAt = now;
    };
    const stop = () => {
      // The reader's own input: the place is theirs from here.
      pending = false;
    };
    const record = () => {
      if (pending) {
        attempt();
        return;
      }
      const el = scroller();
      if (el) memory.save(key, capturePosition(el));
    };
    attempt();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => attempt());
    observer?.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "style", "class"] });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => attempt());
    const observeScroller = () => {
      const el = scroller();
      if (el && resize) {
        resize.observe(el);
        if (el.firstElementChild) resize.observe(el.firstElementChild);
      }
    };
    observeScroller();
    const timer = setTimeout(() => {
      pending = false;
    }, RESTORE_WAIT_MS + SETTLE_MS);
    const inputs = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const name of inputs) host.addEventListener(name, stop, { passive: true, capture: true });
    // A scroll does not bubble; caught on the way down.
    host.addEventListener("scroll", record, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      resize?.disconnect();
      for (const name of inputs) host.removeEventListener(name, stop, { capture: true });
      host.removeEventListener("scroll", record, { capture: true });
    };
    // `restore` is read once per key, when the place comes on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, memory]);
}
