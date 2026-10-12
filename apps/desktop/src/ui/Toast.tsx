import { AlertCircle, CheckCircle2, Download, ExternalLink, FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { AppController, DownloadItem } from "../state/app";
import { formatSize } from "./Attachments";
import { FileName } from "./FileName";
import { t } from "../i18n";

/** Transient error banner for actions that fail after login (edit, upload, settings…). */
export function Toast({ controller }: { controller: AppController }) {
  const message = controller.error;
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => controller.setError(null), 6000);
    return () => clearTimeout(timer);
  }, [message, controller]);
  if (!message) return null;
  return (
    <div
      role="alert"
      className="fixed bottom-6 left-1/2 z-[60] flex max-w-[80vw] -translate-x-1/2 items-center gap-3 rounded-xl border border-danger/40 bg-canvas px-4 py-3 text-sm text-ink shadow-2xl"
    >
      <AlertCircle size={18} className="shrink-0 text-danger" />
      <span>{message}</span>
      <button type="button" className="rounded-md p-1 text-muted hover:bg-ink/6 hover:text-ink" onClick={() => controller.setError(null)} aria-label={t("common.close")}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Short confirmation (M12b 「リンクをコピーしました」); disappears by itself. */
export function NoticeToast({ controller }: { controller: AppController }) {
  const message = controller.notice;
  const action = controller.noticeAction;
  useEffect(() => {
    if (!message) return;
    // M141: one with a button (「元に戻す」) stays a little longer, so there is time to press it.
    const timer = setTimeout(() => controller.setNotice(null), action ? 6000 : 2500);
    return () => clearTimeout(timer);
  }, [message, action, controller]);
  if (!message) return null;
  return (
    <div role="status" className="fixed bottom-6 left-1/2 z-[60] flex max-w-[80vw] -translate-x-1/2 items-center gap-2 rounded-xl border border-line bg-canvas px-4 py-2.5 text-sm text-ink shadow-2xl">
      <CheckCircle2 size={16} className="shrink-0 text-success" />
      <span>{message}</span>
      {action && (
        <button
          type="button"
          className="ml-2 rounded-md px-2 py-0.5 font-medium text-accent hover:bg-accent-soft"
          onClick={() => {
            controller.setNotice(null);
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** How long a finished download's toast stays (longer than a notice: it has buttons), unless the pointer is on it. */
export const DOWNLOAD_TOAST_MS = 8000;

/**
 * Downloads (docs/PREVIEWS.md §9), bottom right, newest at the bottom: a bar while the bytes come in (with the size so
 * far and the percentage when the total is known), then 「ダウンロードしました：名前」 with 「開く」 and 「フォルダを開く」 in
 * the desktop app (the browser keeps its own download list, so there it is just the line). Clickable over the viewers
 * (`data-download-toasts`: they keep a click here from closing them).
 */
export function DownloadToasts({ controller }: { controller: AppController }) {
  const items = controller.downloads;
  if (!items || items.length === 0) return null;
  return (
    <div data-download-toasts="" className="pointer-events-auto fixed bottom-6 right-6 z-[60] flex w-80 max-w-[calc(100vw-3rem)] flex-col gap-2">
      {items.map((item) => <DownloadToast key={item.id} controller={controller} item={item} />)}
    </div>
  );
}

function DownloadToast({ controller, item }: { controller: AppController; item: DownloadItem }) {
  const [hovered, setHovered] = useState(false);
  const done = item.state === "done";
  useEffect(() => {
    if (!done || hovered) return;
    const timer = setTimeout(() => controller.dismissDownload(item.id), DOWNLOAD_TOAST_MS);
    return () => clearTimeout(timer);
  }, [done, hovered, controller, item.id]);
  const percent = item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : null;
  const button = "inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs font-medium hover:bg-panel";
  return (
    <div
      role="status"
      data-download={item.state}
      className="rounded-xl border border-line bg-canvas px-3.5 py-3 text-sm text-ink shadow-2xl"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div className="flex items-start gap-2.5">
        {done ? <CheckCircle2 size={18} className="mt-px shrink-0 text-success" /> : <Download size={18} className="mt-px shrink-0 animate-pulse text-accent" />}
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">{done ? t("download.done") : t("download.downloading")}</div>
          <FileName name={item.filename} className="font-medium" />
        </div>
        <button type="button" className="-mr-1 -mt-0.5 rounded-md p-1 text-muted hover:bg-ink/6 hover:text-ink" onClick={() => controller.dismissDownload(item.id)} aria-label={t("common.close")}>
          <X size={14} />
        </button>
      </div>
      {!done && (
        <div className="mt-2 pl-[28px]">
          <div
            role="progressbar"
            aria-label={t("download.progress", { name: item.filename })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-1.5 overflow-hidden rounded-full bg-ink/10"
          >
            <div
              className={percent === null ? "h-full w-1/3 animate-pulse rounded-full bg-accent" : "h-full rounded-full bg-accent transition-[width] duration-150"}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] tabular-nums text-muted">
            {item.total > 0 ? `${formatSize(item.loaded)} / ${formatSize(item.total)} · ${percent}%` : formatSize(item.loaded)}
          </div>
        </div>
      )}
      {done && item.path && (
        <div className="mt-2 flex gap-1.5 pl-[28px]">
          {item.openable && (
            <button type="button" className={button} onClick={() => { controller.dismissDownload(item.id); void controller.openDownload(item); }}>
              <ExternalLink size={12} /> {t("download.open")}
            </button>
          )}
          <button type="button" className={button} onClick={() => { controller.dismissDownload(item.id); void controller.revealDownload(item); }}>
            <FolderOpen size={12} /> {t("download.reveal")}
          </button>
        </div>
      )}
    </div>
  );
}
