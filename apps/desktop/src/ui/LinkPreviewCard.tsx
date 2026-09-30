import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { openExternalLink } from "../platform/external";
import type { AppController } from "../state/app";

/**
 * Open Graph card under a message for its first link (M11g); nothing while loading or when the page had no data.
 * The timeline renders every row it holds, so the preview is asked for only once the row comes within a screen of the
 * viewport: 「最初の未読へ」 can add 800 rows at once, and asking for all of them hits the server's rate limit (429),
 * after which no card shows for the rest of the session (SYNC_PROTOCOL.md §10.1 6.).
 */
export function LinkPreviewCard({ controller, url }: { controller: AppController; url: string }) {
  // Its own subscription (M21): the rows are memoized, and a preview arriving re-renders only the cards.
  const subscribe = useCallback((listener: () => void) => controller.subscribeLinkPreviews(listener), [controller]);
  // undefined: not fetched yet; null: the page had no preview.
  const preview = useSyncExternalStore(subscribe, () => controller.linkPreviews.get(url));
  const probe = useRef<HTMLSpanElement>(null);
  const known = preview !== undefined;
  useEffect(() => {
    const element = probe.current;
    if (known || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      controller.linkPreview(url);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      controller.linkPreview(url);
    }, { root: scrollParent(element), rootMargin: "100% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [url, known]);
  if (!known) return <span ref={probe} aria-hidden className="block h-0" />;
  if (!preview) return null;
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => openExternalLink(event, preview.url)}
      // A plain outlined card, the site first (tester, 2026-09-30: the accent bar at the left looked "AI-like").
      className="mt-1.5 flex max-w-xl gap-3 rounded-lg border border-line px-3 py-2.5 text-sm no-underline transition-colors hover:bg-panel"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-muted">{preview.site_name || hostOf(preview.url)}</div>
        {preview.title && <div className="mt-0.5 line-clamp-2 font-semibold text-ink">{preview.title}</div>}
        {preview.description && <div className="mt-0.5 line-clamp-2 text-[13px] text-muted">{preview.description}</div>}
      </div>
      {preview.image_url && <img src={preview.image_url} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-md object-cover" />}
    </a>
  );
}

/** The link's host without "www.", for a page that names no site. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The nearest scrolling ancestor: the observer's root, so its margin reaches rows just outside the scroller's view. */
export function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}
