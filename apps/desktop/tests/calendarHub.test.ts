// M51: the calendar on this device (sync/calendar.ts): windows on ranges, calendar.* events, reconnecting.
process.env.TZ = "Asia/Tokyo";

import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { CalendarEventOut } from "../src/api/types";
import { type CalendarApi, CalendarHub } from "../src/sync/calendar";
import { allDay, timed } from "./calendarFixtures";

const OCT = { from: "2026-10-01T00:00:00+09:00", to: "2026-11-01T00:00:00+09:00" };

function fakeApi(rows: CalendarEventOut[] = []) {
  const state = { rows, upcoming: [] as CalendarEventOut[] };
  const api: CalendarApi = {
    calendarEvents: vi.fn(async (_from: string, _to: string, channelId?: string | null) => state.rows.filter((e) => !channelId || e.channel_id === channelId)),
    calendarUpcoming: vi.fn(async () => state.upcoming),
    createCalendarEvent: vi.fn(async (body) => timed(body.title, body.starts_at!, body.ends_at!, { id: "new" })),
    updateCalendarEvent: vi.fn(async (id, patch) => ({ ...state.rows.find((e) => e.id === id)!, ...patch }) as CalendarEventOut),
    deleteCalendarEvent: vi.fn(async () => {}),
    setCalendarAlarm: vi.fn(async (id, minutes) => ({ ...state.rows.find((e) => e.id === id)!, alarm: { minutes_before: minutes, fire_at: "2026-10-05T04:50:00Z", status: "pending" as const } })),
    clearCalendarAlarm: vi.fn(async () => {}),
    getCalendarEvent: vi.fn(async (id) => state.rows.find((e) => e.id === id)!),
  };
  return { api, state };
}

const shared = (event: CalendarEventOut) => {
  const { can_edit: _canEdit, alarm: _alarm, ...rest } = event;
  return rest;
};

