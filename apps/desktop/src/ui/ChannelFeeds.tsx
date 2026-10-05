/**
 * M97 (docs/FEEDS.md §5): a channel's 「フィード」 — the RSS / Atom feeds its members registered, whose new entries the
 * channel's 「RSS」 bot posts. Everyone who reads the channel sees the list (title, URL, who added it, the last fetch or
 * its error); members add one by URL; the one who added it, the channel's owners and administrators pause, resume and
 * delete it. In the channel details page and, on a wide window, in a dialog from ⋯.
 * M98: above the list, the bot that posts — its owners and administrators rename it, an administrator may make an
 * existing bot of the channel (an imported Slack RSS bot) the feed bot.
 */
import { Bot, Pause, Pencil, Play, Plus, Rss, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { openExternalLink } from "../platform/external";
import type { FeedBotOut, FeedOut } from "../api/types";
import { describeError } from "../api/errors";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { canAddFeed, feedErrorText, feedState, feedStatusLine, feedUrlProblem } from "./feeds";
import { Button, cn, Input, Modal } from "./primitives";
import { shortDateTime } from "./recurring";
import { t } from "../i18n";

const MAX_FEEDS = 20;
const SELECT = "h-8 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2 text-sm";

/**
 * M98: the bot the channel's feeds post as. Nothing at all before the first feed for whoever cannot adopt one, or when
 * the server does not know the call. `onChanged` reloads the list (an adoption changes its bot).
 */
export function FeedBotPanel({ controller, channel, reload, onChanged }: { controller: AppController; channel: ChannelState; reload: number; onChanged: () => void }) {
  const [bot, setBot] = useState<FeedBotOut | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [pick, setPick] = useState("");
  const [confirmAdopt, setConfirmAdopt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    let current = true;
    Promise.resolve().then(() => api.channelFeedBot(channel.id)).then(
      (out) => { if (current) setBot(out); },
      () => { if (current) setBot(null); },
    );
    return () => { current = false; };
  }, [controller, channel.id, reload]);

  const save = async (body: { display_name?: string; bot_user_id?: string }, done: string) => {
    const api = controller.api;
    if (!api || busy) return;
    setBusy(true);
    setResult(null);
    try {
      setBot(await api.updateChannelFeedBot(channel.id, body));
      setResult({ ok: true, text: done });
      setEditing(false);
      setConfirmAdopt(false);
      setPick("");
      if (body.bot_user_id) onChanged();
    } catch (error) {
      setResult({ ok: false, text: describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  if (!bot || (!bot.bot_user_id && !bot.can_adopt)) return null;
  const candidates = bot.candidates ?? [];
  const chosen = candidates.find((c) => c.id === pick);
  const trimmed = name.trim();
  return (
    <div className="space-y-1.5 rounded-lg border border-line px-3 py-2" data-feed-bot>
      {editing ? (
        <form
          className="flex items-center gap-2"
          aria-label={t("feeds.renameBot")}
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) void save({ display_name: trimmed }, t("feeds.botRenamed", { name: trimmed }));
          }}
        >
          <Input aria-label={t("feeds.botName")} className="h-8 min-w-0 flex-1 text-sm" maxLength={80} value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <Button type="submit" size="sm" disabled={busy || !trimmed}>{t("common.save")}</Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
        </form>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <Bot size={15} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">
            {t("feeds.postingBot")} {bot.display_name ? <strong data-feed-bot-name>{bot.display_name}</strong> : <span className="text-muted">{t("feeds.botCreatedOnFirst")}</span>}
            {bot.adopted && <span className="ml-1.5 text-xs text-muted">{t("feeds.adopted")}</span>}
          </span>
          {bot.can_rename && bot.display_name && (
            <Button variant="ghost" size="sm" onClick={() => { setName(bot.display_name ?? ""); setEditing(true); setResult(null); }}>
              <Pencil size={13} /> {t("channel.rename")}
            </Button>
          )}
        </div>
      )}
      {bot.can_adopt && candidates.length > 0 && (
        confirmAdopt && chosen ? (
          <div className="space-y-1.5 rounded-lg bg-panel-2 px-2 py-1.5 text-xs">
            <p>
              {t("feeds.adoptQuestion", { name: chosen.display_name, username: chosen.username })}
              {bot.adopted || !bot.bot_user_id ? "" : t("feeds.adoptDisables", { name: bot.display_name ?? "" })}
              {t("feeds.adoptKeeps")}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmAdopt(false)}>{t("common.cancel")}</Button>
              <Button size="sm" disabled={busy} onClick={() => void save({ bot_user_id: chosen.id }, t("feeds.adoptedNotice", { name: chosen.display_name }))}>
                {t("feeds.useThisBot")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <select aria-label={t("feeds.useExisting")} className={SELECT} value={pick} onChange={(e) => { setPick(e.target.value); setResult(null); }}>
              <option value="">{t("feeds.useExistingAdmin")}</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>{c.display_name} (@{c.username}{c.active ? "" : t("feeds.inactiveMark")})</option>
              ))}
            </select>
            <Button variant="secondary" size="sm" disabled={!chosen} onClick={() => setConfirmAdopt(true)}>{t("feeds.choose")}</Button>
          </div>
        )
      )}
      {result && <p role={result.ok ? "status" : "alert"} className={cn("text-xs", result.ok ? "text-muted" : "text-danger")}>{result.text}</p>}
    </div>
  );
}

