// @vitest-environment jsdom
// M51: the calendar's screens: the month grid, the list, the event dialog (new, edit, read-only).
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalendarEventOut, ChannelOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import type { CalendarHub } from "../src/sync/calendar";
import { Store } from "../src/sync/store";
import { CalendarEventDialog, writableCalendars } from "../src/ui/CalendarEventDialog";
import { AgendaList, filterEvents, MonthGrid } from "../src/ui/CalendarView";
import { newDraft } from "../src/ui/calendarDates";
import { allDay, timed } from "./calendarFixtures";

afterEach(cleanup);

function channel(id: string, name: string, extra: Partial<ChannelOut> = {}): ChannelOut {
  return {
    id,
    type: "public",
    name,
    topic: null,
    purpose: null,
    archived: false,
    created_at: "2026-01-01T00:00:00Z",
    last_seq: 0,
    posting_policy: "everyone",
    ...extra,
  } as ChannelOut;
}

function setup(isAdmin = false) {
  const store = new Store();
  store.upsertChannel(channel("c-lab", "lab"), { isMember: true, membership: { role: "member" } as never });
  store.upsertChannel(channel("c-news", "news", { posting_policy: "owners" }), { isMember: true, membership: { role: "member" } as never });
  store.upsertChannel(channel("c-old", "old", { archived: true }), { isMember: true, membership: { role: "member" } as never });
  store.upsertChannel(channel("c-dm", "", { type: "dm", name: null }), { isMember: true });
  store.upsertChannel(channel("c-other", "other"), { isMember: false });
  const hub = {
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => {}),
    setAlarm: vi.fn(async () => {}),
  };
  const controller = { store, engine: { calendar: hub as unknown as CalendarHub }, isAdmin } as unknown as AppController;
  return { store, hub, controller };
}

describe("the month grid", () => {
  it("puts the events in their days, three at most, then 「+N」", () => {
    const events = [
      allDay("学会", "2026-10-05", "2026-10-06", { channel_id: "c-lab" }),
      timed("ゼミ", "2026-10-07T05:00:00Z", "2026-10-07T06:00:00Z"),
      ...["a", "b", "c", "d", "e"].map((t, i) => timed(t, `2026-10-09T0${i}:00:00Z`, `2026-10-09T0${i}:30:00Z`)),
    ];
    const onNew = vi.fn();
    const onOpen = vi.fn();
    const onDay = vi.fn();
    render(<MonthGrid anchor="2026-10-01" today="2026-10-01" events={events} onOpen={onOpen} onNew={onNew} onDay={onDay} />);
    const cell = (day: string) => document.querySelector(`[data-day="${day}"]`) as HTMLElement;
    expect(document.querySelectorAll("[data-day]")).toHaveLength(35); // 27 Sep – 31 Oct, Sunday first
    expect(within(cell("2026-10-05")).getByText("学会")).toBeTruthy();
    expect(within(cell("2026-10-06")).getByText("学会")).toBeTruthy();
    expect(within(cell("2026-10-07")).getByText("ゼミ")).toBeTruthy();
    expect(within(cell("2026-10-07")).getByText("14:00")).toBeTruthy();
    const busy = cell("2026-10-09");
    expect(busy.querySelectorAll("[data-event]")).toHaveLength(3);
    expect(within(busy).getByText("+2")).toBeTruthy();
    fireEvent.click(within(busy).getByText("+2"));
    expect(onDay).toHaveBeenCalledWith("2026-10-09");
    fireEvent.click(within(cell("2026-10-07")).getByText("ゼミ"));
    expect(onOpen).toHaveBeenCalledWith(events[1]);
    fireEvent.click(cell("2026-10-20"));
    expect(onNew).toHaveBeenCalledWith("2026-10-20");
  });
});

