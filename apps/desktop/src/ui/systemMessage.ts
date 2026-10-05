/**
 * M88 (docs/MEMBERSHIP.md §1): the line a system message (type "system") shows — the join / leave lines. Written from
 * its `system_event` with the names in the directory today (a renamed person reads with the new name); the body (names
 * as they were, written by the server) stands in when the event is missing, of a kind this version does not know, or
 * names someone the directory does not have.
 */
import type { MessageOut } from "../api/types";
import { t } from "../i18n";

export type SystemEvent = NonNullable<MessageOut["system_event"]>;

/** Whether a row is a system line (rendered as one muted line, never grouped, no actions). */
export function isSystemMessage(message: { type?: string | null }): boolean {
  return (message.type ?? "user") !== "user";
}

/** M90: past this many people a line lists the first ones and 「ほか N 人」 (the server's MEMBERSHIP_NAMES_SHOWN). */
export const NAMES_SHOWN = 10;

/** 「A、B」 as the server writes the list (the Japanese comma, no 「と」); 「A、… J ほか N 人」 past NAMES_SHOWN. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= NAMES_SHOWN) return names.join(t("common.listSeparator"));
  return t("activity.andOthers", { name: names.slice(0, NAMES_SHOWN).join(t("common.listSeparator")), count: names.length - NAMES_SHOWN });
}

export function systemMessageText(message: Pick<MessageOut, "body" | "system_event">, nameOf: (userId: string) => string | undefined): string {
  const event = message.system_event;
  if (!event) return message.body;
  const actor = nameOf(event.actor_id);
  const others = event.user_ids.map(nameOf);
  if (actor === undefined || others.some((name) => name === undefined)) return message.body;
  const list = joinNames(others as string[]);
  switch (event.kind) {
    case "member_joined":
      return t("system.joined", { actor });
    case "member_left":
      return t("system.left", { actor });
    case "members_added":
      return t("system.added", { actor, list });
    case "member_removed":
      return t("system.removed", { actor, list });
    default:
      return message.body;
  }
}
