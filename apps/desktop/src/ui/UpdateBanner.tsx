import { Download } from "lucide-react";
import { useSyncExternalStore } from "react";

import type { AppController } from "../state/app";
import { notesFirstLine, type UpdateChecker, versionLabel } from "../state/updates";
import { Button } from "./primitives";
import { t } from "../i18n";

/** Re-render when the update state changes (found, put off, downloading …). */
export function useUpdates(updates: UpdateChecker): UpdateChecker {
  useSyncExternalStore((listener) => updates.subscribe(listener), () => updates.version);
  return updates;
}

/** 「12.3 / 48.0 MB」, or the bytes so far when the size is unknown. */
export function progressLabel(progress: { downloaded: number; total: number | null } | null): string {
  if (!progress) return "";
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return progress.total ? `${mb(progress.downloaded)} / ${mb(progress.total)} MB` : `${mb(progress.downloaded)} MB`;
}

/** The share of the download done (0–100), null while the size is unknown. */
export function progressPercent(progress: { downloaded: number; total: number | null } | null): number | null {
  if (!progress?.total) return null;
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
}

/**
 * The desktop app's 「新しい版があります」 card in the bottom-right corner: the version, the notes' first line,
 * 「更新して再起動」 (with a progress bar while it downloads) and 「あとで」 (hidden until the next start).
 */
export function UpdateBanner({ controller }: { controller: AppController }) {
  const updates = useUpdates(controller.updates);
  const update = updates.available;
  if (!updates.enabled || !update || !updates.bannerVisible) return null;
  const busy = updates.installInProgress || updates.status === "downloading" || updates.status === "installing";
  const note = notesFirstLine(update.body);
  const percent = progressPercent(updates.progress);
  return (
    <div role="status" aria-label={t("update.label")} className="fixed bottom-6 right-6 z-40 w-[340px] max-w-[calc(100vw-32px)] rounded-xl border border-line bg-canvas p-4 text-sm text-ink shadow-2xl">
      <div className="flex items-start gap-3">
        <Download size={18} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{t("settings.about.available", { version: versionLabel(update.version) })}</div>
          {note && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{note}</div>}
        </div>
      </div>
      {busy ? (
        <div className="mt-3 space-y-1.5">
          <div
            role="progressbar"
            aria-label={t("attach.download")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-1.5 overflow-hidden rounded-full bg-panel-2"
          >
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${updates.status === "installing" ? 100 : (percent ?? 5)}%` }} />
          </div>
          <div className="text-xs text-muted">{updates.status === "installing" ? t("update.installing") : t("update.downloading", { progress: progressLabel(updates.progress) })}</div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => updates.later()}>{t("common.later")}</Button>
          <Button size="sm" onClick={() => void updates.install(() => controller.prepareForRestart())}>{t("settings.about.restart")}</Button>
        </div>
      )}
    </div>
  );
}
