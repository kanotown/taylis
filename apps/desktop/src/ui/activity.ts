/**
 * M39, the activity (MOBILE_UI.md §6.4 stage B, §7.2): pure rules of its rows — what a row says, when its dot shows,
 * the newest time a screen of rows marks read, and pages put together.
 */
import type { ActivityFilter, ActivityItem } from "../api/types";

export const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "mentions", "threads", "reactions"];

export const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = { all: "すべて", mentions: "メンション", threads: "スレッド", reactions: "リアクション" };

/**
 * One row per kind and message (a reaction item is one message's reactions); a canvas mention (M76) by its own id (one
 * per canvas while unread).
 */
export function activityKey(item: Pick<ActivityItem, "kind" | "message" | "canvas">): string {
  return `${item.kind}:${item.message?.id ?? item.canvas?.item_id ?? ""}`;
}

/** M76: an item this client can show: a message's, or a canvas mention with its canvas (anything else is skipped). */
export function isShownActivity(item: ActivityItem): boolean {
  return item.kind === "canvas_mention" ? !!item.canvas : !!item.message;
}

const time = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
};

/** The row's dot: it happened after the read position (items at the position itself are read). */
export function isActivityUnread(item: Pick<ActivityItem, "at">, readAt: string | null | undefined): boolean {
  return !!readAt && time(item.at) > time(readAt);
}

/** The newest `at` of the rows (what being on screen marks read); null without rows. */
export function newestActivityAt(items: readonly Pick<ActivityItem, "at">[]): string | null {
  let newest: string | null = null;
  for (const item of items) if (newest === null || time(item.at) > time(newest)) newest = item.at;
  return newest;
}

/** Whether marking `at` read moves the position (the server only moves it forward). */
export function movesActivityRead(at: string | null, readAt: string | null | undefined): boolean {
  return !!at && (!readAt || time(at) > time(readAt));
}

/**
 * The next page after the rows held: a row already held (a tie at the page boundary, or a reaction item that moved) is
 * not listed twice; the held one stays where it is.
 */
export function appendActivityPage(held: readonly ActivityItem[], page: readonly ActivityItem[]): ActivityItem[] {
  const keys = new Set(held.map(activityKey));
  return [...held, ...page.filter((item) => !keys.has(activityKey(item)))];
}

/**
 * Who did it, as the row's first line says it: 「〇〇 がメンション」, 「〇〇 がスレッドに返信」, 「〇〇 が「題名」であなたを
 * メンションしました」 (a canvas, M76), and for reactions 「〇〇 が」 / 「〇〇 ほか N 人が」 followed by the emoji (drawn by
 * the caller, custom emoji as pictures).
 */
export function activityHeadline(item: Pick<ActivityItem, "kind" | "actor_ids" | "canvas">, nameOf: (userId: string) => string): { who: string; what: string } {
  const first = item.actor_ids[0];
  const name = first ? nameOf(first) : "誰か";
  if (item.kind === "mention") return { who: name, what: " がメンション" };
  if (item.kind === "canvas_mention") return { who: name, what: ` が「${item.canvas?.title ?? "キャンバス"}」であなたをメンションしました` };
  if (item.kind === "thread_reply") return { who: name, what: " がスレッドに返信" };
  const others = Math.max(0, item.actor_ids.length - 1);
  return others > 0 ? { who: `${name} ほか ${others} 人`, what: "が" } : { who: name, what: " が" };
}

/** The same headline as plain text (the row's accessible name), the emoji written out. */
export function activityHeadlineText(item: Pick<ActivityItem, "kind" | "actor_ids" | "emojis" | "canvas">, nameOf: (userId: string) => string): string {
  const { who, what } = activityHeadline(item, nameOf);
  return item.kind === "reaction" ? `${who}${what} ${(item.emojis ?? []).join("")}` : `${who}${what}`;
}

/** An empty list says what would be listed there. */
export function activityEmptyText(filter: ActivityFilter): string {
  switch (filter) {
    case "mentions":
      return "まだメンションはありません";
    case "threads":
      return "フォロー中のスレッドへの返信はまだありません";
    case "reactions":
      return "自分の投稿へのリアクションはまだありません";
    default:
      return "まだアクティビティはありません";
  }
}
