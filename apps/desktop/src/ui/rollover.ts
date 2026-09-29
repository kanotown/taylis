/**
 * The yearly rollover (L7 / M32, DATA_MODEL.md lab_rollovers): the academic year, the choices per student and the body
 * `POST /lab/rollovers` takes. The proposal itself (B3・B4・M1・D1・D2 move up, M2・D3 finish) comes from the preview.
 */
import type { RolloverAction, RolloverApply, RolloverOut, RolloverPreviewItem } from "../api/types";

/** The Japanese academic year a day falls in: April to March (2027-03-31 → 2026, 2027-04-01 → 2027). */
export function academicYear(day: Date): number {
  return day.getMonth() < 3 ? day.getFullYear() - 1 : day.getFullYear();
}

export interface RolloverChoice {
  action: RolloverAction;
  /** Graduates only: become a guest (not for myself: 409 cannot_modify_self). */
  guest: boolean;
  /** Graduates only: channels they stay in (from the row's `channels`). */
  keep: ReadonlySet<string>;
}

/** 進級 (→ M1) / 据え置き / 卒業・修了; no 進級 without a next grade (D3, or no grade: 422 rollover_cannot_advance). */
export function actionOptions(item: RolloverPreviewItem): Array<[RolloverAction, string]> {
  return [
    ...(item.next_grade ? [["advance", `進級 (→ ${item.next_grade})`] as [RolloverAction, string]] : []),
    ["stay", "据え置き"],
    ["graduate", "卒業・修了"],
  ];
}

/** The server's proposal; a graduate becomes a guest unless `guestByDefault` is false (me, administrators). */
export function defaultChoice(item: RolloverPreviewItem, guestByDefault: boolean): RolloverChoice {
  const action = item.action === "advance" && !item.next_grade ? "stay" : item.action;
  return { action, guest: guestByDefault, keep: new Set() };
}

/**
 * Everyone in the preview, as chosen: guest and kept channels only for graduates; the channels every graduate joins and
 * stays in (the OB/OG one, the all-hands one: with DMs, all a graduate still sees).
 */
export function rolloverBody(
  year: number,
  items: readonly RolloverPreviewItem[],
  choices: ReadonlyMap<string, RolloverChoice>,
  stayChannelIds: readonly string[],
): RolloverApply {
  const stay = new Set(stayChannelIds);
  return {
    academic_year: year,
    stay_channel_ids: [...stay],
    items: items.map((item) => {
      const choice = choices.get(item.user_id) ?? defaultChoice(item, false);
      const graduate = choice.action === "graduate";
      const listed = new Set(item.channels.map((c) => c.id));
      return {
        user_id: item.user_id,
        action: choice.action,
        guest: graduate && choice.guest,
        keep_channel_ids: graduate ? [...choice.keep].filter((id) => listed.has(id) && !stay.has(id)) : [],
      };
    }),
  };
}

export function rolloverCounts(body: RolloverApply): { advance: number; stay: number; graduate: number; guests: number } {
  const count = (action: RolloverAction) => body.items.filter((i) => i.action === action).length;
  return { advance: count("advance"), stay: count("stay"), graduate: count("graduate"), guests: body.items.filter((i) => i.guest).length };
}

/** 「進級 3 · 据え置き 1 · 卒業・修了 2」 */
export function rolloverSummary(out: Pick<RolloverOut, "advanced" | "stayed" | "graduated">): string {
  return `進級 ${out.advanced} · 据え置き ${out.stayed} · 卒業・修了 ${out.graduated}`;
}
