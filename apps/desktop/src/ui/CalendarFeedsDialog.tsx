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

export const FEED_SCOPES: Array<{ value: CalendarFeedScope; label: string }> = [
  { value: "all", label: "すべて (自分のカレンダーと参加しているチャンネル)" },
  { value: "personal", label: "自分のカレンダーだけ" },
];

export function feedScopeLabel(scope: CalendarFeedScope): string {
  return scope === "personal" ? "自分のカレンダーだけ" : "すべて";
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
    try {
      await navigator.clipboard?.writeText(made);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal onClose={onClose} title="カレンダーを購読 (iCal)" description="Google カレンダーや Apple のカレンダーにこのカレンダーの予定を表示します (読み取り専用)。" className="w-[560px]">
      <div className="mt-4 space-y-4 text-sm">
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs">
          購読 URL を知っている人は、ログインしなくても誰でも予定を見られます。人に教えないでください。漏れたら削除して作り直してください。
        </p>
        <section className="space-y-2" aria-label="購読 URL を作る">
          <div className="text-xs font-medium text-muted">範囲</div>
          <div className="space-y-1">
            {FEED_SCOPES.map((choice) => (
              <label key={choice.value} className="flex items-center gap-2">
                <input type="radio" name="feed-scope" value={choice.value} checked={scope === choice.value} onChange={() => setScope(choice.value)} />
                {choice.label}
              </label>
            ))}
          </div>
          <Button size="sm" disabled={!api || busy} onClick={() => void create()}>購読 URL を作る</Button>
        </section>
        {made && (
          <section className="space-y-1 rounded-xl border border-accent/40 bg-accent-soft/50 p-3" aria-label="作った URL">
            <div className="font-medium">購読 URL</div>
            <div className="flex items-center gap-2">
              <Input readOnly value={made} aria-label="購読 URL" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
              <Button size="sm" variant="secondary" onClick={() => void copy()}>
                <Copy size={14} /> {copied ? "コピーしました" : "コピー"}
              </Button>
            </div>
            <div className="text-xs text-muted">この URL はいまだけ表示します。閉じると再表示できません (必要なら作り直してください)。</div>
          </section>
        )}
        <section className="space-y-1" aria-label="作った購読 URL">
          <div className="text-xs font-medium text-muted">作った購読 URL</div>
          {feeds === null ? (
            <div className="text-xs text-muted">{api ? "読み込み中…" : "接続すると表示します"}</div>
          ) : feeds.length === 0 ? (
            <div className="text-xs text-muted">まだありません</div>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {feeds.map((feed) => (
                <li key={feed.id} data-feed={feed.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block">{feedScopeLabel(feed.scope)}</span>
                    <span className="block text-xs text-muted">
                      {shortDate(feed.created_at)} に作成 ・ {feed.last_used_at ? `${shortDate(feed.last_used_at)} に読まれました` : "まだ読まれていません"}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" className="text-danger" disabled={busy} aria-label="この購読 URL を削除" onClick={() => void remove(feed)}>
                    <Trash2 size={14} /> 削除
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <section className="space-y-1 text-xs text-muted" aria-label="使い方">
          <div className="font-medium text-ink">使い方</div>
          <p>Google カレンダー (ブラウザ): 左の「他のカレンダー」の「＋」→「URL で追加」に URL を貼り付けて「カレンダーを追加」。</p>
          <p>Apple のカレンダー (Mac): 「ファイル」→「新規カレンダー照会…」に URL を貼り付けて「照会」。iPhone では「設定」→「カレンダー」→「アカウント」→「アカウントを追加」→「その他」→「照会するカレンダーを追加」。</p>
          <p>反映はカレンダーのアプリが読みに来たとき (数分〜数時間ごと) です。90 日前から 400 日先までの予定が入ります。</p>
        </section>
      </div>
    </Modal>
  );
}
