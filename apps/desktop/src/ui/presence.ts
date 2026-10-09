import type { DndDuration, PresenceChoice, PresenceLook, PresenceStatus, UserMe, UserPublic } from "../api/types";
import { t, type MessageKey } from "../i18n";

/**
 * The quick status menu (docs/PRESENCE.md §11). 取り込み中 is `dnd_until` (the M12c pause, public), オフライン表示 is
 * `presence_hidden` (L4), 離席中 is `presence_manual: "away"` (the hub then announces me as away). The rules here are
 * the ones the phones copy.
 */

/** A dnd_until at or after this instant means 「解除するまで」 (the server stores 9999-12-31T00:00:00Z). */
export const DND_INDEFINITE_FROM = Date.UTC(9999, 0, 1);

export function isIndefiniteDnd(until: string | null | undefined): boolean {
  if (!until) return false;
  const at = Date.parse(until);
  return !Number.isNaN(at) && at >= DND_INDEFINITE_FROM;
}

/** The manual pause (取り込み中) still running, else null. Quiet hours are not 取り込み中 (they keep the 🔕 only). */
export function dndUntil(user: Pick<UserPublic, "dnd_until"> | null | undefined, now = Date.now()): string | null {
  const until = user?.dnd_until;
  if (!until) return null;
  const at = Date.parse(until);
  return !Number.isNaN(at) && at > now ? until : null;
}

/** What an avatar shows: 取り込み中 beats the connection (online, away or offline alike, as in Mattermost). */
export function presenceLook(status: PresenceStatus, user: Pick<UserPublic, "dnd_until"> | null | undefined, now = Date.now()): PresenceLook {
  return dndUntil(user, now) ? "dnd" : status;
}

/** My choice in the menu: 取り込み中 > オフライン表示 > 離席中 > 自動 (the same order others see it in). */
export function myPresenceChoice(me: Pick<UserMe, "dnd_until" | "presence_hidden" | "presence_manual"> | null | undefined, now = Date.now()): PresenceChoice {
  if (!me) return "auto";
  if (dndUntil(me, now)) return "dnd";
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
  "30m": "presence.duration.30m",
  "1h": "presence.duration.1h",
  "2h": "presence.duration.2h",
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

const hhmm = (at: Date) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

/** 「15:30」 today, 「10/10 23:59」 on another day, 「解除するまで」 for the indefinite pause (device's zone). */
export function dndEndLabel(until: string, now = new Date()): string {
  if (isIndefiniteDnd(until)) return t("presence.untilCleared");
  const at = new Date(until);
  return at.toDateString() === now.toDateString() ? hhmm(at) : `${at.getMonth() + 1}/${at.getDate()} ${hhmm(at)}`;
}

/** The menu header's line: 「取り込み中（〜15:30）」, 「取り込み中（解除するまで）」, 「離席中」… */
export function myPresenceLine(me: Pick<UserMe, "dnd_until" | "presence_hidden" | "presence_manual"> | null | undefined, now = new Date()): string {
  const choice = myPresenceChoice(me, now.getTime());
  if (choice !== "dnd") return choiceLabel(choice);
  return dndLine(dndUntil(me, now.getTime())!, now);
}

/** 「取り込み中（〜15:30）」 / 「取り込み中（解除するまで）」 (my menu, anyone's profile card). */
export function dndLine(until: string, now = new Date()): string {
  return isIndefiniteDnd(until) ? t("presence.dndForever") : t("presence.dndUntil", { when: dndEndLabel(until, now) });
}
