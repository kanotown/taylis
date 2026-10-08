/**
 * M123 (WIKI.md §5, §9.1): a database page's table and calendar. The saved views are tabs; sorting, filtering and the
 * columns (order, width, hidden) change on this screen at once and are saved to the view by someone with full access
 * (「ビューを保存」). The server sorts and filters (`POST …/query`); a change of a row anywhere comes as
 * wiki.rows.changed and the rows are read again.
 *
 * - table: cells edited in place (a popover per type, a checkbox toggles), 「＋ 新規」 adds a row, the title's ↗ opens the
 *   row beside the table (its properties above its body); scrolls sideways on a narrow screen. M145 (WIKI.md §22.3):
 *   「新規」 starts from the database's default template (the server's choice), its ▾ lists the row templates (a row
 *   from one, ✎ to edit it, ☆ to make it the default), a blank row and a new template.
 * - calendar: a month by a date property; a row with a range spans its days, a click on a day adds a row on that day,
 *   a row dragged to another day moves its date (and its end with it). On a narrow screen, the month as an agenda.
 */
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, Columns3, Download, Eye, EyeOff, FileText, LayoutTemplate, ListFilter, Loader2, Maximize2, MoreHorizontal, Pencil, Plus, Save, Star, Trash2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../api/errors";
import type { DatabaseOut, DbFilterCondition, DbFilterOp, DbGroupOut, DbProperty, DbRow, DbRowRef, DbSchemaOp, DbTemplateRef, DbView, DbViewIn, DbViewType } from "../api/types";
import { saveDownload } from "../platform/download";
import type { AppController } from "../state/app";
import { getLocale, intlLocale, t, weekdayName, type MessageKey } from "../i18n";
import { CellDisplay, CellEditor, type DbCtx, PropertyDialog, PropIcon, propName } from "./DbCells";
import { BoardEmpty, BoardView, GalleryView, type Grouping, LayoutButton, ListView, SectionHeader, ViewFooter, viewIcon } from "./DbViews";
import { localZone, pageTitle } from "./docsActions";
import { useWikiHub } from "./DocsTree";
import { Button, cn, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, PopoverAnchor, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import {
  agenda,
  clampWidth,
  type Column,
  columnsOf,
  databaseRights,
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
  isRestrictedValue,
  boardValue,
  firstBoardProp,
  flattenSections,
  groupableProps,
  groupValue,
  moveInSections,
  placeIn,
  type Section,
  sectionsOf,
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

const VIEW_WORDS: Record<DbViewType, MessageKey> = {
  table: "docs.db.table",
  calendar: "docs.db.calendar",
  board: "docs.db.board",
  list: "docs.db.list",
  gallery: "docs.db.gallery",
};

export function viewName(view: Pick<DbView, "name" | "type">): string {
  return view.name || t(VIEW_WORDS[view.type] ?? "docs.db.table");
}

/** A new view of a type (M147): a board's columns by the first select / person / checkbox; a board, list or gallery
 * shows the first three properties (not the board's own) on its cards. */
export function newView(database: DatabaseOut, type: DbViewType): DbViewIn {
  const base: DbViewIn = { name: "", type, columns: [], sort: [], filter: null, date_prop_id: null, group_by: null, cover: "body", card_size: "medium" };
  if (type === "calendar") return { ...base, date_prop_id: firstDateProp(database)?.id ?? null };
  if (type === "table") return base;
  const board = type === "board" ? firstBoardProp(database) : null;
  let shown = 0;
  const columns = database.properties.map((p) => {
    const show = p.type === "title" || (p.id !== board?.id && shown < 3);
    if (p.type !== "title" && show) shown += 1;
    return { prop_id: p.id, hidden: !show };
  });
  return { ...base, columns, group_by: board ? { prop_id: board.id, date_unit: null, hidden: [], hide_empty: false } : null };
}

/**
 * M149 (WIKI.md §22.5): the database embedded in a page's body (`![…](page:<id>#view=<view>)`): that view only, its
 * first EMBED_ROWS rows and 「すべて表示」, rows open as their pages. Cells and rows edit as on the database's own page
 * (the same rights).
 */
export interface DbEmbed {
  viewId: string | null;
  /** The title row (the database's current name and icon, which opens it). */
  header: ReactNode;
  onOpenAll: () => void;
  /** Shown instead when the database cannot be read (gone, no access, not a database): never its name. */
  unavailable: ReactNode;
}

export const EMBED_ROWS = 10;

export function DatabaseView({ controller, databaseId, compact, renderPeek, onOpenRowPage, embed = null }: {
  controller: AppController;
  databaseId: string;
  compact: boolean;
  /** The row beside the table (a wide screen); a narrow one opens the row as its page. */
  renderPeek: (rowId: string, close: () => void) => ReactNode;
  onOpenRowPage: (rowId: string) => void;
  embed?: DbEmbed | null;
}) {
  const hub = useWikiHub(controller);
  const [database, setDatabase] = useState<DatabaseOut | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewId, setViewId] = useState<string | null>(() => (embed ? embed.viewId : readRemembered(databaseId)));
  const [draft, setDraft] = useState<DbViewIn | null>(null);
  const [rows, setRows] = useState<DbRow[]>([]);
  // M147: a grouped answer's groups and the group of each row (null: not grouped).
  const [groups, setGroups] = useState<DbGroupOut[] | null>(null);
  const [rowGroups, setRowGroups] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
  // M144 (WIKI.md §22.2): editors shape the database (properties, options, views); deleting and retyping is full.
  const { canEdit, canShape, canDestroy } = databaseRights(database?.my_level, controller.isGuest);

  const embedded = embed !== null;
  const loadDatabase = useCallback(async () => {
    const api = controller.api;
    if (!api) return;
    try {
      const next = await api.wikiDatabase(databaseId);
      setDatabase((current) => (current && current.schema_version === next.schema_version && current.row_count === next.row_count && sameTemplates(current, next) ? current : next));
      setFailed(false);
    } catch (error) {
      setFailed(true);
      if (!(error instanceof ApiError && (error.status === 404 || (embedded && error.status === 403)))) controller.setError(error);
    }
  }, [controller, databaseId, embedded]);
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
  // M147: every view but the calendar may be grouped (a board always is, once it has its property).
  const grouped = !!draft && draft.type !== "calendar" && !!draft.group_by?.prop_id;
  const covers = draft?.type === "gallery" && (draft.cover ?? "body") === "body";
  const queryKey = draft ? JSON.stringify({ s: draft.sort, f: readyConditions(draft.filter?.conditions ?? []), c: draft.filter?.combinator, r: range, type: draft.type, g: grouped ? draft.group_by : null, cv: covers }) : "";

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
        limit: embedded && !range ? EMBED_ROWS : range || grouped ? 1000 : PAGE,
        grouped,
        group_by: grouped ? draft.group_by : null,
        covers,
        tz: localZone(),
      });
      if (seq !== loadSeq.current) return;
      setRows((current) => (more ? [...current, ...out.rows] : out.rows));
      setGroups(out.groups ?? null);
      setRowGroups((current) => (more ? [...current, ...(out.row_groups ?? [])] : out.row_groups ?? []));
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
      // A value may move the row to another group: read the groups again.
      if (grouped) void loadRows(false);
      setRefs((current) => {
        const next = new Map(current);
        for (const ref of out.refs) next.set(ref.id, ref);
        return next;
      });
    } catch (error) {
      controller.setError(error);
      void loadRows(false);
    }
  }, [controller, database, loadRows, grouped]);

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
    if (compact || embedded) onOpenRowPage(rowId);
    else setPeek(rowId);
  }, [compact, embedded, onOpenRowPage]);

  /** A new row: from the default template (the server's choice) unless `from` says a template, a blank row or a new
   * row template (M145). A template is not a row of the table: it opens beside it to be written. */
  const addRow = async (props: Record<string, unknown> = {}, from: { templateId?: string | null; blank?: boolean; isTemplate?: boolean } = {}): Promise<DbRow | null> => {
    const api = controller.api;
    if (!api) return null;
    try {
      const out = await api.createWikiRow(databaseId, {
        title: "",
        props,
        template_id: from.templateId ?? null,
        blank: from.blank ?? false,
        is_template: from.isTemplate ?? false,
        tz: localZone(),
        client_save_id: crypto.randomUUID(),
      });
      if (from.isTemplate) {
        void loadDatabase();
        return out.row;
      }
      if (grouped) {
        void loadRows(false);
      } else {
        setRows((current) => [...current, out.row]);
        setTotal((n) => n + 1);
      }
      return out.row;
    } catch (error) {
      controller.setError(error);
      return null;
    }
  };
  const setDefaultTemplate = async (templateId: string | null) => {
    const api = controller.api;
    if (!api) return;
    try {
      setDatabase(await api.setWikiDefaultTemplate(databaseId, templateId));
    } catch (error) {
      controller.setError(error);
    }
  };

  /** M147: a board's card to another column (its value) and / or another place (the rows' order), in one write; shown at
   * once, then the server's groups. */
  const moveCard = async (row: DbRow, from: string, to: string, index: number) => {
    const api = controller.api;
    const prop = draft?.group_by ? database?.properties.find((p) => p.id === draft.group_by!.prop_id) : null;
    if (!api || !prop || !groups) return;
    const manual = (draft?.sort ?? []).length === 0;
    const sections = sectionsOf(groups, rows, rowGroups);
    const set: Record<string, unknown> = from === to ? {} : { [prop.id]: boardValue(prop, row, from, to) };
    const place = manual ? placeIn(sections.find((s) => s.key === to)?.rows ?? [], row.id, index) : {};
    if (Object.keys(set).length === 0 && !place.before_id && !place.after_id) return;
    const props = { ...row.props } as Record<string, unknown>;
    if (prop.id in set) {
      if (set[prop.id] === null || set[prop.id] === false) delete props[prop.id];
      else props[prop.id] = set[prop.id];
    }
    const moved: DbRow = { ...row, props: props as DbRow["props"] };
    const next = flattenSections(moveInSections(sections, moved, from, to, manual ? index : Number.MAX_SAFE_INTEGER));
    setRows(next.rows);
    setRowGroups(next.rowGroups);
    setGroups(groups.map((g) => ({ ...g, count: g.count + (from === to ? 0 : g.key === to ? 1 : g.key === from ? -1 : 0) })));
    try {
      await api.moveWikiRow(row.id, { set, ...place, client_op_id: crypto.randomUUID() });
    } catch (error) {
      controller.setError(error);
    }
    void loadRows(false);
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
    if (embed && failed) return <>{embed.unavailable}</>;
    return failed ? <p className="py-6 text-sm text-muted">{t("docs.db.loadFailed")}</p> : <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-muted" /></div>;
  }

  const ctx: DbCtx = { controller, database, refs, canEdit, canShape, canDestroy, setCell, changeSchema, openRow };
  const columns = columnsOf(database.properties, draft.columns ?? []);
  const setColumns = (next: Column[]) => setDraft({ ...draft, columns: toViewColumns(next) });
  const differs = viewDiffers(view, draft);
  // M149: an embed shows its first rows; the rest are on the database's page.
  const more = !embedded && !!cursor;
  const newMenu = (
    <NewRowMenu templates={database.templates ?? []} defaultId={database.default_template_id ?? null}
      onFrom={async (templateId) => { const row = await addRow({}, templateId ? { templateId } : { blank: true }); if (row) openRow(row.id); }}
      onNewTemplate={async () => { const row = await addRow({}, { isTemplate: true }); if (row) openRow(row.id); }}
      onEdit={openRow}
      onDefault={(id) => void setDefaultTemplate(id)}
    />
  );
  // M147: the groups of the answer (the board's columns, the table's / list's / gallery's sections).
  const groupProp = draft.type !== "calendar" && draft.group_by ? database.properties.find((p) => p.id === draft.group_by!.prop_id) ?? null : null;
  const sections: Section[] | null = groupProp && groups ? sectionsOf(groups, rows, rowGroups) : null;
  const grouping = groupProp && sections && draft.type !== "board" ? {
    prop: groupProp,
    unit: draft.group_by?.date_unit ?? null,
    sections,
    collapsed,
    onToggle: (key: string) => setCollapsed((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }),
  } : null;
  const databases = [...(hub?.pages.values() ?? [])].filter((p) => p.kind === "database").map((p) => ({ id: p.id, title: p.title }));
  if (!databases.some((d) => d.id === databaseId)) databases.unshift({ id: databaseId, title: hub?.page(databaseId)?.title ?? "" });

  return (
    <div className={cn("min-w-0", embed ? "my-3 rounded-xl border border-line px-3 pb-1 pt-2" : "mt-6")} data-database={databaseId} data-embed={embed ? view.id : undefined}>
      <div className="flex flex-wrap items-center gap-1 border-b border-line pb-1.5">
        {embed ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
            {embed.header}
            <span className="inline-flex items-center gap-1 text-muted" data-embed-view>
              <ViewTypeIcon type={view.type} />
              {viewName(view)}
            </span>
          </div>
        ) : (
        <div role="tablist" aria-label={t("docs.db.views")} className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
          {database.views.map((v) => (
            <ViewTab key={v.id} view={v} active={v.id === view.id} canShape={canShape} last={database.views.length === 1}
              onPick={() => { setViewId(v.id); remember(databaseId, v.id); setDraft(viewBody(v)); lastSaved.current = JSON.stringify(viewBody(v)); }}
              onRename={() => setRenaming(v)}
              onDelete={() => void deleteView(v.id)}
            />
          ))}
          {canShape && database.views.length < database.limits.views && (
            <Menu>
              <MenuTrigger asChild>
                <button type="button" aria-label={t("docs.db.addView")} title={t("docs.db.addView")} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-ink/6 hover:text-ink"><Plus size={15} /></button>
              </MenuTrigger>
              <MenuContent align="start">
                {(["table", "board", "list", "gallery", "calendar"] as const).map((type) => {
                  const Icon = viewIcon(type);
                  const disabled = (type === "calendar" && !firstDateProp(database)) || (type === "board" && !firstBoardProp(database));
                  return (
                    <MenuItem key={type} disabled={disabled} title={type === "board" && disabled ? t("docs.db.needBoardProp") : undefined} onSelect={() => void saveView(newView(database, type), newViewId())}>
                      <Icon size={14} /> {t(VIEW_WORDS[type])}
                    </MenuItem>
                  );
                })}
              </MenuContent>
            </Menu>
          )}
        </div>
        )}
        <div className="flex items-center gap-0.5">
          {loading &&<Loader2 size={14} className="mr-1 animate-spin text-muted" />}
          <SortButton database={database} draft={draft} onChange={(sort) => setDraft({ ...draft, sort })} />
          <FilterButton ctx={ctx} draft={draft} onChange={(filter) => setDraft({ ...draft, filter })} />
          {draft.type !== "calendar" && <ColumnsButton columns={columns} canShape={canShape} onChange={setColumns} onAdd={() => setPropDialog({ prop: null })} onEdit={(prop) => setPropDialog({ prop })} />}
          {draft.type !== "calendar" && <LayoutButton ctx={ctx} draft={draft} groups={groups} onChange={setDraft} />}
          {differs && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setDraft(viewBody(view))}>{t("docs.db.reset")}</Button>
              {canShape && <Button size="sm" onClick={() => void saveView(draft)}><Save size={13} /> {t("docs.db.saveView")}</Button>}
            </>
          )}
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={t("docs.db.more")} title={t("docs.db.more")} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink hover:bg-ink/6"><MoreHorizontal size={16} /></button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => void exportCsv()}><Download size={14} /> {t("docs.db.exportCsv")}</MenuItem>
              {canShape && <MenuItem onSelect={() => setPropDialog({ prop: null })}><Plus size={14} /> {t("docs.db.addProperty")}</MenuItem>}
            </MenuContent>
          </Menu>
        </div>
      </div>
      {draft.type === "calendar" && (
        <CalendarBar database={database} propId={datePropId} month={month} onMonth={setMonth} onProp={(id) => setDraft({ ...draft, date_prop_id: id })} />
      )}
      <div className="flex min-w-0 gap-3">
        <div className="min-w-0 flex-1">
          {draft.type === "board" ? (
            groupProp && groups ? (
              <>
                <BoardView ctx={ctx} columns={columns} prop={groupProp} unit={draft.group_by?.date_unit ?? null} sections={sections ?? []}
                  manual={(draft.sort ?? []).length === 0}
                  onMove={(row, from, to, index) => void moveCard(row, from, to, index)}
                  onAddIn={async (key) => {
                    const value = groupValue(groupProp, key, draft.group_by?.date_unit ?? null);
                    const row = await addRow(value === undefined ? {} : { [groupProp.id]: value });
                    if (row) openRow(row.id);
                  }}
                  onHidden={(key, hide) => setDraft({ ...draft, group_by: { ...draft.group_by!, hidden: hide ? [...(draft.group_by!.hidden ?? []), key] : (draft.group_by!.hidden ?? []).filter((k) => k !== key) } })}
                />
                <ViewFooter ctx={ctx} total={total} hasMore={more} onMore={() => void loadRows(true)} onAddRow={() => void addRow()} newMenu={newMenu} />
              </>
            ) : groupProp ? null : (
              <BoardEmpty hasProps={groupableProps(database.properties, "board").length > 0} />
            )
          ) : draft.type === "list" || draft.type === "gallery" ? (
            <>
              {draft.type === "list" ? (
                <ListView ctx={ctx} columns={columns} rows={rows} grouping={grouping} />
              ) : (
                <GalleryView ctx={ctx} columns={columns} rows={rows} grouping={grouping} cover={draft.cover ?? "body"} size={draft.card_size ?? "medium"} />
              )}
              <ViewFooter ctx={ctx} total={total} hasMore={more} onMore={() => void loadRows(true)} onAddRow={() => void addRow()} newMenu={newMenu} />
            </>
          ) : draft.type === "table" ? (
            <TableView ctx={ctx} columns={columns} rows={rows} total={total} hasMore={more} onMore={() => void loadRows(true)} grouping={grouping}
              onColumns={setColumns} onAddRow={() => void addRow()} onEditProp={canShape ? (prop) => setPropDialog({ prop }) : null}
              newMenu={newMenu}
              onAddProp={canShape ? () => setPropDialog({ prop: null }) : null}
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
      {embed && (
        <div className="flex justify-end border-t border-line pt-1">
          <button type="button" data-embed-all className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-accent hover:bg-accent-soft/40" onClick={embed.onOpenAll}>
            <Maximize2 size={13} aria-hidden="true" /> {t("docs.embed.showAll")}
          </button>
        </div>
      )}
      {propDialog && <PropertyDialog ctx={ctx} prop={propDialog.prop} databases={databases} onClose={() => setPropDialog(null)} />}
      {renaming && <RenameView view={renaming} onClose={() => setRenaming(null)} onSave={(name) => { setRenaming(null); void saveView({ ...viewBody(renaming), name }, renaming.id); }} />}
    </div>
  );
}

