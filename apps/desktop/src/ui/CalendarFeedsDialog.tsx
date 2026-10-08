/**
 * M68 (CALENDAR.md §10.6, §10.7): 「カレンダーを購読 (iCal)」 — private feed URLs that calendar apps (Google, Apple) poll.
 * Make one (everything I see, or my own calendar only), copy its URL (shown this once: the server keeps only a hash),
 * list them (scope, when made, when last read) and delete them (the URL stops at once). Anyone with a URL sees the events.
 */
import { Copy, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { describeError } from "../api/errors";
import type { CalendarFeedOut, CalendarFeedScope } from "../api/types";
import type { AppController } from "../state/app";
import { Button, Input, Modal } from "./primitives";
import { t } from "../i18n";

export const FEED_SCOPES: Array<{ value: CalendarFeedScope; label: string }> = [
  { value: "all", get label() { return t("calendarFeeds.scopeAll"); } },
  { value: "personal", get label() { return t("calendarFeeds.scopePersonal"); } },
];

export function feedScopeLabel(scope: CalendarFeedScope): string {
  return scope === "personal" ? t("calendarFeeds.scopePersonal") : t("admin.users.filter.all");
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function CalendarFeedsDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  const api = controller.api;
  const [feeds, setFeeds] = useState<CalendarFeedOut[] | null>(null);
  const [scope, setScope] = useState<CalendarFeedScope>("all");
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.calendarFeeds().then(
      (list) => live && setFeeds(list),
      (err: unknown) => live && setError(describeError(err)),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const create = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createCalendarFeed(scope);
      setMade(created.url);
      setCopied(false);
      setFeeds((list) => [...(list ?? []), created.feed]);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (feed: CalendarFeedOut) => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteCalendarFeed(feed.id);
      setFeeds((list) => (list ?? []).filter((f) => f.id !== feed.id));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!made) return;
    setCopied(await controller.copyToClipboard(made));
  };

  return (
    <Modal onClose={onClose} title={t("calendar.subscribeIcal")} description={t("calendarFeeds.description")} className="w-[560px]">
      <div className="mt-4 space-y-4 text-sm">
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs">
          {t("calendarFeeds.warning")}
        </p>
        <section className="space-y-2" aria-label={t("calendarFeeds.create")}>
          <div className="text-xs font-medium text-muted">{t("calendarFeeds.scope")}</div>
          <div className="space-y-1">
            {FEED_SCOPES.map((choice) => (
              <label key={choice.value} className="flex items-center gap-2">
                <input type="radio" name="feed-scope" value={choice.value} checked={scope === choice.value} onChange={() => setScope(choice.value)} />
                {choice.label}
              </label>
            ))}
          </div>
          <Button size="sm" disabled={!api || busy} onClick={() => void create()}>{t("calendarFeeds.create")}</Button>
        </section>
        {made && (
          <section className="space-y-1 rounded-xl border border-accent/40 bg-accent-soft/50 p-3" aria-label={t("calendarFeeds.madeUrl")}>
            <div className="font-medium">{t("calendarFeeds.url")}</div>
            <div className="flex items-center gap-2">
              <Input readOnly value={made} aria-label={t("calendarFeeds.url")} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
              <Button size="sm" variant="secondary" onClick={() => void copy()}>
                <Copy size={14} /> {copied ? t("calendarFeeds.copied") : t("common.copy")}
              </Button>
            </div>
            <div className="text-xs text-muted">{t("calendarFeeds.onlyNow")}</div>
          </section>
        )}
        <section className="space-y-1" aria-label={t("calendarFeeds.made")}>
          <div className="text-xs font-medium text-muted">{t("calendarFeeds.made")}</div>
          {feeds === null ? (
            <div className="text-xs text-muted">{api ? t("common.loading") : t("calendar.connectToShow")}</div>
          ) : feeds.length === 0 ? (
            <div className="text-xs text-muted">{t("rollover.none")}</div>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {feeds.map((feed) => (
                <li key={feed.id} data-feed={feed.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block">{feedScopeLabel(feed.scope)}</span>
                    <span className="block text-xs text-muted">
                      {t("calendarFeeds.createdAt", { at: shortDate(feed.created_at) })} · {feed.last_used_at ? t("calendarFeeds.readAt", { at: shortDate(feed.last_used_at) }) : t("calendarFeeds.notRead")}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" className="text-danger" disabled={busy} aria-label={t("calendarFeeds.delete")} onClick={() => void remove(feed)}>
                    <Trash2 size={14} /> {t("common.delete")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <section className="space-y-1 text-xs text-muted" aria-label={t("calendarFeeds.howTo")}>
          <div className="font-medium text-ink">{t("calendarFeeds.howTo")}</div>
          <p>{t("calendarFeeds.google")}</p>
          <p>{t("calendarFeeds.apple")}</p>
          <p>{t("calendarFeeds.refresh")}</p>
        </section>
      </div>
    </Modal>
  );
}
