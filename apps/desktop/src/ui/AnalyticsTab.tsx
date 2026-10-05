import { ArrowDown, ArrowUp, Download, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiError } from "../api/errors";
import type { AnalyticsMemberOut, AnalyticsMemberSort, AnalyticsMembersOut, AnalyticsMembersQuery, AnalyticsOverviewOut } from "../api/types";
import { saveDownload } from "../platform/download";
import type { AppController } from "../state/app";
import { t } from "../i18n";
import { absoluteTime, barLayout, barPath, csvFilename, dayLabel, deviceTimeZone, INACTIVE_CHOICES, MEMBER_COLUMNS, nextSort, PAGE_SIZE, type Period, PERIODS, platformLabel, relativeTime } from "./analytics";
import { group3 } from "./format";
import { Badge, Button, cn, Input } from "./primitives";

const SELECT = "h-9 rounded-lg border border-line bg-canvas px-2 text-sm";

/**
 * 管理 →「アナリティクス」 (M116, docs/ANALYTICS.md §6): summary cards, two daily bar charts (inline SVG), the busiest
 * channels and posters, and the members table (sort, 「利用なし N 日以上」, search, CSV) with the last sign-in and the last
 * activity (relative, the full time on hover). Counts and times only: never a message's text.
 */
export function AnalyticsTab({ controller }: { controller: AppController }) {
  const [days, setDays] = useState<Period>(30);
  const [overview, setOverview] = useState<AnalyticsOverviewOut | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!controller.api) return;
    let live = true;
    controller.api
      .adminAnalyticsOverview(days, deviceTimeZone())
      .then((out) => { if (live) setOverview(out); })
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) setUnsupported(true);
        else controller.setError(error);
      });
    return () => { live = false; };
  }, [controller.api, days, reload]);

  if (unsupported) {
    return <p className="mt-4 text-sm text-muted">{t("errors.serverTooOld", { feature: t("admin.tab.analytics") })}</p>;
  }
  return (
    <div className="mt-4 space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t("analytics.period")} value={days} onChange={(e) => setDays(Number(e.target.value) as Period)} className={SELECT}>
          {PERIODS.map((value) => <option key={value} value={value}>{t("analytics.period.days", { days: value })}</option>)}
        </select>
        <Button size="sm" variant="ghost" onClick={() => setReload((n) => n + 1)}>
          <RefreshCw size={14} /> {t("analytics.refresh")}
        </Button>
        {overview && <span className="text-xs text-muted" title={overview.tz}>{t("analytics.asOf", { at: absoluteTime(overview.generated_at) })}</span>}
      </div>
      <p className="text-xs text-muted">{t("analytics.privacyNote")}</p>
      {!overview ? (
        <p className="text-sm text-muted">{t("common.loading")}</p>
      ) : (
        <>
          <SummaryCards overview={overview} />
          <div className="grid gap-4 md:grid-cols-2">
            <DailyChart title={t("analytics.chart.messages")} days={overview.series.map((d) => d.date)} values={overview.series.map((d) => d.messages)} />
            <DailyChart title={t("analytics.chart.active")} days={overview.series.map((d) => d.date)} values={overview.series.map((d) => d.active_members)} note={t("analytics.chart.activeNote")} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <TopChannels overview={overview} />
            <TopPosters overview={overview} />
          </div>
        </>
      )}
      <MembersTable controller={controller} reload={reload} />
    </div>
  );
}

function Card({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{group3(value)}</div>
      {note && <div className="mt-0.5 text-[11px] text-muted">{note}</div>}
    </div>
  );
}

