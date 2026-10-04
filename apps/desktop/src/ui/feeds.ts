/** M97 (docs/FEEDS.md §5): the pure parts of the channel's 「フィード」 section. */
import { ApiError, describeError } from "../api/errors";
import type { FeedOut } from "../api/types";
import type { ChannelState } from "../sync/types";

/** Why a fetch failed (FeedOut.last_error_code, or details.reason of 422 feed_invalid), in words. */
export const FEED_REASONS: Readonly<Record<string, string>> = {
  not_a_feed: "RSS / Atom のフィードではありません",
  unsafe_xml: "安全でない XML (エンティティの宣言) を含みます",
  http_error: "サイトがエラーを返しました",
  too_large: "大きすぎます (2 MB まで)",
  timeout: "サイトが応答しません",
  dns_failed: "ホストが見つかりません",
  network: "サイトに接続できません",
  too_many_redirects: "リダイレクトが多すぎます",
  url_not_allowed: "この URL には接続できません",
};

export function feedReason(code: string | null | undefined): string {
  if (!code) return "";
  return FEED_REASONS[code] ?? "読み込めませんでした";
}

/** The add form's error: the Japanese message, and for 422 feed_invalid the reason too. */
export function feedErrorText(error: unknown): string {
  const text = describeError(error);
  if (error instanceof ApiError && error.code === "feed_invalid") {
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === "string" && FEED_REASONS[reason]) return `${text} (${FEED_REASONS[reason]})`;
  }
  return text;
}

/** Who may add one: a member (not a guest) of a channel that is not archived. */
export function canAddFeed(channel: ChannelState | undefined, isGuest: boolean): boolean {
  if (!channel || !channel.isMember || channel.archived || isGuest) return false;
  return channel.type === "public" || channel.type === "private";
}

export type FeedState = "paused" | "owner_absent" | "failing" | "ok" | "new";

/** One word for the row's badge (paused first: nothing happens while paused, whatever else). */
export function feedState(feed: FeedOut): FeedState {
  if (!feed.enabled) return "paused";
  if (!feed.owner_active) return "owner_absent";
  if (feed.last_error_code) return "failing";
  return feed.last_success_at ? "ok" : "new";
}

/** The status line under a feed: the last fetch, or the error with the count of failures in a row. */
export function feedStatusLine(feed: FeedOut, when: (iso: string) => string): string {
  if (feed.last_error_code) {
    const raw = feed.last_error && feed.last_error !== feed.last_error_code ? ` (${feed.last_error})` : "";
    const count = feed.consecutive_failures > 1 ? ` · ${feed.consecutive_failures} 回続けて失敗` : "";
    return `取得に失敗: ${feedReason(feed.last_error_code)}${raw}${count}`;
  }
  const parts = [feed.last_fetched_at ? `最終取得 ${when(feed.last_fetched_at)}` : "まだ取得していません"];
  if (feed.post_count > 0) parts.push(`投稿 ${feed.post_count} 件`);
  return parts.join(" · ");
}

/** The URL as typed, trimmed; http(s) only (the server checks the rest). */
export function feedUrlProblem(url: string): string | null {
  const value = url.trim();
  if (!value) return "URL を入力してください";
  if (!/^https?:\/\/[^\s/]+/i.test(value)) return "http:// か https:// で始まる URL を入力してください";
  if (value.length > 2048) return "URL が長すぎます";
  return null;
}
