/**
 * M121 (WIKI.md §4, §9.1): the 「ドキュメント」 dialogs.
 *
 * - Move: the server's dry run says who would gain or lose access when the page takes its new parent's sharing
 *   (§4.5). The page can move that way, or keep today's sharing (`keep_access`: its effective entries become its own and
 *   it stops inheriting). When nobody with full access would be left (`manager_lost`) only the second is possible.
 * - Share: who can read the page and how (its own entries and those inherited, with the page they come from — 「上位の
 *   ページ」 when that one is not readable to me), adding everyone / a group / a person at view / edit / full, changing
 *   and removing (narrowing an inherited entry stops the inheritance, §4.2), and the inheritance itself. Only someone
 *   with full access who is not a guest changes it; everyone else sees it read only. Guests are added by name only.
 * - Trash: the pages I moved there (or could have), restorable; an administrator can delete one for good.
 */
import { AlertTriangle, ArrowRight, Copy, RotateCcw, Trash2, Users, UsersRound, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { PageItem, PageMeta, WikiAccessChange, WikiAccessOut, WikiAccessUpdate, WikiLevel, WikiMoveOut } from "../api/types";
import type { AppController } from "../state/app";
import type { MoveTarget } from "../sync/wikiTree";
import { Avatar } from "./Avatar";
import { addGrant, changeLevel, LEVELS, levelRank, type Principal, principalKey, removeGrant, setInherit, sortedEntries } from "./docsAccess";
import { movePage, pageTitle, restorePage, setAccess, wikiCall } from "./docsActions";
import { sinceLabel } from "./format";
import { PageIcon } from "./PageIcon";
import { Badge, Button, cn, Input, Modal } from "./primitives";
import { t } from "../i18n";

export function levelLabel(level: WikiLevel | null | undefined): string {
  return level === "full" ? t("docs.level.full") : level === "edit" ? t("docs.level.edit") : level === "view" ? t("docs.level.view") : t("docs.level.none");
}

/** The name of whoever an entry is for (everyone, a group, a person). */
export function principalName(controller: AppController, p: Principal): string {
  if (p.principal_type === "workspace") return t("docs.everyone");
  if (p.principal_type === "group") return (p.principal_id && controller.store.groups.get(p.principal_id)?.name) || t("docs.unknownGroup");
  return (p.principal_id && controller.store.users.get(p.principal_id)?.display_name) || t("common.member");
}

function PrincipalBadge({ controller, p, size = 24 }: { controller: AppController; p: Principal; size?: number }) {
  if (p.principal_type === "user" && p.principal_id) return <Avatar id={p.principal_id} name={principalName(controller, p)} size={size} className="rounded-md text-[10px]" />;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent" style={{ width: size, height: size }}>
      {p.principal_type === "workspace" ? <Users size={14} /> : <UsersRound size={14} />}
    </span>
  );
}

const isGuestUser = (controller: AppController, p: Principal) => p.principal_type === "user" && !!p.principal_id && controller.store.users.get(p.principal_id)?.role === "guest";

// --- move ---------------------------------------------------------------------------------------

/** Gains and losses of a move (each person / group / everyone once). */
export function moveEffects(changes: readonly WikiAccessChange[]): { gains: WikiAccessChange[]; losses: WikiAccessChange[] } {
  const gains = changes.filter((c) => levelRank(c.after) > levelRank(c.before));
  const losses = changes.filter((c) => levelRank(c.after) < levelRank(c.before));
  return { gains, losses };
}

