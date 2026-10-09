import type { DndDuration, PresenceChoice, PresenceLook, PresenceStatus, PresenceUpdate, UserMe, UserPublic } from "../api/types";
import { clockLabel, deviceTimeZone, isIndefiniteDnd, pausedUntil } from "./dnd";
import { t, type MessageKey } from "../i18n";

/**
 * The quick status menu (docs/PRESENCE.md §11). 取り込み中 is `dnd_until` (the M12c pause, public; its clock rules —
 * still running, 「解除するまで」, the end's time — are dnd.ts's), オフライン表示 is `presence_hidden` (L4), 離席中 is
 * `presence_manual: "away"` (the hub then announces me as away). The rules here are the ones the phones copy
 * (apps/shared/presence-rules.json).
 */

/** What an avatar shows: 取り込み中 beats the connection (online, away or offline alike, as in Mattermost). */
export function presenceLook(status: PresenceStatus, user: Pick<UserPublic, "dnd_until"> | null | undefined, now = Date.now()): PresenceLook {
  return pausedUntil(user, new Date(now)) ? "dnd" : status;
}

/** My choice in the menu: 取り込み中 > オフライン表示 > 離席中 > 自動 (the same order others see it in). */
export function myPresenceChoice(me: Pick<UserMe, "dnd_until" | "presence_hidden" | "presence_manual"> | null | undefined, now = Date.now()): PresenceChoice {
  if (!me) return "auto";
  if (pausedUntil(me, new Date(now))) return "dnd";
  if (me.presence_hidden) return "invisible";
  if (me.presence_manual === "away") return "away";
  return "auto";
}

/**
 * Me as the menu reads it: my own fields from `me`, the public ones (dnd_until) from the users map when that is newer
 * (user.updated from another of my devices arrives before GET /users/me answers).
 */
export function currentMe(store: { me: UserMe | null; users: ReadonlyMap<string, UserPublic> }): UserMe | null {
  const me = store.me;
  if (!me) return null;
  const shared = store.users.get(me.id);
  return shared && Date.parse(shared.updated_at) > Date.parse(me.updated_at) ? { ...me, ...shared } : me;
}

/** The menu's durations, in order (the server works them out in the zone sent as `tz`). */
export const DND_DURATIONS: readonly DndDuration[] = ["30m", "1h", "2h", "4h", "today", "tomorrow", "forever"];

const DURATION_KEYS: Record<DndDuration, MessageKey> = {
  // The first three are the settings' 「通知を一時停止」 lengths, with their texts.
  "30m": "dnd.30m",
  "1h": "dnd.1h",
  "2h": "dnd.2h",
  "4h": "presence.duration.4h",
  today: "presence.duration.today",
  tomorrow: "presence.duration.tomorrow",
  forever: "presence.duration.forever",
};

export function durationLabel(duration: DndDuration): string {
  return t(DURATION_KEYS[duration]);
}

const CHOICE_KEYS: Record<PresenceChoice, MessageKey> = {
  auto: "presence.choice.auto",
  away: "presence.choice.away",
  dnd: "presence.choice.dnd",
  invisible: "presence.choice.invisible",
};

export function choiceLabel(choice: PresenceChoice): string {
  return t(CHOICE_KEYS[choice]);
}

/**
 * The body of PUT /users/me/presence (§11.4): 取り込み中 carries its length and this device's zone (the server works out
 * 今日 / 明日 in it); the other choices carry the status alone.
 */
export function presenceRequest(choice: PresenceChoice, duration?: DndDuration, tz = deviceTimeZone()): PresenceUpdate {
  return choice === "dnd" ? { status: "dnd", duration, tz } : { status: choice };
}

/** 「15:30」 today, 「10/10 23:59」 on another day, 「解除するまで」 for the indefinite pause (device's zone). */
export function dndEndLabel(until: string, now = new Date()): string {
  return isIndefiniteDnd(until) ? t("presence.untilCleared") : clockLabel(until, now);
}

/** The menu header's line: 「取り込み中（〜15:30）」, 「取り込み中（解除するまで）」, 「離席中」… */
export function myPresenceLine(me: Pick<UserMe, "dnd_until" | "presence_hidden" | "presence_manual"> | null | undefined, now = new Date()): string {
  const choice = myPresenceChoice(me, now.getTime());
  if (choice !== "dnd") return choiceLabel(choice);
  return dndLine(pausedUntil(me, now)!, now);
}

/** 「取り込み中（〜15:30）」 / 「取り込み中（解除するまで）」 (my menu, anyone's profile card). */
export function dndLine(until: string, now = new Date()): string {
  return isIndefiniteDnd(until) ? t("presence.dndForever") : t("presence.dndUntil", { when: dndEndLabel(until, now) });
}
