/**
 * WIKI.md §29.3: the find bar of an open Docs page (⌘F / Ctrl+F). It finds the words in the page as it shows — reading,
 * the 見たまま editor, or the Markdown editor's preview — marks every match and the current one, says 「3 / 12」, and
 * steps with Enter / Shift+Enter (⌘G / ⇧⌘G too) or ↑ ↓. Esc closes it. The page is counted again when it changes
 * (someone's edit coming in, my typing in the editor). See findInPage.ts for why the app needs its own.
 */
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { isImeKeyEvent } from "./ime";
import { findRanges, paintMatches, revealRange, stepIndex } from "./findInPage";
import { cn } from "./primitives";
import { t } from "../i18n";

/** How long the page must be still before the matches are counted again (typing in the editor changes it). */
const RECOUNT_MS = 150;

/**
 * ⌘F / Ctrl+F (⌘G / ⇧⌘G while open) for the page in `section`. A page shown inside another (a row beside its table,
 * `embedded`) takes them only while the focus is in it; the outer page leaves them to it then. Nothing happens under a
 * modal dialog (the rest of the app is hidden from it), and the keys never reach the app's message search.
 */
export function usePageFindKeys(section: React.RefObject<HTMLElement | null>, embedded: boolean, open: boolean, onOpen: () => void, onStep: (step: 1 | -1) => void) {
  const latest = useRef({ open, onOpen, onStep });
  latest.current = { open, onOpen, onStep };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (!mod || event.altKey || (key !== "f" && key !== "g") || (key === "f" && event.shiftKey)) return;
      if (key === "g" && !latest.current.open) return;
      const here = section.current;
      if (!here || here.closest("[aria-hidden='true']")) return;
      const active = document.activeElement;
      if (embedded) {
        if (!active || !here.contains(active)) return;
      } else {
        const inner = active?.closest("[data-doc-page]");
        if (inner && inner !== here && here.contains(inner)) return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (key === "f") latest.current.onOpen();
      else latest.current.onStep(event.shiftKey ? -1 : 1);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [section, embedded]);
}

export interface PageFindHandle {
  focus: () => void;
  step: (step: 1 | -1) => void;
}

export function PageFindBar({ section, onClose, handle, className }: {
  /** The page: its content box (`data-find-root`: reading, the editor, or the Markdown preview) is where to look. */
  section: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  handle: React.RefObject<PageFindHandle | null>;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(-1);
  const ranges = useRef<Range[]>([]);
  const root = useCallback(() => section.current?.querySelector("[data-find-root]") ?? null, [section]);
  const input = useRef<HTMLInputElement>(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  const show = useCallback((index: number, reveal: boolean) => {
    setCurrent(index);
    const painted = paintMatches(ranges.current, index);
    const range = ranges.current[index];
    if (!range) return;
    if (reveal) revealRange(range);
    if (!painted && reveal) {
      // No highlight API: the current match is shown as the selection (the find box keeps the focus).
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, []);

  /** Counts again; the match shown stays the one at (or the first after) its place. */
  const recount = useCallback((reveal: boolean, fresh = false) => {
    const box = root();
    const before = ranges.current[currentRef.current];
    const next = box ? findRanges(box, query) : [];
    ranges.current = next;
    setCount(next.length);
    if (next.length === 0) {
      paintMatches([], -1);
      setCurrent(-1);
      return;
    }
    let index = 0;
    if (before && !fresh) {
      const at = next.findIndex((r) => {
        try {
          return r.compareBoundaryPoints(Range.START_TO_START, before) >= 0;
        } catch {
          return false;
        }
      });
      index = at < 0 ? 0 : at;
    }
    show(index, reveal);
  }, [root, query, show]);

  // New words: from the first match.
  useEffect(() => {
    recount(true, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // The page changing under the bar (an edit, the mode switched, a toggle opened): counted again once it is still. The
  // whole page is watched, since switching between reading and editing replaces the content box; the bar's own changes
  // (its count) are not the page's.
  useEffect(() => {
    const box = section.current;
    if (!box || typeof MutationObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver((records) => {
      const page = records.some((r) => {
        const element = r.target instanceof Element ? r.target : r.target.parentElement;
        return !element?.closest("[data-find-skip]");
      });
      if (!page) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => recount(false), RECOUNT_MS);
    });
    observer.observe(box, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["open", "hidden", "class"] });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [section, recount]);

  // Closed: nothing stays marked.
  useEffect(() => () => { paintMatches([], -1); }, []);

  const step = useCallback((by: 1 | -1) => {
    if (ranges.current.length === 0) return;
    show(stepIndex(currentRef.current, ranges.current.length, by), true);
  }, [show]);

  handle.current = {
    focus: () => {
      input.current?.focus();
      input.current?.select();
    },
    step,
  };

  useEffect(() => {
    input.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Escape") {
      // Closes the bar only; the screen's own Esc waits for the next one.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const label = !query.trim() ? "" : count === 0 ? t("docs.find.noMatch") : t("docs.find.count", { n: current + 1, total: count });
  return (
    <div role="search" aria-label={t("docs.find.inPage")} data-find-skip="" className={cn("flex h-9 items-center gap-1 rounded-lg border border-line bg-canvas px-2 shadow-lg", className)}>
      <Search size={14} className="shrink-0 text-muted" />
      <input
        ref={input}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("docs.find.inPage")}
        aria-label={t("docs.find.inPage")}
        className="h-full w-44 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-muted"
      />
      <span className={cn("shrink-0 text-xs tabular-nums", query.trim() && count === 0 ? "text-danger" : "text-muted")} aria-live="polite" data-find-count="">{label}</span>
      <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-ink/6 hover:text-ink disabled:opacity-40" aria-label={t("docs.find.prev")} title={t("docs.find.prev")} disabled={count === 0} onClick={() => step(-1)}><ChevronUp size={14} /></button>
      <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-ink/6 hover:text-ink disabled:opacity-40" aria-label={t("docs.find.next")} title={t("docs.find.next")} disabled={count === 0} onClick={() => step(1)}><ChevronDown size={14} /></button>
      <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-ink/6 hover:text-ink" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}><X size={14} /></button>
    </div>
  );
}
