// @vitest-environment jsdom
// M68: 「繰り返し」 in the event dialog, the 3-way question for a recurring event's occurrence, the iCal feed dialog, and
// the hub's handling of series (read again, never expanded here).
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalendarEventOut, CalendarFeedOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { type CalendarApi, CalendarHub } from "../src/sync/calendar";
import { Store } from "../src/sync/store";
import { CalendarEventDialog } from "../src/ui/CalendarEventDialog";
import { CalendarFeedsDialog } from "../src/ui/CalendarFeedsDialog";
import { newDraft } from "../src/ui/calendarDates";
import { timed } from "./calendarFixtures";

afterEach(cleanup);

function setup() {
  const store = new Store();
  const hub = {
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => {}),
    setAlarm: vi.fn(async () => {}),
    updateOccurrence: vi.fn(async () => ({ id: "s2", series_id: "s2" })),
    removeOccurrence: vi.fn(async () => {}),
  };
  const feeds: CalendarFeedOut[] = [{ id: "f1", scope: "personal", created_at: "2026-10-01T00:00:00Z", last_used_at: null }];
  const api = {
    calendarFeeds: vi.fn(async () => feeds),
    createCalendarFeed: vi.fn(async (scope: string) => ({
      feed: { id: "f2", scope, created_at: "2026-10-02T00:00:00Z", last_used_at: null },
      url: "https://chat.example/api/v1/calendar/ical/secret-token.ics",
    })),
    deleteCalendarFeed: vi.fn(async () => {}),
  };
  const controller = { store, engine: { calendar: hub as unknown as CalendarHub }, isAdmin: false, api } as unknown as AppController;
  return { hub, api, controller };
}

const series = (extra: Partial<CalendarEventOut> = {}) =>
  timed("ゼミ", "2026-10-20T05:00:00Z", "2026-10-20T06:00:00Z", {
    id: "occ-3",
    series_id: "s1",
    occurrence_start: "2026-10-20T05:00:00Z",
    recurring: true,
    rrule: "FREQ=WEEKLY;BYDAY=TU",
    tz: "Asia/Tokyo",
    alarm: { minutes_before: 10, fire_at: "2026-10-20T04:50:00Z", status: "pending", occurrence_start: "2026-10-20T05:00:00Z" },
    ...extra,
  });

