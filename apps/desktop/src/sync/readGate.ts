/**
 * SYNC_PROTOCOL.md §10.1 (M17): when visible-range read marks may be sent. The same pure helpers exist in
 * every client (iOS `enum ReadGate`, Android `object ReadGate`) so the three behave alike.
 */

/** The largest unread count that gets 「最初の未読へ」: it keeps the rows held at once near the M22 retention (§10.1 6.). */
export const UNREAD_JUMP_MAX = 500;
/** 「最初の未読へ」 pages backwards with this limit … */
export const JUMP_PAGE_SIZE = 200;
/** … at most this many times per press (a safety valve when most rows are not counted as unread). */
export const JUMP_MAX_PAGES = 4;

/** Every timeline row with seq > m is held: the loaded range (§7.3) reaches m + 1, or the channel's start. */
export function covers(oldestLoadedSeq: number | null, m: number): boolean {
  return oldestLoadedSeq === 0 || (oldestLoadedSeq !== null && oldestLoadedSeq <= m + 1);
}

/**
 * Every row up to the newest is held too. Between bootstrap raising last_seq and the catch-up (reconnecting,
 * relaunching, opening a conversation that fell behind) the unread rows are still on their way.
 */
export function caughtUp(channel: { syncedSeq: number | null; lastSeq: number }): boolean {
  return channel.syncedSeq !== null && channel.syncedSeq >= channel.lastSeq;
}

/** Nothing unread, or every unread row is held (both ends): only then may rows on screen move the read position. */
export function readRangeReady(channel: { unreadCount: number; oldestLoadedSeq: number | null; lastReadSeq: number; syncedSeq: number | null; lastSeq: number }): boolean {
  return channel.unreadCount === 0 || (covers(channel.oldestLoadedSeq, channel.lastReadSeq) && caughtUp(channel));
}

/**
 * §10.1 12.: what the server counts as unread (and dates first_unread_at by): someone else's "user" row in the
 * timeline (top-level, or a reply also sent to the channel). System rows counted here would make the count and the
 * banner's 「… 以降」 disagree with the server until its next value.
 */
export function countsAsUnread(message: { sender_id: string; type?: string | null; parent_id?: string | null; also_in_channel?: boolean }, meId: string | null | undefined): boolean {
  return message.sender_id !== meId && (message.type ?? "user") === "user" && (!message.parent_id || message.also_in_channel === true);
}

/** The first held row after `afterSeq` from someone else (my own rows are never unread). */
export function firstUnreadRow<T extends { seq: number | null; sender_id: string }>(rows: readonly T[], afterSeq: number, meId: string | null | undefined): T | null {
  return rows.find((row) => row.seq !== null && row.seq > afterSeq && row.sender_id !== meId) ?? null;
}

/** Where 「新着メッセージ」 goes: the held mark (「ここから未読にする」) or the one captured at open, only when the range reaches it. */
export function dividerMark(held: number | null | undefined, captured: number | null, oldestLoadedSeq: number | null): number | null {
  const mark = held ?? captured;
  return mark !== null && covers(oldestLoadedSeq, mark) ? mark : null;
}

/**
 * The view's anchored flag after one evaluation: true once the first unread row has been on screen (or
 * nothing is unread / no unread row is held), false again whenever the range stops reaching the read position
 * or the first unread row went past above the screen unseen (`passed`, see passedUnseen).
 */
export function nextAnchored(prev: boolean, unreadCount: number, ready: boolean, firstUnread: { id: string } | null, visibleMessageIds: ReadonlySet<string>, passed = false): boolean {
  if (unreadCount === 0) return true;
  if (!ready) return false;
  if (prev) return !passed;
  return firstUnread === null || visibleMessageIds.has(firstUnread.id);
}

/**
 * §10.1 2.: the first unread row is above every row shown (`shownSeqs`) and not even partly on screen: the view
 * followed new rows, a reload or catch-up filled rows in, or the reader jumped more than a screen. Rows between were
 * never shown, so reading on from here would skip them. Nothing shown (the reader is not looking): no verdict.
 */
export function passedUnseen(firstUnread: { id: string; seq: number | null } | null, shownSeqs: readonly number[], partlyVisibleIds: ReadonlySet<string>): boolean {
  if (!firstUnread || firstUnread.seq === null || shownSeqs.length === 0) return false;
  return firstUnread.seq < Math.min(...shownSeqs) && !partlyVisibleIds.has(firstUnread.id);
}

/** 「ここから未読にする」 on the row with `seq`: moving the position forward past unread rows needs all of them held (10.). */
export function markUnreadOffered(seq: number, channel: Parameters<typeof readRangeReady>[0]): boolean {
  return seq - 1 <= channel.lastReadSeq || readRangeReady(channel);
}

export function jumpButtonShown(ready: boolean, unreadCount: number): boolean {
  return ready || unreadCount <= UNREAD_JUMP_MAX;
}
