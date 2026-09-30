// M51: the calendar's date math (ui/calendarDates.ts), in Tokyo like the lab's devices.
process.env.TZ = "Asia/Tokyo";

import { describe, expect, it } from "vitest";

import {
  addDays,
  alarmChoices,
  channelColor,
  dayBlocks,
  daysBetween,
  draftFromEvent,
  draftProblem,
  draftToCreate,
  draftToPatch,
  eventDays,
  eventsOn,
  eventWhen,
  isoLocal,
  monthGrid,
  newDraft,
  OWN_COLOR,
  overlapsRange,
  rangeFor,
  rangeParams,
  remapAlarm,
  timeOnDay,
  weekStart,
} from "../src/ui/calendarDates";
import { allDay, timed } from "./calendarFixtures";

describe("weeks start on Sunday (日曜始まり)", () => {
  it("builds the month grid from the Sunday before the 1st to the Saturday after the last day", () => {
    const weeks = monthGrid("2026-10-15"); // 1 Oct 2026 is a Thursday
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(weeks[4]![6]).toBe("2026-10-31");
    expect(monthGrid("2026-02-01")).toHaveLength(4); // Feb 2026: Sunday the 1st to Saturday the 28th
    expect(monthGrid("2026-08-01")).toHaveLength(6); // Aug 2026: Saturday the 1st, 31 days
    expect(weekStart("2026-10-01")).toBe("2026-09-27");
    expect(weekStart("2026-10-04")).toBe("2026-10-04");
  });

  it("gives each mode its days and sends them as local midnights", () => {
    expect(rangeFor("month", "2026-10-15")).toEqual({ start: "2026-09-27", end: "2026-11-01" });
    expect(rangeFor("week", "2026-10-01")).toEqual({ start: "2026-09-27", end: "2026-10-04" });
    expect(rangeFor("list", "2026-10-01")).toEqual({ start: "2026-10-01", end: "2026-11-30" });
    expect(rangeParams("2026-10-01", "2026-10-02")).toEqual({ from: "2026-10-01T00:00:00+09:00", to: "2026-10-02T00:00:00+09:00" });
    expect(isoLocal(new Date("2026-10-01T05:30:00Z"))).toBe("2026-10-01T14:30:00+09:00");
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("timed and all-day events", () => {
  it("covers the local days of a timed event up to the instant before its end", () => {
    // 23:00–01:00 Tokyo crosses midnight; one ending exactly at midnight stays on its day.
    expect(eventDays(timed("late", "2026-10-01T14:00:00Z", "2026-10-01T16:00:00Z"))).toEqual({ first: "2026-10-01", last: "2026-10-02" });
    expect(eventDays(timed("to midnight", "2026-10-01T13:00:00Z", "2026-10-01T15:00:00Z"))).toEqual({ first: "2026-10-01", last: "2026-10-01" });
    expect(eventDays(allDay("学会", "2026-10-05", "2026-10-07"))).toEqual({ first: "2026-10-05", last: "2026-10-07" });
  });

  it("overlaps a range like the server: instants for timed events, dates for all-day ones", () => {
    const from = "2026-10-01T00:00:00+09:00";
    const to = "2026-10-02T00:00:00+09:00";
    expect(overlapsRange(timed("ends at from", "2026-09-30T14:00:00Z", "2026-09-30T15:00:00Z"), from, to)).toBe(false);
    expect(overlapsRange(timed("starts at to", "2026-10-01T15:00:00Z", "2026-10-01T16:00:00Z"), from, to)).toBe(false);
    expect(overlapsRange(timed("inside", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z"), from, to)).toBe(true);
    expect(overlapsRange(timed("around", "2026-09-30T00:00:00Z", "2026-10-03T00:00:00Z"), from, to)).toBe(true);
    expect(overlapsRange(allDay("on the day", "2026-10-01"), from, to)).toBe(true);
    expect(overlapsRange(allDay("next day", "2026-10-02"), from, to)).toBe(false);
    expect(overlapsRange(allDay("day before", "2026-09-30"), from, to)).toBe(false);
    expect(overlapsRange(allDay("span", "2026-09-20", "2026-10-10"), from, to)).toBe(true);
  });

  it("orders a day's events: all-day and continuing ones first, then by time", () => {
    const events = [
      timed("14:00", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z"),
      timed("9:30", "2026-10-01T00:30:00Z", "2026-10-01T01:00:00Z"),
      allDay("学会", "2026-10-01"),
      timed("前日から", "2026-09-30T14:00:00Z", "2026-10-01T01:00:00Z"),
      allDay("明日", "2026-10-02"),
    ];
    expect(eventsOn(events, "2026-10-01").map((e) => e.title)).toEqual(["前日から", "学会", "9:30", "14:00"]);
    const overnight = events[3]!;
    expect(timeOnDay(overnight, "2026-09-30")).toBe("23:00〜");
    expect(timeOnDay(overnight, "2026-10-01")).toBe("〜10:00");
    expect(timeOnDay(events[0]!, "2026-10-01")).toBe("14:00〜15:00");
    expect(timeOnDay(events[2]!, "2026-10-01")).toBe("終日");
    expect(eventWhen(events[0]!)).toBe("10月1日 (木) 14:00〜15:00");
    expect(eventWhen(allDay("学会", "2026-10-05", "2026-10-07"))).toBe("10月5日 (月)〜10月7日 (水) 終日");
  });

  it("puts overlapping timed events side by side in the week view", () => {
    const blocks = dayBlocks(
      [
        timed("a", "2026-10-01T01:00:00Z", "2026-10-01T03:00:00Z"), // 10:00–12:00
        timed("b", "2026-10-01T02:00:00Z", "2026-10-01T03:00:00Z"), // 11:00–12:00
        timed("c", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z"), // 14:00–15:00
        allDay("all day", "2026-10-01"),
      ],
      "2026-10-01",
    );
    expect(blocks.map((b) => [b.event.title, b.top, b.height, b.lane, b.lanes])).toEqual([
      ["a", 600, 120, 0, 2],
      ["b", 660, 60, 1, 2],
      ["c", 840, 60, 0, 1],
    ]);
  });
});

describe("the event form", () => {
  const base = { ...newDraft("2026-10-01", "me", new Date("2026-09-01T00:00:00Z")), title: "ゼミ" };

  it("says what is wrong before sending", () => {
    expect(draftProblem(base)).toBeNull();
    expect(draftProblem({ ...base, title: "  " })).toBe("題名を入れてください");
    expect(draftProblem({ ...base, title: "x".repeat(201) })).toBe("題名は 200 文字までです");
    expect(draftProblem({ ...base, location: "x".repeat(201) })).toBe("場所は 200 文字までです");
    expect(draftProblem({ ...base, description: "x".repeat(4001) })).toBe("説明は 4000 文字までです");
    expect(draftProblem({ ...base, endTime: base.startTime })).toBe("終了は開始より後にしてください");
    expect(draftProblem({ ...base, endDay: "2026-10-16" })).toBe("時刻の予定は 14 日までです");
    expect(draftProblem({ ...base, allDay: true, endDay: "2026-09-30" })).toBe("終了日は開始日より後にしてください");
    expect(draftProblem({ ...base, allDay: true, endDay: "2026-11-30" })).toBe("終日の予定は 60 日までです");
    expect(draftProblem({ ...base, allDay: true, endDay: "2026-11-29" })).toBeNull();
  });

  it("sends a timed event as UTC instants and an all-day one as dates", () => {
    const timedBody = draftToCreate({ ...base, startTime: "14:00", endTime: "15:30", alarm: 10, calendar: "c1", location: " 5 号館 " }, "Asia/Tokyo", "k1");
    expect(timedBody).toMatchObject({
      channel_id: "c1",
      title: "ゼミ",
      all_day: false,
      starts_at: "2026-10-01T05:00:00.000Z",
      ends_at: "2026-10-01T06:30:00.000Z",
      start_date: null,
      location: "5 号館",
      description: null,
      alarm_minutes: 10,
      tz: "Asia/Tokyo",
      client_event_id: "k1",
    });
    const dayBody = draftToCreate({ ...base, allDay: true, endDay: "2026-10-03", alarm: -480 }, "Asia/Tokyo", "k2");
    expect(dayBody).toMatchObject({ channel_id: null, all_day: true, starts_at: null, ends_at: null, start_date: "2026-10-01", end_date: "2026-10-03", alarm_minutes: -480 });
    expect(draftToPatch({ ...base, allDay: true })).toMatchObject({ all_day: true, start_date: "2026-10-01", end_date: "2026-10-01", starts_at: null });
  });

  it("reads an event back into the form in local time", () => {
    const draft = draftFromEvent(timed("ゼミ", "2026-10-01T05:00:00Z", "2026-10-01T06:30:00Z", { channel_id: "c1", alarm: { minutes_before: 30, fire_at: "", status: "pending" } }));
    expect(draft).toMatchObject({ startDay: "2026-10-01", startTime: "14:00", endTime: "15:30", calendar: "c1", alarm: 30, allDay: false });
  });

  it("offers the alarms of the event's kind and keeps 前日 when it switches", () => {
    expect(alarmChoices(false).map((c) => c.value)).toEqual([null, 0, 5, 10, 15, 30, 60, 1440]);
    expect(alarmChoices(true).map((c) => c.label)).toEqual(["なし", "前日 8:00", "当日 8:00"]);
    expect(remapAlarm(30, true)).toBe(-480);
    expect(remapAlarm(1440, true)).toBe(1440);
    expect(remapAlarm(-480, false)).toBe(60);
    expect(remapAlarm(null, true)).toBeNull();
  });
});

describe("colours", () => {
  it("gives each channel one fixed colour, the same on every device, and mine slate", () => {
    const id = "0199a0b0-1111-7000-8000-000000000001";
    expect(channelColor(id)).toBe(channelColor(id));
    expect(channelColor(id)).toMatch(/^#[0-9a-f]{6}$/);
    expect(channelColor(null)).toBe(OWN_COLOR);
    const colours = new Set(Array.from({ length: 20 }, (_, i) => channelColor(`channel-${i}`)));
    expect(colours.size).toBeGreaterThan(4);
  });
});