export function MoveDialog({ controller, page, target, dry, onClose, onMoved }: {
  controller: AppController;
  page: Pick<PageItem, "id" | "title" | "icon">;
  target: MoveTarget;
  dry: WikiMoveOut;
  onClose: () => void;
  onMoved: () => void;
}) {
  const hub = controller.engine?.wiki ?? null;
  const [keep, setKeep] = useState(dry.manager_lost);
  const [busy, setBusy] = useState(false);
  const { gains, losses } = moveEffects(dry.changes);
  const destination = target.parent_id ? pageTitle(hub?.page(target.parent_id), t("docs.untitled")) : t("docs.topLevel");
  const move = async () => {
    setBusy(true);
    const moved = await movePage(controller, page.id, target, keep);
    setBusy(false);
    if (moved) {
      onMoved();
      onClose();
    }
  };
  const change = (c: WikiAccessChange) => (
    <li key={principalKey(c)} className="flex items-center gap-2 py-1 text-sm">
      <PrincipalBadge controller={controller} p={c} size={22} />
      <span className="min-w-0 flex-1 truncate">{principalName(controller, c)}</span>
      <span className="shrink-0 text-xs text-muted">{levelLabel(c.before)}</span>
      <ArrowRight size={12} className="shrink-0 text-muted" />
      <span className={cn("shrink-0 text-xs font-medium", levelRank(c.after) > levelRank(c.before) ? "text-success" : "text-danger")}>{levelLabel(c.after)}</span>
    </li>
  );
  return (
    <Modal title={t("docs.move.title", { title: pageTitle(page, t("docs.untitled")) })} description={t("docs.move.description", { destination })} onClose={onClose} className="w-[560px]">
      <div className="mt-4 space-y-3">
        {gains.length > 0 && (
          <section aria-label={t("docs.move.gains")}>
            <h3 className="text-xs font-semibold text-muted">{t("docs.move.gains")}</h3>
            <ul className="mt-1">{gains.map(change)}</ul>
          </section>
        )}
        {losses.length > 0 && (
          <section aria-label={t("docs.move.losses")}>
            <h3 className="text-xs font-semibold text-muted">{t("docs.move.losses")}</h3>
            <ul className="mt-1">{losses.map(change)}</ul>
          </section>
        )}
        {dry.manager_lost && (
          <p className="flex items-start gap-2 rounded-lg bg-warning/15 px-3 py-2 text-sm">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>{t("docs.move.managerLost")}</span>
          </p>
        )}
        <fieldset className="space-y-1.5" aria-label={t("docs.move.how")}>
          <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2", !keep ? "border-accent bg-accent-soft/50" : "border-line", dry.manager_lost && "cursor-not-allowed opacity-50")}>
            <input type="radio" name="move-access" className="mt-1" checked={!keep} disabled={dry.manager_lost} onChange={() => setKeep(false)} />
            <span>
              <span className="block text-sm font-medium">{t("docs.move.inherit")}</span>
              <span className="block text-xs text-muted">{t("docs.move.inheritNote")}</span>
            </span>
          </label>
          <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2", keep ? "border-accent bg-accent-soft/50" : "border-line")}>
            <input type="radio" name="move-access" className="mt-1" checked={keep} onChange={() => setKeep(true)} />
            <span>
              <span className="block text-sm font-medium">{t("docs.move.keep")}</span>
              <span className="block text-xs text-muted">{t("docs.move.keepNote")}</span>
            </span>
          </label>
        </fieldset>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={busy} onClick={() => void move()}>{t("docs.move.confirm")}</Button>
      </div>
    </Modal>
  );
}

// --- sharing ------------------------------------------------------------------------------------

