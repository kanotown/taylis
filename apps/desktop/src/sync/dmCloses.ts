/**
 * M141 「会話を閉じる」 (SYNC_PROTOCOL.md §7.9): the rules the three clients share (apps/shared/dm-close-rules.json).
 */

/**
 * Review v0.1.43 #6: whether a dm_close.updated is taken. An open always is; a close is not when this device already holds
 * a timeline message newer than where it was closed (`lastMessageSeq`, the §7.8 last_message): that message reopened the
 * conversation on the server too, it only reached this device first. No `closedSeq` (an older server): taken.
 */
export function takesDmClose(closed: boolean, closedSeq: number | null | undefined, lastMessageSeq: number | null | undefined): boolean {
  if (!closed || closedSeq === null || closedSeq === undefined) return true;
  return lastMessageSeq === null || lastMessageSeq === undefined || lastMessageSeq <= closedSeq;
}

/**
 * Review v0.1.43 #7: a refused close puts back only its own pin. `channelId` goes back to `place` (its index before the
 * close, clamped to the list as it is now) or stays out when it was not pinned; the other pins stay as events left them.
 */
export function restoredDmPins(pins: readonly string[], channelId: string, place: number | null): string[] {
  const next = pins.filter((id) => id !== channelId);
  if (place !== null) next.splice(Math.min(place, next.length), 0, channelId);
  return next;
}

export interface CloseReadMark {
  lastSeq: number;
  lastReadSeq: number;
  unreadCount: number;
  mentionCount: number;
}

/**
 * Review v0.1.43 #7: when a refused close could not ask the server for the read state either, the snapshot from before
 * the close goes back only if nothing touched the read state since the close set it (`optimistic`); otherwise what came
 * meanwhile (a new message, another device's read) is kept for the next bootstrap.
 */
export function readFallback(optimistic: CloseReadMark, now: CloseReadMark): "snapshot" | "keep" {
  const same =
    optimistic.lastSeq === now.lastSeq &&
    optimistic.lastReadSeq === now.lastReadSeq &&
    optimistic.unreadCount === now.unreadCount &&
    optimistic.mentionCount === now.mentionCount;
  return same ? "snapshot" : "keep";
}
