import { Flag, Link } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AdminReportOut } from "../api/types";
import type { AppController } from "../state/app";
import { fullTimestamp } from "./format";
import { REPORT_REASONS } from "./ModerationDialogs";
import { Badge, Button, cn } from "./primitives";
import { t, labelled } from "../i18n";

type Filter = "open" | "resolved" | "all";

const FILTERS: ReadonlyArray<[Filter, string]> = [
  labelled("open", "reports.open"),
  labelled("resolved", "activity.done"),
  labelled("all", "admin.users.filter.all"),
];

export function reportReasonLabel(reason: string): string {
  return REPORT_REASONS.find((item) => item.value === reason)?.label ?? reason;
}

/**
 * Administration → 報告 (M104, docs/MODERATION.md §3): reported messages, newest first, with the body as it was when
 * reported; 「対応済みにする」 / 「未対応に戻す」. The moderation bot's DM tells the administrators of each new one.
 */
export function ReportsTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const [filter, setFilter] = useState<Filter>("open");
  const [reports, setReports] = useState<AdminReportOut[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!controller.api) return;
    try {
      setReports(await controller.api.adminListReports(filter));
    } catch (error) {
      controller.setError(error);
    }
  }, [controller, filter]);
  useEffect(() => { void load(); }, [load]);
  const setStatus = async (report: AdminReportOut, resolved: boolean) => {
    if (!controller.api) return;
    setBusy(true);
    try {
      if (resolved) await controller.api.adminResolveReport(report.id);
      else await controller.api.adminReopenReport(report.id);
      await load();
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };
  const name = (id: string | null) => (id ? store.users.get(id)?.display_name : undefined) ?? t("common.unknownUser");
  const where = (report: AdminReportOut) => (report.channel_name ? `#${report.channel_name}` : report.channel_type === "group_dm" ? t("common.groupDm") : "DM");
  return (
    <div className="space-y-3 py-3">
      <div className="flex gap-1" role="radiogroup" aria-label={t("activity.show")}>
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={filter === value}
            onClick={() => setFilter(value)}
            className={cn("rounded-full px-3 py-1 text-xs", filter === value ? "bg-accent-soft text-ink" : "text-muted hover:bg-panel")}
          >
            {label}
          </button>
        ))}
      </div>
      {reports === null ? (
        <p className="text-sm text-muted">{t("common.loading")}</p>
      ) : reports.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted"><Flag size={14} /> {filter === "open" ? t("reports.noneOpen") : t("reports.none")}</p>
      ) : (
        <ul aria-label={t("admin.tab.reports")} className="space-y-2">
          {reports.map((report) => (
            <li key={report.id} data-report={report.id} className="space-y-1.5 rounded-xl border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={report.status === "open" ? "danger" : "neutral"}>{report.status === "open" ? t("reports.open") : t("activity.done")}</Badge>
                <span className="font-medium">{reportReasonLabel(report.reason)}</span>
                <span className="text-xs text-muted">{fullTimestamp(report.created_at)} · {where(report)}</span>
              </div>
              <div className="text-xs text-muted">
                {t("reports.author")}<span className="text-ink">{name(report.reported_user_id)}</span> · {t("reports.reporter")}<span className="text-ink">{name(report.reporter_id)}</span>
              </div>
              <blockquote className="whitespace-pre-wrap break-words rounded-lg bg-panel px-3 py-2 text-[13px]">
                {report.body_snapshot || t("drafts.noText")}
                {report.message_deleted && <span className="mt-1 block text-xs text-muted">{t("reports.deletedSince")}</span>}
              </blockquote>
              {report.note && <p className="text-xs text-muted">{t("reports.note", { note: report.note })}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                {report.message_id && !report.message_deleted && (
                  <Button size="sm" variant="ghost" onClick={() => { if (report.message_id) void controller.copyPermalink(report.message_id); }}>
                    <Link size={13} /> {t("canvas.copyLink")}
                  </Button>
                )}
                <Button size="sm" variant={report.status === "open" ? "primary" : "secondary"} disabled={busy} onClick={() => void setStatus(report, report.status === "open")}>
                  {report.status === "open" ? t("reports.resolve") : t("reports.reopen")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
