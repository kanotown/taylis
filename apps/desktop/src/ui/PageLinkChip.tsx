/**
 * M121 (WIKI.md §2.3, §9.3): a link to a Docs page inside a body — `[label](page:<uuid>)` in a page or canvas, or the
 * permalink `<server>/p/<uuid>` anywhere. It shows the page's current icon and title (the label is only what was typed
 * then): from the tree, else asked of the server (`POST /wiki/pages/resolve`). A page I cannot read (or that is gone)
 * is 「アクセスできないページ」, never its title. `[name](attachment:<uuid>)` is a file of the page: a chip that downloads it.
 */
import { FileLock2, Paperclip } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import { PageIcon } from "./PageIcon";
import { cn } from "./primitives";
import { t } from "../i18n";

const CHIP = "inline-flex max-w-full items-center gap-1 rounded-md px-1 align-baseline leading-6";

export function PageLinkChip({ controller, pageId, label }: { controller: AppController; pageId: string; label?: string }) {
  const hub = controller.engine?.wiki ?? null;
  useSyncExternalStore((listener) => hub?.subscribe(listener) ?? (() => {}), () => hub?.version ?? 0);
  const ref = hub ? hub.resolve(pageId) : null;
  if (ref === null) {
    return (
      <span data-page-link={pageId} data-readable="false" className={cn(CHIP, "bg-panel text-muted")} title={t("docs.unreadablePageHint")}>
        <FileLock2 size={13} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{t("docs.unreadablePage")}</span>
      </span>
    );
  }
  const title = ref ? ref.title || t("docs.untitled") : label || t("docs.untitled");
  return (
    <button
      type="button"
      data-page-link={pageId}
      data-readable={ref ? "true" : "unknown"}
      className={cn(CHIP, "bg-accent-soft/40 font-medium text-accent hover:bg-accent-soft hover:underline")}
      onClick={(event) => {
        event.stopPropagation();
        controller.requestOpenPage(pageId);
      }}
    >
      <PageIcon controller={controller} icon={ref?.icon} size={13} className={ref?.icon ? undefined : "text-accent"} />
      <span className="truncate">{title}</span>
    </button>
  );
}

export function FileLinkChip({ controller, attachmentId, label }: { controller: AppController; attachmentId: string; label?: string }) {
  const [meta, setMeta] = useState<AttachmentOut | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void controller.attachmentMeta(attachmentId).then((found) => { if (live) setMeta(found); });
    return () => { live = false; };
  }, [controller, attachmentId]);
  const name = label || meta?.filename || t("docs.file");
  if (meta === null) {
    return (
      <span data-file-link={attachmentId} className={cn(CHIP, "bg-panel text-muted")}>
        <Paperclip size={13} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{t("docs.fileUnavailable", { name })}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-file-link={attachmentId}
      className={cn(CHIP, "border border-line bg-panel text-ink hover:bg-accent-soft/40")}
      title={t("docs.downloadFile")}
      disabled={!meta}
      onClick={(event) => {
        event.stopPropagation();
        if (meta) void controller.downloadAttachment(meta);
      }}
    >
      <Paperclip size={13} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="truncate">{name}</span>
    </button>
  );
}
