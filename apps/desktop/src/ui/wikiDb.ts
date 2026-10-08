/**
 * M123 (WIKI.md §5): wiki databases without React — how a cell reads, which filters a property takes, the table's
 * columns from a view, and the calendar's month grid with multi-day rows laid out in lanes (and the agenda list a
 * narrow screen shows instead). The server sorts and filters; nothing here reorders rows.
 */
import type { DatabaseOut, DbDateValue, DbFilterOp, DbGroupBy, DbGroupOut, DbProperty, DbPropType, DbRow, DbRowRef, DbView, DbViewColumn, DbViewIn, DbViewType } from "../api/types";

export const TITLE_ID = "title";

/** The option colours (the server's names) as chip classes. */
export const OPTION_COLORS: Record<string, string> = {
  gray: "bg-zinc-500/15 text-ink",
  brown: "bg-amber-900/15 text-ink",
  orange: "bg-orange-500/20 text-ink",
  yellow: "bg-yellow-400/25 text-ink",
  green: "bg-emerald-500/20 text-ink",
  blue: "bg-sky-500/20 text-ink",
  purple: "bg-violet-500/20 text-ink",
  pink: "bg-pink-500/20 text-ink",
  red: "bg-rose-500/20 text-ink",
};
export const COLOR_NAMES = Object.keys(OPTION_COLORS);

/** Types a person sets (the others are computed by the server). */
export const EDITABLE_TYPES: readonly DbPropType[] = ["title", "text", "number", "select", "multi_select", "date", "person", "checkbox", "url", "relation"];
export const COMPUTED_TYPES: readonly DbPropType[] = ["created_time", "updated_time", "created_by", "updated_by"];
/** What「プロパティを追加」 offers, in order. */
export const NEW_TYPES = ["text", "number", "select", "multi_select", "date", "person", "checkbox", "url", "relation", "created_time", "updated_time", "created_by", "updated_by"] as const;
export type NewType = (typeof NEW_TYPES)[number];

export const isEditable = (type: DbPropType) => EDITABLE_TYPES.includes(type);
export const isDateish = (type: DbPropType) => type === "date" || type === "created_time" || type === "updated_time";

// --- who may do what (M144, WIKI.md §22.2) -------------------------------------------------------------------------

export interface DatabaseRights {
  /** Add rows and change their values (edit). */
  canEdit: boolean;
  /** Add, rename and reorder properties, add options and change their names and colours, a number's format, and
   * create, change and delete views (edit since M144). */
  canShape: boolean;
  /** Delete a property or an option, change a type, make a two-way relation (full). */
  canDestroy: boolean;
}

/** The server decides (403 page_manage_restricted); this only shows what it would allow. Guests keep the controls
 * hidden as before (they reshape nothing of the lab's even where a page gives them more). */
export function databaseRights(level: DatabaseOut["my_level"] | null | undefined, isGuest: boolean): DatabaseRights {
  const canEdit = level === "edit" || level === "full";
  return { canEdit, canShape: canEdit && !isGuest, canDestroy: level === "full" && !isGuest };
}

// --- reading a cell ------------------------------------------------------------------------------------------------

/** A cell's value as the server has it (computed ones from the row). Relations: the readable row ids. */
export function cellValue(prop: DbProperty, row: DbRow): unknown {
  switch (prop.type) {
    case "title":
      return row.title || null;
    case "created_time":
      return { start: row.created_at, end: null, time: true } satisfies DbDateValue;
    case "updated_time":
      return { start: row.updated_at, end: null, time: true } satisfies DbDateValue;
    case "created_by":
      return [row.created_by];
    case "updated_by":
      return [row.updated_by];
    case "relation":
      return row.relations[prop.id] ?? [];
    default:
      return row.props[prop.id] ?? null;
  }
}

export function asDate(value: unknown): DbDateValue | null {
  if (!value || typeof value !== "object" || typeof (value as DbDateValue).start !== "string") return null;
  return value as DbDateValue;
}

