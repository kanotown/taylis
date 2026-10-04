/**
 * M97 (docs/FEEDS.md §5): a channel's 「フィード」 — the RSS / Atom feeds its members registered, whose new entries the
 * channel's 「RSS」 bot posts. Everyone who reads the channel sees the list (title, URL, who added it, the last fetch or
 * its error); members add one by URL; the one who added it, the channel's owners and administrators pause, resume and
 * delete it. In the channel details page and, on a wide window, in a dialog from ⋯.
 */
import { Pause, Play, Plus, Rss, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { openExternalLink } from "../platform/external";
import type { FeedOut } from "../api/types";
import { describeError } from "../api/errors";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { canAddFeed, feedErrorText, feedState, feedStatusLine, feedUrlProblem } from "./feeds";
import { Button, cn, Input, Modal } from "./primitives";
import { shortDateTime } from "./recurring";

const MAX_FEEDS = 20;

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
      setResult({ ok: true, text: `「${feed.title ?? feed.url}」を追加しました。これからの新しい記事を投稿します` });
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
      {rows === null ? (
        <p className="py-2 text-sm text-muted">読み込み中…</p>
      ) : rows === "failed" ? (
        <p className="py-2 text-sm text-danger">読み込めませんでした</p>
      ) : rows.length === 0 ? (
        <p className="py-1 text-sm text-muted">
          フィードはありません。{canAdd ? "ブログや週報サイトの RSS / Atom の URL を追加すると、新しい記事を「RSS」ボットがこのチャンネルに投稿します。" : ""}
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
                  {state === "paused" && <span className="shrink-0 rounded bg-panel-2 px-1.5 text-[11px] font-medium text-muted">停止中</span>}
                  {state === "owner_absent" && (
                    <span className="shrink-0 rounded bg-panel-2 px-1.5 text-[11px] font-medium text-muted" title="追加した人がチャンネルにいない (または無効) ため取得していません">
                      取得を休止中
                    </span>
                  )}
                  {state === "failing" && <span className="shrink-0 rounded bg-danger/10 px-1.5 text-[11px] font-medium text-danger">エラー</span>}
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
                <div className="text-xs text-muted">追加: {owner}</div>
                <div className={cn("text-xs", state === "failing" ? "text-danger" : "text-muted")} data-feed-status>
                  {feedStatusLine(feed, shortDateTime)}
                </div>
                {feed.can_manage && api && (
                  confirmDelete === feed.id ? (
                    <div className="flex items-center justify-end gap-2 rounded-lg bg-danger/10 px-2 py-1.5">
                      <span className="mr-auto text-xs">「{feed.title ?? feed.url}」を削除しますか？ これまでの投稿は残ります</span>
                      <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(null)}>キャンセル</Button>
                      <Button variant="danger" size="sm" disabled={busy === feed.id} onClick={() => void act(feed, () => api.deleteFeed(feed.id), "削除しました")}>
                        削除する
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {!(channel.archived && !feed.enabled) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy === feed.id}
                          onClick={() => void act(feed, () => api.updateFeed(feed.id, { enabled: !feed.enabled }), feed.enabled ? "止めました" : "再開しました")}
                        >
                          {feed.enabled ? <><Pause size={13} /> 止める</> : <><Play size={13} /> 再開</>}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirmDelete(feed.id)}>
                        <Trash2 size={13} /> 削除
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
          aria-label="フィードを追加"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              type="url"
              aria-label="フィードの URL"
              placeholder="https://example.com/feed.xml"
              className="h-8 min-w-0 flex-1 text-sm"
              value={url}
              disabled={full}
              onChange={(e) => { setUrl(e.target.value); setAddError(null); }}
            />
            <Button type="submit" size="sm" variant="secondary" disabled={adding || full}>
              <Plus size={14} /> {adding ? "確認中…" : "追加"}
            </Button>
          </div>
          {addError ? (
            <p role="alert" className="text-xs text-danger">{addError}</p>
          ) : (
            <p className="text-xs text-muted">
              {full ? `1 つのチャンネルのフィードは ${MAX_FEEDS} 件までです` : "RSS / Atom の URL (サイトのトップページでも、フィードを案内していれば見つけます)。追加の時点の記事は投稿しません"}
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
    <Modal onClose={onClose} title="フィード" description={`ブログや週報サイトの新しい記事を #${channel.name ?? ""} に投稿します (30 分ごとに確認)`} className="w-[520px]">
      <div className="mt-3">
        <FeedList controller={controller} channel={channel} />
      </div>
    </Modal>
  );
}
