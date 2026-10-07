/**
 * M123 (WIKI.md §5): a database's cells — how each type shows, the editors (text, number, URL, select and multi-select
 * with new options for managers, dates with an end and a time, people, the relation picker that searches only rows I
 * can read), the property icons, and the dialog that adds, renames, retypes or deletes a property.
 *
 * A relation cell shows the linked rows I can read; links to rows I cannot read are one 「アクセスできないページ」
 * (never a title or a count) and stay when I change the cell (the server keeps them).
 */
import { ArrowUpRight, Calendar, CaseSensitive, Check, CircleChevronDown, Clock, Hash, Link2, Loader2, Lock, Plus, SquareCheck, Tags, Trash2, Type, User, UserPen, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import type { DatabaseOut, DbDateValue, DbOption, DbProperty, DbPropType, DbRow, DbRowRef, DbSchemaOp } from "../api/types";
import type { AppController } from "../state/app";
import { getLocale, intlLocale, t, type MessageKey } from "../i18n";
import { Avatar } from "./Avatar";
import { PageIcon } from "./PageIcon";
import { Button, cn, Field, Input, Modal } from "./primitives";
import { asDate, cellValue, COLOR_NAMES, formatDate, formatNumber, NEW_TYPES, type NewType, OPTION_COLORS, todayIso, withOffset } from "./wikiDb";

/** What the cells of one database need. */
export interface DbCtx {
  controller: AppController;
  database: DatabaseOut;
  refs: ReadonlyMap<string, DbRowRef>;
  canEdit: boolean;
  canManage: boolean;
  /** Write one cell (the last write wins on the server). */
  setCell(row: DbRow, propId: string, value: unknown): Promise<void>;
  /** A schema change on the database's current version (null: refused, the error shown). */
  changeSchema(ops: DbSchemaOp[]): Promise<DatabaseOut | null>;
  openRow(rowId: string): void;
}

const TYPE_ICONS: Record<DbPropType, typeof Type> = {
  title: CaseSensitive,
  text: Type,
  number: Hash,
  select: CircleChevronDown,
  multi_select: Tags,
  date: Calendar,
  person: User,
  checkbox: SquareCheck,
  url: Link2,
  relation: ArrowUpRight,
  created_time: Clock,
  updated_time: Clock,
  created_by: UserPen,
  updated_by: UserPen,
};

export function PropIcon({ type, size = 13, className }: { type: DbPropType; size?: number; className?: string }) {
  const Icon = TYPE_ICONS[type] ?? Type;
  return <Icon size={size} className={cn("shrink-0 text-muted", className)} aria-hidden="true" />;
}

export function typeLabel(type: DbPropType): string {
  return t(`docs.db.type.${type}` as MessageKey);
}

/** A property's name, or the clients' word for an unnamed title (「名前」). */
export function propName(prop: DbProperty): string {
  if (prop.name) return prop.name;
  return prop.type === "title" ? t("docs.db.titleProp") : typeLabel(prop.type);
}

export function OptionChip({ option }: { option: DbOption }) {
  return <span className={cn("inline-flex max-w-full items-center truncate rounded px-1.5 py-px text-xs", OPTION_COLORS[option.color] ?? OPTION_COLORS.gray)}>{option.name}</span>;
}

function userName(controller: AppController, id: string): string {
  return controller.store.users.get(id)?.display_name ?? t("common.member");
}

/** The rows I cannot read in a relation cell: one chip, nothing about them. */
export function HiddenRows() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-panel-2 px-1.5 py-px text-xs text-muted" data-hidden-rows title={t("docs.db.hiddenRowsHint")}>
      <Lock size={11} /> {t("docs.db.hiddenRows")}
    </span>
  );
}