export function ShareDialog({ controller, page, onClose }: { controller: AppController; page: Pick<PageItem, "id" | "title" | "icon">; onClose: () => void }) {
  const [access, setAccessState] = useState<WikiAccessOut | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void wikiCall(controller, (api) => api.wikiAccess(page.id)).then((found) => { if (live) setAccessState(found); });
    return () => { live = false; };
  }, [controller, page.id]);
  const editable = !!access && access.my_level === "full" && !controller.isGuest;
  const apply = async (update: WikiAccessUpdate) => {
    setBusy(true);
    const next = await setAccess(controller, page.id, update);
    setBusy(false);
    if (next) setAccessState(next);
  };
  const nameOf = (p: Principal) => principalName(controller, p);
  const entries = access ? sortedEntries(access.effective, nameOf) : [];
  const inherited = entries.some((e) => e.inherited);
  return (
    <Modal title={t("docs.share.title", { title: pageTitle(page, t("docs.untitled")) })} description={editable ? t("docs.share.description") : t("docs.share.readOnly")} onClose={onClose} className="w-[600px]" growsDown>
      {access === null ? (
        <div className="py-8 text-center text-sm text-muted">{t("common.loading")}</div>
      ) : (
        <div className="mt-4 space-y-4">
          {editable && <AddPerson controller={controller} access={access} busy={busy} onAdd={(who, level) => void apply(addGrant(access, who, level))} />}
          {(inherited || !access.inherit_access) && (
            <div className="flex items-center gap-2 rounded-lg bg-panel px-3 py-2 text-sm" data-inherit={access.inherit_access ? "on" : "off"}>
              <span className="min-w-0 flex-1">{access.inherit_access ? t("docs.share.inheriting") : t("docs.share.notInheriting")}</span>
              {editable && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void apply(setInherit(access, !access.inherit_access))}>
                  {access.inherit_access ? t("docs.share.stopInherit") : t("docs.share.resumeInherit")}
                </Button>
              )}
            </div>
          )}
          <ul aria-label={t("docs.share.list")} className="max-h-[45dvh] space-y-0.5 overflow-y-auto">
            {entries.map((entry) => (
              <li key={principalKey(entry)} className="flex items-center gap-2 rounded-lg px-1 py-1.5" data-principal={principalKey(entry)}>
                <PrincipalBadge controller={controller} p={entry} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="truncate">{nameOf(entry)}</span>
                    {isGuestUser(controller, entry) && <Badge>{t("docs.share.guest")}</Badge>}
                  </span>
                  {entry.inherited && (
                    <span className="block truncate text-[11px] text-muted" data-source={entry.source_page_id ?? ""}>
                      {entry.source_title ? t("docs.share.from", { title: entry.source_title }) : t("docs.share.fromAbove")}
                    </span>
                  )}
                </span>
                {editable ? (
                  <>
                    <select
                      aria-label={t("docs.share.levelOf", { name: nameOf(entry) })}
                      className="h-8 rounded-lg border border-line bg-canvas px-2 text-sm"
                      value={entry.level}
                      disabled={busy}
                      onChange={(event) => void apply(changeLevel(access, entry, event.target.value as WikiLevel))}
                    >
                      {LEVELS.map((level) => <option key={level} value={level}>{levelLabel(level)}</option>)}
                    </select>
                    <button type="button" aria-label={t("docs.share.remove", { name: nameOf(entry) })} title={t("docs.share.removeTitle")} disabled={busy} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger" onClick={() => void apply(removeGrant(access, entry))}>
                      <X size={15} />
                    </button>
                  </>
                ) : (
                  <span className="shrink-0 text-xs text-muted">{levelLabel(entry.level)}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{t("docs.share.guestNote")}</p>
          <div className="flex justify-between gap-2">
            <Button variant="secondary" onClick={() => void controller.copyPageLink(page.id)}><Copy size={14} /> {t("canvas.copyLink")}</Button>
            <Button onClick={onClose}>{t("common.close")}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 「追加」: everyone, a group or a person (bots and deactivated people are not offered), at a level. */
function AddPerson({ controller, access, busy, onAdd }: { controller: AppController; access: WikiAccessOut; busy: boolean; onAdd: (who: Principal, level: WikiLevel) => void }) {
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<Principal | null>(null);
  const [level, setLevel] = useState<WikiLevel>("edit");
  const store = controller.store;
  const present = new Set(access.effective.map(principalKey));
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Array<{ p: Principal; label: string; detail: string; guest: boolean }> = [];
    if (!present.has("workspace:")) out.push({ p: { principal_type: "workspace", principal_id: null }, label: t("docs.everyone"), detail: t("docs.share.everyoneDetail"), guest: false });
    for (const group of store.groups.values()) out.push({ p: { principal_type: "group", principal_id: group.id }, label: group.name, detail: t("docs.share.groupDetail", { count: group.member_ids.length }), guest: false });
    for (const user of store.users.values()) {
      if (user.bot_kind || user.role === "bot" || user.deactivated_at) continue;
      out.push({ p: { principal_type: "user", principal_id: user.id }, label: user.display_name, detail: `@${user.username}`, guest: user.role === "guest" });
    }
    return out
      .filter((o) => !present.has(principalKey(o.p)))
      .filter((o) => !q || o.label.toLowerCase().includes(q) || o.detail.toLowerCase().includes(q))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, access, store.users.size, store.groups.size]);
  const chosen = choice ? principalName(controller, choice) : null;
  return (
    <div className="rounded-lg border border-line p-2">
      <div className="flex items-center gap-2">
        {chosen ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-accent-soft px-2 py-1 text-sm">
            <span className="truncate">{chosen}</span>
            <button type="button" aria-label={t("common.cancel")} className="ml-auto text-muted hover:text-ink" onClick={() => setChoice(null)}><X size={13} /></button>
          </span>
        ) : (
          <Input aria-label={t("docs.share.addLabel")} placeholder={t("docs.share.addPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} className="flex-1" />
        )}
        <select aria-label={t("docs.share.newLevel")} className="h-9 rounded-lg border border-line bg-canvas px-2 text-sm" value={level} onChange={(event) => setLevel(event.target.value as WikiLevel)}>
          {LEVELS.map((value) => <option key={value} value={value}>{levelLabel(value)}</option>)}
        </select>
        <Button disabled={!choice || busy} onClick={() => { if (choice) { onAdd(choice, level); setChoice(null); setQuery(""); } }}>{t("docs.share.add")}</Button>
      </div>
      {!choice && query.trim() !== "" && (
        <ul className="mt-1 max-h-56 overflow-y-auto" aria-label={t("docs.share.candidates")}>
          {options.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted">{t("docs.share.noCandidates")}</li>
          ) : (
            options.map((o) => (
              <li key={principalKey(o.p)}>
                <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => setChoice(o.p)}>
                  <PrincipalBadge controller={controller} p={o.p} size={22} />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.guest && <Badge>{t("docs.share.guest")}</Badge>}
                  <span className="shrink-0 text-xs text-muted">{o.detail}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// --- trash --------------------------------------------------------------------------------------

export function DocsTrashDialog({ controller, onClose, onRestored }: { controller: AppController; onClose: () => void; onRestored: (pageId: string) => void }) {
  const [rows, setRows] = useState<PageMeta[] | null>(null);
  const [purging, setPurging] = useState<PageMeta | null>(null);
  const load = () => void wikiCall(controller, (api) => api.wikiTrash()).then((list) => setRows(list ?? []));
  useEffect(load, [controller]); // eslint-disable-line react-hooks/exhaustive-deps
  const restore = async (page: PageMeta) => {
    const restored = await restorePage(controller, page.id);
    if (restored) onRestored(restored.id);
  };
  const purge = async (page: PageMeta) => {
    const done = await wikiCall(controller, (api) => api.adminPurgeWikiPage(page.id).then(() => true));
    setPurging(null);
    if (done) {
      controller.setNotice(t("docs.trashView.purged"));
      load();
    }
  };
  return (
    <Modal title={t("docs.trashView.title")} description={t("docs.trashView.description")} onClose={onClose} growsDown>
      <div className="mt-4 max-h-[55dvh] space-y-1 overflow-y-auto" aria-label={t("docs.trash")}>
        {rows === null ? (
          <div className="py-4 text-center text-sm text-muted">{t("common.loading")}</div>
        ) : rows.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted">{t("docs.trashView.empty")}</div>
        ) : (
          rows.map((page) => (
            <div key={page.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-panel" data-trashed={page.id}>
              <PageIcon controller={controller} icon={page.icon} kind={page.kind} size={15} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{pageTitle(page, t("docs.untitled"))}</span>
                <span className="block text-[11px] text-muted">{t("canvas.deletedAt", { when: page.deleted_at ? sinceLabel(page.deleted_at) : "" })}</span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => void restore(page)}><RotateCcw size={13} /> {t("canvas.restore")}</Button>
              {controller.isAdmin && (
                <Button size="sm" variant="secondary" className="text-danger" onClick={() => setPurging(page)}><Trash2 size={13} /> {t("docs.trashView.purge")}</Button>
              )}
            </div>
          ))
        )}
      </div>
      {purging && (
        <Modal title={t("docs.trashView.purgeTitle")} description={t("docs.trashView.purgeNote", { title: pageTitle(purging, t("docs.untitled")) })} onClose={() => setPurging(null)}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPurging(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => void purge(purging)}>{t("docs.trashView.purge")}</Button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

/** A small row of a page (children, backlinks). */
export function PageRow({ controller, page, onOpen, trailing }: { controller: AppController; page: Pick<PageItem, "id" | "title" | "icon">; onOpen: (id: string) => void; trailing?: ReactNode }) {
  return (
    <button type="button" data-page-item={page.id} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-panel" onClick={() => onOpen(page.id)}>
      <PageIcon controller={controller} icon={page.icon} size={15} />
      <span className="min-w-0 flex-1 truncate">{pageTitle(page, t("docs.untitled"))}</span>
      {trailing}
    </button>
  );
}