function ViewTypeIcon({ type }: { type: DbViewType }) {
  const Icon = viewIcon(type);
  return <Icon size={13} aria-hidden="true" />;
}

/** Whether two answers list the same row templates and default (M145): a change re-renders the ▾. */
function sameTemplates(a: DatabaseOut, b: DatabaseOut): boolean {
  return a.default_template_id === b.default_template_id && JSON.stringify(a.templates ?? []) === JSON.stringify(b.templates ?? []);
}

/** M145 (WIKI.md §22.3): 「新規 ▾」 — a row from a template (or blank), ✎ a template, ☆ the default, a new template. */
export function NewRowMenu({ templates, defaultId, onFrom, onNewTemplate, onEdit, onDefault }: {
  templates: readonly DbTemplateRef[];
  defaultId: string | null;
  onFrom: (templateId: string | null) => void;
  onNewTemplate: () => void;
  onEdit: (templateId: string) => void;
  onDefault: (templateId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  const untitled = t("docs.untitled");
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t("docs.tpl.newRowMenu")} title={t("docs.tpl.newRowMenu")} className="flex h-7 w-6 items-center justify-center rounded-md hover:bg-panel hover:text-ink">
          <ChevronDown size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5" data-new-row-menu>
        <div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{t("docs.tpl.section")}</div>
        {templates.length === 0 && <p className="px-2 py-1 text-xs text-muted">{t("docs.tpl.noRowTemplates")}</p>}
        <ul>
          {templates.map((tpl) => {
            const name = pageTitle(tpl, untitled);
            const isDefault = tpl.id === defaultId;
            return (
              <li key={tpl.id} className="group flex items-center gap-0.5 rounded-md hover:bg-panel" data-row-template={tpl.id}>
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm" onClick={() => run(() => onFrom(tpl.id))}>
                  <LayoutTemplate size={14} className="shrink-0 text-muted" />
                  <span className="truncate">{name}</span>
                  {isDefault && <span className="shrink-0 rounded bg-accent-soft px-1 text-[10px] text-accent">{t("docs.tpl.default")}</span>}
                </button>
                <button type="button" aria-label={t("docs.tpl.editTemplate", { title: name })} title={t("docs.tpl.editTemplate", { title: name })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-ink/8 hover:text-ink" onClick={() => run(() => onEdit(tpl.id))}>
                  <Pencil size={13} />
                </button>
                <button type="button" aria-pressed={isDefault} aria-label={isDefault ? t("docs.tpl.unsetDefault") : t("docs.tpl.defaultOf", { title: name })} title={isDefault ? t("docs.tpl.unsetDefault") : t("docs.tpl.defaultOf", { title: name })}
                  className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-ink/8", isDefault ? "text-accent" : "text-muted hover:text-ink")}
                  onClick={() => run(() => onDefault(isDefault ? null : tpl.id))}
                >
                  <Star size={13} fill={isDefault ? "currentColor" : "none"} />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="my-1 h-px bg-line" />
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => run(() => onFrom(null))}>
          <FileText size={14} className="text-muted" /> {t("docs.tpl.blankRow")}
        </button>
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => run(onNewTemplate)}>
          <Plus size={14} className="text-muted" /> {t("docs.tpl.new")}
        </button>
      </PopoverContent>
    </PopoverRoot>
  );
}

function ViewTab({ view, active, canShape, last, onPick, onRename, onDelete }: { view: DbView; active: boolean; canShape: boolean; last: boolean; onPick: () => void; onRename: () => void; onDelete: () => void }) {
  const Icon = viewIcon(view.type);
  return (
    <span className={cn("group inline-flex items-center rounded-md", active ? "bg-panel-2 text-ink" : "text-muted hover:bg-ink/6 hover:text-ink")}>
      <button type="button" role="tab" aria-selected={active} className="inline-flex h-7 items-center gap-1.5 px-2 text-sm font-medium" onClick={onPick}>
        <Icon size={14} /> {viewName(view)}
      </button>
      {canShape && active && (
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
      {isRestrictedValue(value) && <option value={value}>{t("docs.db.hiddenRows")}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.title || t("docs.untitled")}</option>)}
    </select>
  );
}

function ColumnsButton({ columns, canShape, onChange, onAdd, onEdit }: { columns: Column[]; canShape: boolean; onChange: (columns: Column[]) => void; onAdd: () => void; onEdit: (prop: DbProperty) => void }) {
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
              {canShape && <button type="button" aria-label={t("docs.db.editProperty")} className="text-muted hover:text-ink" onClick={() => onEdit(column.prop)}><Pencil size={13} /></button>}
            </li>
          ))}
        </ul>
        {canShape && <Button size="sm" variant="ghost" className="mt-1" onClick={onAdd}><Plus size={13} /> {t("docs.db.addProperty")}</Button>}
      </PopoverContent>
    </PopoverRoot>
  );
}