export function RowChip({ ctx, rowId, onRemove }: { ctx: Pick<DbCtx, "controller" | "refs" | "openRow">; rowId: string; onRemove?: () => void }) {
  const ref = ctx.refs.get(rowId);
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded bg-panel-2 px-1.5 py-px text-xs">
      <button type="button" className="flex min-w-0 items-center gap-1 hover:underline" onClick={(event) => { event.stopPropagation(); ctx.openRow(rowId); }}>
        <PageIcon controller={ctx.controller} icon={ref?.icon ?? null} size={11} />
        <span className="truncate">{ref?.title || t("docs.untitled")}</span>
      </button>
      {onRemove && (
        <button type="button" aria-label={t("docs.db.remove")} className="text-muted hover:text-ink" onClick={(event) => { event.stopPropagation(); onRemove(); }}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

/** A cell as it reads (the table, the row page, the calendar's details). */
export function CellDisplay({ ctx, prop, row, wrap = false }: { ctx: Pick<DbCtx, "controller" | "refs" | "openRow">; prop: DbProperty; row: DbRow; wrap?: boolean }) {
  const value = cellValue(prop, row);
  const locale = intlLocale(getLocale());
  const empty = <span className="text-muted/50" />;
  switch (prop.type) {
    case "title":
      return <span className={cn("font-medium", !wrap && "truncate")}>{row.title || <span className="text-muted">{t("docs.untitled")}</span>}</span>;
    case "text":
      return value ? <span className={cn(wrap ? "whitespace-pre-wrap break-words" : "truncate")}>{String(value)}</span> : empty;
    case "number":
      return value === null ? empty : <span className={cn("truncate tabular-nums", !wrap && "block w-full text-right")}>{formatNumber(Number(value), prop.number_format, locale)}</span>;
    case "select": {
      const option = prop.options.find((o) => o.id === value);
      return option ? <OptionChip option={option} /> : empty;
    }
    case "multi_select":
      return (
        <span className={cn("flex gap-1", wrap ? "flex-wrap" : "overflow-hidden")}>
          {((value as string[] | null) ?? []).map((id) => prop.options.find((o) => o.id === id)).filter((o): o is DbOption => !!o).map((o) => <OptionChip key={o.id} option={o} />)}
        </span>
      );
    case "date":
    case "created_time":
    case "updated_time": {
      const date = asDate(value);
      return date ? <span className="truncate tabular-nums">{formatDate(date, locale)}</span> : empty;
    }
    case "person":
    case "created_by":
    case "updated_by":
      return (
        <span className={cn("flex items-center gap-1.5", wrap ? "flex-wrap" : "overflow-hidden")}>
          {((value as string[] | null) ?? []).map((id) => (
            <span key={id} className="inline-flex min-w-0 items-center gap-1">
              <Avatar id={id} name={userName(ctx.controller, id)} size={16} />
              <span className="truncate text-sm">{userName(ctx.controller, id)}</span>
            </span>
          ))}
        </span>
      );
    case "checkbox":
      return (
        <span className={cn("inline-flex h-4 w-4 items-center justify-center rounded border", value ? "border-accent bg-accent-solid text-white" : "border-line")} aria-label={value ? t("docs.db.checked") : t("docs.db.unchecked")}>
          {value ? <Check size={12} /> : null}
        </span>
      );
    case "url":
      return value ? (
        <a href={String(value)} target="_blank" rel="noreferrer" className="truncate text-accent hover:underline" onClick={(event) => event.stopPropagation()}>
          {String(value)}
        </a>
      ) : empty;
    case "relation": {
      const ids = (value as string[]) ?? [];
      const hidden = row.hidden_relations.includes(prop.id);
      return (
        <span className={cn("flex gap-1", wrap ? "flex-wrap" : "overflow-hidden")}>
          {ids.map((id) => <RowChip key={id} ctx={ctx} rowId={id} />)}
          {hidden && <HiddenRows />}
        </span>
      );
    }
  }
}

// --- editors -------------------------------------------------------------------------------------------------------

/** The editor of one cell (in a popover or the row page). `onDone` closes it. */
export function CellEditor({ ctx, prop, row, onDone }: { ctx: DbCtx; prop: DbProperty; row: DbRow; onDone: () => void }) {
  const value = cellValue(prop, row);
  const set = (next: unknown, close = true) => {
    void ctx.setCell(row, prop.id, next);
    if (close) onDone();
  };
  switch (prop.type) {
    case "title":
    case "text":
    case "url":
      return <TextEditor initial={(value as string | null) ?? ""} kind={prop.type} onCommit={(text) => set(prop.type === "title" ? text : text.trim() === "" ? null : text)} onCancel={onDone} />;
    case "number":
      return <TextEditor initial={value === null ? "" : String(value)} kind="number" onCommit={(text) => set(text.trim() === "" ? null : Number(text))} onCancel={onDone} />;
    case "select":
    case "multi_select":
      return <OptionEditor ctx={ctx} prop={prop} value={value} onSet={(next) => set(next, prop.type === "select")} />;
    case "date":
      return <DateEditor value={asDate(value)} onSet={(next) => set(next, false)} onDone={onDone} />;
    case "person":
      return <PersonEditor ctx={ctx} value={(value as string[] | null) ?? []} onSet={(next) => set(next.length ? next : null, false)} />;
    case "relation":
      return <RelationPicker ctx={ctx} prop={prop} row={row} />;
    case "checkbox":
      return null; // toggled where it shows
    default:
      return <p className="p-2 text-xs text-muted">{t("docs.db.computed")}</p>;
  }
}

function TextEditor({ initial, kind, onCommit, onCancel }: { initial: string; kind: "title" | "text" | "url" | "number"; onCommit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (text !== initial) onCommit(text);
    else onCancel();
  };
  return (
    <div className="p-1.5">
      <Input
        autoFocus
        aria-label={t("docs.db.editCell")}
        type={kind === "number" ? "number" : kind === "url" ? "url" : "text"}
        inputMode={kind === "number" ? "decimal" : undefined}
        value={text}
        maxLength={kind === "title" ? 200 : 2000}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            done.current = true;
            onCancel();
          }
        }}
        placeholder={kind === "url" ? "https://" : undefined}
        className="h-8 w-full text-sm"
      />
    </div>
  );
}

