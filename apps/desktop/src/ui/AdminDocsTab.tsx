/**
 * M121 (WIKI.md §4.3): 「管理 → ドキュメント」 — every page's title and who has access (never its body), so an
 * administrator can take a page over (full access for themselves; always written to the audit log, and said so before)
 * when nobody with full access is left, and delete a page in the trash for good. Administrators do not read pages that
 * are not shared with them.
 */
import { AlertTriangle, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AdminPageOut } from "../api/types";
import type { AppController } from "../state/app";
import { pageTitle, wikiCall } from "./docsActions";
import { levelLabel, principalName } from "./DocsDialogs";
import { sinceLabel } from "./format";
import { PageIcon } from "./PageIcon";
import { Badge, Button, Input, Modal } from "./primitives";
import { t } from "../i18n";

export function AdminDocsTab({ controller }: { controller: AppController }) {
  const [rows, setRows] = useState<AdminPageOut[] | null>(null);
  const [query, setQuery] = useState("");
  const [takeover, setTakeover] = useState<AdminPageOut | null>(null);
  const [purge, setPurge] = useState<AdminPageOut | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void wikiCall(controller, (api) => api.adminWikiPages()).then((list) => setRows(list ?? []));
  useEffect(load, [controller]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((row) => !q || row.title.toLowerCase().includes(q));
  }, [rows, query]);

  const doTakeover = async (row: AdminPageOut) => {
    setBusy(true);
    const page = await wikiCall(controller, (api) => api.adminTakeOverWikiPage(row.id));
    setBusy(false);
    setTakeover(null);
    if (page === null) return;
    controller.engine?.wiki?.upsert(page);
    void controller.engine?.wiki?.catchUp();
    controller.setNotice(t("docs.admin.takenOver", { title: pageTitle(row, t("docs.untitled")) }));
    load();
  };
  const doPurge = async (row: AdminPageOut) => {
    setBusy(true);
    const done = await wikiCall(controller, (api) => api.adminPurgeWikiPage(row.id).then(() => true));
    setBusy(false);
    setPurge(null);
    if (!done) return;
    controller.setNotice(t("docs.trashView.purged"));
    load();
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t("docs.admin.description")}</p>
      <div className="relative max-w-sm">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <Input aria-label={t("docs.admin.filter")} placeholder={t("docs.admin.filter")} value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8" />
      </div>
      {rows === null ? (
        <div className="py-6 text-center text-sm text-muted">{t("common.loading")}</div>
      ) : shown.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">{t("docs.admin.empty")}</div>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t("docs.admin.list")}>
          {shown.map((row) => (
            <li key={row.id} className="flex items-start gap-2 px-3 py-2" data-admin-page={row.id}>
              <PageIcon controller={controller} icon={row.icon} size={16} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="truncate font-medium">{pageTitle(row, t("docs.untitled"))}</span>
                  {row.deleted_at && <Badge>{t("docs.admin.inTrash")}</Badge>}
                  {!row.has_manager && !row.deleted_at && <Badge tone="danger">{t("docs.admin.noManager")}</Badge>}
                  {!row.inherit_access && <Badge>{t("docs.admin.ownSharing")}</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {row.effective.length === 0
                    ? t("docs.admin.nobody")
                    : row.effective.map((entry) => `${principalName(controller, entry)}（${levelLabel(entry.level)}）`).join(t("common.listSeparator"))}
                </div>
                <div className="text-[11px] text-muted">{t("docs.admin.updated", { when: sinceLabel(row.updated_at) })}</div>
              </div>
              {!row.deleted_at && (
                <Button size="sm" variant="secondary" onClick={() => setTakeover(row)}><ShieldCheck size={13} /> {t("docs.admin.takeover")}</Button>
              )}
              {row.deleted_at && (
                <Button size="sm" variant="secondary" className="text-danger" onClick={() => setPurge(row)}><Trash2 size={13} /> {t("docs.trashView.purge")}</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {takeover && (
        <Modal title={t("docs.admin.takeoverTitle")} description={t("docs.admin.takeoverNote", { title: pageTitle(takeover, t("docs.untitled")) })} onClose={() => setTakeover(null)}>
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning/15 px-3 py-2 text-sm">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>{t("docs.admin.takeoverAudit")}</span>
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTakeover(null)}>{t("common.cancel")}</Button>
            <Button disabled={busy} onClick={() => void doTakeover(takeover)}>{t("docs.admin.takeover")}</Button>
          </div>
        </Modal>
      )}
      {purge && (
        <Modal title={t("docs.trashView.purgeTitle")} description={t("docs.trashView.purgeNote", { title: pageTitle(purge, t("docs.untitled")) })} onClose={() => setPurge(null)}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPurge(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void doPurge(purge)}>{t("docs.trashView.purge")}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