export function formatNumber(value: number, format: DbProperty["number_format"], locale: string): string {
  if (format === "percent") return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value * 100)}%`;
  if (format === "yen") return new Intl.NumberFormat(locale, { style: "currency", currency: "JPY" }).format(value);
  if (format === "integer") return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: false }).format(value);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 10, useGrouping: false }).format(value);
}

/** "2026/10/07", "2026/10/07 9:30", a range with " → ". Times show in this device's zone. */
export function formatDate(value: DbDateValue, locale: string): string {
  const one = (text: string) => {
    if (!value.time || text.length <= 10) {
      const [y, m, d] = text.slice(0, 10).split("-").map(Number);
      return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(y!, m! - 1, d!));
    }
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }).format(new Date(text));
  };
  return value.end ? `${one(value.start)} → ${one(value.end)}` : one(value.start);
}

/** A cell as plain text (the calendar's labels, the agenda, a tooltip). */
export function cellText(prop: DbProperty, row: DbRow, ctx: { locale: string; names: (id: string) => string; refs: ReadonlyMap<string, DbRowRef>; hidden: string; untitled: string }): string {
  const value = cellValue(prop, row);
  if (value === null || value === undefined) return "";
  switch (prop.type) {
    case "title":
    case "text":
    case "url":
      return String(value);
    case "number":
      return formatNumber(Number(value), prop.number_format, ctx.locale);
    case "checkbox":
      return value ? "✓" : "";
    case "select":
      return prop.options.find((o) => o.id === value)?.name ?? "";
    case "multi_select":
      return (value as string[]).map((id) => prop.options.find((o) => o.id === id)?.name).filter(Boolean).join(", ");
    case "date":
    case "created_time":
    case "updated_time":
      return asDate(value) ? formatDate(asDate(value)!, ctx.locale) : "";
    case "person":
    case "created_by":
    case "updated_by":
      return (value as string[]).map(ctx.names).join(", ");
    case "relation": {
      const titles = (value as string[]).map((id) => ctx.refs.get(id)?.title || ctx.untitled);
      if (row.hidden_relations.includes(prop.id)) titles.push(ctx.hidden);
      return titles.join(", ");
    }
  }
  return "";
}

// --- filters (the server's rules, WIKI.md §5.4) --------------------------------------------------------------------

const TEXT_OPS: DbFilterOp[] = ["contains", "not_contains", "equals", "not_equals", "starts_with", "is_empty", "is_not_empty"];
const OPS: Record<string, DbFilterOp[]> = {
  text: TEXT_OPS,
  number: ["equals", "not_equals", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"],
  select: ["equals", "not_equals", "is_empty", "is_not_empty"],
  multi_select: ["contains", "not_contains", "is_empty", "is_not_empty"],
  date: ["equals", "before", "after", "on_or_before", "on_or_after", "between", "is_empty", "is_not_empty"],
  person: ["contains", "not_contains", "is_empty", "is_not_empty"],
  checkbox: ["equals"],
  relation: ["contains", "not_contains", "is_empty", "is_not_empty"],
};

function family(type: DbPropType): string {
  if (type === "title" || type === "text" || type === "url") return "text";
  if (isDateish(type)) return "date";
  if (type === "person" || type === "created_by" || type === "updated_by") return "person";
  return type;
}

export function opsFor(type: DbPropType): DbFilterOp[] {
  return OPS[family(type)] ?? [];
}

export function opNeedsValue(op: DbFilterOp): boolean {
  return op !== "is_empty" && op !== "is_not_empty";
}

/** A new condition on a property: its first operator with an empty value of the right kind. */
export function newCondition(prop: DbProperty): { prop_id: string; op: DbFilterOp; value: unknown } {
  const op = opsFor(prop.type)[0]!;
  const fam = family(prop.type);
  const value = fam === "checkbox" ? true : fam === "number" ? 0 : fam === "date" ? todayIso() : fam === "select" || fam === "multi_select" ? prop.options[0]?.id ?? "" : fam === "person" ? "me" : "";
  return { prop_id: prop.id, op, value };
}

/** Conditions whose value is not filled in yet are not sent (the server would refuse them). */
export function readyConditions<T extends { op: DbFilterOp; value?: unknown }>(conditions: readonly T[]): T[] {
  return conditions.filter((c) => !opNeedsValue(c.op) || (c.value !== "" && c.value !== null && c.value !== undefined));
}

/** A saved relation condition on a row I cannot read comes as "restricted:<n>" instead of the row id (WIKI.md §5.7).
 * It is shown as an inaccessible row and sent back as it is: the server keeps the hidden row when the view is saved. */
export const isRestrictedValue = (value: unknown): value is string => typeof value === "string" && value.startsWith("restricted:");

export const sortable = (type: DbPropType) => type !== "relation";

// --- the table's columns -------------------------------------------------------------------------------------------

export interface Column {
  prop: DbProperty;
  width: number;
  hidden: boolean;
}

export const DEFAULT_WIDTH = 180;
export const TITLE_WIDTH = 260;
export const MIN_WIDTH = 60;
export const MAX_WIDTH = 1000;

/** The view's columns in its order, then the properties it does not list (schema order); the title never hides. */
export function columnsOf(properties: readonly DbProperty[], columns: ReadonlyArray<Pick<DbViewColumn, "prop_id"> & Partial<DbViewColumn>>): Column[] {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const out: Column[] = [];
  const listed = new Set<string>();
  for (const column of columns) {
    const prop = byId.get(column.prop_id);
    if (!prop || listed.has(prop.id)) continue;
    listed.add(prop.id);
    out.push({ prop, width: column.width ?? (prop.type === "title" ? TITLE_WIDTH : DEFAULT_WIDTH), hidden: prop.type !== "title" && !!column.hidden });
  }
  for (const prop of properties) if (!listed.has(prop.id)) out.push({ prop, width: prop.type === "title" ? TITLE_WIDTH : DEFAULT_WIDTH, hidden: false });
  return out;
}

/** The columns back as the view stores them. */
export function toViewColumns(columns: readonly Column[]): DbViewColumn[] {
  return columns.map((c) => ({ prop_id: c.prop.id, width: Math.round(c.width), hidden: c.hidden }));
}

export function moveColumn(columns: readonly Column[], propId: string, toIndex: number): Column[] {
  const from = columns.findIndex((c) => c.prop.id === propId);
  if (from < 0) return [...columns];
  const out = [...columns];
  const [moved] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, toIndex)), 0, moved!);
  return out;
}

export function clampWidth(width: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
}

/** A view as saved (`PUT …/views/{id}`). */
export function viewBody(view: DbView): DbViewIn {
  return {
    name: view.name, type: view.type, columns: view.columns, sort: view.sort, filter: view.filter ?? null, date_prop_id: view.date_prop_id ?? null,
    group_by: view.group_by ?? null, cover: view.cover ?? "body", card_size: view.card_size ?? "medium",
  };
}

/** Whether the screen's sort / filter / columns / groups / cards differ from the saved view (「ビューを保存」). */
export function viewDiffers(saved: DbView, draft: DbViewIn): boolean {
  const group = (g: DbViewIn["group_by"]) => (g ? { p: g.prop_id, u: g.date_unit ?? null, h: g.hidden ?? [], e: !!g.hide_empty } : null);
  const norm = (v: DbViewIn) => JSON.stringify({
    c: v.columns ?? [], s: v.sort ?? [], f: v.filter?.conditions?.length ? v.filter : null, d: v.date_prop_id ?? null,
    g: group(v.group_by), cv: v.cover ?? "body", cs: v.card_size ?? "medium",
  });
  return norm(viewBody(saved)) !== norm(draft);
}

// --- groups, boards, lists and galleries (M147, WIKI.md §22.4) -----------------------------------------------------

/** The group of rows with no value (「なし」). */
export const NONE_GROUP = "";
/** A board's columns: a card moves by setting the value. */
export const BOARD_GROUP_TYPES: readonly DbPropType[] = ["select", "person", "checkbox"];
/** Any other view's groups. */
export const GROUP_TYPES: readonly DbPropType[] = ["select", "multi_select", "person", "checkbox", "date", "created_time", "updated_time", "created_by", "updated_by"];

/** The properties a view of this type may group by (none for a calendar). */
export function groupableProps(properties: readonly DbProperty[], viewType: DbViewType): DbProperty[] {
  if (viewType === "calendar") return [];
  const allowed = viewType === "board" ? BOARD_GROUP_TYPES : GROUP_TYPES;
  return properties.filter((p) => allowed.includes(p.type));
}

/** A new board's columns: the first select, else a person, else a checkbox (null: none to group by). */
export function firstBoardProp(database: Pick<DatabaseOut, "properties">): DbProperty | null {
  for (const type of BOARD_GROUP_TYPES) {
    const found = database.properties.find((p) => p.type === type);
    if (found) return found;
  }
  return null;
}

/** The value a card gets when it moves from the column `from` to `to`: a select takes the option (none: cleared), a
 * checkbox its state, a person value loses `from` and gains `to` (「なし」 clears it). */
export function boardValue(prop: DbProperty, row: DbRow, from: string, to: string): unknown {
  if (prop.type === "checkbox") return to === "true";
  if (to === NONE_GROUP) return null;
  if (prop.type === "person") {
    const current = ((row.props[prop.id] as string[] | undefined) ?? []).filter((id) => id !== from);
    return current.includes(to) ? current : [...current, to];
  }
  return to;
}

/** The value of a row made in a group (「＋ 新規」 under it); undefined: the group gives none (「なし」, a week, …). */
export function groupValue(prop: DbProperty, key: string, unit: DbGroupBy["date_unit"]): unknown {
  if (prop.type === "checkbox") return key === "true" ? true : undefined;
  if (key === NONE_GROUP) return undefined;
  switch (prop.type) {
    case "select":
      return key;
    case "multi_select":
    case "person":
      return [key];
    case "date":
      return (unit ?? "day") === "day" ? { start: key, end: null, time: false } : undefined;
    default:
      return undefined;
  }
}

export interface Section {
  key: string;
  count: number;
  hidden: boolean;
  rows: DbRow[];
}

/** The groups of an answer with their rows (`rowGroups[i]` is the group of `rows[i]`; a row may be in several). */
export function sectionsOf(groups: readonly DbGroupOut[], rows: readonly DbRow[], rowGroups: readonly string[]): Section[] {
  const out = groups.map((g) => ({ key: g.key, count: g.count, hidden: g.hidden, rows: [] as DbRow[] }));
  const byKey = new Map(out.map((s) => [s.key, s]));
  rows.forEach((row, index) => byKey.get(rowGroups[index] ?? NONE_GROUP)?.rows.push(row));
  return out;
}

/** The neighbour a card dropped at `index` of a column (counted without the card itself) is placed next to. */
export function placeIn(column: readonly DbRow[], movingId: string, index: number): { before_id?: string; after_id?: string } {
  const others = column.filter((r) => r.id !== movingId);
  if (others.length === 0) return {};
  if (index < others.length) return { before_id: others[Math.max(0, index)]!.id };
  return { after_id: others[others.length - 1]!.id };
}

/** The sections after a card moved (shown at once; the server's answer replaces it): out of `from`, into `to` at
 * `index` (counted without it), the row's new value on every copy of it. */
export function moveInSections(sections: readonly Section[], row: DbRow, from: string, to: string, index: number): Section[] {
  return sections.map((section) => {
    let rows = section.rows.map((r) => (r.id === row.id ? row : r));
    let count = section.count;
    if (section.key === from && from !== to) {
      rows = rows.filter((r) => r.id !== row.id);
      count = Math.max(0, count - 1);
    }
    if (section.key === to) {
      const had = rows.some((r) => r.id === row.id);
      rows = rows.filter((r) => r.id !== row.id);
      rows.splice(Math.max(0, Math.min(rows.length, index)), 0, row);
      if (!had) count += 1;
    }
    return { ...section, rows, count };
  });
}

/** Sections back as the answer's parallel lists. */
export function flattenSections(sections: readonly Section[]): { rows: DbRow[]; rowGroups: string[] } {
  const rows: DbRow[] = [];
  const rowGroups: string[] = [];
  for (const section of sections) for (const row of section.rows) { rows.push(row); rowGroups.push(section.key); }
  return { rows, rowGroups };
}

/** The date of a group "YYYY-MM-DD" / "YYYY-MM" as a local Date (labels). */
export function groupDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

/** The first date property (a new calendar's). */
export function firstDateProp(database: Pick<DatabaseOut, "properties">): DbProperty | null {
  return database.properties.find((p) => p.type === "date") ?? database.properties.find((p) => isDateish(p.type)) ?? null;
}

export function newViewId(): string {
  return `v${Math.random().toString(36).slice(2, 10)}`;
}

// --- dates ---------------------------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

export function isoOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayIso(): string {
  return isoOf(new Date());
}

function parseIso(day: string): Date {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addDays(day: string, n: number): string {
  const date = parseIso(day);
  date.setDate(date.getDate() + n);
  return isoOf(date);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / 86_400_000);
}

/** The calendar day of a stored date or time: a date as written; a time on this device's day. */
export function dayOfValue(text: string): string {
  return text.length <= 10 ? text : isoOf(new Date(text));
}

/** [first day, last day] of a row on a date property (null: no date). */
export function spanOf(prop: DbProperty, row: DbRow): [string, string] | null {
  const value = asDate(cellValue(prop, row));
  if (!value) return null;
  const first = dayOfValue(value.start);
  const last = value.end ? dayOfValue(value.end) : first;
  return last < first ? [first, first] : [first, last];
}

/** The value moved by `days` (a drag on the calendar): start and end together, times kept. */
export function shiftDate(value: DbDateValue, days: number): DbDateValue {
  const move = (text: string) => {
    if (text.length <= 10) return addDays(text, days);
    const date = new Date(text);
    date.setDate(date.getDate() + days);
    return withOffset(date);
  };
  return { start: move(value.start), end: value.end ? move(value.end) : null, time: value.time };
}

/** A local time as ISO 8601 with this device's offset ("2026-10-07T09:30:00+09:00"). */
export function withOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${isoOf(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The first and last day of a month (`month` 0-11). */
export function monthBounds(year: number, month: number): [string, string] {
  return [isoOf(new Date(year, month, 1)), isoOf(new Date(year, month + 1, 0))];
}

/** Six weeks covering the month (`month` 0-11), weeks starting on `weekStart` (0 Sunday, 1 Monday). */
export function monthGrid(year: number, month: number, weekStart = 0): string[][] {
  const first = new Date(year, month, 1);
  const back = (first.getDay() - weekStart + 7) % 7;
  const start = new Date(year, month, 1 - back);
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      week.push(isoOf(date));
    }
    weeks.push(week);
  }
  return weeks;
}

export interface WeekBar {
  rowId: string;
  /** Columns 0-6 the bar covers in this week. */
  startCol: number;
  endCol: number;
  /** Which line of the week it is drawn on (0 = top). */
  lane: number;
  /** It began before this week / goes on after it (the bar's ends are drawn open). */
  fromBefore: boolean;
  goesOn: boolean;
}

/**
 * The bars of one week: each row on the days it covers, in lanes so that none overlap. Longer spans first, then by
 * start, then in the order given (the server's sort).
 */
export function layoutWeek(week: readonly string[], spans: ReadonlyArray<{ rowId: string; first: string; last: string }>): WeekBar[] {
  const weekFirst = week[0]!, weekLast = week[week.length - 1]!;
  const inWeek = spans
    .map((span, order) => ({ ...span, order }))
    .filter((s) => s.first <= weekLast && s.last >= weekFirst)
    .map((s) => {
      const startCol = s.first < weekFirst ? 0 : week.indexOf(s.first);
      const endCol = s.last > weekLast ? week.length - 1 : week.indexOf(s.last);
      return { ...s, startCol, endCol };
    })
    .sort((a, b) => (b.endCol - b.startCol) - (a.endCol - a.startCol) || a.startCol - b.startCol || a.order - b.order);
  const lanes: boolean[][] = [];
  const out: WeekBar[] = [];
  for (const s of inWeek) {
    let lane = 0;
    for (; ; lane++) {
      const used = (lanes[lane] ??= Array(week.length).fill(false));
      let free = true;
      for (let c = s.startCol; c <= s.endCol; c++) if (used[c]) free = false;
      if (free) {
        for (let c = s.startCol; c <= s.endCol; c++) used[c] = true;
        break;
      }
    }
    out.push({ rowId: s.rowId, startCol: s.startCol, endCol: s.endCol, lane, fromBefore: s.first < weekFirst, goesOn: s.last > weekLast });
  }
  return out.sort((a, b) => a.lane - b.lane || a.startCol - b.startCol);
}

/** The agenda (a narrow screen's calendar): each day of [from, to] that has rows, a row on every day it covers. */
export function agenda(spans: ReadonlyArray<{ rowId: string; first: string; last: string }>, from: string, to: string): Array<{ day: string; rowIds: string[] }> {
  const days = new Map<string, string[]>();
  for (const span of spans) {
    let day = span.first < from ? from : span.first;
    const last = span.last > to ? to : span.last;
    while (day <= last) {
      const list = days.get(day) ?? [];
      list.push(span.rowId);
      days.set(day, list);
      day = addDays(day, 1);
    }
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, rowIds]) => ({ day, rowIds }));
}
