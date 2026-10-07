/**
 * M123 (WIKI.md §5, §9.1): a database page's table and calendar. The saved views are tabs; sorting, filtering and the
 * columns (order, width, hidden) change on this screen at once and are saved to the view by someone with full access
 * (「ビューを保存」). The server sorts and filters (`POST …/query`); a change of a row anywhere comes as
 * wiki.rows.changed and the rows are read again.
 *
 * - table: cells edited in place (a popover per type, a checkbox toggles), 「＋ 新規」 adds a row, the title's ↗ opens the
 *   row beside the table (its properties above its body); scrolls sideways on a narrow screen.
 * - calendar: a month by a date property; a row with a range spans its days, a click on a day adds a row on that day,
 *   a row dragged to another day moves its date (and its end with it). On a narrow screen, the month as an agenda.
 */
import { ArrowDown, ArrowUp, ArrowUpDown, CalendarDays, ChevronLeft, ChevronRight, Columns3, Download, Eye, EyeOff, ListFilter, Loader2, Maximize2, MoreHorizontal, Pencil, Plus, Save, Table2, Trash2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../api/errors";
import type { DatabaseOut, DbFilterCondition, DbFilterOp, DbProperty, DbRow, DbRowRef, DbSchemaOp, DbView, DbViewIn } from "../api/types";
import { saveDownload } from "../platform/download";
import type { AppController } from "../state/app";
import { getLocale, intlLocale, t, weekdayName, type MessageKey } from "../i18n";
import { CellDisplay, CellEditor, type DbCtx, PropertyDialog, PropIcon, propName } from "./DbCells";
import { useWikiHub } from "./DocsTree";
import { Button, cn, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, PopoverAnchor, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import {
  agenda,
  clampWidth,
  type Column,
  columnsOf,
  daysBetween,
  firstDateProp,
  isDateish,
  layoutWeek,
  monthBounds,
  monthGrid,
  moveColumn,
  newCondition,
  newViewId,
  opNeedsValue,
  opsFor,
  readyConditions,
  shiftDate,
  sortable,
  spanOf,
  todayIso,
  toViewColumns,
  viewBody,
  viewDiffers,
  asDate,
} from "./wikiDb";

const PAGE = 200;

function readRemembered(databaseId: string): string | null {
  try {
    return localStorage.getItem(`wikidb:view:${databaseId}`);
  } catch {
    return null;
  }
}

function remember(databaseId: string, viewId: string): void {
  try {
    localStorage.setItem(`wikidb:view:${databaseId}`, viewId);
  } catch {
    // private mode: the first view next time
  }
}

export function viewName(view: Pick<DbView, "name" | "type">): string {
  return view.name || (view.type === "calendar" ? t("docs.db.calendar") : t("docs.db.table"));
}

export function DatabaseView({ controller, databaseId, compact, renderPeek, onOpenRowPage }: {
  controller: AppController;
  databaseId: string;
  compact: boolean;
  /** The row beside the table (a wide screen); a narrow one opens the row as its page. */
  renderPeek: (rowId: string, close: () => void) => ReactNode;
  onOpenRowPage: (rowId: string) => void;
}) {
  const hub = useWikiHub(controller);
  const [database, setDatabase] = useState<DatabaseOut | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewId, setViewId] = useState<string | null>(() => readRemembered(databaseId));
  const [draft, setDraft] = useState<DbViewIn | null>(null);
  const [rows, setRows] = useState<DbRow[]>([]);
  const [refs, setRefs] = useState<Map<string, DbRowRef>>(new Map());
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);
  const [month, setMonth] = useState(() => { const now = new Date(); return { year: now.getFullYear(), month: now.getMonth() }; });
  const [propDialog, setPropDialog] = useState<{ prop: DbProperty | null } | null>(null);
  const [renaming, setRenaming] = useState<DbView | null>(null);
  const loadSeq = useRef(0);

  const view = database ? database.views.find((v) => v.id === viewId) ?? database.views[0]! : null;
  const canEdit = database ? database.my_level !== "view" : false;
  const canManage = database ? database.my_level === "full" && !controller.isGuest : false;

  const loadDatabase = useCallback(async () => {
    const api = controller.api;
    if (!api) return;
    try {
      const next = await api.wikiDatabase(databaseId);
      setDatabase((current) => (current && current.schema_version === next.schema_version && current.row_count === next.row_count ? current : next));
      setFailed(false);
    } catch (error) {
      setFailed(true);
      if (!(error instanceof ApiError && error.status === 404)) controller.setError(error);
    }
  }, [controller, databaseId]);
  useEffect(() => { void loadDatabase(); }, [loadDatabase]);

  // The screen's sort / filter / columns start as the view's, and follow it while unchanged here.
  const savedBody = view ? JSON.stringify(viewBody(view)) : "";
  const lastSaved = useRef<string>("");
  useEffect(() => {
    if (!view) return;
    setDraft((current) => (current === null || JSON.stringify(current) === lastSaved.current || current.type !== view.type ? viewBody(view) : current));
    lastSaved.current = savedBody;
  }, [view?.id, savedBody]); // eslint-disable-line react-hooks/exhaustive-deps

  const datePropId = draft?.type === "calendar" ? draft.date_prop_id ?? (database ? firstDateProp(database)?.id ?? null : null) : null;
  const grid = useMemo(() => monthGrid(month.year, month.month, 1), [month]);
  const range = draft?.type === "calendar" && datePropId ? { prop_id: datePropId, start: grid[0]![0]!, end: grid[5]![6]! } : null;
  const queryKey = draft ? JSON.stringify({ s: draft.sort, f: readyConditions(draft.filter?.conditions ?? []), c: draft.filter?.combinator, r: range, type: draft.type }) : "";

  const loadRows = useCallback(async (more = false) => {
    const api = controller.api;
    if (!api || !draft || !view) return;
    if (draft.type === "calendar" && !range) {
      setRows([]);
      setTotal(0);
      return;
    }
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const conditions = readyConditions(draft.filter?.conditions ?? []);
      const out = await api.queryWikiRows(databaseId, {
        view_id: view.id,
        sort: draft.sort ?? [],
        filter: { combinator: draft.filter?.combinator ?? "and", conditions },
        range,
        cursor: more ? cursor : null,
        limit: range ? 1000 : PAGE,
      });
      if (seq !== loadSeq.current) return;
      setRows((current) => (more ? [...current, ...out.rows] : out.rows));
      setRefs((current) => {
        const next = new Map(more ? current : []);
        for (const ref of out.refs) next.set(ref.id, ref);
        return next;
      });
      setTotal(out.total);
      setCursor(out.next_cursor ?? null);
      if (database && out.schema_version !== database.schema_version) void loadDatabase();
    } catch (error) {
      if (seq === loadSeq.current) controller.setError(error);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [controller, databaseId, queryKey, view?.id, cursor, database?.schema_version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadRows(false); }, [queryKey, view?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // wiki.rows.changed (and a reconnect): read again, collapsing a burst.
  const reload = useRef<() => void>(() => {});
  reload.current = () => { void loadDatabase(); void loadRows(false); };
  useEffect(() => {
    if (!hub) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = hub.onRows(databaseId, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => reload.current(), 300);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [hub, databaseId]);

  const setCell = useCallback(async (row: DbRow, propId: string, value: unknown) => {
    const api = controller.api;
    if (!api) return;
    const patch = (r: DbRow): DbRow => {
      if (r.id !== row.id) return r;
      if (propId === "title") return { ...r, title: String(value ?? "") };
      const prop = database?.properties.find((p) => p.id === propId);
      if (prop?.type === "relation") return { ...r, relations: { ...r.relations, [propId]: (value as string[]) ?? [] } };
      const props = { ...r.props } as Record<string, unknown>;
      if (value === null || value === false) delete props[propId];
      else props[propId] = value;
      return { ...r, props: props as DbRow["props"] };
    };
    setRows((current) => current.map(patch));
    try {
      const out = await api.setWikiCells(row.id, { [propId]: value }, crypto.randomUUID());
      setRows((current) => current.map((r) => (r.id === out.row.id ? out.row : r)));
      setRefs((current) => {
        const next = new Map(current);
        for (const ref of out.refs) next.set(ref.id, ref);
        return next;
      });
    } catch (error) {
      controller.setError(error);
      void loadRows(false);
    }
  }, [controller, database, loadRows]);

  const changeSchema = useCallback(async (ops: DbSchemaOp[]) => {
    const api = controller.api;
    if (!api || !database) return null;
    try {
      const next = await api.changeWikiSchema(databaseId, { base_schema_version: database.schema_version, ops });
      setDatabase(next);
      void loadRows(false);
      return next;
    } catch (error) {
      controller.setError(error);
      if (error instanceof ApiError && error.status === 409) void loadDatabase();
      return null;
    }
  }, [controller, database, databaseId, loadDatabase, loadRows]);

  const openRow = useCallback((rowId: string) => {
    if (compact) onOpenRowPage(rowId);
    else setPeek(rowId);
  }, [compact, onOpenRowPage]);

  const addRow = async (props: Record<string, unknown> = {}): Promise<DbRow | null> => {
    const api = controller.api;
    if (!api) return null;
    try {
      const out = await api.createWikiRow(databaseId, { title: "", props, client_save_id: crypto.randomUUID() });
      setRows((current) => [...current, out.row]);
      setTotal((n) => n + 1);
      return out.row;
    } catch (error) {
      controller.setError(error);
      return null;
    }
  };

  const saveView = async (body: DbViewIn, id = view?.id) => {
    const api = controller.api;
    if (!api || !id) return;
    try {
      const next = await api.putWikiView(databaseId, id, body);
      setDatabase(next);
      lastSaved.current = JSON.stringify(body);
      setViewId(id);
      remember(databaseId, id);
    } catch (error) {
      controller.setError(error);
    }
  };
  const deleteView = async (id: string) => {
    const api = controller.api;
    if (!api) return;
    try {
      const next = await api.deleteWikiView(databaseId, id);
      setDatabase(next);
      if (id === view?.id) setViewId(next.views[0]?.id ?? null);
    } catch (error) {
      controller.setError(error);
    }
  };
  const exportCsv = async () => {
    const api = controller.api;
    if (!api) return;
    try {
      const blob = await api.exportWikiDatabaseCsv(databaseId, view?.id ?? null);
      const title = hub?.page(databaseId)?.title?.replace(/[\\/:*?"<>|]+/g, "_") || "database";
      await saveDownload(`${title}.csv`, blob);
    } catch (error) {
      controller.setError(error);
    }
  };

  if (!database || !draft || !view) {
    return failed ? <p className="py-6 text-sm text-muted">{t("docs.db.loadFailed")}</p> : <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-muted" /></div>;
  }

  const ctx: DbCtx = { controller, database, refs, canEdit, canManage, setCell, changeSchema, openRow };
  const columns = columnsOf(database.properties, draft.columns ?? []);
  const setColumns = (next: Column[]) => setDraft({ ...draft, columns: toViewColumns(next) });
  const differs = viewDiffers(view, draft);
  const databases = [...(hub?.pages.values() ?? [])].filter((p) => p.kind === "database").map((p) => ({ id: p.id, title: p.title }));
  if (!databases.some((d) => d.id === databaseId)) databases.unshift({ id: databaseId, title: hub?.page(databaseId)?.title ?? "" });

  return (
    <div className="mt-6 min-w-0" data-database={databaseId}>
      <div className="flex flex-wrap items-center gap-1 border-b border-line pb-1.5">
        <div role="tablist" aria-label={t("docs.db.views")} className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
          {database.views.map((v) => (
            <ViewTab key={v.id} view={v} active={v.id === view.id} canManage={canManage} last={database.views.length === 1}
              onPick={() => { setViewId(v.id); remember(databaseId, v.id); setDraft(viewBody(v)); lastSaved.current = JSON.stringify(viewBody(v)); }}
              onRename={() => setRenaming(v)}
              onDelete={() => void deleteView(v.id)}
            />
          ))}
          {canManage && database.views.length < database.limits.views && (
            <Menu>
              <MenuTrigger asChild>
                <button type="button" aria-label={t("docs.db.addView")} title={t("docs.db.addView")} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-ink/6 hover:text-ink"><Plus size={15} /></button>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuItem onSelect={() => void saveView({ name: "", type: "table", columns: [], sort: [], filter: null, date_prop_id: null }, newViewId())}><Table2 size={14} /> {t("docs.db.table")}</MenuItem>
                <MenuItem onSelect={() => void saveView({ name: "", type: "calendar", columns: [], sort: [], filter: null, date_prop_id: firstDateProp(database)?.id ?? null }, newViewId())} disabled={!firstDateProp(database)}><CalendarDays size={14} /> {t("docs.db.calendar")}</MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {loading && <Loader2 size={14} className="mr-1 animate-spin text-muted" />}
          <SortButton database={database} draft={draft} onChange={(sort) => setDraft({ ...draft, sort })} />
          <FilterButton ctx={ctx} draft={draft} onChange={(filter) => setDraft({ ...draft, filter })} />
          {draft.type === "table" && <ColumnsButton columns={columns} canManage={canManage} onChange={setColumns} onAdd={() => setPropDialog({ prop: null })} onEdit={(prop) => setPropDialog({ prop })} />}
          {differs && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setDraft(viewBody(view))}>{t("docs.db.reset")}</Button>
              {canManage && <Button size="sm" onClick={() => void saveView(draft)}><Save size={13} /> {t("docs.db.saveView")}</Button>}
            </>
          )}
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={t("docs.db.more")} title={t("docs.db.more")} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink hover:bg-ink/6"><MoreHorizontal size={16} /></button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => void exportCsv()}><Download size={14} /> {t("docs.db.exportCsv")}</MenuItem>
              {canManage && <MenuItem onSelect={() => setPropDialog({ prop: null })}><Plus size={14} /> {t("docs.db.addProperty")}</MenuItem>}
            </MenuContent>
          </Menu>
        </div>
      </div>
      {draft.type === "calendar" && (
        <CalendarBar database={database} propId={datePropId} month={month} onMonth={setMonth} onProp={(id) => setDraft({ ...draft, date_prop_id: id })} />
      )}
      <div className="flex min-w-0 gap-3">
        <div className="min-w-0 flex-1">
          {draft.type === "table" ? (
            <TableView ctx={ctx} columns={columns} rows={rows} total={total} hasMore={!!cursor} onMore={() => void loadRows(true)}
              onColumns={setColumns} onAddRow={() => void addRow()} onEditProp={canManage ? (prop) => setPropDialog({ prop }) : null}
              onSort={(propId, direction) => setDraft({ ...draft, sort: [{ prop_id: propId, direction }] })}
            />
          ) : datePropId ? (
            compact ? (
              <AgendaView ctx={ctx} rows={rows} propId={datePropId} month={month} />
            ) : (
              <CalendarView ctx={ctx} rows={rows} propId={datePropId} grid={grid} month={month}
                onAddOn={async (day) => {
                  const prop = database.properties.find((p) => p.id === datePropId);
                  if (prop?.type !== "date") return;
                  const row = await addRow({ [datePropId]: { start: day, end: null, time: false } });
                  if (row) openRow(row.id);
                }}
              />
            )
          ) : (
            <p className="py-6 text-sm text-muted">{t("docs.db.needDateProp")}</p>
          )}
        </div>
        {peek && !compact && (
          <aside aria-label={t("docs.db.rowPane")} className="flex max-h-[80vh] w-[440px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-sm" data-row-peek={peek}>
            <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-line px-1.5">
              <button type="button" aria-label={t("docs.db.openFull")} title={t("docs.db.openFull")} className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-ink/6" onClick={() => onOpenRowPage(peek)}><Maximize2 size={14} /></button>
              <button type="button" aria-label={t("common.close")} title={t("common.close")} className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-ink/6" onClick={() => setPeek(null)}><X size={15} /></button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{renderPeek(peek, () => setPeek(null))}</div>
          </aside>
        )}
      </div>
      {propDialog && <PropertyDialog ctx={ctx} prop={propDialog.prop} databases={databases} onClose={() => setPropDialog(null)} />}
      {renaming && <RenameView view={renaming} onClose={() => setRenaming(null)} onSave={(name) => { setRenaming(null); void saveView({ ...viewBody(renaming), name }, renaming.id); }} />}
    </div>
  );
}

function ViewTab({ view, active, canManage, last, onPick, onRename, onDelete }: { view: DbView; active: boolean; canManage: boolean; last: boolean; onPick: () => void; onRename: () => void; onDelete: () => void }) {
  const Icon = view.type === "calendar" ? CalendarDays : Table2;
  return (
    <span className={cn("group inline-flex items-center rounded-md", active ? "bg-panel-2 text-ink" : "text-muted hover:bg-ink/6 hover:text-ink")}>
      <button type="button" role="tab" aria-selected={active} className="inline-flex h-7 items-center gap-1.5 px-2 text-sm font-medium" onClick={onPick}>
        <Icon size={14} /> {viewName(view)}
      </button>
      {canManage && active && (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" aria-label={t("docs.db.viewMenu")} className="mr-0.5 inline-flex h-6 w-5 items-center justify-center rounded text-muted hover:text-ink"><MoreHorizontal size={13} /></button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem onSelect={onRename}><Pencil size={14} /> {t("docs.db.renameView")}</MenuItem>
            {!last && <MenuItem className="text-danger" onSelect={onDelete}><Trash2 size={14} /> {t("docs.db.deleteView")}</MenuItem>}
          </MenuContent>
        </Menu>
      )}
    </span>
  );
}

function RenameView({ view, onClose, onSave }: { view: DbView; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(view.name);
  return (
    <Modal title={t("docs.db.renameView")} onClose={onClose}>
      <form className="mt-3" onSubmit={(event) => { event.preventDefault(); onSave(name.trim()); }}>
        <Input autoFocus aria-label={t("docs.db.viewName")} value={name} maxLength={60} placeholder={viewName({ ...view, name: "" })} onChange={(event) => setName(event.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit">{t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- toolbar -------------------------------------------------------------------------------------------------------

function ToolButton({ icon, label, count }: { icon: ReactNode; label: string; count?: number }) {
  return (
    <PopoverTrigger asChild>
      <button type="button" className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium hover:bg-ink/6", count ? "text-accent" : "text-ink")}>
        {icon}
        <span className="max-md:sr-only">{label}</span>
        {count ? <span className="tabular-nums">{count}</span> : null}
      </button>
    </PopoverTrigger>
  );
}

const selectClass = "h-8 rounded-md border border-line bg-canvas px-1.5 text-sm";

function SortButton({ database, draft, onChange }: { database: DatabaseOut; draft: DbViewIn; onChange: (sort: NonNullable<DbViewIn["sort"]>) => void }) {
  const sort = draft.sort ?? [];
  const props = database.properties.filter((p) => sortable(p.type));
  return (
    <PopoverRoot>
      <ToolButton icon={<ArrowUpDown size={13} />} label={t("docs.db.sort")} count={sort.length} />
      <PopoverContent align="end" className="w-80 p-2">
        {sort.length === 0 && <p className="px-1 py-1 text-xs text-muted">{t("docs.db.noSort")}</p>}
        <ul className="space-y-1">
          {sort.map((key, index) => (
            <li key={index} className="flex items-center gap-1">
              <select aria-label={t("docs.db.sortBy")} className={cn(selectClass, "min-w-0 flex-1")} value={key.prop_id} onChange={(event) => onChange(sort.map((k, i) => (i === index ? { ...k, prop_id: event.target.value } : k)))}>
                {props.map((p) => <option key={p.id} value={p.id}>{propName(p)}</option>)}
              </select>
              <select aria-label={t("docs.db.direction")} className={selectClass} value={key.direction ?? "asc"} onChange={(event) => onChange(sort.map((k, i) => (i === index ? { ...k, direction: event.target.value as "asc" | "desc" } : k)))}>
                <option value="asc">{t("docs.db.asc")}</option>
                <option value="desc">{t("docs.db.desc")}</option>
              </select>
              <button type="button" aria-label={t("docs.db.remove")} className="text-muted hover:text-ink" onClick={() => onChange(sort.filter((_, i) => i !== index))}><X size={14} /></button>
            </li>
          ))}
        </ul>
        {sort.length < 5 && (
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => onChange([...sort, { prop_id: props.find((p) => !sort.some((k) => k.prop_id === p.id))?.id ?? "title", direction: "asc" }])}><Plus size={13} /> {t("docs.db.addSort")}</Button>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

function FilterButton({ ctx, draft, onChange }: { ctx: DbCtx; draft: DbViewIn; onChange: (filter: DbViewIn["filter"]) => void }) {
  const conditions = (draft.filter?.conditions ?? []) as DbFilterCondition[];
  const combinator = draft.filter?.combinator ?? "and";
  const props = ctx.database.properties;
  const set = (next: DbFilterCondition[], comb = combinator) => onChange({ combinator: comb, conditions: next });
  return (
    <PopoverRoot>
      <ToolButton icon={<ListFilter size={13} />} label={t("docs.db.filter")} count={conditions.length} />
      <PopoverContent align="end" className="w-[420px] max-w-[94vw] p-2">
        {conditions.length === 0 && <p className="px-1 py-1 text-xs text-muted">{t("docs.db.noFilter")}</p>}
        {conditions.length > 1 && (
          <label className="mb-1 flex items-center gap-2 px-1 text-xs text-muted">
            {t("docs.db.match")}
            <select aria-label={t("docs.db.match")} className={selectClass} value={combinator} onChange={(event) => set(conditions, event.target.value as "and" | "or")}>
              <option value="and">{t("docs.db.matchAll")}</option>
              <option value="or">{t("docs.db.matchAny")}</option>
            </select>
          </label>
        )}
        <ul className="space-y-1">
          {conditions.map((condition, index) => {
            const prop = props.find((p) => p.id === condition.prop_id);
            if (!prop) return null;
            const replace = (next: DbFilterCondition) => set(conditions.map((c, i) => (i === index ? next : c)));
            return (
              <li key={index} className="flex flex-wrap items-center gap-1">
                <select aria-label={t("docs.db.filterProp")} className={cn(selectClass, "w-32")} value={prop.id} onChange={(event) => { const p = props.find((x) => x.id === event.target.value); if (p) replace(newCondition(p) as DbFilterCondition); }}>
                  {props.map((p) => <option key={p.id} value={p.id}>{propName(p)}</option>)}
                </select>
                <select aria-label={t("docs.db.filterOp")} className={cn(selectClass, "w-32")} value={condition.op} onChange={(event) => replace({ ...condition, op: event.target.value as DbFilterOp })}>
                  {opsFor(prop.type).map((op) => <option key={op} value={op}>{t(`docs.db.op.${op}` as MessageKey)}</option>)}
                </select>
                {opNeedsValue(condition.op) && <FilterValue ctx={ctx} prop={prop} condition={condition} onChange={(value) => replace({ ...condition, value })} />}
                <button type="button" aria-label={t("docs.db.remove")} className="ml-auto text-muted hover:text-ink" onClick={() => set(conditions.filter((_, i) => i !== index))}><X size={14} /></button>
              </li>
            );
          })}
        </ul>
        {conditions.length < 20 && (
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => set([...conditions, newCondition(props[0]!) as DbFilterCondition])}><Plus size={13} /> {t("docs.db.addFilter")}</Button>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

function FilterValue({ ctx, prop, condition, onChange }: { ctx: DbCtx; prop: DbProperty; condition: DbFilterCondition; onChange: (value: unknown) => void }) {
  const value = condition.value as unknown;
  const cls = cn(selectClass, "min-w-0 flex-1");
  switch (prop.type) {
    case "number":
      return <input type="number" aria-label={t("docs.db.filterValue")} className={cls} value={typeof value === "number" ? value : ""} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} />;
    case "checkbox":
      return (
        <select aria-label={t("docs.db.filterValue")} className={cls} value={value ? "1" : "0"} onChange={(event) => onChange(event.target.value === "1")}>
          <option value="1">{t("docs.db.checked")}</option>
          <option value="0">{t("docs.db.unchecked")}</option>
        </select>
      );
    case "select":
    case "multi_select":
      return (
        <select aria-label={t("docs.db.filterValue")} className={cls} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          {prop.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      );
    case "person":
    case "created_by":
    case "updated_by":
      return (
        <select aria-label={t("docs.db.filterValue")} className={cls} value={String(value ?? "me")} onChange={(event) => onChange(event.target.value)}>
          <option value="me">{t("docs.db.me")}</option>
          {[...ctx.controller.store.users.values()].filter((u) => u.role !== "bot").map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
      );
    case "relation":
      return <RelationFilterValue ctx={ctx} prop={prop} value={String(value ?? "")} onChange={onChange} />;
    case "date":
    case "created_time":
    case "updated_time":
      if (condition.op === "between") {
        const range = (value && typeof value === "object" ? value : { start: todayIso(), end: todayIso() }) as { start: string; end: string };
        return (
          <span className="flex flex-1 items-center gap-1">
            <input type="date" aria-label={t("docs.db.startDate")} className={cls} value={range.start} onChange={(event) => onChange({ ...range, start: event.target.value })} />
            <input type="date" aria-label={t("docs.db.endDate")} className={cls} value={range.end} onChange={(event) => onChange({ ...range, end: event.target.value })} />
          </span>
        );
      }
      return <input type="date" aria-label={t("docs.db.filterValue")} className={cls} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />;
    default:
      return <input type="text" aria-label={t("docs.db.filterValue")} className={cls} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />;
  }
}

function RelationFilterValue({ ctx, prop, value, onChange }: { ctx: DbCtx; prop: DbProperty; value: string; onChange: (value: unknown) => void }) {
  const [options, setOptions] = useState<DbRowRef[]>([]);
  useEffect(() => {
    let live = true;
    ctx.controller.api?.wikiRelationCandidates(ctx.database.page_id, prop.id, "", 50).then((rows) => { if (live) setOptions(rows); }, () => {});
    return () => { live = false; };
  }, [ctx.controller, ctx.database.page_id, prop.id]);
  return (
    <select aria-label={t("docs.db.filterValue")} className={cn(selectClass, "min-w-0 flex-1")} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">—</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.title || t("docs.untitled")}</option>)}
    </select>
  );
}

function ColumnsButton({ columns, canManage, onChange, onAdd, onEdit }: { columns: Column[]; canManage: boolean; onChange: (columns: Column[]) => void; onAdd: () => void; onEdit: (prop: DbProperty) => void }) {
  const hidden = columns.filter((c) => c.hidden).length;
  return (
    <PopoverRoot>
      <ToolButton icon={<Columns3 size={13} />} label={t("docs.db.properties")} count={hidden} />
      <PopoverContent align="end" className="w-72 p-2">
        <ul className="max-h-80 overflow-y-auto">
          {columns.map((column, index) => (
            <li key={column.prop.id} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-panel">
              <PropIcon type={column.prop.type} />
              <span className="min-w-0 flex-1 truncate text-sm">{propName(column.prop)}</span>
              <button type="button" aria-label={t("docs.db.moveUp")} disabled={index === 0} className="text-muted hover:text-ink disabled:opacity-30" onClick={() => onChange(moveColumn(columns, column.prop.id, index - 1))}><ArrowUp size={13} /></button>
              <button type="button" aria-label={t("docs.db.moveDown")} disabled={index === columns.length - 1} className="text-muted hover:text-ink disabled:opacity-30" onClick={() => onChange(moveColumn(columns, column.prop.id, index + 1))}><ArrowDown size={13} /></button>
              {column.prop.type !== "title" && (
                <button type="button" aria-label={column.hidden ? t("docs.db.show") : t("docs.db.hide")} className="text-muted hover:text-ink" onClick={() => onChange(columns.map((c) => (c.prop.id === column.prop.id ? { ...c, hidden: !c.hidden } : c)))}>
                  {column.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              )}
              {canManage && <button type="button" aria-label={t("docs.db.editProperty")} className="text-muted hover:text-ink" onClick={() => onEdit(column.prop)}><Pencil size={13} /></button>}
            </li>
          ))}
        </ul>
        {canManage && <Button size="sm" variant="ghost" className="mt-1" onClick={onAdd}><Plus size={13} /> {t("docs.db.addProperty")}</Button>}
      </PopoverContent>
    </PopoverRoot>
  );
}

// --- the table -----------------------------------------------------------------------------------------------------

function TableView({ ctx, columns, rows, total, hasMore, onMore, onColumns, onAddRow, onEditProp, onSort }: {
  ctx: DbCtx;
  columns: Column[];
  rows: DbRow[];
  total: number;
  hasMore: boolean;
  onMore: () => void;
  onColumns: (columns: Column[]) => void;
  onAddRow: () => void;
  onEditProp: ((prop: DbProperty) => void) | null;
  onSort: (propId: string, direction: "asc" | "desc") => void;
}) {
  const shown = columns.filter((c) => !c.hidden);
  const [editing, setEditing] = useState<{ rowId: string; propId: string } | null>(null);
  const startResize = (event: React.PointerEvent, column: Column) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = column.width;
    let width = startWidth;
    const move = (e: PointerEvent) => {
      width = clampWidth(startWidth + e.clientX - startX);
      onColumns(columns.map((c) => (c.prop.id === column.prop.id ? { ...c, width } : c)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const width = shown.reduce((sum, c) => sum + c.width, 0);
  return (
    <div className="mt-1">
      <div className="overflow-x-auto overscroll-x-contain" data-db-table>
        <table className="table-fixed border-collapse text-sm" style={{ width }}>
          <colgroup>{shown.map((c) => <col key={c.prop.id} style={{ width: c.width }} />)}</colgroup>
          <thead>
            <tr className="border-b border-line text-left">
              {shown.map((column, index) => (
                <th key={column.prop.id} scope="col" className="relative h-8 border-r border-line/60 px-0 font-normal text-muted last:border-r-0">
                  <Menu>
                    <MenuTrigger asChild>
                      <button type="button" className="flex h-8 w-full items-center gap-1.5 px-2 text-left hover:bg-ink/4" data-column={column.prop.id}>
                        <PropIcon type={column.prop.type} />
                        <span className="truncate">{propName(column.prop)}</span>
                      </button>
                    </MenuTrigger>
                    <MenuContent align="start">
                      {sortable(column.prop.type) && (
                        <>
                          <MenuItem onSelect={() => onSort(column.prop.id, "asc")}><ArrowUp size={14} /> {t("docs.db.sortAsc")}</MenuItem>
                          <MenuItem onSelect={() => onSort(column.prop.id, "desc")}><ArrowDown size={14} /> {t("docs.db.sortDesc")}</MenuItem>
                        </>
                      )}
                      {index > 0 && <MenuItem onSelect={() => onColumns(moveColumn(columns, column.prop.id, columns.indexOf(shown[index - 1]!)))}><ChevronLeft size={14} /> {t("docs.db.moveLeft")}</MenuItem>}
                      {index < shown.length - 1 && <MenuItem onSelect={() => onColumns(moveColumn(columns, column.prop.id, columns.indexOf(shown[index + 1]!)))}><ChevronRight size={14} /> {t("docs.db.moveRight")}</MenuItem>}
                      {column.prop.type !== "title" && <MenuItem onSelect={() => onColumns(columns.map((c) => (c.prop.id === column.prop.id ? { ...c, hidden: true } : c)))}><EyeOff size={14} /> {t("docs.db.hide")}</MenuItem>}
                      {onEditProp && (
                        <>
                          <MenuSeparator />
                          <MenuItem onSelect={() => onEditProp(column.prop)}><Pencil size={14} /> {t("docs.db.editProperty")}</MenuItem>
                        </>
                      )}
                    </MenuContent>
                  </Menu>
                  <div role="separator" aria-orientation="vertical" aria-label={t("docs.db.columnWidth")} className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-accent/40" onPointerDown={(event) => startResize(event, column)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="group border-b border-line/70 hover:bg-panel/50" data-row={row.id}>
                {shown.map((column) => (
                  <Cell key={column.prop.id} ctx={ctx} prop={column.prop} row={row}
                    editing={editing?.rowId === row.id && editing.propId === column.prop.id}
                    onEdit={(on) => setEditing(on ? { rowId: row.id, propId: column.prop.id } : null)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 py-1.5 text-sm text-muted">
        {ctx.canEdit && rows.length < ctx.database.limits.rows && (
          <button type="button" className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-panel hover:text-ink" onClick={onAddRow}><Plus size={14} /> {t("docs.db.newRow")}</button>
        )}
        <span className="ml-auto text-xs tabular-nums">{t("docs.db.count", { count: total })}</span>
      </div>
      {hasMore && <div className="text-center"><Button size="sm" variant="secondary" onClick={onMore}>{t("docs.db.loadMore")}</Button></div>}
    </div>
  );
}

function Cell({ ctx, prop, row, editing, onEdit }: { ctx: DbCtx; prop: DbProperty; row: DbRow; editing: boolean; onEdit: (on: boolean) => void }) {
  const editable = ctx.canEdit && prop.type !== "created_time" && prop.type !== "updated_time" && prop.type !== "created_by" && prop.type !== "updated_by";
  const body = (
    <div className="flex h-9 min-w-0 items-center gap-1 px-2">
      <CellDisplay ctx={ctx} prop={prop} row={row} />
      {prop.type === "title" && (
        <button type="button" aria-label={t("docs.db.openRow")} title={t("docs.db.openRow")} className="ml-auto hidden shrink-0 items-center gap-0.5 rounded border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-muted hover:text-ink group-hover:inline-flex focus:inline-flex" onClick={(event) => { event.stopPropagation(); ctx.openRow(row.id); }}>
          <Maximize2 size={11} /> {t("docs.db.open")}
        </button>
      )}
    </div>
  );
  if (!editable) return <td className="border-r border-line/60 p-0 last:border-r-0" data-cell={prop.id}>{body}</td>;
  if (prop.type === "checkbox") {
    return (
      <td className="border-r border-line/60 p-0 last:border-r-0" data-cell={prop.id}>
        <button type="button" className="flex h-9 w-full items-center px-2" aria-label={propName(prop)} onClick={() => void ctx.setCell(row, prop.id, !row.props[prop.id])}>
          <CellDisplay ctx={ctx} prop={prop} row={row} />
        </button>
      </td>
    );
  }
  return (
    <td className="border-r border-line/60 p-0 last:border-r-0" data-cell={prop.id}>
      <PopoverRoot open={editing} onOpenChange={onEdit}>
        <PopoverAnchor asChild>
          <div role="button" tabIndex={0} className="cursor-default outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50" onClick={() => onEdit(true)} onKeyDown={(event) => { if (event.key === "Enter") onEdit(true); }} aria-label={t("docs.db.editCellOf", { name: propName(prop) })}>
            {body}
          </div>
        </PopoverAnchor>
        <PopoverContent align="start" sideOffset={-36} className="p-0">
          {editing && <CellEditor ctx={ctx} prop={prop} row={row} onDone={() => onEdit(false)} />}
        </PopoverContent>
      </PopoverRoot>
    </td>
  );
}

// --- the calendar --------------------------------------------------------------------------------------------------

function CalendarBar({ database, propId, month, onMonth, onProp }: { database: DatabaseOut; propId: string | null; month: { year: number; month: number }; onMonth: (m: { year: number; month: number }) => void; onProp: (id: string) => void }) {
  const label = new Intl.DateTimeFormat(intlLocale(getLocale()), { year: "numeric", month: "long" }).format(new Date(month.year, month.month, 1));
  const step = (n: number) => { const d = new Date(month.year, month.month + n, 1); onMonth({ year: d.getFullYear(), month: d.getMonth() }); };
  const dateProps = database.properties.filter((p) => isDateish(p.type));
  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <strong className="min-w-[8em] text-base" aria-live="polite">{label}</strong>
      <button type="button" aria-label={t("docs.db.prevMonth")} className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-ink/6" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
      <Button size="sm" variant="secondary" onClick={() => { const now = new Date(); onMonth({ year: now.getFullYear(), month: now.getMonth() }); }}>{t("docs.db.today")}</Button>
      <button type="button" aria-label={t("docs.db.nextMonth")} className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-ink/6" onClick={() => step(1)}><ChevronRight size={16} /></button>
      {dateProps.length > 0 && (
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          {t("docs.db.calendarBy")}
          <select aria-label={t("docs.db.calendarBy")} className={selectClass} value={propId ?? ""} onChange={(event) => onProp(event.target.value)}>
            {dateProps.map((p) => <option key={p.id} value={p.id}>{propName(p)}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

const LANE = 22;
const VISIBLE_LANES = 3;

function CalendarView({ ctx, rows, propId, grid, month, onAddOn }: { ctx: DbCtx; rows: DbRow[]; propId: string; grid: string[][]; month: { year: number; month: number }; onAddOn: (day: string) => void }) {
  const prop = ctx.database.properties.find((p) => p.id === propId)!;
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const spans = useMemo(() => rows.flatMap((row) => { const s = spanOf(prop, row); return s ? [{ rowId: row.id, first: s[0], last: s[1] }] : []; }), [rows, prop]);
  const today = todayIso();
  const canMove = ctx.canEdit && prop.type === "date";
  const [dragging, setDragging] = useState<{ rowId: string; grabDay: string } | null>(null);
  const drop = (day: string) => {
    if (!dragging) return;
    const row = byId.get(dragging.rowId);
    const value = row ? asDate(row.props[prop.id]) : null;
    const delta = daysBetween(dragging.grabDay, day);
    setDragging(null);
    if (row && value && delta !== 0) void ctx.setCell(row, prop.id, shiftDate(value, delta));
  };
  return (
    <div className="overflow-hidden rounded-lg border border-line" data-db-calendar>
      <div className="grid grid-cols-7 border-b border-line bg-panel/60 text-center text-[11px] font-semibold text-muted">
        {[0, 1, 2, 3, 4, 5, 6].map((d) => <div key={d} className="py-1">{weekdayName(d) /* Monday first, as the calendar screen */}</div>)}
      </div>
      {grid.map((week) => {
        const bars = layoutWeek(week, spans);
        const lanes = Math.max(0, ...bars.map((b) => b.lane + 1));
        const hiddenByDay = week.map((_, col) => bars.filter((b) => b.lane >= VISIBLE_LANES && b.startCol <= col && b.endCol >= col).length);
        return (
          <div key={week[0]} className="relative grid grid-cols-7 border-b border-line last:border-b-0" style={{ minHeight: 28 + Math.min(lanes, VISIBLE_LANES) * LANE + 22 }} data-week={week[0]}>
            {week.map((day, col) => {
              const inMonth = Number(day.slice(5, 7)) - 1 === month.month;
              return (
                <div key={day} data-day={day}
                  className={cn("group/day relative border-r border-line/70 last:border-r-0", !inMonth && "bg-panel/40")}
                  onDragOver={(event) => { if (dragging) event.preventDefault(); }}
                  onDrop={(event) => { event.preventDefault(); drop(day); }}
                >
                  <div className="flex items-center justify-between px-1.5 pt-1">
                    <span className={cn("text-xs tabular-nums", day === today ? "flex h-5 w-5 items-center justify-center rounded-full bg-accent-solid font-semibold text-white" : inMonth ? "text-ink" : "text-muted")}>{Number(day.slice(8, 10))}</span>
                    {ctx.canEdit && prop.type === "date" && (
                      <button type="button" aria-label={t("docs.db.addOnDay", { day })} className="hidden h-5 w-5 items-center justify-center rounded text-muted hover:bg-ink/6 hover:text-ink group-hover/day:inline-flex" onClick={() => onAddOn(day)}><Plus size={13} /></button>
                    )}
                  </div>
                  {hiddenByDay[col]! > 0 && <div className="absolute bottom-0.5 left-1.5 text-[11px] text-muted">{t("docs.db.moreRows", { count: hiddenByDay[col]! })}</div>}
                </div>
              );
            })}
            {bars.filter((b) => b.lane < VISIBLE_LANES).map((bar) => {
              const row = byId.get(bar.rowId)!;
              return (
                <button key={bar.rowId} type="button" draggable={canMove}
                  onDragStart={(event) => {
                    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    const col = Math.min(bar.endCol, bar.startCol + Math.floor(((event.clientX - box.left) / box.width) * (bar.endCol - bar.startCol + 1)));
                    setDragging({ rowId: bar.rowId, grabDay: week[col]! });
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", bar.rowId);
                  }}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => ctx.openRow(bar.rowId)}
                  title={row.title || t("docs.untitled")}
                  data-bar={bar.rowId}
                  className={cn("absolute z-[1] truncate border border-accent/30 bg-accent-soft px-1.5 text-left text-xs text-ink hover:bg-accent/25", bar.fromBefore ? "rounded-l-none" : "rounded-l-md", bar.goesOn ? "rounded-r-none" : "rounded-r-md")}
                  style={{ top: 26 + bar.lane * LANE, height: LANE - 3, left: `calc(${(bar.startCol / 7) * 100}% + 3px)`, width: `calc(${((bar.endCol - bar.startCol + 1) / 7) * 100}% - 6px)` }}
                >
                  {row.title || t("docs.untitled")}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** A narrow screen's calendar: the month's days that have rows, each row under every day it covers. */
function AgendaView({ ctx, rows, propId, month }: { ctx: DbCtx; rows: DbRow[]; propId: string; month: { year: number; month: number } }) {
  const prop = ctx.database.properties.find((p) => p.id === propId)!;
  const [first, last] = monthBounds(month.year, month.month);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const days = agenda(rows.flatMap((row) => { const s = spanOf(prop, row); return s ? [{ rowId: row.id, first: s[0], last: s[1] }] : []; }), first, last);
  const locale = intlLocale(getLocale());
  if (days.length === 0) return <p className="py-6 text-sm text-muted" data-db-agenda>{t("docs.db.agendaEmpty")}</p>;
  return (
    <ol className="divide-y divide-line" data-db-agenda>
      {days.map(({ day, rowIds }) => (
        <li key={day} className="py-2">
          <div className="mb-1 text-xs font-semibold text-muted">{new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short" }).format(new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))))}</div>
          <ul>
            {rowIds.map((id) => (
              <li key={id}>
                <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => ctx.openRow(id)}>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-accent-solid" />
                  <span className="truncate">{byId.get(id)?.title || t("docs.untitled")}</span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
