/**
 * M34 (MOBILE_UI.md §5, §6.3, §6.4 stage A, §8): the phone's bottom tabs. Pure rules shared with iOS and Android —
 * the tab badges (on top of the unread rules in ./channels, unchanged), the DM list's order and time labels, where a
 * notification / permalink / search result lands, and the per-tab screen stacks.
 */
import type { ChannelState, ThreadSummary } from "../sync/types";
import { hasUnread, isDmChannel, isSelfNotes } from "./channels";

export type MobileTab = "home" | "dm" | "activity" | "you";

export const MOBILE_TABS: readonly MobileTab[] = ["home", "dm", "activity", "you"];

export const MOBILE_TAB_LABELS: Record<MobileTab, string> = { home: "ホーム", dm: "DM", activity: "アクティビティ", you: "自分" };

// --- badges (§8) -------------------------------------------------------------------------------

/** DM tab: the DMs and group DMs of mine that are unread by the sidebar's rule (a muted one only with a mention). */
export function dmBadge(channels: Iterable<ChannelState>, meId: string | null, now?: Date): number {
  let count = 0;
  for (const channel of channels) if (channel.isMember && isDmChannel(channel) && hasUnread(channel, meId, now)) count += 1;
  return count;
}

/**
 * Activity tab (stage A): the followed threads' unread count plus the channels (not DMs) of mine with a mention;
 * red when any of those channels or threads mentions me.
 */
export function activityBadge(channels: Iterable<ChannelState>, threads: ThreadSummary): { count: number; mention: boolean } {
  let mentioned = 0;
  for (const channel of channels) if (channel.isMember && !isDmChannel(channel) && channel.mentionCount > 0) mentioned += 1;
  return { count: threads.unread_count + mentioned, mention: mentioned > 0 || threads.mention_count > 0 };
}

/** Home tab: a dot while any channel (not a DM) of mine is unread by the sidebar's rule. */
export function homeDot(channels: Iterable<ChannelState>, meId: string | null, now?: Date): boolean {
  for (const channel of channels) if (channel.isMember && !isDmChannel(channel) && hasUnread(channel, meId, now)) return true;
  return false;
}

// --- the DM list (§6.3) ------------------------------------------------------------------------

// My own DM (a DM with nobody but me, titled with my name): its rules live in ./channels, the sidebar uses them too.
export { isSelfNotes, showsSelfNotesPlaceholder } from "./channels";

/**
 * The DM (not group DM) whose members are exactly `userId` and me — with `userId` = me, my own DM, never one of my 1:1
 * DMs.
 */
export function findDmWith(channels: Iterable<ChannelState>, userId: string, meId: string | null): ChannelState | undefined {
  const wanted = new Set([userId, ...(meId ? [meId] : [])]);
  for (const channel of channels) {
    if (channel.type !== "dm") continue;
    const members = new Set(channel.dm_user_ids ?? []);
    if (members.size === wanted.size && [...wanted].every((id) => members.has(id))) return channel;
  }
  return undefined;
}

/** My DMs and group DMs: my own DM first, then the newest last message first; `query` filters by name. */
export function dmList(channels: Iterable<ChannelState>, title: (channel: ChannelState) => string, meId: string | null, query = ""): ChannelState[] {
  const needle = query.trim().toLowerCase();
  const rows = [...channels].filter((c) => c.isMember && isDmChannel(c) && (!needle || title(c).toLowerCase().includes(needle)));
  return rows.sort((a, b) => Number(isSelfNotes(b, meId)) - Number(isSelfNotes(a, meId)) || (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
}

const WEEKDAYS = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];

/**
 * The time on a DM row, in local time: today "H:mm", the day before 「昨日」, 2–6 days before the weekday, older "M/d",
 * another year "yyyy/M/d"; nothing without a message.
 */
export function dmTimeLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (days === 1) return "昨日";
  if (days >= 2 && days <= 6) return WEEKDAYS[at.getDay()]!;
  if (at.getFullYear() !== now.getFullYear()) return `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()}`;
  return `${at.getMonth() + 1}/${at.getDate()}`;
}

// --- where things land, and the stacks (§5, M34 (7)) -------------------------------------------

/** A notification, permalink or search result: a DM on the DM tab, a channel (and its thread) on the home tab. */
export function landingTab(channel: Pick<ChannelState, "type"> | undefined): MobileTab {
  return channel && (channel.type === "dm" || channel.type === "group_dm") ? "dm" : "home";
}

/**
 * The tabs' stacks: the selected tab's screens are live (the screen's own state, `S`), every other tab's are kept here
 * as they were left.
 */
export interface TabStacks<S> {
  tab: MobileTab;
  saved: Partial<Record<MobileTab, S>>;
}

/**
 * A tap on the bar. Another tab: this tab's screens are kept and that tab's come back (its root the first time). The
 * selected tab: back to its root, or, at the root already, `scrollTop` (its list to the top).
 */
export function tapTab<S>(stacks: TabStacks<S>, live: S, target: MobileTab, root: (screen: S) => S, isRoot: (screen: S) => boolean): { stacks: TabStacks<S>; live: S; scrollTop: boolean } {
  if (target === stacks.tab) return isRoot(live) ? { stacks, live, scrollTop: true } : { stacks, live: root(live), scrollTop: false };
  const saved = { ...stacks.saved, [stacks.tab]: live };
  const next = saved[target] ?? root(live);
  delete saved[target];
  return { stacks: { tab: target, saved }, live: next, scrollTop: false };
}

/** Land `screen` on `target`, replacing that tab's stack and selecting it; the other tabs keep theirs. */
export function landOn<S>(stacks: TabStacks<S>, live: S, target: MobileTab, screen: S): { stacks: TabStacks<S>; live: S } {
  if (target === stacks.tab) return { stacks, live: screen };
  const saved = { ...stacks.saved, [stacks.tab]: live };
  delete saved[target];
  return { stacks: { tab: target, saved }, live: screen };
}
