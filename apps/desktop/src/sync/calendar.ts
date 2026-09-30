/**
 * M51: the calendar on this device (CALENDAR.md §5). Nothing is kept for long: each screen that shows events (the
 * calendar view, a channel's 「予定」 tab) opens a window on a range, read from the server, and calendar.* events
 * update the windows they overlap (the rest are dropped: the next read has them). A channel's header count comes
 * from GET /calendar/upcoming, read again when one of its events changes. After reconnecting every window and count is
 * read again, which fills whatever events were missed.
 */
import { ApiError } from "../api/errors";
import type {
  CalendarAlarmUpdated,
  CalendarEventCreate,
  CalendarEventDeleted,
  CalendarEventOut,
  CalendarEventUpdate,
  CalendarEventUpdated,
} from "../api/types";
import { compareEvents, localZone, overlapsRange } from "../ui/calendarDates";

export interface CalendarApi {
  calendarEvents(from: string, to: string, channelId?: string | null): Promise<CalendarEventOut[]>;
  calendarUpcoming(channelId: string | null, days: number, tz: string): Promise<CalendarEventOut[]>;
  createCalendarEvent(body: CalendarEventCreate): Promise<CalendarEventOut>;
  updateCalendarEvent(eventId: string, patch: CalendarEventUpdate): Promise<CalendarEventOut>;
  deleteCalendarEvent(eventId: string): Promise<void>;
  setCalendarAlarm(eventId: string, minutesBefore: number, tz: string): Promise<CalendarEventOut>;
  clearCalendarAlarm(eventId: string): Promise<void>;
  getCalendarEvent(eventId: string): Promise<CalendarEventOut>;
}

export type CalendarWindowState = "loading" | "ready" | "failed" | "unsupported";

export interface CalendarWindow {
  from: string;
  to: string;
  /** Only this channel's calendar (a channel's tab); null: mine and all my channels'. */
  channelId: string | null;
  state: CalendarWindowState;
  /** In order (compareEvents). */
  events: CalendarEventOut[];
}

/** Today and tomorrow (the header's count). */
const UPCOMING_DAYS = 2;

export class CalendarHub {
  private readonly windows = new Map<string, CalendarWindow>();
  private readonly upcoming = new Map<string, CalendarEventOut[]>();
  /** A read in flight per window: an older answer never replaces a newer one. */
  private readonly reads = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  version = 0;

  constructor(
    private readonly deps: {
      api: CalendarApi | null;
      /** My user id (can_edit is `editor_ids` holding it). */
      me: () => string | null;
      /** One of my alarms fired (a notification while the app is open). */
      onAlarm?: (event: CalendarEventOut) => void;
      tz?: () => string;
    },
  ) {}

  get available(): boolean {
    return this.deps.api !== null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private get tz(): string {
    return this.deps.tz?.() ?? localZone();
  }

  window(key: string): CalendarWindow | undefined {
    return this.windows.get(key);
  }

  /** The count in a channel's header: its events today and tomorrow not over yet (null: not read). */
  upcomingOf(channelId: string): CalendarEventOut[] | null {
    return this.upcoming.get(channelId) ?? null;
  }

  /** A screen shows [from, to): read it (again when the range changes). */
  async open(key: string, from: string, to: string, channelId: string | null = null): Promise<void> {
    const current = this.windows.get(key);
    const same = current && current.from === from && current.to === to && current.channelId === channelId;
    if (same && current.state === "ready") return;
    this.windows.set(key, { from, to, channelId, state: "loading", events: same ? current.events : [] });
    this.changed();
    await this.read(key);
  }

  close(key: string): void {
    if (this.windows.delete(key)) this.changed();
  }

  private async read(key: string): Promise<void> {
    const api = this.deps.api;
    const window = this.windows.get(key);
    if (!api || !window) return;
    const ticket = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, ticket);
    try {
      const events = await api.calendarEvents(window.from, window.to, window.channelId);
      const now = this.windows.get(key);
      if (this.reads.get(key) !== ticket || !now || now.from !== window.from || now.to !== window.to) return;
      this.windows.set(key, { ...now, state: "ready", events: [...events].sort(compareEvents) });
    } catch (err) {
      console.warn("could not read the calendar", err);
      const now = this.windows.get(key);
      if (this.reads.get(key) !== ticket || !now) return;
      // A server from before M51 has no such route (404 not_found).
      const unsupported = err instanceof ApiError && err.status === 404 && err.code === "not_found";
      this.windows.set(key, { ...now, state: unsupported ? "unsupported" : "failed" });
    }
    this.changed();
  }

  async loadUpcoming(channelId: string): Promise<void> {
    const api = this.deps.api;
    if (!api) return;
    try {
      this.upcoming.set(channelId, await api.calendarUpcoming(channelId, UPCOMING_DAYS, this.tz));
      this.changed();
    } catch (err) {
      console.warn("could not read the channel's upcoming events", err);
    }
  }

  // --- changes made here ---------------------------------------------------------------------------

  async create(body: CalendarEventCreate): Promise<CalendarEventOut> {
    const event = await this.requireApi().createCalendarEvent(body);
    this.put(event);
    return event;
  }