function OptionEditor({ ctx, prop, value, onSet }: { ctx: DbCtx; prop: DbProperty; value: unknown; onSet: (next: unknown) => void }) {
  const [q, setQ] = useState("");
  const multi = prop.type === "multi_select";
  const chosen = multi ? ((value as string[] | null) ?? []) : value ? [value as string] : [];
  const shown = prop.options.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase()));
  const exact = prop.options.some((o) => o.name === q.trim());
  const toggle = (id: string) => {
    if (!multi) return onSet(chosen[0] === id ? null : id);
    const next = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id];
    onSet(next.length ? next : null);
  };
  const create = async () => {
    const name = q.trim();
    if (!name) return;
    const color = (COLOR_NAMES[prop.options.length % COLOR_NAMES.length] ?? "gray") as DbOption["color"];
    const updated = await ctx.changeSchema([{ op: "update", id: prop.id, options: [...prop.options.map((o) => ({ id: o.id, name: o.name, color: o.color })), { name, color }] }]);
    const created = updated?.properties.find((p) => p.id === prop.id)?.options.find((o) => o.name === name);
    setQ("");
    if (created) toggle(created.id);
  };
  return (
    <div className="w-64 p-1.5">
      <Input autoFocus aria-label={t("docs.db.findOption")} placeholder={ctx.canManage ? t("docs.db.findOrCreateOption") : t("docs.db.findOption")} value={q} onChange={(event) => setQ(event.target.value)} className="mb-1 h-8 text-sm"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (shown[0] && (exact || !ctx.canManage)) toggle(shown[0].id);
            else if (ctx.canManage) void create();
          }
        }}
      />
      <ul className="max-h-60 overflow-y-auto" role="listbox" aria-multiselectable={multi}>
        {shown.map((option) => (
          <li key={option.id}>
            <button type="button" role="option" aria-selected={chosen.includes(option.id)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel" onClick={() => toggle(option.id)}>
              <span className="flex w-4 justify-center">{chosen.includes(option.id) && <Check size={13} />}</span>
              <OptionChip option={option} />
            </button>
          </li>
        ))}
      </ul>
      {ctx.canManage && q.trim() && !exact && (
        <button type="button" className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-panel" onClick={() => void create()}>
          <Plus size={13} /> {t("docs.db.createOption", { name: q.trim() })}
        </button>
      )}
      {!ctx.canManage && prop.options.length === 0 && <p className="px-2 py-1 text-xs text-muted">{t("docs.db.noOptions")}</p>}
    </div>
  );
}