// --- the table -----------------------------------------------------------------------------------------------------

const ADD_COLUMN_WIDTH = 36;

function TableView({ ctx, columns, rows, grouping, total, hasMore, onMore, onColumns, onAddRow, newMenu, onEditProp, onAddProp, onSort }: {
  ctx: DbCtx;
  columns: Column[];
  rows: DbRow[];
  /** M147: the groups (a header row each, closed here). */
  grouping: Grouping | null;
  total: number;
  hasMore: boolean;
  onMore: () => void;
  onColumns: (columns: Column[]) => void;
  onAddRow: () => void;
  /** M145: the ▾ beside 「新規」 (the row templates). */
  newMenu?: ReactNode;
  onEditProp: ((prop: DbProperty) => void) | null;
  /** M144: 「＋」 at the end of the header row (editors too). */
  onAddProp: (() => void) | null;
  onSort: (propId: string, direction: "asc" | "desc") => void;
}) {
  const shown = columns.filter((c) => !c.hidden);
  // A row in several groups (a multi-select, people) is a line in each: the cell edited is the one of its group.
  const [editing, setEditing] = useState<{ rowId: string; propId: string; group: string } | null>(null);
  const renderRow = (row: DbRow, group: string) => (
    <tr key={`${group}:${row.id}`} className="group border-b border-line/70 hover:bg-panel/50" data-row={row.id}>
      {shown.map((column) => (
        <Cell key={column.prop.id} ctx={ctx} prop={column.prop} row={row}
          editing={editing?.rowId === row.id && editing.propId === column.prop.id && editing.group === group}
          onEdit={(on) => setEditing(on ? { rowId: row.id, propId: column.prop.id, group } : null)}
        />
      ))}
      {onAddProp && <td />}
    </tr>
  );
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
  const width = shown.reduce((sum, c) => sum + c.width, 0) + (onAddProp ? ADD_COLUMN_WIDTH : 0);
  return (
    <div className="mt-1">
      <div className="overflow-x-auto overscroll-x-contain" data-db-table>
        <table className="table-fixed border-collapse text-sm" style={{ width }}>
          <colgroup>{shown.map((c) => <col key={c.prop.id} style={{ width: c.width }} />)}{onAddProp && <col style={{ width: ADD_COLUMN_WIDTH }} />}</colgroup>
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
              {onAddProp && (
                <th scope="col" className="h-8 px-0 font-normal">
                  <button type="button" aria-label={t("docs.db.addProperty")} title={t("docs.db.addProperty")} className="flex h-8 w-full items-center justify-center text-muted hover:bg-ink/4 hover:text-ink" onClick={onAddProp}><Plus size={14} /></button>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {grouping
              ? grouping.sections.filter((s) => !s.hidden).flatMap((section) => {
                const closed = grouping.collapsed.has(section.key);
                return [
                  <tr key={`group:${section.key}`} className="border-b border-line/70 bg-panel/30" data-group-row={section.key}>
                    <td colSpan={shown.length + (onAddProp ? 1 : 0)} className="px-1">
                      <SectionHeader ctx={ctx} prop={grouping.prop} unit={grouping.unit} section={section} collapsed={closed} onToggle={() => grouping.onToggle(section.key)} />
                    </td>
                  </tr>,
                  ...(closed ? [] : section.rows.map((row) => renderRow(row, section.key))),
                ];
              })
              : rows.map((row) => renderRow(row, ""))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 py-1.5 text-sm text-muted">
        {ctx.canEdit && rows.length < ctx.database.limits.rows && (
          <span className="flex items-center">
            <button type="button" className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-panel hover:text-ink" onClick={onAddRow}><Plus size={14} /> {t("docs.db.newRow")}</button>
            {newMenu}
          </span>
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
