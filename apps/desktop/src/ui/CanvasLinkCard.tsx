/**
 * M44 (CANVAS.md §4.13): a `<server>/c/<id>` link in a message (a canvas shared to its conversation, or pasted) shown as a
 * card: the title, its conversation, who changed it last and the task progress. A click opens the canvas in its
 * conversation. Someone outside that conversation sees 「メンバーではありません」 and nothing of the canvas (the server
 * answers 403); a canvas in the trash or gone 「表示できないキャンバス」.
 */
import { FileText, Lock, TriangleAlert } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { AppController, CanvasLinkState } from "../state/app";
import { sinceLabel } from "./format";
import { channelTitle } from "./MainScreen";
import { cn } from "./primitives";
import { t } from "../i18n";

export function CanvasLinkCard({ controller, canvasId, url }: { controller: AppController; canvasId: string; url: string }) {
  const store = controller.store;
  // The store's copy (kept current by canvas.* events) wins over the one fetched for the card.
  useSyncExternalStore((listener) => store.subscribe(listener), () => store.version);
  const live = store.canvasMeta(canvasId);
  const [link, setLink] = useState<CanvasLinkState | null>(live ? { state: "ok", canvas: live } : null);
  useEffect(() => {
    if (live) return;
    let current = true;
    void controller.canvasLink(canvasId).then((state) => {
      if (current) setLink(state);
    });
    return () => {
      current = false;
    };
  }, [controller, canvasId, !!live]); // eslint-disable-line react-hooks/exhaustive-deps

  const shell = "my-1 flex w-full max-w-md items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5 text-left align-top";
  const canvas = live ?? (link?.state === "ok" ? link.canvas : null);
  if (canvas) {
    const channel = store.getChannel(canvas.channel_id);
    const where = channel ? channelTitle(channel, controller) : t("ask.conversation");
    const who = store.users.get(canvas.updated_by)?.display_name ?? t("common.member");
    const done = canvas.task_total > 0 ? Math.round((canvas.task_done / canvas.task_total) * 100) : null;
    return (
      <button type="button" data-canvas-card={canvasId} title={url} className={cn(shell, "transition-colors hover:border-accent/50 hover:bg-accent-soft/40")} onClick={() => void controller.openCanvasLink(canvasId)}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><FileText size={18} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{canvas.title}</span>
          <span className="block truncate text-xs text-muted">{where} · {t("main.tab.canvas")} · {t("canvasCard.updated", { who, when: sinceLabel(canvas.updated_at) })}</span>
          {done !== null && (
            <span className="mt-1 flex items-center gap-2 text-[11px] text-muted" aria-label={t("canvases.tasks", { progress: `${canvas.task_done}/${canvas.task_total}` })}>
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                <span className="block h-full rounded-full bg-success" style={{ width: `${done}%` }} />
              </span>
              {canvas.task_done}/{canvas.task_total}
            </span>
          )}
        </span>
      </button>
    );
  }
  if (!link) {
    return (
      <span data-canvas-card={canvasId} className={cn(shell, "text-sm text-muted")}>
        <FileText size={18} className="shrink-0" /> {t("canvasCard.loading")}
      </span>
    );
  }
  if (link.state === "forbidden") {
    return (
      <span data-canvas-card={canvasId} className={cn(shell, "text-sm")}>
        <Lock size={18} className="shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="block font-medium">{t("canvasCard.notMember")}</span>
          <span className="block text-xs text-muted">{t("canvasCard.notMemberNote")}</span>
        </span>
      </span>
    );
  }
  return (
    <button type="button" data-canvas-card={canvasId} title={url} className={cn(shell, "text-sm")} onClick={() => void controller.openCanvasLink(canvasId)}>
      <TriangleAlert size={18} className="shrink-0 text-muted" />
      <span className="min-w-0">
        <span className="block font-medium">{t("canvasCard.unavailable")}</span>
        <span className="block text-xs text-muted">{link.state === "missing" ? t("canvasCard.missing") : t("canvasCard.failed")}</span>
      </span>
    </button>
  );
}
