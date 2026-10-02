// M68: 「繰り返し」 — the picker to a rule (normalized as the server stores it), a rule back to the picker and to words.
process.env.TZ = "Asia/Tokyo";

import { describe, expect, it } from "vitest";

import { draftChanges, draftFromEvent, draftProblem, draftToCreate, newDraft } from "../src/ui/calendarDates";
import {
  describeRrule,
  monthlyChoices,
  noRepeat,
  nthOfMonth,
  type RepeatDraft,
  repeatProblem,
  repeatToRrule,
  ruleChanged,
  rruleToRepeat,
} from "../src/ui/calendarRecurrence";
import { timed } from "./calendarFixtures";

const TUESDAY = "2026-10-13"; // the 2nd Tuesday of October 2026
const repeat = (patch: Partial<RepeatDraft>, start = TUESDAY): RepeatDraft => ({ ...noRepeat(start), ...patch });

describe("the picker to a rule", () => {
  it("makes the presets", () => {
    expect(repeatToRrule(repeat({ kind: "none" }), TUESDAY)).toBeNull();
    expect(repeatToRrule(repeat({ kind: "daily" }), TUESDAY)).toBe("FREQ=DAILY");
    // 毎週 starts with the start's weekday; the days go Monday first, as the server stores them.
    expect(repeatToRrule(repeat({ kind: "weekly" }), TUESDAY)).toBe("FREQ=WEEKLY;BYDAY=TU");
    expect(repeatToRrule(repeat({ kind: "weekly", weekdays: [4, 0, 2] }), TUESDAY)).toBe("FREQ=WEEKLY;BYDAY=TU,TH,SU");
    expect(repeatToRrule(repeat({ kind: "monthly" }), TUESDAY)).toBe("FREQ=MONTHLY;BYMONTHDAY=13");
    expect(repeatToRrule(repeat({ kind: "monthly", monthly: "nth" }), TUESDAY)).toBe("FREQ=MONTHLY;BYDAY=2TU");
    expect(repeatToRrule(repeat({ kind: "monthly", monthly: "last" }, "2026-10-30"), "2026-10-30")).toBe("FREQ=MONTHLY;BYDAY=-1FR");
    expect(repeatToRrule(repeat({ kind: "monthly", monthly: "monthEnd" }, "2026-10-31"), "2026-10-31")).toBe("FREQ=MONTHLY;BYMONTHDAY=-1");
    expect(repeatToRrule(repeat({ kind: "yearly" }), TUESDAY)).toBe("FREQ=YEARLY");
  });

  it("makes a custom rule with an interval and an end", () => {
    expect(repeatToRrule(repeat({ kind: "custom", freq: "WEEKLY", interval: 2, weekdays: [1, 3] }), TUESDAY)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE");
    expect(repeatToRrule(repeat({ kind: "custom", freq: "DAILY", interval: 3, end: "count", count: 10 }), TUESDAY)).toBe("FREQ=DAILY;INTERVAL=3;COUNT=10");
    expect(repeatToRrule(repeat({ kind: "daily", end: "until", until: "2026-12-20" }), TUESDAY)).toBe("FREQ=DAILY;UNTIL=20261220");
    // A preset has no interval of its own.
    expect(repeatToRrule(repeat({ kind: "daily", interval: 5 }), TUESDAY)).toBe("FREQ=DAILY");
  });

  it("reads a rule back into the picker", () => {
    expect(rruleToRepeat("FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261220", TUESDAY)).toMatchObject({ kind: "weekly", weekdays: [2, 4], end: "until", until: "2026-12-20" });
    expect(rruleToRepeat("FREQ=MONTHLY;BYDAY=2TU;COUNT=5", TUESDAY)).toMatchObject({ kind: "monthly", monthly: "nth", end: "count", count: 5 });
    expect(rruleToRepeat("FREQ=MONTHLY;BYDAY=-1FR", "2026-10-30")).toMatchObject({ kind: "monthly", monthly: "last" });
    expect(rruleToRepeat("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-10-31")).toMatchObject({ kind: "monthly", monthly: "monthEnd" });
    expect(rruleToRepeat("FREQ=DAILY;INTERVAL=2", TUESDAY)).toMatchObject({ kind: "custom", freq: "DAILY", interval: 2 });
    expect(rruleToRepeat(null, TUESDAY).kind).toBe("none");
    for (const rule of ["FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "FREQ=MONTHLY;BYDAY=2TU;COUNT=5", "FREQ=YEARLY;UNTIL=20301013"]) {
      expect(repeatToRrule(rruleToRepeat(rule, TUESDAY), TUESDAY)).toBe(rule);
    }
  });

  it("tells a changed rule from the same one written differently", () => {
    expect(ruleChanged(rruleToRepeat("FREQ=WEEKLY", TUESDAY), TUESDAY, "FREQ=WEEKLY")).toBe(false);
    expect(ruleChanged(repeat({ kind: "weekly" }), TUESDAY, "FREQ=WEEKLY;BYDAY=TU")).toBe(false);
    expect(ruleChanged(repeat({ kind: "weekly", weekdays: [2, 4] }), TUESDAY, "FREQ=WEEKLY;BYDAY=TU")).toBe(true);
    expect(ruleChanged(repeat({ kind: "none" }), TUESDAY, "FREQ=DAILY")).toBe(true);
    expect(ruleChanged(repeat({ kind: "none" }), TUESDAY, null)).toBe(false);
  });

  it("offers the month's choices for the day", () => {
    expect(nthOfMonth(TUESDAY)).toEqual({ n: 2, last: false });
    expect(monthlyChoices(TUESDAY).map((c) => c.label)).toEqual(["毎月 13 日", "毎月 第 2 火曜日"]);
    expect(monthlyChoices("2026-10-27").map((c) => c.label)).toEqual(["毎月 27 日", "毎月 第 4 火曜日", "毎月 最終 火曜日"]);
    expect(monthlyChoices("2026-10-31").map((c) => c.label)).toEqual(["毎月 31 日", "毎月 月末", "毎月 最終 土曜日"]);
    // A 5th weekday is only 「最終」.
    expect(monthlyChoices("2026-10-29").map((c) => c.value)).toEqual(["day", "last"]);
  });

  it("checks the picker", () => {
    expect(repeatProblem(repeat({ kind: "weekly", weekdays: [] }), TUESDAY)).toBe("曜日を選んでください");
    expect(repeatProblem(repeat({ kind: "custom", interval: 0 }), TUESDAY)).toBe("間隔は 1〜99 にしてください");
    expect(repeatProblem(repeat({ kind: "daily", end: "until", until: "2026-10-01" }), TUESDAY)).toBe("終了日は開始日より後にしてください");
    expect(repeatProblem(repeat({ kind: "daily", end: "count", count: 1000 }), TUESDAY)).toBe("回数は 1〜999 にしてください");
    expect(repeatProblem(repeat({ kind: "daily", end: "count", count: 3 }), TUESDAY)).toBeNull();
    expect(draftProblem({ ...newDraft(TUESDAY), title: "x", repeat: repeat({ kind: "weekly", weekdays: [] }) })).toBe("曜日を選んでください");
  });
});

describe("a rule in words", () => {
  it.each([
    ["FREQ=DAILY", "毎日"],
    ["FREQ=DAILY;INTERVAL=3", "3 日ごと"],
    ["FREQ=WEEKLY;BYDAY=TU,TH", "毎週 火・木曜日"],
    ["FREQ=WEEKLY", "毎週 火曜日"],
    ["FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2 週間ごと 月曜日"],
    ["FREQ=MONTHLY;BYMONTHDAY=10", "毎月 10 日"],
    ["FREQ=MONTHLY", "毎月 13 日"],
    ["FREQ=MONTHLY;BYMONTHDAY=-1", "毎月 月末"],
    ["FREQ=MONTHLY;BYDAY=2TU", "毎月 第 2 火曜日"],
    ["FREQ=MONTHLY;BYDAY=-1FR", "毎月 最終 金曜日"],
    ["FREQ=YEARLY", "毎年 10月13日"],
    ["FREQ=WEEKLY;BYDAY=TU;UNTIL=20261220", "毎週 火曜日、2026年12月20日まで"],
    ["FREQ=DAILY;COUNT=10", "毎日、10 回"],
  ])("%s → %s", (rule, words) => {
    expect(describeRrule(rule, TUESDAY)).toBe(words);
  });
});

describe("the form with a rule", () => {
  it("sends the rule when made, and only what changed for an occurrence", () => {
    const draft = { ...newDraft(TUESDAY), title: "ゼミ", repeat: repeat({ kind: "weekly", weekdays: [2, 4] }) };
    expect(draftToCreate(draft, "Asia/Tokyo", "k").rrule).toBe("FREQ=WEEKLY;BYDAY=TU,TH");
    expect(draftToCreate({ ...draft, repeat: noRepeat(TUESDAY) }, "Asia/Tokyo", "k").rrule).toBeNull();

    const event = timed("ゼミ", "2026-10-13T05:00:00Z", "2026-10-13T06:00:00Z", { recurring: true, rrule: "FREQ=WEEKLY;BYDAY=TU", series_id: "s1", occurrence_start: "2026-10-13T05:00:00Z" });
    const opened = draftFromEvent(event);
    expect(opened.repeat).toMatchObject({ kind: "weekly", weekdays: [2] });
    expect(draftChanges(opened, opened)).toEqual({});
    expect(draftChanges({ ...opened, title: "輪講" }, opened)).toEqual({ title: "輪講" });
    expect(draftChanges({ ...opened, location: "501" }, opened)).toEqual({ location: "501" });
    expect(draftChanges({ ...opened, startTime: "15:00", endTime: "16:00" }, opened)).toEqual({
      all_day: false,
      starts_at: "2026-10-13T06:00:00.000Z",
      ends_at: "2026-10-13T07:00:00.000Z",
      start_date: null,
      end_date: null,
    });
  });
});
