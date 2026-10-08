/**
 * M147 (WIKI.md §22.4, §25): a database's board, list and gallery, and the groups every view but the calendar may have.
 *
 * - board: a column per group of a select, a person or a checkbox (「なし」 for no value), each with its count. A card
 *   dragged to another column takes that value; dragged within a column (when the view has no sort) it takes its place
 *   among the rows (`POST /wiki/rows/{id}/move`, one write). Every card's ⋯ does the same from the keyboard (「◯◯へ
 *   移動」, 上へ / 下へ). Columns hide and show again (「隠したグループ」); 「＋」 under a column adds a row with its value.
 * - list: a line per row (title, then the shown properties); gallery: cards with the first image of the row's body.
 * - groups of a table, list or gallery: a header per group (collapsible here, counted by the server).
 *
 * The server groups, counts, sorts and filters (`POST …/query` with `grouped`); nothing here reorders rows.
 */
import { ChevronDown, ChevronRight, Eye, EyeOff, ImageOff, LayoutGrid, List, MoreHorizontal, Plus, Settings2, SquareKanban, Table2, CalendarDays, ArrowUp, ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { DbGroupBy, DbGroupOut, DbProperty, DbRow, DbRowCover, DbViewIn, DbViewType } from "../api/types";
import { getLocale, intlLocale, t } from "../i18n";
import { Avatar } from "./Avatar";
import { CellDisplay, type DbCtx, OptionChip, propName } from "./DbCells";
import { PageIcon } from "./PageIcon";
import { Button, cn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import { cellValue, type Column, formatDate, groupableProps, groupDate, isDateish, NONE_GROUP, type Section } from "./wikiDb";

export function viewIcon(type: DbViewType) {
  switch (type) {
    case "calendar":
      return CalendarDays;
    case "board":
      return SquareKanban;
    case "list":
      return List;
    case "gallery":
      return LayoutGrid;
    default:
      return Table2;
  }
}

/** A group's name as text (menus, labels for screen readers). */
export function groupName(ctx: Pick<DbCtx, "controller">, prop: DbProperty, key: string, unit: DbGroupBy["date_unit"]): string {
  if (prop.type === "checkbox") return key === "true" ? t("docs.db.checked") : t("docs.db.unchecked");
  if (key === NONE_GROUP) return t("docs.db.noValueGroup");
  switch (prop.type) {
    case "select":
    case "multi_select":
      return prop.options.find((o) => o.id === key)?.name ?? t("docs.db.noValueGroup");
    case "person":
    case "created_by":
    case "updated_by":
      return ctx.controller.store.users.get(key)?.display_name ?? t("common.member");
    default: {
      const locale = intlLocale(getLocale());
      if ((unit ?? "day") === "month") return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(groupDate(key));
      const day = formatDate({ start: key, end: null, time: false }, locale);
      return unit === "week" ? t("docs.db.weekOf", { day }) : day;
    }
  }
}

/** A group's label as it shows (an option's chip, a person with their face, a checkbox's state). */
export function GroupLabel({ ctx, prop, groupKey, unit }: { ctx: Pick<DbCtx, "controller">; prop: DbProperty; groupKey: string; unit: DbGroupBy["date_unit"] }) {
  const name = groupName(ctx, prop, groupKey, unit);
  if (groupKey === NONE_GROUP && prop.type !== "checkbox") return <span className="text-sm text-muted">{name}</span>;
  if (prop.type === "select" || prop.type === "multi_select") {
    const option = prop.options.find((o) => o.id === groupKey);
    return option ? <OptionChip option={option} /> : <span className="text-sm text-muted">{name}</span>;
  }
  if (prop.type === "person" || prop.type === "created_by" || prop.type === "updated_by") {
    return <span className="inline-flex min-w-0 items-center gap-1.5 text-sm"><Avatar id={groupKey} name={name} size={18} /><span className="truncate">{name}</span></span>;
  }
  return <span className="truncate text-sm font-medium">{name}</span>;
}

// --- the layout settings ---------------------------------------------------------------------------------------------

const selectClass = "h-8 rounded-md border border-line bg-canvas px-1.5 text-sm";

/** 「レイアウト」: the groups (or a board's columns), a date's unit, which groups show, and a gallery's cards. */
export function LayoutButton({ ctx, draft, groups, onChange }: { ctx: DbCtx; draft: DbViewIn; groups: readonly DbGroupOut[] | null; onChange: (next: DbViewIn) => void }) {
  const type = draft.type ?? "table";
  const props = groupableProps(ctx.database.properties, type);
  const group = draft.group_by ?? null;
  const prop = group ? ctx.database.properties.find((p) => p.id === group.prop_id) ?? null : null;
  const setGroup = (next: DbGroupBy | null) => onChange({ ...draft, group_by: next });
  const hidden = new Set(group?.hidden ?? []);
  // Highlighted when it changes what shows (a board's columns are the board itself).
  const count = (group && type !== "board" ? 1 : 0) + hidden.size;
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button type="button" className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium hover:bg-ink/6", count ? "text-accent" : "text-ink")} data-layout-button>
          <Settings2 size={13} />
          <span className="max-md:sr-only">{t("docs.db.layout")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3" data-layout-panel>
        <label className="block text-xs font-semibold text-muted" htmlFor="db-group-by">{type === "board" ? t("docs.db.columnsBy") : t("docs.db.groupBy")}</label>
        <select id="db-group-by" className={cn(selectClass, "mt-1 w-full")} value={group?.prop_id ?? ""}
          onChange={(event) => {
            const next = ctx.database.properties.find((p) => p.id === event.target.value);
            setGroup(next ? { prop_id: next.id, date_unit: isDateish(next.type) ? "day" : null, hidden: [], hide_empty: false } : null);
          }}
        >
          {(type !== "board" || !group) && <option value="">{type === "board" ? "—" : t("docs.db.noGrouping")}</option>}
          {props.map((p) => <option key={p.id} value={p.id}>{propName(p)}</option>)}
        </select>
        {type === "board" && props.length === 0 && <p className="mt-1 text-xs text-muted">{t("docs.db.needBoardProp")}</p>}
        {group && prop && isDateish(prop.type) && (
          <>
            <label className="mt-3 block text-xs font-semibold text-muted" htmlFor="db-date-unit">{t("docs.db.dateUnit")}</label>
            <select id="db-date-unit" className={cn(selectClass, "mt-1 w-full")} value={group.date_unit ?? "day"} onChange={(event) => setGroup({ ...group, date_unit: event.target.value as "day" | "week" | "month", hidden: [] })}>
              <option value="day">{t("docs.db.unit.day")}</option>
              <option value="week">{t("docs.db.unit.week")}</option>
              <option value="month">{t("docs.db.unit.month")}</option>
            </select>
          </>
        )}
        {group && prop && (
          <>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!group.hide_empty} onChange={(event) => setGroup({ ...group, hide_empty: event.target.checked })} />
              {t("docs.db.hideEmptyGroups")}
            </label>
            {groups && groups.length > 0 && (
              <>
                <div className="mt-3 text-xs font-semibold text-muted">{t("docs.db.groupsShown")}</div>
                <ul className="mt-1 max-h-60 overflow-y-auto" data-group-list>
                  {groups.map((g) => {
                    const name = groupName(ctx, prop, g.key, group.date_unit);
                    const off = hidden.has(g.key);
                    return (
                      <li key={g.key} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-panel" data-group-key={g.key}>
                        <span className={cn("min-w-0 flex-1 truncate", off && "opacity-50")}><GroupLabel ctx={ctx} prop={prop} groupKey={g.key} unit={group.date_unit} /></span>
                        <span className="text-xs tabular-nums text-muted">{g.count}</span>
                        <button type="button" aria-pressed={!off} aria-label={off ? t("docs.db.showGroup", { name }) : `${t("docs.db.hideGroup")}: ${name}`} className="text-muted hover:text-ink"
                          onClick={() => setGroup({ ...group, hidden: off ? (group.hidden ?? []).filter((k) => k !== g.key) : [...(group.hidden ?? []), g.key] })}
                        >
                          {off ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}
        {type === "gallery" && (
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3">
            <label className="text-xs font-semibold text-muted">
              {t("docs.db.cardImage")}
              <select className={cn(selectClass, "mt-1 w-full font-normal text-ink")} value={draft.cover ?? "body"} onChange={(event) => onChange({ ...draft, cover: event.target.value as "body" | "none" })}>
                <option value="body">{t("docs.db.cover.body")}</option>
                <option value="none">{t("docs.db.cover.none")}</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-muted">
              {t("docs.db.cardSize")}
              <select className={cn(selectClass, "mt-1 w-full font-normal text-ink")} value={draft.card_size ?? "medium"} onChange={(event) => onChange({ ...draft, card_size: event.target.value as "small" | "medium" | "large" })}>
                <option value="small">{t("docs.db.size.small")}</option>
                <option value="medium">{t("docs.db.size.medium")}</option>
                <option value="large">{t("docs.db.size.large")}</option>
              </select>
            </label>
          </div>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

// --- shared pieces -------------------------------------------------------------------------------------------------------

/** The shown properties of a card or a list line: the view's visible columns but the title, empty ones left out. */
function CardProps({ ctx, row, columns, inline = false }: { ctx: DbCtx; row: DbRow; columns: readonly Column[]; inline?: boolean }) {
  const shown = columns.filter((c) => !c.hidden && c.prop.type !== "title" && !isEmpty(cellValue(c.prop, row), c.prop, row));
  if (shown.length === 0) return null;
  return (
    <div className={cn(inline ? "flex min-w-0 items-center gap-3 overflow-hidden" : "mt-1.5 flex flex-col gap-1")}>
      {shown.map((c) => (
        <div key={c.prop.id} className={cn("flex min-w-0 items-center gap-1.5 text-sm", inline && "max-w-[16rem] shrink-0")} title={propName(c.prop)} data-card-prop={c.prop.id}>
          <CellDisplay ctx={ctx} prop={c.prop} row={row} />
        </div>
      ))}
    </div>
  );
}

function isEmpty(value: unknown, prop: DbProperty, row: DbRow): boolean {
  if (prop.type === "relation") return (value as string[]).length === 0 && !row.hidden_relations.includes(prop.id);
  if (prop.type === "checkbox") return false;
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function RowTitle({ ctx, row, className }: { ctx: DbCtx; row: DbRow; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {row.icon && <PageIcon controller={ctx.controller} icon={row.icon} size={14} />}
      <span className={cn("truncate font-medium", !row.title && "text-muted")}>{row.title || t("docs.untitled")}</span>
    </span>
  );
}

/** A group's header in a table, list or gallery: closes and opens its rows here (not saved). */
export function SectionHeader({ ctx, prop, unit, section, collapsed, onToggle }: { ctx: DbCtx; prop: DbProperty; unit: DbGroupBy["date_unit"]; section: Section; collapsed: boolean; onToggle: () => void }) {
  const name = groupName(ctx, prop, section.key, unit);
  return (
    <button type="button" aria-expanded={!collapsed} aria-label={collapsed ? t("docs.db.expandGroup", { name }) : t("docs.db.collapseGroup", { name })}
      className="flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-left hover:bg-panel" onClick={onToggle} data-group-header={section.key}
    >
      {collapsed ? <ChevronRight size={14} className="shrink-0 text-muted" /> : <ChevronDown size={14} className="shrink-0 text-muted" />}
      <GroupLabel ctx={ctx} prop={prop} groupKey={section.key} unit={unit} />
      <span className="text-xs tabular-nums text-muted">{section.count}</span>
    </button>
  );
}

/** 「＋ 新規」, the count and 「さらに読み込む」 under a list, a gallery or a board. */
export function ViewFooter({ ctx, total, hasMore, onMore, onAddRow, newMenu }: { ctx: DbCtx; total: number; hasMore: boolean; onMore: () => void; onAddRow: () => void; newMenu?: ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-3 py-1.5 text-sm text-muted">
        {ctx.canEdit && (
          <span className="flex items-center">
            <button type="button" className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-panel hover:text-ink" onClick={onAddRow}><Plus size={14} /> {t("docs.db.newRow")}</button>
            {newMenu}
          </span>
        )}
        <span className="ml-auto text-xs tabular-nums">{t("docs.db.count", { count: total })}</span>
      </div>
      {hasMore && <div className="text-center"><Button size="sm" variant="secondary" onClick={onMore}>{t("docs.db.loadMore")}</Button></div>}
    </>
  );
}

export interface Grouping {
  prop: DbProperty;
  unit: DbGroupBy["date_unit"];
  sections: Section[];
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

/** Rows as they are, or in their (shown) groups with a header each. */
function Grouped({ ctx, rows, grouping, render }: { ctx: DbCtx; rows: DbRow[]; grouping: Grouping | null; render: (rows: DbRow[], key: string) => ReactNode }) {
  if (!grouping) return <>{render(rows, "")}</>;
  return (
    <>
      {grouping.sections.filter((s) => !s.hidden).map((section) => {
        const collapsed = grouping.collapsed.has(section.key);
        return (
          <section key={section.key} className="mt-2" data-group={section.key}>
            <SectionHeader ctx={ctx} prop={grouping.prop} unit={grouping.unit} section={section} collapsed={collapsed} onToggle={() => grouping.onToggle(section.key)} />
            {!collapsed && (section.rows.length > 0 ? render(section.rows, section.key) : <p className="px-7 py-1 text-xs text-muted">{t("docs.db.groupEmpty")}</p>)}
          </section>
        );
      })}
    </>
  );
}

// --- the list ----------------------------------------------------------------------------------------------------------

export function ListView({ ctx, columns, rows, grouping }: { ctx: DbCtx; columns: readonly Column[]; rows: DbRow[]; grouping: Grouping | null }) {
  return (
    <div className="mt-1" data-db-list>
      <Grouped ctx={ctx} rows={rows} grouping={grouping} render={(list, key) => (
        <ul className="divide-y divide-line/70 border-y border-line/70">
          {list.map((row) => (
            <li key={`${key}:${row.id}`} data-row={row.id}>
              <button type="button" className="flex w-full min-w-0 items-center gap-4 px-2 py-2 text-left hover:bg-panel/60" onClick={() => ctx.openRow(row.id)}>
                <RowTitle ctx={ctx} row={row} className="min-w-[8rem] max-w-[50%] shrink-0" />
                <span className="ml-auto flex min-w-0 justify-end"><CardProps ctx={ctx} row={row} columns={columns} inline /></span>
              </button>
            </li>
          ))}
        </ul>
      )} />
    </div>
  );
}

// --- the gallery -------------------------------------------------------------------------------------------------------

const CARD_WIDTH = { small: 180, medium: 240, large: 320 } as const;

/** A card's picture, fetched with the session when it comes into sight (a gallery of hundreds of rows). */
function Cover({ ctx, cover }: { ctx: DbCtx; cover: DbRowCover | null | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = box.current;
    if (!node || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setSeen(true); }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  useEffect(() => {
    const api = ctx.controller.api;
    if (!seen || !cover || !api) return;
    let live = true;
    let objectUrl: string | null = null;
    setFailed(false);
    api.fetchBlob(`/api/v1/attachments/${cover.attachment_id}/${cover.thumbnail ? "thumbnail" : "content"}`).then((blob) => {
      if (!live) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }, () => { if (live) setFailed(true); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); setUrl(null); };
  }, [ctx.controller, seen, cover?.attachment_id, cover?.thumbnail]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={box} className="flex aspect-[16/10] items-center justify-center overflow-hidden border-b border-line bg-panel" data-cover={cover?.attachment_id ?? ""}>
      {url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} /> : failed ? <ImageOff size={18} className="text-muted/60" /> : null}
    </div>
  );
}

export function GalleryView({ ctx, columns, rows, grouping, cover, size }: { ctx: DbCtx; columns: readonly Column[]; rows: DbRow[]; grouping: Grouping | null; cover: "body" | "none"; size: "small" | "medium" | "large" }) {
  return (
    <div className="mt-1" data-db-gallery data-card-size={size}>
      <Grouped ctx={ctx} rows={rows} grouping={grouping} render={(list, key) => (
        <ul className="grid gap-3 py-1" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${CARD_WIDTH[size]}px), 1fr))` }}>
          {list.map((row) => (
            <li key={`${key}:${row.id}`} data-row={row.id}>
              <button type="button" className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-line bg-canvas text-left shadow-sm transition-colors hover:border-accent/50 hover:bg-panel/40" onClick={() => ctx.openRow(row.id)}>
                {cover === "body" && <Cover ctx={ctx} cover={row.cover} />}
                <div className="min-w-0 p-2.5">
                  <RowTitle ctx={ctx} row={row} />
                  <CardProps ctx={ctx} row={row} columns={columns} />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )} />
    </div>
  );
}

// --- the board -----------------------------------------------------------------------------------------------------------

export interface BoardProps {
  ctx: DbCtx;
  columns: readonly Column[];
  prop: DbProperty;
  unit: DbGroupBy["date_unit"];
  sections: Section[];
  /** Cards keep the rows' own order (no sort): a drag within a column places the card. */
  manual: boolean;
  onMove: (row: DbRow, from: string, to: string, index: number) => void;
  onAddIn: (key: string) => void;
  /** Hide / show a column (the view's draft; null: not allowed). */
  onHidden: ((key: string, hidden: boolean) => void) | null;
}

export function BoardView({ ctx, columns, prop, unit, sections, manual, onMove, onAddIn, onHidden }: BoardProps) {
  const [dragging, setDragging] = useState<{ rowId: string; from: string } | null>(null);
  const [target, setTarget] = useState<{ key: string; index: number } | null>(null);
  const shown = sections.filter((s) => !s.hidden);
  const hidden = sections.filter((s) => s.hidden);
  const canMove = ctx.canEdit;
  const drop = (key: string) => {
    const drag = dragging;
    const index = target?.key === key ? target.index : Number.MAX_SAFE_INTEGER;
    setDragging(null);
    setTarget(null);
    if (!drag) return;
    const row = sections.find((s) => s.key === drag.from)?.rows.find((r) => r.id === drag.rowId);
    if (!row) return;
    if (drag.from === key && !manual) return;
    onMove(row, drag.from, key, index);
  };
  return (
    <div className="mt-2 overflow-x-auto overscroll-x-contain pb-2" data-db-board>
      {!manual && <p className="mb-1.5 text-xs text-muted">{t("docs.db.sortedOrder")}</p>}
      <div className="flex items-start gap-3">
        {shown.map((section) => {
          const name = groupName(ctx, prop, section.key, unit);
          const others = dragging ? section.rows.filter((r) => r.id !== dragging.rowId) : section.rows;
          const marker = target?.key === section.key ? target.index : -1;
          return (
            <section key={section.key} aria-label={name} data-board-column={section.key}
              className={cn("flex w-72 shrink-0 flex-col rounded-lg bg-panel/60 p-1.5", dragging && target?.key === section.key && "ring-2 ring-accent/40")}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                if (event.target === event.currentTarget || (event.target as HTMLElement).dataset.columnEnd !== undefined) setTarget({ key: section.key, index: others.length });
              }}
              onDrop={(event) => { event.preventDefault(); drop(section.key); }}
            >
              <header className="flex items-center gap-1.5 px-1 pb-1.5 pt-0.5">
                <span className="min-w-0 truncate"><GroupLabel ctx={ctx} prop={prop} groupKey={section.key} unit={unit} /></span>
                <span className="text-xs tabular-nums text-muted" aria-label={t("docs.db.cardCount", { count: section.count })}>{section.count}</span>
                <span className="ml-auto flex items-center">
                  {onHidden && (
                    <Menu>
                      <MenuTrigger asChild>
                        <button type="button" aria-label={t("docs.db.groupMenu", { name })} className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-ink/6 hover:text-ink"><MoreHorizontal size={14} /></button>
                      </MenuTrigger>
                      <MenuContent align="end">
                        <MenuItem onSelect={() => onHidden(section.key, true)}><EyeOff size={14} /> {t("docs.db.hideGroup")}</MenuItem>
                      </MenuContent>
                    </Menu>
                  )}
                  {ctx.canEdit && (
                    <button type="button" aria-label={t("docs.db.addInGroup", { name })} title={t("docs.db.addInGroup", { name })} className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-ink/6 hover:text-ink" onClick={() => onAddIn(section.key)}><Plus size={14} /></button>
                  )}
                </span>
              </header>
              <ul className="flex flex-col gap-1.5">
                {section.rows.map((row, position) => {
                  // Places count the column without the dragged card (as the server's neighbours).
                  const self = dragging?.rowId === row.id;
                  const index = dragging && !self ? others.indexOf(row) : position;
                  const last = others.length > 0 && others[others.length - 1]!.id === row.id;
                  return (
                    <li key={row.id} data-card={row.id}
                      draggable={canMove}
                      onDragStart={(event) => {
                        setDragging({ rowId: row.id, from: section.key });
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", row.id);
                      }}
                      onDragEnd={() => { setDragging(null); setTarget(null); }}
                      onDragOver={(event) => {
                        if (!dragging) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (self) return;
                        const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
                        const after = event.clientY > box.top + box.height / 2;
                        setTarget({ key: section.key, index: index + (after ? 1 : 0) });
                      }}
                      className={cn("relative", self && "opacity-40")}
                    >
                      {!self && marker === index && <DropLine />}
                      <BoardCard ctx={ctx} row={row} columns={columns} section={section} sections={shown} manual={manual} index={position} total={section.rows.length}
                        groupNameOf={(key) => groupName(ctx, prop, key, unit)} onMove={onMove}
                      />
                      {!self && last && marker === others.length && <DropLine bottom />}
                    </li>
                  );
                })}
              </ul>
              {others.length === 0 && marker >= 0 && <DropLine static />}
              <div data-column-end="" className="min-h-6 flex-1" />
            </section>
          );
        })}
        {hidden.length > 0 && (
          <section aria-label={t("docs.db.hiddenGroups")} className="w-56 shrink-0 rounded-lg p-1.5" data-board-hidden>
            <div className="px-1 pb-1.5 text-xs font-semibold text-muted">{t("docs.db.hiddenGroups")}</div>
            <ul className="flex flex-col gap-0.5">
              {hidden.map((section) => {
                const name = groupName(ctx, prop, section.key, unit);
                return (
                  <li key={section.key} className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-panel" data-hidden-group={section.key}>
                    <span className="min-w-0 flex-1 truncate opacity-70"><GroupLabel ctx={ctx} prop={prop} groupKey={section.key} unit={unit} /></span>
                    <span className="text-xs tabular-nums text-muted">{section.count}</span>
                    {onHidden && (
                      <button type="button" aria-label={t("docs.db.showGroup", { name })} title={t("docs.db.showGroup", { name })} className="text-muted hover:text-ink" onClick={() => onHidden(section.key, false)}><Eye size={13} /></button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function DropLine({ bottom = false, static: inFlow = false }: { bottom?: boolean; static?: boolean }) {
  if (inFlow) return <div className="my-1 h-0.5 rounded bg-accent" data-drop-line />;
  return <div className={cn("pointer-events-none absolute inset-x-0 z-[1] h-0.5 rounded bg-accent", bottom ? "-bottom-1" : "-top-1")} data-drop-line />;
}

/** A card: opens the row; its ⋯ moves it from the keyboard (to another column, up, down). */
function BoardCard({ ctx, row, columns, section, sections, manual, index, total, groupNameOf, onMove }: {
  ctx: DbCtx;
  row: DbRow;
  columns: readonly Column[];
  section: Section;
  sections: readonly Section[];
  manual: boolean;
  index: number;
  total: number;
  groupNameOf: (key: string) => string;
  onMove: (row: DbRow, from: string, to: string, index: number) => void;
}) {
  const title = row.title || t("docs.untitled");
  return (
    <div className="group/card relative rounded-md border border-line bg-canvas shadow-sm hover:border-accent/40">
      <button type="button" className="block w-full min-w-0 p-2 pr-8 text-left" onClick={() => ctx.openRow(row.id)}>
        <RowTitle ctx={ctx} row={row} />
        <CardProps ctx={ctx} row={row} columns={columns} />
      </button>
      {ctx.canEdit && (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" aria-label={t("docs.db.cardMenu", { title })} className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 hover:bg-ink/6 hover:text-ink focus:opacity-100 group-hover/card:opacity-100 data-[state=open]:opacity-100">
              <MoreHorizontal size={14} />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            {sections.filter((s) => s.key !== section.key).map((s) => (
              <MenuItem key={s.key} onSelect={() => onMove(row, section.key, s.key, Number.MAX_SAFE_INTEGER)}>{t("docs.db.moveTo", { name: groupNameOf(s.key) })}</MenuItem>
            ))}
            {manual && (index > 0 || index < total - 1) && <MenuSeparator />}
            {manual && index > 0 && <MenuItem onSelect={() => onMove(row, section.key, section.key, index - 1)}><ArrowUp size={14} /> {t("docs.db.moveUp")}</MenuItem>}
            {manual && index < total - 1 && <MenuItem onSelect={() => onMove(row, section.key, section.key, index + 1)}><ArrowDown size={14} /> {t("docs.db.moveDown")}</MenuItem>}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

export function BoardEmpty({ hasProps }: { hasProps: boolean }) {
  return <p className="py-6 text-sm text-muted" data-board-empty>{hasProps ? t("docs.db.chooseBoardProp") : t("docs.db.needBoardProp")}</p>;
}
