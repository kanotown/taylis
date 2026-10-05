/**
 * M51: the calendar on this device (CALENDAR.md §5). Nothing is kept for long: each screen that shows events (the
 * calendar view, a channel's 「予定」 tab) opens a window on a range, read from the server, and calendar.* events
 * update the windows they overlap (the rest are dropped: the next read has them). A channel's header count comes
 * from GET /calendar/upcoming, read again when one of its events changes. After reconnecting every window and count is
 * read again, which fills whatever events were missed.
 *
 * M68 (CALENDAR.md §10.4): a recurring event comes as one entry per occurrence (its own `id`, the series' `series_id`).
 * The server alone expands a series: any change to one (its calendar.event.updated has `recurring`, as do the answers to
 * my own changes) reads the windows it may touch again instead of patching them here. A series' alarm is one per person
 * and applies to all its occurrences.
 */
import { ApiError } from "../api/errors";
import type {
  CalendarAlarmOut,
  CalendarAlarmUpdated,
  CalendarEventData,
  CalendarEventCreate,
  CalendarEventDeleted,
  CalendarEventOut,
  CalendarEventUpdate,
  CalendarEventUpdated,
  CalendarOccurrenceUpdate,
  OccurrenceScope,
} from "../api/types";
import { clock, compareEvents, localZone, overlapsRange } from "../ui/calendarDates";
import { t } from "../i18n";

export interface CalendarApi {
  calendarEvents(from: string, to: string, channelId?: string | null): Promise<CalendarEventOut[]>;
  calendarUpcoming(channelId: string | null, days: number, tz: string): Promise<CalendarEventOut[]>;
  createCalendarEvent(body: CalendarEventCreate): Promise<CalendarEventOut>;
  updateCalendarEvent(eventId: string, patch: CalendarEventUpdate): Promise<CalendarEventOut>;
  deleteCalendarEvent(eventId: string): Promise<void>;
  setCalendarAlarm(eventId: string, minutesBefore: number, tz: string): Promise<CalendarEventOut>;
  clearCalendarAlarm(eventId: string): Promise<void>;
  getCalendarEvent(eventId: string): Promise<CalendarEventOut>;
  updateCalendarOccurrence(seriesId: string, occurrenceStart: string, body: CalendarOccurrenceUpdate): Promise<CalendarEventOut>;
  deleteCalendarOccurrence(seriesId: string, occurrenceStart: string, scope: OccurrenceScope): Promise<void>;
}

/** The series an entry belongs to (a one-off event is its own). */
export const seriesOf = (event: Pick<CalendarEventOut, "id" | "series_id">): string => event.series_id ?? event.id;

/**
 * The open app's line for a fired alarm, worded like the server's push: 「14:00 ゼミ (#m2-進捗)」, 「終日 学会」. `event` null
 * (the occurrence is not known here, Review v0.1.22 #9): 「予定の通知があります (#…)」, never another occurrence's title.
 */