describe("the repeat picker", () => {
  it("makes a weekly event on chosen days, ending after a number of times", async () => {
    const { controller, hub } = setup();
    render(<CalendarEventDialog controller={controller} event={null} initial={{ ...newDraft("2026-10-13"), title: "ゼミ" }} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("繰り返し"), { target: { value: "weekly" } });
    const days = within(screen.getByRole("group", { name: "曜日" }));
    expect(days.getByRole("button", { name: "火曜日" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(days.getByRole("button", { name: "木曜日" }));
    fireEvent.change(screen.getByLabelText("繰り返しの終了"), { target: { value: "count" } });
    fireEvent.change(screen.getByLabelText("回数"), { target: { value: "8" } });
    expect(screen.getByText("毎週 火・木曜日、8 回")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "追加" })); });
    expect(hub.create.mock.calls[0]).toMatchObject([{ title: "ゼミ", rrule: "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=8" }]);
  });

  it("offers 第 N 曜日 for 毎月 and an interval for カスタム", async () => {
    const { controller, hub } = setup();
    render(<CalendarEventDialog controller={controller} event={null} initial={{ ...newDraft("2026-10-13"), title: "定例" }} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("繰り返し"), { target: { value: "monthly" } });
    const monthly = screen.getByLabelText("毎月の日") as HTMLSelectElement;
    expect([...monthly.options].map((o) => o.textContent)).toEqual(["毎月 13 日", "毎月 第 2 火曜日"]);
    fireEvent.change(monthly, { target: { value: "nth" } });
    expect(screen.getByText("毎月 第 2 火曜日", { selector: "[data-repeat-summary]" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("繰り返し"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("間隔"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("間隔の単位"), { target: { value: "DAILY" } });
    fireEvent.change(screen.getByLabelText("繰り返しの終了"), { target: { value: "until" } });
    fireEvent.change(screen.getByLabelText("繰り返しの終了日"), { target: { value: "2026-12-31" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "追加" })); });
    expect(hub.create.mock.calls[0]).toMatchObject([{ rrule: "FREQ=DAILY;INTERVAL=2;UNTIL=20261231" }]);
  });

  it("makes a one-off event recurring with PATCH", async () => {
    const { controller, hub } = setup();
    const event = timed("ゼミ", "2026-10-13T05:00:00Z", "2026-10-13T06:00:00Z");
    render(<CalendarEventDialog controller={controller} event={event} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("繰り返し"), { target: { value: "daily" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
    expect(hub.update).toHaveBeenCalledWith(event.id, expect.objectContaining({ rrule: "FREQ=DAILY", tz: "Asia/Tokyo" }));
    expect(hub.updateOccurrence).not.toHaveBeenCalled();
  });
});

describe("an occurrence of a recurring event", () => {
  it("asks which ones a change is for and sends only what changed", async () => {
    const { controller, hub } = setup();
    const onClose = vi.fn();
    render(<CalendarEventDialog controller={controller} event={series()} onClose={onClose} />);
    expect((screen.getByLabelText("繰り返し") as HTMLSelectElement).value).toBe("weekly");
    fireEvent.change(screen.getByLabelText("題名"), { target: { value: "ゼミ (休講)" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const ask = within(screen.getByRole("group", { name: "繰り返しの予定の変更" }));
    expect(ask.getAllByRole("button").map((b) => b.textContent)).toEqual(["この予定", "これ以降すべて", "すべての予定", "キャンセル"]);
    await act(async () => { fireEvent.click(ask.getByRole("button", { name: "この予定" })); });
    expect(hub.updateOccurrence).toHaveBeenCalledWith("s1", "2026-10-20T05:00:00Z", { scope: "this", title: "ゼミ (休講)" });
    expect(hub.update).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("does not offer 「この予定」 for a new rule, and sends the rule for the later ones", async () => {
    const { controller, hub } = setup();
    render(<CalendarEventDialog controller={controller} event={series()} onClose={() => {}} />);
    fireEvent.click(within(screen.getByRole("group", { name: "曜日" })).getByRole("button", { name: "木曜日" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const ask = within(screen.getByRole("group", { name: "繰り返しの予定の変更" }));
    expect(ask.queryByRole("button", { name: "この予定" })).toBeNull();
    await act(async () => { fireEvent.click(ask.getByRole("button", { name: "これ以降すべて" })); });
    expect(hub.updateOccurrence).toHaveBeenCalledWith("s1", "2026-10-20T05:00:00Z", { scope: "following", rrule: "FREQ=WEEKLY;BYDAY=TU,TH" });
  });

  it("changes only my alarm (on the series) without asking", async () => {
    const { controller, hub } = setup();
    render(<CalendarEventDialog controller={controller} event={series()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("通知"), { target: { value: "30" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
    expect(screen.queryByRole("group", { name: "繰り返しの予定の変更" })).toBeNull();
    expect(hub.setAlarm).toHaveBeenCalledWith("s1", 30);
    expect(hub.updateOccurrence).not.toHaveBeenCalled();
  });

  it("asks which ones to delete", async () => {
    const { controller, hub } = setup();
    render(<CalendarEventDialog controller={controller} event={series()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /削除/ }));
    const ask = within(screen.getByRole("group", { name: "繰り返しの予定の削除" }));
    await act(async () => { fireEvent.click(ask.getByRole("button", { name: "すべての予定" })); });
    expect(hub.removeOccurrence).toHaveBeenCalledWith("s1", "2026-10-20T05:00:00Z", "all");
    expect(hub.remove).not.toHaveBeenCalled();
  });

  it("shows the rule to someone who may not change it", () => {
    const { controller } = setup();
    render(<CalendarEventDialog controller={controller} event={series({ can_edit: false })} onClose={() => {}} />);
    expect(screen.getByText(/毎週 火曜日/)).toBeTruthy();
  });
});

describe("the iCal feed dialog", () => {
  it("makes a URL shown once, lists and deletes them", async () => {
    const { controller, api } = setup();
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    await act(async () => { render(<CalendarFeedsDialog controller={controller} onClose={() => {}} />); });
    expect(screen.getByText(/誰でも予定を見られます/)).toBeTruthy();
    expect(screen.getByText("自分のカレンダーだけ", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/URL で追加/)).toBeTruthy();
    expect(screen.getByText(/新規カレンダー照会/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "購読 URL を作る" })); });
    expect(api.createCalendarFeed).toHaveBeenCalledWith("all");
    const url = screen.getByLabelText("購読 URL") as HTMLInputElement;
    expect(url.value).toBe("https://chat.example/api/v1/calendar/ical/secret-token.ics");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /コピー/ })); });
    expect(writeText).toHaveBeenCalledWith(url.value);
    expect(screen.getAllByRole("button", { name: "この購読 URL を削除" })).toHaveLength(2);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "この購読 URL を削除" })[0]!); });
    expect(api.deleteCalendarFeed).toHaveBeenCalledWith("f1");
    expect(screen.getAllByRole("button", { name: "この購読 URL を削除" })).toHaveLength(1);
  });
});

describe("the hub and series", () => {
  const OCT = { from: "2026-10-01T00:00:00+09:00", to: "2026-11-01T00:00:00+09:00" };

  function fakeApi(rows: CalendarEventOut[]) {
    const state = { rows };
    const api: CalendarApi = {
      calendarEvents: vi.fn(async () => state.rows),
      calendarUpcoming: vi.fn(async () => []),
      createCalendarEvent: vi.fn(async () => series({ id: "s9", series_id: "s9" })),
      updateCalendarEvent: vi.fn(async () => state.rows[0]!),
      deleteCalendarEvent: vi.fn(async () => {}),
      setCalendarAlarm: vi.fn(async () => series({ id: "s1", alarm: { minutes_before: 30, fire_at: "2026-10-20T04:30:00Z", status: "pending", occurrence_start: "2026-10-20T05:00:00Z" } })),
      clearCalendarAlarm: vi.fn(async () => {}),
      getCalendarEvent: vi.fn(async () => state.rows[0]!),
      updateCalendarOccurrence: vi.fn(async () => series()),
      deleteCalendarOccurrence: vi.fn(async () => {}),
    };
    return { api, state };
  }

  const week = (n: number, extra: Partial<CalendarEventOut> = {}) =>
    series({ id: n === 0 ? "s1" : `occ-${n}`, occurrence_start: `2026-10-${String(6 + 7 * n).padStart(2, "0")}T05:00:00Z`, starts_at: `2026-10-${String(6 + 7 * n).padStart(2, "0")}T05:00:00Z`, ends_at: `2026-10-${String(6 + 7 * n).padStart(2, "0")}T06:00:00Z`, ...extra });

  it("reads the windows again when a series changes, and drops a deleted series whole", async () => {
    const rows = [week(0), week(1), week(2)];
    const { api, state } = fakeApi(rows);
    const hub = new CalendarHub({ api, me: () => "me" });
    await hub.open("view", OCT.from, OCT.to);
    expect(hub.window("view")!.events).toHaveLength(3);
    state.rows = [week(0), week(2)];
    const { can_edit: _c, alarm: _a, ...shared } = week(0);
    hub.applyEvent("calendar.event.updated", { event: shared, editor_ids: ["me"] });
    await vi.waitFor(() => expect(hub.window("view")!.events).toHaveLength(2));
    expect(api.calendarEvents).toHaveBeenCalledTimes(2);
    hub.applyEvent("calendar.event.deleted", { id: "s1", channel_id: null });
    expect(hub.window("view")!.events).toEqual([]);
  });

  it("applies my alarm to every occurrence and announces the one it fired for", async () => {
    const { api } = fakeApi([week(0), week(1), week(2)]);
    const onAlarm = vi.fn();
    const hub = new CalendarHub({ api, me: () => "me", onAlarm });
    await hub.open("view", OCT.from, OCT.to);
    await hub.setAlarm("s1", 30);
    expect(hub.window("view")!.events.every((e) => e.alarm?.minutes_before === 30)).toBe(true);
    hub.applyEvent("calendar.alarm.updated", { event_id: "s1", channel_id: null, alarm: { minutes_before: 30, fire_at: "2026-10-13T04:30:00Z", status: "fired", occurrence_start: "2026-10-13T05:00:00Z" } });
    await vi.waitFor(() => expect(onAlarm).toHaveBeenCalledTimes(1));
    expect(onAlarm.mock.calls[0]![0].id).toBe("occ-1");
    // The alarm moves on to the next occurrence, then fires for it: announced again.
    hub.applyEvent("calendar.alarm.updated", { event_id: "s1", channel_id: null, alarm: { minutes_before: 30, fire_at: "2026-10-20T04:30:00Z", status: "pending", occurrence_start: "2026-10-20T05:00:00Z" } });
    hub.applyEvent("calendar.alarm.updated", { event_id: "s1", channel_id: null, alarm: { minutes_before: 30, fire_at: "2026-10-20T04:30:00Z", status: "fired", occurrence_start: "2026-10-20T05:00:00Z" } });
    await vi.waitFor(() => expect(onAlarm).toHaveBeenCalledTimes(2));
    expect(onAlarm.mock.calls[1]![0].id).toBe("occ-2");
  });

  it("drops the occurrences a delete took and reads the window again", async () => {
    const { api } = fakeApi([week(0), week(1), week(2)]);
    const hub = new CalendarHub({ api, me: () => "me" });
    await hub.open("view", OCT.from, OCT.to);
    (api.calendarEvents as ReturnType<typeof vi.fn>).mockImplementation(async () => [week(0)]);
    await hub.removeOccurrence("s1", "2026-10-13T05:00:00Z", "following");
    expect(api.deleteCalendarOccurrence).toHaveBeenCalledWith("s1", "2026-10-13T05:00:00Z", "following");
    expect(hub.window("view")!.events.map((e) => e.id)).toEqual(["s1"]);
    // A series made here is read, not put in by hand.
    await hub.create({ title: "x", all_day: false });
    expect(api.calendarEvents).toHaveBeenCalledTimes(3);
  });
});