  async update(eventId: string, patch: CalendarEventUpdate): Promise<CalendarEventOut> {
    const event = await this.requireApi().updateCalendarEvent(eventId, patch);
    this.put(event);
    return event;
  }

  async remove(eventId: string): Promise<void> {
    const known = this.find(eventId);
    await this.requireApi().deleteCalendarEvent(eventId);
    this.drop(eventId, known?.channel_id ?? null);
  }

  /** My alarm: minutes before (null removes it). */
  async setAlarm(eventId: string, minutes: number | null): Promise<void> {
    const api = this.requireApi();
    if (minutes === null) {
      await api.clearCalendarAlarm(eventId);
      this.patchAlarm(eventId, null);
    } else {
      this.put(await api.setCalendarAlarm(eventId, minutes, this.tz));
    }
  }

  private requireApi(): CalendarApi {
    if (!this.deps.api) throw new Error("The calendar is not available");
    return this.deps.api;
  }

  // --- events (§5) ---------------------------------------------------------------------------------

  applyEvent(event: string, data: unknown): void {
    if (event === "calendar.event.updated") {
      const { event: shared, editor_ids: editors } = data as CalendarEventUpdated;
      const me = this.deps.me();
      const known = this.find(shared.id);
      this.put({ ...shared, can_edit: me !== null && editors.includes(me), alarm: known?.alarm ?? null });
      if (shared.channel_id) this.refreshUpcoming(shared.channel_id);
    } else if (event === "calendar.event.deleted") {
      const { id, channel_id: channelId } = data as CalendarEventDeleted;
      this.drop(id, channelId);
    } else if (event === "calendar.alarm.updated") {
      const { event_id: eventId, alarm } = data as CalendarAlarmUpdated;
      const before = this.find(eventId)?.alarm?.status;
      this.patchAlarm(eventId, alarm);
      if (alarm?.status === "fired" && before !== "fired") void this.announce(eventId);
    }
  }

  /** A fired alarm: its event as known here, else read (it may be outside every window). */
  private async announce(eventId: string): Promise<void> {
    if (!this.deps.onAlarm) return;
    let event = this.find(eventId);
    if (!event && this.deps.api) {
      try {
        event = await this.deps.api.getCalendarEvent(eventId);
      } catch {
        return; // gone or no longer mine to see: nothing to say
      }
    }
    if (event) this.deps.onAlarm(event);
  }

  /** An event as it is now: into every window it overlaps (out of those it left). */
  put(event: CalendarEventOut): void {
    for (const [key, window] of this.windows) {
      const fits = (window.channelId === null || window.channelId === event.channel_id) && overlapsRange(event, window.from, window.to);
      const rest = window.events.filter((e) => e.id !== event.id);
      if (!fits && rest.length === window.events.length) continue;
      this.windows.set(key, { ...window, events: fits ? [...rest, event].sort(compareEvents) : rest });
    }
    for (const [channelId, list] of this.upcoming) {
      const index = list.findIndex((e) => e.id === event.id);
      if (index >= 0) this.upcoming.set(channelId, list.map((e) => (e.id === event.id ? event : e)));
    }
    this.changed();
  }

  private drop(eventId: string, channelId: string | null): void {
    for (const [key, window] of this.windows) {
      if (window.events.some((e) => e.id === eventId)) this.windows.set(key, { ...window, events: window.events.filter((e) => e.id !== eventId) });
    }
    for (const [id, list] of this.upcoming) {
      if (list.some((e) => e.id === eventId)) this.upcoming.set(id, list.filter((e) => e.id !== eventId));
    }
    if (channelId) this.refreshUpcoming(channelId);
    this.changed();
  }

  private patchAlarm(eventId: string, alarm: CalendarEventOut["alarm"]): void {
    const known = this.find(eventId);
    if (known) this.put({ ...known, alarm });
  }

  private refreshUpcoming(channelId: string): void {
    if (this.upcoming.has(channelId)) void this.loadUpcoming(channelId);
  }

  find(eventId: string): CalendarEventOut | undefined {
    for (const window of this.windows.values()) {
      const event = window.events.find((e) => e.id === eventId);
      if (event) return event;
    }
    for (const list of this.upcoming.values()) {
      const event = list.find((e) => e.id === eventId);
      if (event) return event;
    }
    return undefined;
  }

  // --- lifecycle -----------------------------------------------------------------------------------

  /** After (re)connecting: every window and count is read again (events missed while away, §5). */
  online(): void {
    for (const key of this.windows.keys()) void this.read(key);
    for (const channelId of this.upcoming.keys()) void this.loadUpcoming(channelId);
  }

  /** I left the channel (or was removed): its events leave every window. */
  removeChannel(channelId: string): void {
    for (const [key, window] of this.windows) {
      if (window.channelId === channelId) this.windows.delete(key);
      else this.windows.set(key, { ...window, events: window.events.filter((e) => e.channel_id !== channelId) });
    }
    this.upcoming.delete(channelId);
    this.changed();
  }

  stop(): void {
    this.windows.clear();
    this.upcoming.clear();
    this.changed();
  }
}
