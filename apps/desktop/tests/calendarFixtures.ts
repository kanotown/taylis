/** M51: calendar events for the tests, shaped like the server's CalendarEventOut. */
import type { CalendarEventOut } from "../src/api/types";

let n = 0;

export function timed(title: string, startsAt: string, endsAt: string, extra: Partial<CalendarEventOut> = {}): CalendarEventOut {
  n += 1;
  return {
    id: `e${n}`,
    channel_id: null,
    channel_name: null,
    owner_id: "me",
    title,
    all_day: false,
    starts_at: startsAt,
    ends_at: endsAt,
    start_date: null,
    end_date: null,
    location: null,
    description: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    can_edit: true,
    alarm: null,
    ...extra,
  };
}

export function allDay(title: string, start: string, end: string = start, extra: Partial<CalendarEventOut> = {}): CalendarEventOut {
  return timed(title, "", "", { all_day: true, starts_at: null, ends_at: null, start_date: start, end_date: end, ...extra });
}