function DateEditor({ value, onSet, onDone }: { value: DbDateValue | null; onSet: (next: DbDateValue | null) => void; onDone: () => void }) {
  const [start, setStart] = useState(value?.start ?? "");
  const [end, setEnd] = useState(value?.end ?? "");
  const [time, setTime] = useState(value?.time ?? false);
  const [hasEnd, setHasEnd] = useState(!!value?.end);
  const local = (text: string) => (text.length > 10 ? withOffset(new Date(text)).slice(0, 16) : text ? `${text}T09:00` : "");
  const day = (text: string) => (text.length > 10 ? withOffset(new Date(text)).slice(0, 10) : text);
  const toValue = (s: string, e: string, timed: boolean, withEnd: boolean): DbDateValue | null => {
    if (!s) return null;
    const one = (text: string) => (timed ? withOffset(new Date(text.length > 10 ? text : `${text}T09:00`)) : day(text));
    const first = one(s);
    let last = withEnd && e ? one(e) : null;
    if (last && last < first) last = first;
    return { start: first, end: last, time: timed };
  };
  const apply = (s = start, e = end, timed = time, withEnd = hasEnd) => onSet(toValue(s, e, timed, withEnd));
  return (
    <div className="w-72 space-y-2 p-2.5 text-sm">
      <Field label={hasEnd ? t("docs.db.startDate") : t("docs.db.date")}>
        <Input type={time ? "datetime-local" : "date"} aria-label={hasEnd ? t("docs.db.startDate") : t("docs.db.date")} value={time ? local(start) : day(start)} onChange={(event) => { setStart(event.target.value); apply(event.target.value); }} className="h-8" />
      </Field>
      {hasEnd && (
        <Field label={t("docs.db.endDate")}>
          <Input type={time ? "datetime-local" : "date"} aria-label={t("docs.db.endDate")} value={time ? local(end) : day(end)} onChange={(event) => { setEnd(event.target.value); apply(start, event.target.value); }} className="h-8" />
        </Field>
      )}
      <label className="flex items-center gap-2"><input type="checkbox" checked={hasEnd} onChange={(event) => { const next = event.target.checked; setHasEnd(next); const e = next ? end || start : ""; setEnd(e); apply(start, e, time, next); }} /> {t("docs.db.endDateToggle")}</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={time} onChange={(event) => { const next = event.target.checked; setTime(next); apply(start, end, next); }} /> {t("docs.db.includeTime")}</label>
      <div className="flex justify-between pt-1">
        <Button size="sm" variant="ghost" onClick={() => { if (!start) { setStart(todayIso()); apply(todayIso()); } }}>{t("docs.db.today")}</Button>
        <div className="flex gap-1">
          <Button size="sm" variant="secondary" onClick={() => { onSet(null); onDone(); }}>{t("docs.db.clear")}</Button>
          <Button size="sm" onClick={onDone}>{t("docs.db.done")}</Button>
        </div>
      </div>
    </div>
  );
}