export function calendarAlarmText(event: CalendarEventOut | null, channelName: string | null): string {
  if (!event) return channelName ? t("calendar.alarm.unknownIn", { channel: channelName }) : t("calendar.alarm.unknown");
  const when = event.all_day ? t("calendar.allDay") : clock(event.starts_at!);
  const name = event.channel_name ?? channelName;
  return `${when} ${event.title}${name ? ` (#${name})` : ""}`;
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
      /**
       * One of my alarms fired (a notification while the app is open): the occurrence it is for, or null when this device
       * cannot tell which occurrence that is (an older server, not loaded here): then say so neutrally (`channelId` names
       * the calendar), never with another occurrence's title or time (Review v0.1.22 #9).
       */
      onAlarm?: (event: CalendarEventOut | null, channelId: string | null) => void;
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
    this.settle(event);
    return event;
  }

  /** A whole event (a series: all its occurrences, 「すべての予定」 without moving it from an occurrence). */
  async update(eventId: string, patch: CalendarEventUpdate): Promise<CalendarEventOut> {
    const event = await this.requireApi().updateCalendarEvent(eventId, patch);
    this.settle(event);
    return event;
  }

  /** A whole event (a series: every occurrence). */
  async remove(eventId: string): Promise<void> {
    const known = this.find(eventId);
    await this.requireApi().deleteCalendarEvent(eventId);
    this.drop(eventId, known?.channel_id ?? null);
  }

  /** M68: one occurrence of a series, it and the later ones, or all of them (the windows are read again). */
  async updateOccurrence(seriesId: string, occurrenceStart: string, body: CalendarOccurrenceUpdate): Promise<CalendarEventOut> {
    const known = this.find(seriesId);
    const event = await this.requireApi().updateCalendarOccurrence(seriesId, occurrenceStart, body);
    this.reloadFor(event.channel_id ?? known?.channel_id ?? null);
    return event;
  }

  async removeOccurrence(seriesId: string, occurrenceStart: string, scope: OccurrenceScope): Promise<void> {
    const known = this.find(seriesId);
    await this.requireApi().deleteCalendarOccurrence(seriesId, occurrenceStart, scope);
    const channelId = known?.channel_id ?? null;
    if (scope === "all") this.drop(seriesId, channelId);
    else {
      // The occurrence (or the later ones) leave at once; the windows' next read confirms it.
      const gone = (e: CalendarEventOut) => seriesOf(e) === seriesId && (scope === "this" ? e.occurrence_start === occurrenceStart : e.occurrence_start >= occurrenceStart);
      this.dropWhere(gone, channelId);
      this.reloadFor(channelId);
    }
  }

  /** My alarm (minutes before; null removes it). On a series it is the series' (every occurrence's): pass its id. */
  async setAlarm(eventId: string, minutes: number | null): Promise<void> {
    const api = this.requireApi();
    if (minutes === null) {
      await api.clearCalendarAlarm(eventId);
      this.patchAlarm(eventId, null);
    } else {
      const event = await api.setCalendarAlarm(eventId, minutes, this.tz);
      if (event.recurring) this.patchAlarm(seriesOf(event), event.alarm);
      else this.put(event);
    }
  }

  /** My change's answer: a one-off event goes in as it is; a series is read again where it may show. */
  private settle(event: CalendarEventOut): void {
    if (event.recurring) this.reloadFor(event.channel_id);
    else this.put(event);
  }

  /** Reads again every window that may hold the channel's events (null: my own calendar), and its count. */
  private reloadFor(channelId: string | null): void {
    for (const [key, window] of this.windows) {
      if (window.channelId === null || window.channelId === channelId) void this.read(key);
    }
    if (channelId) this.refreshUpcoming(channelId);
  }

  private requireApi(): CalendarApi {
    if (!this.deps.api) throw new Error("The calendar is not available");
    return this.deps.api;
  }

  // --- events (§5) ---------------------------------------------------------------------------------

  applyEvent(event: string, data: unknown): void {
    if (event === "calendar.event.updated") {
      const { event: shared, editor_ids: editors } = data as CalendarEventUpdated;
      if (shared.recurring) {
        // A series changed (its rule, an occurrence, a split): only the server expands it.
        this.reloadFor(shared.channel_id);
        return;
      }
      const me = this.deps.me();
      const known = this.find(shared.id);
      this.put({ ...shared, can_edit: me !== null && editors.includes(me), alarm: known?.alarm ?? null });
      if (shared.channel_id) this.refreshUpcoming(shared.channel_id);
    } else if (event === "calendar.event.deleted") {
      const { id, channel_id: channelId } = data as CalendarEventDeleted;
      this.drop(id, channelId);
    } else if (event === "calendar.alarm.updated") {
      const { event_id: eventId, channel_id: channelId, alarm, occurrence } = data as CalendarAlarmUpdated;
      const before = this.findSeries(eventId)?.alarm;
      this.patchAlarm(eventId, alarm);
      const again = before?.status === "fired" && (before.occurrence_start ?? null) === (alarm?.occurrence_start ?? null);
      if (alarm?.status === "fired" && !again) void this.announce(eventId, channelId, alarm, occurrence ?? null);
    }
  }

  /**
   * A fired alarm, said for the occurrence it is for (Review v0.1.22 #9): the one the server put in the event; from an
   * older server, the occurrence as held here, else the event read (a one-off, or a series whose first occurrence is
   * the one). Anything else would be another occurrence's title and time: the neutral notice instead.
   */
  private async announce(eventId: string, channelId: string | null, alarm: CalendarAlarmOut, occurrence: CalendarEventData | null): Promise<void> {
    const onAlarm = this.deps.onAlarm;
    if (!onAlarm) return;
    const key = alarm.occurrence_start ?? null;
    const known = this.findSeries(eventId);
    if (occurrence && (key === null || occurrence.occurrence_start === key)) {
      const held = this.findOccurrence(seriesOf(occurrence), occurrence.occurrence_start);
      onAlarm({ ...occurrence, can_edit: held?.can_edit ?? known?.can_edit ?? false, alarm }, occurrence.channel_id);
      return;
    }
    const fits = (e: CalendarEventOut | undefined) => e !== undefined && (key === null ? !e.recurring : e.occurrence_start === key);
    let event: CalendarEventOut | undefined = key !== null ? this.findOccurrence(eventId, key) : this.find(eventId);
    if (!fits(event) && this.deps.api) {
      try {
        event = await this.deps.api.getCalendarEvent(eventId);
      } catch {
        return; // gone or no longer mine to see: nothing to say
      }
    }
    onAlarm(fits(event) ? event! : null, event?.channel_id ?? channelId);
  }

  /** An event as it is now: into every window it overlaps (out of those it left). A one-off event also replaces what was
   * left of its series (it no longer repeats). */
  put(event: CalendarEventOut): void {
    const series = seriesOf(event);
    const other = (e: CalendarEventOut) => e.id !== event.id && !(!event.recurring && seriesOf(e) === series);
    for (const [key, window] of this.windows) {
      const fits = (window.channelId === null || window.channelId === event.channel_id) && overlapsRange(event, window.from, window.to);
      const rest = window.events.filter(other);
      if (!fits && rest.length === window.events.length) continue;
      this.windows.set(key, { ...window, events: fits ? [...rest, event].sort(compareEvents) : rest });
    }
    for (const [channelId, list] of this.upcoming) {
      const index = list.findIndex((e) => e.id === event.id);
      if (index >= 0) this.upcoming.set(channelId, list.map((e) => (e.id === event.id ? event : e)));
    }
    this.changed();
  }

  /** An event gone (a series: every occurrence). */
  private drop(eventId: string, channelId: string | null): void {
    this.dropWhere((e) => e.id === eventId || seriesOf(e) === eventId, channelId);
  }

  private dropWhere(gone: (event: CalendarEventOut) => boolean, channelId: string | null): void {
    for (const [key, window] of this.windows) {
      if (window.events.some(gone)) this.windows.set(key, { ...window, events: window.events.filter((e) => !gone(e)) });
    }
    for (const [id, list] of this.upcoming) {
      if (list.some(gone)) this.upcoming.set(id, list.filter((e) => !gone(e)));
    }
    if (channelId) this.refreshUpcoming(channelId);
    this.changed();
  }

  /** My alarm on an event, or on every occurrence of a series. */
  private patchAlarm(eventId: string, alarm: CalendarEventOut["alarm"]): void {
    const mine = (e: CalendarEventOut) => e.id === eventId || seriesOf(e) === eventId;
    let found = false;
    for (const [key, window] of this.windows) {
      if (!window.events.some(mine)) continue;
      found = true;
      this.windows.set(key, { ...window, events: window.events.map((e) => (mine(e) ? { ...e, alarm } : e)) });
    }
    for (const [id, list] of this.upcoming) {
      if (!list.some(mine)) continue;
      found = true;
      this.upcoming.set(id, list.map((e) => (mine(e) ? { ...e, alarm } : e)));
    }
    if (found) this.changed();
  }

  private refreshUpcoming(channelId: string): void {
    if (this.upcoming.has(channelId)) void this.loadUpcoming(channelId);
  }

  /** Any occurrence of a series (or the one-off event) known here. */
  findSeries(seriesId: string): CalendarEventOut | undefined {
    return this.find(seriesId) ?? this.all().find((e) => seriesOf(e) === seriesId);
  }

  findOccurrence(seriesId: string, occurrenceStart: string): CalendarEventOut | undefined {
    return this.all().find((e) => seriesOf(e) === seriesId && e.occurrence_start === occurrenceStart);
  }

  private all(): CalendarEventOut[] {
    return [...[...this.windows.values()].flatMap((w) => w.events), ...[...this.upcoming.values()].flat()];
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