describe("the calendar hub", () => {
  it("reads a window and keeps the events that overlap it current", async () => {
    const zemi = timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", { channel_id: "c1", channel_name: "lab", owner_id: "bob", can_edit: false, alarm: { minutes_before: 10, fire_at: "2026-10-05T04:50:00Z", status: "pending" } });
    const { api } = fakeApi([zemi]);
    const hub = new CalendarHub({ api, me: () => "me" });
    await hub.open("view", OCT.from, OCT.to);
    expect(hub.window("view")!.state).toBe("ready");
    expect(hub.window("view")!.events.map((e) => e.title)).toEqual(["ゼミ"]);

    // Changed by someone else: my alarm stays, can_edit follows editor_ids.
    hub.applyEvent("calendar.event.updated", { event: { ...shared(zemi), title: "ゼミ (変更)" }, editor_ids: ["bob", "me"] });
    const changed = hub.window("view")!.events[0]!;
    expect(changed.title).toBe("ゼミ (変更)");
    expect(changed.can_edit).toBe(true);
    expect(changed.alarm?.minutes_before).toBe(10);

    // A new one inside the range comes in, in order; one outside is dropped.
    const early = allDay("学会", "2026-10-02", "2026-10-03", { channel_id: "c2" });
    hub.applyEvent("calendar.event.updated", { event: shared(early), editor_ids: [] });
    hub.applyEvent("calendar.event.updated", { event: shared(allDay("来月", "2026-11-01")), editor_ids: ["me"] });
    expect(hub.window("view")!.events.map((e) => e.title)).toEqual(["学会", "ゼミ (変更)"]);
    expect(hub.window("view")!.events[0]!.can_edit).toBe(false);

    // Moved out of the range: it leaves. Deleted: gone.
    hub.applyEvent("calendar.event.updated", { event: { ...shared(zemi), starts_at: "2026-11-05T05:00:00Z", ends_at: "2026-11-05T06:00:00Z" }, editor_ids: [] });
    expect(hub.window("view")!.events.map((e) => e.title)).toEqual(["学会"]);
    hub.applyEvent("calendar.event.deleted", { id: early.id, channel_id: "c2" });
    expect(hub.window("view")!.events).toEqual([]);
  });

  it("keeps a channel's window to that channel", async () => {
    const { api } = fakeApi([]);
    const hub = new CalendarHub({ api, me: () => "me" });
    await hub.open("channel:c1", OCT.from, OCT.to, "c1");
    hub.applyEvent("calendar.event.updated", { event: shared(timed("other", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", { channel_id: "c2" })), editor_ids: [] });
    hub.applyEvent("calendar.event.updated", { event: shared(timed("mine", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z")), editor_ids: ["me"] });
    hub.applyEvent("calendar.event.updated", { event: shared(timed("lab", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", { channel_id: "c1" })), editor_ids: [] });
    expect(hub.window("channel:c1")!.events.map((e) => e.title)).toEqual(["lab"]);
    expect(api.calendarEvents).toHaveBeenCalledWith(OCT.from, OCT.to, "c1");
  });

  it("applies my alarm and says so once when it fires", async () => {
    const zemi = timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z");
    const { api } = fakeApi([zemi]);
    const onAlarm = vi.fn();
    const hub = new CalendarHub({ api, me: () => "me", onAlarm });
    await hub.open("view", OCT.from, OCT.to);
    const alarm = { minutes_before: 10, fire_at: "2026-10-05T04:50:00Z", status: "pending" as const };
    hub.applyEvent("calendar.alarm.updated", { event_id: zemi.id, channel_id: null, alarm });
    expect(hub.find(zemi.id)!.alarm).toEqual(alarm);
    hub.applyEvent("calendar.alarm.updated", { event_id: zemi.id, channel_id: null, alarm: { ...alarm, status: "fired" } });
    hub.applyEvent("calendar.alarm.updated", { event_id: zemi.id, channel_id: null, alarm: { ...alarm, status: "fired" } });
    await Promise.resolve();
    expect(onAlarm).toHaveBeenCalledTimes(1);
    expect(onAlarm.mock.calls[0]![0].title).toBe("ゼミ");
    hub.applyEvent("calendar.alarm.updated", { event_id: zemi.id, channel_id: null, alarm: null });
    expect(hub.find(zemi.id)!.alarm).toBeNull();

    // An alarm of an event outside every window: the event is read to say it.
    const later = timed("来月の予定", "2026-11-20T05:00:00Z", "2026-11-20T06:00:00Z", { id: "far" });
    const { api: api2, state } = fakeApi([]);
    state.rows.push(later);
    const onAlarm2 = vi.fn();
    const hub2 = new CalendarHub({ api: api2, me: () => "me", onAlarm: onAlarm2 });
    hub2.applyEvent("calendar.alarm.updated", { event_id: "far", channel_id: null, alarm: { ...alarm, status: "fired" } });
    await vi.waitFor(() => expect(onAlarm2).toHaveBeenCalledWith(later));
  });

  it("reads everything again after reconnecting and drops a channel I left", async () => {
    const lab = timed("lab", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", { channel_id: "c1" });
    const mine = timed("mine", "2026-10-06T05:00:00Z", "2026-10-06T06:00:00Z");
    const { api, state } = fakeApi([lab]);
    const hub = new CalendarHub({ api, me: () => "me" });
    await hub.open("view", OCT.from, OCT.to);
    state.upcoming = [lab];
    await hub.loadUpcoming("c1");
    expect(hub.upcomingOf("c1")).toHaveLength(1);
    // Missed while offline: the next read has it.
    state.rows = [lab, mine];
    hub.online();
    await vi.waitFor(() => expect(hub.window("view")!.events.map((e) => e.title)).toEqual(["lab", "mine"]));
    expect(api.calendarUpcoming).toHaveBeenCalledTimes(2);
    hub.removeChannel("c1");
    expect(hub.window("view")!.events.map((e) => e.title)).toEqual(["mine"]);
    expect(hub.upcomingOf("c1")).toBeNull();
  });

  it("reads the header count again when one of the channel's events changes", async () => {
    const { api, state } = fakeApi([]);
    const hub = new CalendarHub({ api, me: () => "me" });
    await hub.loadUpcoming("c1");
    const lab = timed("lab", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", { channel_id: "c1" });
    state.upcoming = [lab];
    hub.applyEvent("calendar.event.updated", { event: shared(lab), editor_ids: [] });
    await vi.waitFor(() => expect(hub.upcomingOf("c1")).toHaveLength(1));
    // Another channel's count, never read, is not asked for.
    hub.applyEvent("calendar.event.updated", { event: shared(timed("x", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", { channel_id: "c9" })), editor_ids: [] });
    expect((api.calendarUpcoming as ReturnType<typeof vi.fn>).mock.calls.every((call) => call[0] === "c1")).toBe(true);
  });

  it("puts what I change into the windows at once", async () => {
    const zemi = timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z");
    const { api } = fakeApi([zemi]);
    const hub = new CalendarHub({ api, me: () => "me", tz: () => "Asia/Tokyo" });
    await hub.open("view", OCT.from, OCT.to);
    await hub.setAlarm(zemi.id, 10);
    expect(api.setCalendarAlarm).toHaveBeenCalledWith(zemi.id, 10, "Asia/Tokyo");
    expect(hub.find(zemi.id)!.alarm?.minutes_before).toBe(10);
    await hub.setAlarm(zemi.id, null);
    expect(api.clearCalendarAlarm).toHaveBeenCalledWith(zemi.id);
    expect(hub.find(zemi.id)!.alarm).toBeNull();
    await hub.create({ title: "新しい予定", all_day: false, starts_at: "2026-10-07T05:00:00Z", ends_at: "2026-10-07T06:00:00Z" });
    expect(hub.window("view")!.events.map((e) => e.title)).toEqual(["ゼミ", "新しい予定"]);
    await hub.remove(zemi.id);
    expect(hub.window("view")!.events.map((e) => e.title)).toEqual(["新しい予定"]);
  });

  it("says when the server has no calendar", async () => {
    const { api } = fakeApi([]);
    api.calendarEvents = vi.fn(async () => {
      throw new ApiError(404, "not_found", "Not Found");
    });
    const hub = new CalendarHub({ api, me: () => "me" });
    await hub.open("view", OCT.from, OCT.to);
    expect(hub.window("view")!.state).toBe("unsupported");
  });
});