function PersonEditor({ ctx, value, onSet }: { ctx: DbCtx; value: string[]; onSet: (next: string[]) => void }) {
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState(value);
  const people = useMemo(() => [...ctx.controller.store.users.values()].filter((u) => u.role !== "bot" && !u.deactivated_at), [ctx.controller]);
  const needle = q.trim().toLowerCase();
  const shown = people.filter((u) => !needle || u.display_name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle)).slice(0, 50);
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id];
    setChosen(next);
    onSet(next);
  };
  return (
    <div className="w-64 p-1.5">
      <Input autoFocus aria-label={t("docs.db.findPerson")} placeholder={t("docs.db.findPerson")} value={q} onChange={(event) => setQ(event.target.value)} className="mb-1 h-8 text-sm" />
      <ul className="max-h-60 overflow-y-auto">
        {shown.map((user) => (
          <li key={user.id}>
            <button type="button" aria-pressed={chosen.includes(user.id)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-panel" onClick={() => toggle(user.id)}>
              <span className="flex w-4 justify-center">{chosen.includes(user.id) && <Check size={13} />}</span>
              <Avatar id={user.id} name={user.display_name} size={18} />
              <span className="truncate">{user.display_name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The relation cell's picker: the linked rows I can read (removable), then a search of the related database's rows I
 * can read (`…/candidates`). Rows I cannot read stay linked, shown as one 「アクセスできないページ」.
 */
export function RelationPicker({ ctx, prop, row }: { ctx: DbCtx; prop: DbProperty; row: DbRow }) {
  const current = row.relations[prop.id] ?? [];
  const [q, setQ] = useState("");
  const [found, setFound] = useState<DbRowRef[] | null>(null);
  const [extra, setExtra] = useState<Map<string, DbRowRef>>(new Map());
  const target = prop.relation?.database_id ?? null;
  useEffect(() => {
    const api = ctx.controller.api;
    if (!api || !target) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api.wikiRelationCandidates(ctx.database.page_id, prop.id, q).then((rows) => { if (live) setFound(rows); }, () => { if (live) setFound([]); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [ctx.controller, ctx.database.page_id, prop.id, q, target]);
  const refs = useMemo(() => new Map([...ctx.refs, ...extra]), [ctx.refs, extra]);
  const chipCtx = { ...ctx, refs };
  const write = (ids: string[]) => void ctx.setCell(row, prop.id, ids);
  return (
    <div className="w-80 p-2" data-relation-picker>
      {!target ? (
        <p className="text-sm text-muted">{t("docs.db.relationUnreadable")}</p>
      ) : (
        <>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{prop.relation?.database_title || t("docs.untitled")}</div>
          <div className="mb-2 flex flex-wrap gap-1">
            {current.map((id) => <RowChip key={id} ctx={chipCtx} rowId={id} onRemove={() => write(current.filter((c) => c !== id))} />)}
            {row.hidden_relations.includes(prop.id) && <HiddenRows />}
          </div>
          <Input autoFocus aria-label={t("docs.db.findRow")} placeholder={t("docs.db.findRow")} value={q} onChange={(event) => setQ(event.target.value)} className="mb-1 h-8 text-sm" />
          {found === null ? (
            <div className="flex justify-center py-2"><Loader2 size={16} className="animate-spin text-muted" /></div>
          ) : found.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted">{t("docs.db.noRowsFound")}</p>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {found.map((ref) => {
                const linked = current.includes(ref.id);
                return (
                  <li key={ref.id}>
                    <button type="button" aria-pressed={linked} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-panel"
                      onClick={() => {
                        setExtra((map) => new Map(map).set(ref.id, ref));
                        write(linked ? current.filter((c) => c !== ref.id) : [...current, ref.id]);
                      }}
                    >
                      <span className="flex w-4 justify-center">{linked && <Check size={13} />}</span>
                      <PageIcon controller={ctx.controller} icon={ref.icon} size={13} />
                      <span className="truncate">{ref.title || t("docs.untitled")}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// --- adding and changing properties --------------------------------------------------------------------------------

interface OptionDraft {
  id?: string;
  name: string;
  color: DbOption["color"];
}

/**
 * Add a property, or change one (name, options, number format, type, delete). A type change converts every row on
 * the server; values it cannot convert are kept 30 days and come back if the type is changed back.
 */
export function PropertyDialog({ ctx, prop, databases, onClose }: { ctx: DbCtx; prop: DbProperty | null; databases: ReadonlyArray<{ id: string; title: string }>; onClose: () => void }) {
  const [name, setName] = useState(prop?.name ?? "");
  const [type, setType] = useState<DbPropType>(prop?.type ?? "text");
  const [options, setOptions] = useState<OptionDraft[]>(prop?.options.map((o) => ({ ...o })) ?? []);
  const [format, setFormat] = useState(prop?.number_format ?? "number");
  const [target, setTarget] = useState(prop?.relation?.database_id ?? ctx.database.page_id);
  const [twoWay, setTwoWay] = useState(false);
  const [pairName, setPairName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isTitle = prop?.type === "title";
  const retyping = !!prop && prop.type !== type;
  const hasOptions = type === "select" || type === "multi_select";
  const relation = type === "relation" && (!prop || retyping) ? { database_id: target, two_way: twoWay, pair_name: pairName } : undefined;
  const save = async () => {
    setBusy(true);
    const opts = options.filter((o) => o.name.trim()).map((o) => ({ ...(o.id ? { id: o.id } : {}), name: o.name.trim(), color: o.color }));
    const ops: DbSchemaOp[] = [];
    if (!prop) {
      ops.push({ op: "add", name: name.trim(), type: type as NewType, ...(hasOptions ? { options: opts } : {}), ...(type === "number" ? { number_format: format } : {}), ...(relation ? { relation } : {}) });
    } else {
      if (retyping) ops.push({ op: "retype", id: prop.id, type: type as NewType, ...(type === "number" ? { number_format: format } : {}), ...(relation ? { relation } : {}) });
      const update: DbSchemaOp = { op: "update", id: prop.id };
      if (name.trim() !== prop.name) update.name = name.trim();
      if (hasOptions) update.options = opts;
      if (type === "number" && !retyping && format !== prop.number_format) update.number_format = format;
      if (Object.keys(update).length > 2) ops.push(update);
    }
    const done = ops.length === 0 ? ctx.database : await ctx.changeSchema(ops);
    setBusy(false);
    if (done) onClose();
  };
  const remove = async () => {
    if (!prop) return;
    setBusy(true);
    const done = await ctx.changeSchema([{ op: "delete", id: prop.id }]);
    setBusy(false);
    if (done) onClose();
  };
  const typeChoices: DbPropType[] = isTitle ? ["title"] : [...NEW_TYPES];
  return (
    <Modal title={prop ? t("docs.db.editProperty") : t("docs.db.addProperty")} onClose={onClose}>
      <div className="mt-3 space-y-3">
        <Field label={t("docs.db.propName")}>
          <Input autoFocus value={name} maxLength={100} placeholder={isTitle ? t("docs.db.titleProp") : typeLabel(type)} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("docs.db.propType")} hint={retyping ? t("docs.db.retypeNote") : undefined}>
          <select aria-label={t("docs.db.propType")} disabled={isTitle} value={type} onChange={(event) => setType(event.target.value as DbPropType)} className="h-9 w-full rounded-lg border border-line bg-canvas px-2 text-sm">
            {typeChoices.map((choice) => <option key={choice} value={choice}>{typeLabel(choice)}</option>)}
          </select>
        </Field>
        {type === "number" && (
          <Field label={t("docs.db.numberFormat")}>
            <select aria-label={t("docs.db.numberFormat")} value={format ?? "number"} onChange={(event) => setFormat(event.target.value as typeof format)} className="h-9 w-full rounded-lg border border-line bg-canvas px-2 text-sm">
              {(["number", "integer", "percent", "yen"] as const).map((f) => <option key={f} value={f}>{t(`docs.db.format.${f}` as MessageKey)}</option>)}
            </select>
          </Field>
        )}
        {hasOptions && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted">{t("docs.db.options")}</div>
            <ul className="space-y-1">
              {options.map((option, index) => (
                <li key={option.id ?? `new-${index}`} className="flex items-center gap-1.5">
                  <select aria-label={t("docs.db.optionColor")} value={option.color} onChange={(event) => setOptions((list) => list.map((o, i) => (i === index ? { ...o, color: event.target.value as DbOption["color"] } : o)))} className={cn("h-8 w-24 rounded-md border border-line px-1 text-xs", OPTION_COLORS[option.color])}>
                    {COLOR_NAMES.map((c) => <option key={c} value={c}>{t(`docs.db.color.${c}` as MessageKey)}</option>)}
                  </select>
                  <Input aria-label={t("docs.db.optionName")} value={option.name} maxLength={100} onChange={(event) => setOptions((list) => list.map((o, i) => (i === index ? { ...o, name: event.target.value } : o)))} className="h-8 flex-1 text-sm" />
                  <button type="button" aria-label={t("docs.db.remove")} className="text-muted hover:text-danger" onClick={() => setOptions((list) => list.filter((_, i) => i !== index))}><X size={14} /></button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => setOptions((list) => [...list, { name: "", color: (COLOR_NAMES[list.length % COLOR_NAMES.length] ?? "gray") as DbOption["color"] }])}><Plus size={13} /> {t("docs.db.addOption")}</Button>
          </div>
        )}
        {type === "relation" && (!prop || retyping) && (
          <>
            <Field label={t("docs.db.relationTarget")}>
              <select aria-label={t("docs.db.relationTarget")} value={target} onChange={(event) => setTarget(event.target.value)} className="h-9 w-full rounded-lg border border-line bg-canvas px-2 text-sm">
                {databases.map((d) => <option key={d.id} value={d.id}>{d.id === ctx.database.page_id ? t("docs.db.thisDatabase", { title: d.title || t("docs.untitled") }) : d.title || t("docs.untitled")}</option>)}
              </select>
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={twoWay} onChange={(event) => setTwoWay(event.target.checked)} />
              <span>{t("docs.db.twoWay")}<span className="block text-xs text-muted">{t("docs.db.twoWayHint")}</span></span>
            </label>
            {twoWay && (
              <Field label={t("docs.db.pairName")}>
                <Input value={pairName} maxLength={100} onChange={(event) => setPairName(event.target.value)} />
              </Field>
            )}
          </>
        )}
        {prop?.type === "relation" && !retyping && (
          <p className="text-xs text-muted">{prop.relation?.database_title ? t("docs.db.relationTo", { title: prop.relation.database_title }) : t("docs.db.relationUnreadable")}{prop.relation?.pair_id ? ` ${t("docs.db.relationTwoWay")}` : ""}</p>
        )}
      </div>
      <div className="mt-5 flex items-center justify-between gap-2">
        {prop && !isTitle ? (
          confirmDelete ? (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}><Trash2 size={13} /> {t("docs.db.deleteConfirm")}</Button>
          ) : (
            <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={13} /> {t("docs.db.deleteProperty")}</Button>
          )
        ) : <span />}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={busy || (type === "relation" && !target)} onClick={() => void save()}>{busy && <Loader2 size={14} className="animate-spin" />}{prop ? t("common.save") : t("docs.db.add")}</Button>
        </div>
      </div>
    </Modal>
  );
}

export function Labelled({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-[34px] items-start gap-2 py-0.5">
      <div className="flex w-40 shrink-0 items-center gap-1.5 pt-1.5 text-sm text-muted max-md:w-28">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
