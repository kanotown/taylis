/**
 * M123 (WIKI.md §5.3, §5.5): a database row opened as a page — its properties above the body, each edited in place
 * (the same editors as the table), and the rows I can read that link here through a one-way relation (a two-way
 * relation is a property of this database already). Read again on wiki.rows.changed for its database.
 */
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DbRowDetail, DbRowRef, DbSchemaOp } from "../api/types";
import type { AppController } from "../state/app";
import { t } from "../i18n";
import { CellDisplay, CellEditor, type DbCtx, Labelled, PropIcon, propName, RowChip } from "./DbCells";
import { useWikiHub } from "./DocsTree";
import { PopoverAnchor, PopoverContent, PopoverRoot } from "./primitives";
import { databaseRights } from "./wikiDb";

export function RowProperties({ controller, rowId, version, onOpenPage }: { controller: AppController; rowId: string; version: number; onOpenPage: (pageId: string) => void }) {
  const hub = useWikiHub(controller);
  const [detail, setDetail] = useState<DbRowDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const load = useCallback(async () => {
    const api = controller.api;
    if (!api) return;
    try {
      const next = await api.wikiRow(rowId);
      if (live.current) {
        setDetail(next);
        setFailed(false);
      }
    } catch {
      if (live.current) setFailed(true);
    }
  }, [controller, rowId]);
  useEffect(() => { void load(); }, [load, version]);
  const databaseId = detail?.database.page_id ?? null;
  useEffect(() => {
    if (!hub || !databaseId) return;
    return hub.onRows(databaseId, () => void load());
  }, [hub, databaseId, load]);

  const refs = useMemo(() => new Map<string, DbRowRef>((detail?.refs ?? []).map((r) => [r.id, r])), [detail?.refs]);
  if (!detail) {
    return failed ? null : <div className="my-3 flex"><Loader2 size={16} className="animate-spin text-muted" /></div>;
  }
  const ctx: DbCtx = {
    controller,
    database: detail.database,
    refs,
    ...databaseRights(detail.database.my_level, controller.isGuest),
    openRow: onOpenPage,
    setCell: async (row, propId, value) => {
      const api = controller.api;
      if (!api) return;
      try {
        const out = await api.setWikiCells(row.id, { [propId]: value }, crypto.randomUUID());
        setDetail((current) => current && { ...current, row: out.row, refs: [...current.refs.filter((r) => !out.refs.some((o) => o.id === r.id)), ...out.refs] });
      } catch (error) {
        controller.setError(error);
        void load();
      }
    },
    changeSchema: async (ops: DbSchemaOp[]) => {
      const api = controller.api;
      if (!api) return null;
      try {
        const next = await api.changeWikiSchema(detail.database.page_id, { base_schema_version: detail.database.schema_version, ops });
        void load();
        return next;
      } catch (error) {
        controller.setError(error);
        return null;
      }
    },
  };
  const row = detail.row;
  const props = detail.database.properties.filter((p) => p.type !== "title");
  return (
    <section aria-label={t("docs.db.rowProperties")} className="mt-4 border-b border-line pb-3" data-row-properties={rowId}>
      {props.length === 0 && <p className="text-xs text-muted">{t("docs.db.noProperties")}</p>}
      {props.map((prop) => {
        const computed = prop.type === "created_time" || prop.type === "updated_time" || prop.type === "created_by" || prop.type === "updated_by";
        const label = <><PropIcon type={prop.type} /> <span className="truncate">{propName(prop)}</span></>;
        const value = <div className="min-h-[30px] rounded-md px-1.5 py-1 text-sm"><CellDisplay ctx={ctx} prop={prop} row={row} wrap /></div>;
        if (!ctx.canEdit || computed) return <Labelled key={prop.id} label={label}>{value}</Labelled>;
        if (prop.type === "checkbox") {
          return (
            <Labelled key={prop.id} label={label}>
              <button type="button" aria-label={propName(prop)} className="rounded-md px-1.5 py-1.5 hover:bg-panel" onClick={() => void ctx.setCell(row, prop.id, !row.props[prop.id])}>
                <CellDisplay ctx={ctx} prop={prop} row={row} />
              </button>
            </Labelled>
          );
        }
        return (
          <Labelled key={prop.id} label={label}>
            <PopoverRoot open={editing === prop.id} onOpenChange={(open) => setEditing(open ? prop.id : null)}>
              <PopoverAnchor asChild>
                <div role="button" tabIndex={0} aria-label={t("docs.db.editCellOf", { name: propName(prop) })} className="cursor-default rounded-md hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  onClick={() => setEditing(prop.id)} onKeyDown={(event) => { if (event.key === "Enter") setEditing(prop.id); }}
                >
                  {value}
                </div>
              </PopoverAnchor>
              <PopoverContent align="start" className="p-0">
                {editing === prop.id && <CellEditor ctx={ctx} prop={prop} row={row} onDone={() => setEditing(null)} />}
              </PopoverContent>
            </PopoverRoot>
          </Labelled>
        );
      })}
      {detail.referenced_by.map((group) => (
        <Labelled key={`${group.database_id}:${group.prop_id}`} label={<span className="truncate" title={group.database_title}>{t("docs.db.referencedBy", { name: group.prop_name || t("docs.db.type.relation"), database: group.database_title || t("docs.untitled") })}</span>}>
          <div className="flex flex-wrap gap-1 px-1.5 py-1">
            {group.rows.map((ref) => <RowChip key={ref.id} ctx={{ controller, refs: new Map([[ref.id, ref]]), openRow: onOpenPage }} rowId={ref.id} />)}
          </div>
        </Labelled>
      ))}
    </section>
  );
}