function SummaryCards({ overview }: { overview: AnalyticsOverviewOut }) {
  const m = overview.members;
  return (
    <div role="group" aria-label={t("analytics.summary")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <Card label={t("analytics.card.members")} value={m.accounts} note={t("analytics.card.membersNote", { admins: m.admins, guests: m.guests, deactivated: m.deactivated })} />
      <Card label={t("analytics.card.active1d")} value={m.active_1d} />
      <Card label={t("analytics.card.active7d")} value={m.active_7d} />
      <Card label={t("analytics.card.active30d")} value={m.active_30d} note={t("analytics.card.neverSignedIn", { count: m.never_signed_in })} />
      <Card label={t("analytics.card.messages")} value={overview.messages_in_period} />
      <Card label={t("analytics.card.newMembers")} value={m.new_in_period} />
    </div>
  );
}

const CHART_W = 320;
const CHART_H = 96;

/** One series of daily bars: the title names it (no legend), a hover readout, the largest value on the scale. */
function DailyChart({ title, days, values, note }: { title: string; days: string[]; values: number[]; note?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { bars, max } = useMemo(() => barLayout(values, CHART_W, CHART_H, values.length > 45 ? 1 : 2), [values]);
  const slot = values.length ? CHART_W / values.length : 0;
  const readout = hover !== null ? t("analytics.chart.bar", { date: dayLabel(days[hover]), value: group3(values[hover] ?? 0) }) : t("analytics.chart.max", { value: group3(max) });
  return (
    <figure className="rounded-xl border border-line p-3">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs tabular-nums text-muted" aria-live="polite">{readout}</span>
      </figcaption>
      {max === 0 ? (
        <p className="py-8 text-center text-xs text-muted">{t("analytics.chart.empty")}</p>
      ) : (
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H + 1}`} className="mt-2 h-28 w-full text-accent" preserveAspectRatio="none" role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
          {bars.map((bar, index) => (
            <g key={days[index] ?? index} onMouseEnter={() => setHover(index)}>
              {/* The whole slot answers the hover, not only the (maybe tiny) bar. */}
              <rect x={index * slot} y={0} width={slot} height={CHART_H} fill="transparent" />
              {bar.height > 0 && <path d={barPath(bar)} fill="currentColor" opacity={hover === null || hover === index ? 1 : 0.45} />}
              <title>{t("analytics.chart.bar", { date: dayLabel(days[index]), value: group3(bar.value) })}</title>
            </g>
          ))}
          <line x1={0} x2={CHART_W} y1={CHART_H + 0.5} y2={CHART_H + 0.5} stroke="var(--line)" strokeWidth={1} />
        </svg>
      )}
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{dayLabel(days[0])}</span>
        <span>{dayLabel(days[days.length - 1])}</span>
      </div>
      {note && <p className="mt-1 text-[11px] text-muted">{note}</p>}
    </figure>
  );
}

function TopChannels({ overview }: { overview: AnalyticsOverviewOut }) {
  const hidden = overview.other_private_channels;
  const direct = overview.direct_messages;
  return (
    <section className="rounded-xl border border-line p-3">
      <h3 className="text-sm font-medium">{t("analytics.topChannels")}</h3>
      {overview.top_channels.length === 0 ? (
        <p className="mt-2 text-xs text-muted">{t("analytics.noPosts")}</p>
      ) : (
        <table className="mt-2 w-full text-sm" aria-label={t("analytics.topChannels")}>
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 font-normal">{t("analytics.col.channel")}</th>
              <th className="py-1 text-right font-normal">{t("analytics.col.messages")}</th>
              <th className="py-1 text-right font-normal">{t("analytics.col.posters")}</th>
            </tr>
          </thead>
          <tbody>
            {overview.top_channels.map((channel) => (
              <tr key={channel.channel_id} className="border-t border-line">
                <td className="max-w-0 truncate py-1" title={channel.name}>
                  <span className="text-muted">{channel.type === "private" ? "🔒 " : "# "}</span>{channel.name}
                  {channel.archived && <Badge className="ml-1">{t("channel.archived")}</Badge>}
                </td>
                <td className="py-1 text-right tabular-nums">{group3(channel.messages)}</td>
                <td className="py-1 text-right tabular-nums">{group3(channel.posters)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="mt-2 space-y-0.5 text-xs text-muted">
        <div className="flex justify-between gap-2"><dt>{t("analytics.otherPrivate", { count: hidden.conversations })}</dt><dd className="tabular-nums">{t("analytics.messagesCount", { count: group3(hidden.messages) })}</dd></div>
        <div className="flex justify-between gap-2"><dt>{t("analytics.directMessages", { count: direct.conversations })}</dt><dd className="tabular-nums">{t("analytics.messagesCount", { count: group3(direct.messages) })}</dd></div>
      </dl>
      <p className="mt-1 text-[11px] text-muted">{t("analytics.hiddenNote")}</p>
    </section>
  );
}

function TopPosters({ overview }: { overview: AnalyticsOverviewOut }) {
  return (
    <section className="rounded-xl border border-line p-3">
      <h3 className="text-sm font-medium">{t("analytics.topPosters")}</h3>
      {overview.top_posters.length === 0 ? (
        <p className="mt-2 text-xs text-muted">{t("analytics.noPosts")}</p>
      ) : (
        <ol className="mt-2 space-y-0.5 text-sm" aria-label={t("analytics.topPosters")}>
          {overview.top_posters.map((poster, index) => (
            <li key={poster.user_id} className="flex items-baseline gap-2">
              <span className="w-5 text-right text-xs tabular-nums text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate" title={`@${poster.username}`}>{poster.display_name}</span>
              <span className="tabular-nums">{group3(poster.messages)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TimeCell({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-muted">{t("analytics.never")}</span>;
  return <time dateTime={iso} title={absoluteTime(iso)}>{relativeTime(iso)}</time>;
}

function MembersTable({ controller, reload }: { controller: AppController; reload: number }) {
  const [view, setView] = useState<{ sort: AnalyticsMemberSort; order: "asc" | "desc" }>({ sort: "last_active_at", order: "desc" });
  const [inactive, setInactive] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AnalyticsMembersOut | null>(null);
  const [busy, setBusy] = useState(false);

  // The search box waits for a short pause before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query.trim()); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const filters: AnalyticsMembersQuery = { sort: view.sort, order: view.order, inactive_days: inactive ?? undefined, q: search || undefined };
  useEffect(() => {
    if (!controller.api) return;
    let live = true;
    controller.api
      .adminAnalyticsMembers({ ...filters, limit: PAGE_SIZE, offset })
      .then((out) => { if (live) setPage(out); })
      .catch((error: unknown) => { if (live && !(error instanceof ApiError && error.status === 404)) controller.setError(error); });
    return () => { live = false; };
  }, [controller.api, view, inactive, search, offset, reload]);

  const exportCsv = async () => {
    if (!controller.api) return;
    setBusy(true);
    try {
      await saveDownload(csvFilename(), await controller.api.adminAnalyticsMembersCsv(filters));
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  const rows: AnalyticsMemberOut[] = page?.items ?? [];
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t("analytics.members")}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-48">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <Input type="search" value={query} aria-label={t("analytics.search")} placeholder={t("analytics.search")} className="h-9 pl-8" onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select aria-label={t("analytics.inactive")} value={inactive ?? ""} onChange={(e) => { setInactive(e.target.value ? Number(e.target.value) : null); setOffset(0); }} className={cn(SELECT, "max-sm:flex-1")}>
          <option value="">{t("analytics.inactive.any")}</option>
          {INACTIVE_CHOICES.map((value) => <option key={value} value={value}>{t("analytics.inactive.days", { days: value })}</option>)}
        </select>
        <Button size="sm" variant="secondary" disabled={busy || !page} onClick={() => void exportCsv()}>
          <Download size={14} /> {t("analytics.exportCsv")}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[640px] text-sm" aria-label={t("analytics.members")}>
          <thead>
            <tr className="text-left text-xs text-muted">
              {MEMBER_COLUMNS.map((column) => {
                const active = view.sort === column.sort;
                return (
                  <th key={column.sort} scope="col" aria-sort={active ? (view.order === "asc" ? "ascending" : "descending") : "none"} className={cn("px-3 py-2 font-normal", column.sort === "messages_30d" && "text-right")}>
                    <button type="button" className={cn("inline-flex items-center gap-0.5 hover:text-ink", active && "text-ink")} onClick={() => { setView(nextSort(view, column)); setOffset(0); }}>
                      {column.label}
                      {active && (view.order === "asc" ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
                    </button>
                  </th>
                );
              })}
              <th scope="col" className="px-3 py-2 font-normal">{t("analytics.col.devices")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((member) => (
              <tr key={member.id} data-user={member.username} className={cn("border-t border-line", member.status === "deactivated" && "opacity-60")}>
                <td className="max-w-[14rem] px-3 py-1.5">
                  <div className="truncate font-medium" title={member.display_name}>{member.display_name}</div>
                  <div className="truncate text-xs text-muted">@{member.username}</div>
                </td>
                <td className="px-3 py-1.5">{member.role === "admin" ? t("admin.users.role.admin") : member.role === "guest" ? t("dialogs.guest") : t("admin.users.role.member")}</td>
                <td className="px-3 py-1.5">{member.status === "active" ? t("admin.users.filter.active") : t("admin.users.filter.deactivated")}</td>
                <td className="px-3 py-1.5 whitespace-nowrap"><TimeCell iso={member.last_login_at} /></td>
                <td className="px-3 py-1.5 whitespace-nowrap"><TimeCell iso={member.last_active_at} /></td>
                <td className="px-3 py-1.5 text-right tabular-nums">{group3(member.messages_30d)}</td>
                <td className="px-3 py-1.5 text-xs text-muted" title={member.platforms.map(platformLabel).join(", ")}>
                  {member.devices > 0 ? t("analytics.devicesCount", { count: member.devices, platforms: member.platforms.map(platformLabel).join(", ") }) : "—"}
                </td>
              </tr>
            ))}
            {page && rows.length === 0 && (
              <tr><td colSpan={MEMBER_COLUMNS.length + 1} className="px-3 py-6 text-center text-sm text-muted">{t("admin.users.noMatch")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {page && page.total > page.limit && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted">
          <span>{t("analytics.range", { from: page.offset + 1, to: page.offset + rows.length, total: page.total })}</span>
          <Button size="sm" variant="ghost" disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - page.limit))}>{t("analytics.prev")}</Button>
          <Button size="sm" variant="ghost" disabled={page.offset + page.limit >= page.total} onClick={() => setOffset(page.offset + page.limit)}>{t("analytics.next")}</Button>
        </div>
      )}
    </section>
  );
}
