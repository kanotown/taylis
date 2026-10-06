import { Flag, Link } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AdminReportOut } from "../api/types";
import type { AppController } from "../state/app";
import { fullTimestamp } from "./format";
import { REPORT_CATEGORIES, REPORT_REASONS } from "./ModerationDialogs";
import { Badge, Button, cn } from "./primitives";
import { t, labelled } from "../i18n";

type Filter = "open" | "resolved" | "all";
type KindFilter = "all" | AdminReportOut["kind"];

const FILTERS: ReadonlyArray<[Filter, string]> = [
  labelled("open", "reports.open"),
  labelled("resolved", "activity.done"),
  labelled("all", "admin.users.filter.all"),
];

const KIND_FILTERS: ReadonlyArray<[KindFilter, string]> = [
  labelled("all", "admin.users.filter.all"),
  labelled("message", "reports.kind.message"),
  labelled("user", "reports.kind.user"),
  labelled("general", "reports.kind.general"),
];

export function reportReasonLabel(reason: string): string {
  return (REPORT_REASONS.find((item) => item.value === reason) ?? REPORT_CATEGORIES.find((item) => item.value === reason))?.label ?? reason;
}

export function reportKindLabel(kind: AdminReportOut["kind"]): string {
  return kind === "user" ? t("reports.kind.user") : kind === "general" ? t("reports.kind.general") : t("reports.kind.message");
}

/** A row from a server before M119 has no `kind`: it is a message report. */
function kindOf(report: AdminReportOut): AdminReportOut["kind"] {
  return report.kind ?? "message";
}

/**
 * Administration → 報告 (M104, docs/MODERATION.md §3; M119 §3.1): reports newest first, of messages (with the body as it
 * was when reported), of people, and general reports / feedback (the reporter's text is the content);
 * 「対応済みにする」 / 「未対応に戻す」. The moderation bot's DM tells the administrators of each new one.
 */
export function ReportsTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const [filter, setFilter] = useState<Filter>("open");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
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
  const shown = reports?.filter((report) => kindFilter === "all" || kindOf(report) === kindFilter) ?? null;
  const chips = <T extends string>(items: ReadonlyArray<[T, string]>, value: T, onChange: (next: T) => void, label: string, className?: string) => (
    <div className={cn("flex flex-wrap gap-1", className)} role="radiogroup" aria-label={label}>
      {items.map(([item, text]) => (
        <button
          key={item}
          type="button"
          role="radio"
          aria-checked={value === item}
          onClick={() => onChange(item)}
          className={cn("rounded-full px-3 py-1 text-xs", value === item ? "bg-accent-soft text-ink" : "text-muted hover:bg-panel")}
        >
          {text}
        </button>
      ))}
    </div>
  );
  return (
    <div className="space-y-3 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {chips(FILTERS, filter, setFilter, t("activity.show"))}
        {chips(KIND_FILTERS, kindFilter, setKindFilter, t("reports.kindFilter"), "border-l border-line pl-3")}
      </div>
      {shown === null ? (
        <p className="text-sm text-muted">{t("common.loading")}</p>
      ) : shown.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted"><Flag size={14} /> {filter === "open" ? t("reports.noneOpen") : t("reports.none")}</p>
      ) : (
        <ul aria-label={t("admin.tab.reports")} className="space-y-2">
          {shown.map((report) => {
            const kind = kindOf(report);
            const childSafety = report.reason === "child_safety";
            return (
              <li key={report.id} data-report={report.id} data-kind={kind} className={cn("space-y-1.5 rounded-xl border p-3 text-sm", childSafety ? "border-danger/60 bg-danger/5" : "border-line")}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={report.status === "open" ? "danger" : "neutral"}>{report.status === "open" ? t("reports.open") : t("activity.done")}</Badge>
                  <Badge tone="accent">{reportKindLabel(kind)}</Badge>
                  <span className={cn("font-medium", childSafety && "text-danger")}>{childSafety ? `⚠️ ${reportReasonLabel(report.reason)}` : reportReasonLabel(report.reason)}</span>
                  <span className="text-xs text-muted">{fullTimestamp(report.created_at)}{kind === "message" ? ` · ${where(report)}` : ""}</span>
                </div>
                <div className="text-xs text-muted">
                  {kind === "message" && <>{t("reports.author")}<span className="text-ink">{name(report.reported_user_id)}</span> · </>}
                  {kind === "user" && <>{t("reports.target")}<span className="text-ink">{name(report.reported_user_id)}</span> · </>}
                  {t("reports.reporter")}<span className="text-ink">{name(report.reporter_id)}</span>
                </div>
                {kind === "message" ? (
                  <>
                    <blockquote className="whitespace-pre-wrap break-words rounded-lg bg-panel px-3 py-2 text-[13px]">
                      {report.body_snapshot || t("drafts.noText")}
                      {report.message_deleted && <span className="mt-1 block text-xs text-muted">{t("reports.deletedSince")}</span>}
                    </blockquote>
                    {report.note && <p className="text-xs text-muted">{t("reports.note", { note: report.note })}</p>}
                  </>
                ) : (
                  <p className="whitespace-pre-wrap break-words rounded-lg bg-panel px-3 py-2 text-[13px]" data-testid="report-note">{report.note || t("drafts.noText")}</p>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  {kind === "message" && report.message_id && !report.message_deleted && (
                    <Button size="sm" variant="ghost" onClick={() => { if (report.message_id) void controller.copyPermalink(report.message_id); }}>
                      <Link size={13} /> {t("canvas.copyLink")}
                    </Button>
                  )}
                  <Button size="sm" variant={report.status === "open" ? "primary" : "secondary"} disabled={busy} onClick={() => void setStatus(report, report.status === "open")}>
                    {report.status === "open" ? t("reports.resolve") : t("reports.reopen")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
