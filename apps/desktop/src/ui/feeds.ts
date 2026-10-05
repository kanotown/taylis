/** M97 (docs/FEEDS.md §5): the pure parts of the channel's 「フィード」 section. */
import { ApiError, describeError } from "../api/errors";
import type { FeedOut } from "../api/types";
import type { ChannelState } from "../sync/types";
import { t } from "../i18n";

/** Why a fetch failed (FeedOut.last_error_code, or details.reason of 422 feed_invalid), in words. */
export const FEED_REASONS: Readonly<Record<string, string>> = {
  get not_a_feed() { return t("feeds.reason.notAFeed"); },
  get unsafe_xml() { return t("feeds.reason.unsafeXml"); },
  get http_error() { return t("feeds.reason.httpError"); },
  get too_large() { return t("feeds.reason.tooLarge"); },
  get timeout() { return t("feeds.reason.timeout"); },
  get dns_failed() { return t("feeds.reason.dnsFailed"); },
  get network() { return t("feeds.reason.network"); },
  get too_many_redirects() { return t("feeds.reason.tooManyRedirects"); },
  get url_not_allowed() { return t("feeds.reason.urlNotAllowed"); },
};

export function feedReason(code: string | null | undefined): string {
  if (!code) return "";
  return FEED_REASONS[code] ?? t("common.loadFailed");
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
    const count = feed.consecutive_failures > 1 ? t("feeds.failuresInRow", { count: feed.consecutive_failures }) : "";
    return t("feeds.fetchFailed", { reason: feedReason(feed.last_error_code) }) + raw + count;
  }
  const parts = [feed.last_fetched_at ? t("feeds.lastFetched", { at: when(feed.last_fetched_at) }) : t("feeds.notFetched")];
  if (feed.post_count > 0) parts.push(t("feeds.posts", { count: feed.post_count }));
  return parts.join(" · ");
}

/** The URL as typed, trimmed; http(s) only (the server checks the rest). */
export function feedUrlProblem(url: string): string | null {
  const value = url.trim();
  if (!value) return t("feeds.check.empty");
  if (!/^https?:\/\/[^\s/]+/i.test(value)) return t("feeds.check.scheme");
  if (value.length > 2048) return t("feeds.check.tooLong");
  return null;
}