export function FeedList({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const store = controller.store;
  const [rows, setRows] = useState<FeedOut[] | "failed" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const canAdd = canAddFeed(channel, controller.isGuest);

  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    let current = true;
    // A failure of any kind (also a server without the call) reads as 「読み込めませんでした」.
    Promise.resolve().then(() => api.channelFeeds(channel.id)).then(
      (list) => { if (current) setRows(list); },
      () => { if (current) setRows("failed"); },
    );
    return () => { current = false; };
  }, [controller, channel.id, reload]);

  const act = useCallback(async (feed: FeedOut, action: () => Promise<unknown>, done: string) => {
    setBusy(feed.id);
    setResult(null);
    try {
      await action();
      setResult({ ok: true, text: done });
      setReload((n) => n + 1);
    } catch (error) {
      setResult({ ok: false, text: describeError(error) });
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  }, []);

  const add = async () => {
    const api = controller.api;
    if (!api || adding) return;
    const problem = feedUrlProblem(url);
    if (problem) {
      setAddError(problem);
      return;
    }
    setAdding(true);
    setAddError(null);
    setResult(null);
    try {
      const feed = await api.createFeed(channel.id, { url: url.trim() });
      setUrl("");
      setResult({ ok: true, text: t("feeds.added", { name: feed.title ?? feed.url }) });
      setReload((n) => n + 1);
    } catch (error) {
      setAddError(feedErrorText(error));
    } finally {
      setAdding(false);
    }
  };

  const api = controller.api;
  const full = Array.isArray(rows) && rows.length >= MAX_FEEDS;
  return (
    <div className="space-y-2" data-feed-list>
      <FeedBotPanel controller={controller} channel={channel} reload={reload} onChanged={() => setReload((n) => n + 1)} />
      {rows === null ? (
        <p className="py-2 text-sm text-muted">{t("common.loading")}</p>
      ) : rows === "failed" ? (
        <p className="py-2 text-sm text-danger">{t("common.loadFailed")}</p>
      ) : rows.length === 0 ? (
        <p className="py-1 text-sm text-muted">
          {t("feeds.none")}{canAdd ? t("feeds.noneAdd") : ""}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rows.map((feed) => {
            const state = feedState(feed);
            const owner = store.users.get(feed.owner_id)?.display_name ?? "?";
            return (
              <li key={feed.id} className="space-y-1 px-3 py-2.5" data-feed={feed.id}>
                <div className="flex items-center gap-2">
                  <Rss size={15} className="shrink-0 text-muted" />
                  <strong className="min-w-0 flex-1 truncate text-sm">{feed.title ?? feed.url}</strong>
                  {state === "paused" && <span className="shrink-0 rounded bg-panel-2 px-1.5 text-[11px] font-medium text-muted">{t("workflow.paused")}</span>}
                  {state === "owner_absent" && (
                    <span className="shrink-0 rounded bg-panel-2 px-1.5 text-[11px] font-medium text-muted" title={t("feeds.dormantTitle")}>
                      {t("feeds.dormant")}
                    </span>
                  )}
                  {state === "failing" && <span className="shrink-0 rounded bg-danger/10 px-1.5 text-[11px] font-medium text-danger">{t("feeds.error")}</span>}
                </div>
                <a
                  href={feed.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={feed.url}
                  onClick={(event) => openExternalLink(event, feed.url)}
                  className="block truncate text-xs text-accent hover:underline"
                >
                  {feed.url}
                </a>
                <div className="text-xs text-muted">{t("feeds.addedBy", { name: owner })}</div>
                <div className={cn("text-xs", state === "failing" ? "text-danger" : "text-muted")} data-feed-status>
                  {feedStatusLine(feed, shortDateTime)}
                </div>
                {feed.can_manage && api && (
                  confirmDelete === feed.id ? (
                    <div className="flex items-center justify-end gap-2 rounded-lg bg-danger/10 px-2 py-1.5">
                      <span className="mr-auto text-xs">{t("recurring.deleteConfirm", { name: feed.title ?? feed.url })}</span>
                      <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</Button>
                      <Button variant="danger" size="sm" disabled={busy === feed.id} onClick={() => void act(feed, () => api.deleteFeed(feed.id), t("common.deleted"))}>
                        {t("common.deleteConfirm")}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {!(channel.archived && !feed.enabled) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy === feed.id}
                          onClick={() => void act(feed, () => api.updateFeed(feed.id, { enabled: !feed.enabled }), feed.enabled ? t("workflow.pausedNotice") : t("workflow.resumedNotice"))}
                        >
                          {feed.enabled ? <><Pause size={13} /> {t("settings.pause.pause")}</> : <><Play size={13} /> {t("settings.pause.resume")}</>}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirmDelete(feed.id)}>
                        <Trash2 size={13} /> {t("common.delete")}
                      </Button>
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {result && <p role={result.ok ? "status" : "alert"} className={cn("text-xs", result.ok ? "text-muted" : "text-danger")}>{result.text}</p>}
      {canAdd && api && rows !== "failed" && (
        <form
          className="space-y-1.5 pt-1"
          aria-label={t("feeds.add")}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              type="url"
              aria-label={t("feeds.url")}
              placeholder="https://example.com/feed.xml"
              className="h-8 min-w-0 flex-1 text-sm"
              value={url}
              disabled={full}
              onChange={(e) => { setUrl(e.target.value); setAddError(null); }}
            />
            <Button type="submit" size="sm" variant="secondary" disabled={adding || full}>
              <Plus size={14} /> {adding ? t("common.checking") : t("common.add")}
            </Button>
          </div>
          {addError ? (
            <p role="alert" className="text-xs text-danger">{addError}</p>
          ) : (
            <p className="text-xs text-muted">
              {full ? t("feeds.full", { max: MAX_FEEDS }) : t("feeds.urlHint")}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

/** The wide window's way in: ⋯ → 「フィード…」. */
export function FeedsDialog({ controller, channel, onClose }: { controller: AppController; channel: ChannelState; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title={t("feeds.title")} description={t("feeds.description", { name: channel.name ?? "" })} className="w-[520px]">
      <div className="mt-3">
        <FeedList controller={controller} channel={channel} />
      </div>
    </Modal>
  );
}
