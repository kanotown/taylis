import { useEffect } from "react";

import type { AppController } from "../state/app";

/** Open Graph card under a message for its first link (M11g); nothing while loading or when the page had no data. */
export function LinkPreviewCard({ controller, url }: { controller: AppController; url: string }) {
  const preview = controller.linkPreview(url);
  useEffect(() => {
    if (preview === undefined) controller.linkPreview(url);
  }, [url]);
  if (!preview) return null;
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noreferrer noopener"
      className="mt-1.5 flex max-w-xl gap-3 rounded-lg border border-line border-l-[3px] border-l-accent/60 bg-panel px-3 py-2 text-sm no-underline transition-colors hover:bg-panel-2"
    >
      <div className="min-w-0 flex-1">
        {preview.site_name && <div className="truncate text-[11px] font-medium uppercase tracking-wide text-muted">{preview.site_name}</div>}
        {preview.title && <div className="line-clamp-2 font-semibold text-ink">{preview.title}</div>}
        {preview.description && <div className="mt-0.5 line-clamp-3 text-[13px] text-muted">{preview.description}</div>}
      </div>
      {preview.image_url && <img src={preview.image_url} alt="" loading="lazy" className="h-20 w-20 shrink-0 rounded-md object-cover" />}
    </a>
  );
}