describe("the list", () => {
  it("lists the days with events from today, marking 今日 and 明日", () => {
    const events = [
      timed("ゼミ", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z", { channel_id: "c-lab", channel_name: "lab", location: "5 号館" }),
      allDay("学会", "2026-10-02", "2026-10-03"),
    ];
    render(<AgendaList events={events} start="2026-10-01" end="2026-10-31" today="2026-10-01" onOpen={() => {}} />);
    const days = [...document.querySelectorAll("[data-agenda-day]")].map((d) => d.getAttribute("data-agenda-day"));
    expect(days).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    const first = document.querySelector('[data-agenda-day="2026-10-01"]') as HTMLElement;
    expect(within(first).getByText("今日")).toBeTruthy();
    expect(within(first).getByText("14:00〜15:00")).toBeTruthy();
    expect(within(first).getByText("#lab")).toBeTruthy();
    expect(within(first).getByText("5 号館")).toBeTruthy();
    expect(within(document.querySelector('[data-agenda-day="2026-10-02"]') as HTMLElement).getByText("明日")).toBeTruthy();
    cleanup();
    render(<AgendaList events={[]} start="2026-10-01" end="2026-10-31" today="2026-10-01" onOpen={() => {}} />);
    expect(screen.getByText("この期間の予定はありません")).toBeTruthy();
  });

  it("filters to all, mine, or one channel", () => {
    const events = [timed("mine", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z"), timed("lab", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z", { channel_id: "c-lab" })];
    expect(filterEvents(events, "all")).toHaveLength(2);
    expect(filterEvents(events, "me").map((e) => e.title)).toEqual(["mine"]);
    expect(filterEvents(events, "c-lab").map((e) => e.title)).toEqual(["lab"]);
  });
});

describe("the event dialog", () => {
  it("offers my own calendar and the channels I may post in", () => {
    const { controller } = setup();
    expect(writableCalendars(controller).map((c) => c.name)).toEqual(["lab"]); // not the announcement, archived, DM or unjoined ones
    const admin = setup(true).controller;
    expect(writableCalendars(admin).map((c) => c.name)).toEqual(["lab", "news"]);
  });

  it("makes a new event: checked first, then local times sent as UTC", async () => {
    const { controller, hub } = setup();
    const onClose = vi.fn();
    render(<CalendarEventDialog controller={controller} event={null} initial={newDraft("2026-10-05", "me", new Date("2026-09-01T00:00:00Z"))} onClose={onClose} />);
    const add = screen.getByRole("button", { name: "追加" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true); // no title yet
    fireEvent.change(screen.getByLabelText("題名"), { target: { value: "ゼミ" } });
    fireEvent.change(screen.getByLabelText("開始時刻"), { target: { value: "14:00" } });
    // The end moved with the start (the event keeps its hour).
    expect((screen.getByLabelText("終了時刻") as HTMLInputElement).value).toBe("15:00");
    fireEvent.change(screen.getByLabelText("終了時刻"), { target: { value: "13:00" } });
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("終了時刻"), { target: { value: "15:30" } });
    fireEvent.change(screen.getByLabelText("カレンダー"), { target: { value: "c-lab" } });
    fireEvent.change(screen.getByLabelText("通知"), { target: { value: "10" } });
    expect(add.disabled).toBe(false);
    await act(async () => { fireEvent.click(add); });
    expect(hub.create).toHaveBeenCalledTimes(1);
    const body = (hub.create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).toMatchObject({ channel_id: "c-lab", title: "ゼミ", all_day: false, starts_at: "2026-10-05T05:00:00.000Z", ends_at: "2026-10-05T06:30:00.000Z", alarm_minutes: 10 });
    expect(typeof body.client_event_id).toBe("string");
    expect(onClose).toHaveBeenCalled();
  });

  it("switches to all-day with its own alarms", async () => {
    const { controller, hub } = setup();
    render(<CalendarEventDialog controller={controller} event={null} initial={{ ...newDraft("2026-10-05"), title: "学会", alarm: 30 }} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("終日"));
    expect(screen.queryByLabelText("開始時刻")).toBeNull();
    const alarm = screen.getByLabelText("通知") as HTMLSelectElement;
    expect([...alarm.options].map((o) => o.textContent)).toEqual(["なし", "前日 8:00", "当日 8:00"]);
    expect(alarm.value).toBe("-480");
    fireEvent.change(screen.getByLabelText("終了日"), { target: { value: "2026-10-07" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "追加" })); });
    expect(hub.create.mock.calls[0]).toMatchObject([{ all_day: true, start_date: "2026-10-05", end_date: "2026-10-07", starts_at: null, alarm_minutes: -480 }]);
  });

  it("shows an event I may not change read-only, with my own alarm to set", async () => {
    const { controller, hub } = setup();
    const event: CalendarEventOut = timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", { channel_id: "c-lab", channel_name: "lab", can_edit: false, description: "資料を印刷" });
    render(<CalendarEventDialog controller={controller} event={event} onClose={() => {}} />);
    expect(screen.queryByLabelText("題名")).toBeNull();
    expect(screen.getByText("ゼミ")).toBeTruthy();
    expect(screen.getByText("10月5日 (月) 14:00〜15:00")).toBeTruthy();
    expect(screen.getByText("#lab")).toBeTruthy();
    expect(screen.getByText("資料を印刷")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /削除/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    fireEvent.change(screen.getByLabelText("通知"), { target: { value: "30" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
    expect(hub.update).not.toHaveBeenCalled();
    expect(hub.setAlarm).toHaveBeenCalledWith(event.id, 30);
  });

  it("edits and deletes (after a confirmation) an event I may change", async () => {
    const { controller, hub } = setup();
    const event = timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", { channel_id: "c-lab", channel_name: "lab" });
    const onClose = vi.fn();
    render(<CalendarEventDialog controller={controller} event={event} onClose={onClose} />);
    expect((screen.getByLabelText("カレンダー") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("題名"), { target: { value: "ゼミ (変更)" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
    expect(hub.update).toHaveBeenCalledWith(event.id, expect.objectContaining({ title: "ゼミ (変更)", starts_at: "2026-10-05T05:00:00.000Z" }));
    expect(hub.setAlarm).not.toHaveBeenCalled(); // the alarm did not change
    cleanup();
    render(<CalendarEventDialog controller={controller} event={event} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /削除/ }));
    expect(screen.getByText("この予定を削除しますか？")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "削除する" })); });
    expect(hub.remove).toHaveBeenCalledWith(event.id);
  });

  it("shows the server's refusal in Japanese", async () => {
    const { controller, hub } = setup();
    const { ApiError } = await import("../src/api/errors");
    hub.update.mockRejectedValueOnce(new ApiError(403, "calendar_edit_restricted", "no"));
    const event = timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", { channel_id: "c-lab" });
    render(<CalendarEventDialog controller={controller} event={event} onClose={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
    expect(screen.getByRole("alert").textContent).toBe("この予定を変更できるのは作成者・チャンネルのオーナー・管理者だけです");
  });
});
