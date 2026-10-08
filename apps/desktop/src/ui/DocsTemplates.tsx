/**
 * M145 (WIKI.md §22.3): templates and copies on Desktop / Web.
 *
 * - TemplateGallery: where a new page starts from — 白紙, the built-in templates (the canvases', 週報・議事録 …) and the
 *   page templates I can read (「みんなのテンプレート」). The tree's ＋ and 「子ページを追加」 open it; an empty page's
 *   「テンプレートから始める」 opens it without 白紙.
 * - DuplicateDialog: 「複製」 (beside the original, taking the sharing of where it goes: who can see it is shown) and
 *   「テンプレートとして保存」 (a copy at the top level, everyone can use it or only me). A row's copy stays in its database.
 * - TemplateBanner: on a template (a page or a row of a database): what it is, the placeholders a page made from it gets,
 *   and its actions.
 */
import { Copy, FileText, LayoutTemplate, Loader2, Plus, Sparkles, Users } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { PageItem, WikiAccessOut } from "../api/types";
import type { AppController } from "../state/app";
import { type MessageKey, t } from "../i18n";
import { levelLabel, principalName } from "./DocsDialogs";
import { useWikiHub } from "./DocsTree";
import { duplicatePage, pageTitle, type TemplateChoice, wikiCall } from "./docsActions";
import { PageIcon } from "./PageIcon";
import { Button, cn, Input, Modal } from "./primitives";

/** The placeholders a page made from a template gets (canvases/templates.py), with what they become. */
export const TEMPLATE_VARIABLES: ReadonlyArray<{ token: string; label: MessageKey }> = [
  { token: "{{date}}", label: "docs.tpl.var.date" },
  { token: "{{week}}", label: "docs.tpl.var.week" },
  { token: "{{time}}", label: "docs.tpl.var.time" },
  { token: "{{me}}", label: "docs.tpl.var.me" },
  { token: "{{me_name}}", label: "docs.tpl.var.meName" },
  { token: "{{parent}}", label: "docs.tpl.var.parent" },
];

export function TemplateGallery({ controller, title, description, blank = true, onPick, onClose }: {
  controller: AppController;
  title: string;
  description?: string;
  /** Offer 「白紙のページ」 (not when starting an empty page from a template). */
  blank?: boolean;
  onPick: (choice: TemplateChoice) => void;
  onClose: () => void;
}) {
  const hub = useWikiHub(controller);
  const [loaded, setLoaded] = useState(!!hub?.templates);
  useEffect(() => {
    let live = true;
    void hub?.loadTemplates().then(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [hub]);
  const builtins = hub?.templates?.builtins ?? [];
  const pages = hub?.templatePages() ?? [];
  const pick = (choice: TemplateChoice) => {
    onClose();
    onPick(choice);
  };
  return (
    <Modal title={title} description={description} onClose={onClose} className="w-[640px]" growsDown>
      <div className="mt-4 space-y-4" data-template-gallery>
        {blank && (
          <Tile icon={<FileText size={18} />} name={t("docs.tpl.blank")} note={t("docs.tpl.blankNote")} onClick={() => pick({ kind: "blank" })} autoFocus data-template="blank" />
        )}
        {!loaded && !hub?.templates ? (
          <div className="flex justify-center py-4"><Loader2 size={18} className="animate-spin text-muted" /></div>
        ) : (
          <>
            {builtins.length > 0 && (
              <GallerySection label={t("docs.tpl.builtin")} icon={<Sparkles size={12} />}>
                {builtins.map((b) => (
                  <Tile key={b.key} icon={<LayoutTemplate size={18} />} name={b.name} note={b.description ?? ""} onClick={() => pick({ kind: "builtin", key: b.key })} data-template={`builtin:${b.key}`} />
                ))}
              </GallerySection>
            )}
            <GallerySection label={t("docs.tpl.everyone")} icon={<Users size={12} />}>
              {pages.length === 0 ? (
                <p className="col-span-full px-1 text-xs text-muted">{t("docs.tpl.noTemplates")}</p>
              ) : (
                pages.map((page) => (
                  <Tile key={page.id} icon={<PageIcon controller={controller} icon={page.icon} size={18} />} name={pageTitle(page, t("docs.untitled"))} note={page.private ? t("docs.tpl.sharePrivate") : ""} onClick={() => pick({ kind: "page", id: page.id })} data-template={`page:${page.id}`} />
                ))
              )}
            </GallerySection>
          </>
        )}
      </div>
    </Modal>
  );
}

function GallerySection({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{icon} {label}</h3>
      <div className="grid grid-cols-2 gap-1.5 max-md:grid-cols-1">{children}</div>
    </section>
  );
}

function Tile({ icon, name, note, onClick, autoFocus, ...rest }: { icon: ReactNode; name: string; note: string; onClick: () => void; autoFocus?: boolean; "data-template"?: string }) {
  return (
    <button type="button" autoFocus={autoFocus} onClick={onClick} className="flex min-w-0 items-start gap-2.5 rounded-xl border border-line px-3 py-2.5 text-left hover:border-accent hover:bg-accent-soft/40 focus-visible:border-accent focus-visible:outline-none" {...rest}>
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{name}</span>
        {note && <span className="block truncate text-xs text-muted">{note}</span>}
      </span>
    </button>
  );
}

// --- 「複製」 and 「テンプレートとして保存」 ----------------------------------------------------------------------------

export type DuplicateMode = "copy" | "template";

export function DuplicateDialog({ controller, page, mode, onClose, onDone }: {
  controller: AppController;
  page: Pick<PageItem, "id" | "title" | "kind" | "parent_id" | "private" | "is_template">;
  mode: DuplicateMode;
  onClose: () => void;
  /** The copy (a page, a row or a template): the caller opens it. */
  onDone: (copy: { id: string; title: string; is_template: boolean; kind: PageItem["kind"] }) => void;
}) {
  const hub = useWikiHub(controller);
  const row = page.kind === "row";
  const asTemplate = mode === "template";
  const untitled = t("docs.untitled");
  const [title, setTitle] = useState(() => (asTemplate || page.is_template ? pageTitle(page, untitled) : t("docs.tpl.copyTitle", { title: pageTitle(page, untitled) })));
  const parentId = row || asTemplate || page.is_template ? null : page.parent_id;
  const topLevel = !row && parentId === null;
  const [access, setAccess] = useState<"workspace" | "private">(page.private ? "private" : "workspace");
  const [parentAccess, setParentAccess] = useState<WikiAccessOut | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!parentId) return;
    let live = true;
    void wikiCall(controller, (api) => api.wikiAccess(parentId)).then((found) => { if (live) setParentAccess(found); });
    return () => { live = false; };
  }, [controller, parentId]);
  const parent = parentId ? hub?.page(parentId) : null;
  const submit = async () => {
    setBusy(true);
    const out = await duplicatePage(controller, page.id, {
      as_template: asTemplate ? true : row ? page.is_template : false,
      title: title.trim() || null,
      ...(topLevel ? { access } : {}),
    });
    setBusy(false);
    if (!out) return;
    controller.setNotice(asTemplate ? t("docs.tpl.saved", { title: pageTitle(out.page, untitled) }) : t("docs.tpl.duplicated", { title: pageTitle(out.page, untitled) }));
    onClose();
    onDone({ id: out.page.id, title: out.page.title, is_template: out.page.is_template, kind: out.page.kind });
  };
  const heading = asTemplate ? t("docs.tpl.saveAs") : t("docs.tpl.duplicateTitle", { title: pageTitle(page, untitled) });
  const description = asTemplate ? t("docs.tpl.saveAsDescription") : row ? t("docs.tpl.rowDuplicateDescription") : t("docs.tpl.duplicateDescription");
  return (
    <Modal title={heading} description={description} onClose={onClose} className="w-[520px]">
      <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }} data-duplicate={mode}>
        <Input aria-label={t("docs.titleLabel")} value={title} maxLength={200} autoFocus onChange={(event) => setTitle(event.target.value)} />
        {!row && (
          <section aria-label={t("docs.tpl.who")} className="space-y-1.5">
            <h3 className="text-xs font-semibold text-muted">{t("docs.tpl.who")}</h3>
            {topLevel ? (
              <fieldset className="space-y-1.5">
                {(["workspace", "private"] as const).map((value) => (
                  <label key={value} className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm", access === value ? "border-accent bg-accent-soft/50" : "border-line")}>
                    <input type="radio" name="duplicate-access" checked={access === value} onChange={() => setAccess(value)} />
                    {value === "private" ? t("docs.tpl.sharePrivate") : asTemplate || page.is_template ? t("docs.tpl.shareTemplate") : t("docs.tpl.shareWorkspace")}
                  </label>
                ))}
              </fieldset>
            ) : (
              <>
                <p className="text-xs text-muted">{t("docs.tpl.inheritsNote", { title: pageTitle(parent, untitled) })}</p>
                {parentAccess === null ? (
                  <div className="py-1 text-xs text-muted">{t("common.loading")}</div>
                ) : (
                  <ul className="max-h-40 space-y-0.5 overflow-y-auto" aria-label={t("docs.tpl.who")}>
                    {parentAccess.effective.map((entry) => (
                      <li key={`${entry.principal_type}:${entry.principal_id ?? ""}`} className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{principalName(controller, entry)}</span>
                        <span className="shrink-0 text-xs text-muted">{levelLabel(entry.level)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy}>{asTemplate ? <><LayoutTemplate size={14} /> {t("docs.tpl.saveAs")}</> : <><Copy size={14} /> {t("docs.tpl.duplicate")}</>}</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- on a template --------------------------------------------------------------------------------------------------

export function TemplateBanner({ kind, canEdit, isDefault, onUse, onUnset, onDefault }: {
  kind: "page" | "row";
  canEdit: boolean;
  /** A row template: whether it is the database's default (null: not a row). */
  isDefault: boolean | null;
  onUse: (() => void) | null;
  onUnset: (() => void) | null;
  onDefault: ((on: boolean) => void) | null;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent-soft/40 px-4 py-2 text-xs" data-template-banner={kind}>
      <span className="flex min-w-0 flex-1 items-start gap-1.5">
        <LayoutTemplate size={14} className="mt-0.5 shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="block font-medium text-ink">{kind === "row" ? t("docs.tpl.rowBanner") : t("docs.tpl.banner")}</span>
          <span className="block text-muted">
            {t("docs.tpl.variablesLabel")}
            {TEMPLATE_VARIABLES.map((v, index) => (
              <span key={v.token}>{index > 0 && t("common.listSeparator")}<code className="rounded bg-panel px-1">{v.token}</code>{t("docs.tpl.varNote", { label: t(v.label) })}</span>
            ))}
          </span>
        </span>
      </span>
      <span className="flex max-w-full flex-wrap items-center gap-1.5">
        {onUse && <Button size="sm" onClick={onUse}><Plus size={13} /> {kind === "row" ? t("docs.tpl.useRow") : t("docs.tpl.use")}</Button>}
        {canEdit && onDefault && isDefault !== null && (
          <Button size="sm" variant="secondary" onClick={() => onDefault(!isDefault)}>{isDefault ? t("docs.tpl.unsetDefault") : t("docs.tpl.makeDefault")}</Button>
        )}
        {canEdit && onUnset && <Button size="sm" variant="secondary" onClick={onUnset}>{t("docs.tpl.unset")}</Button>}
      </span>
    </div>
  );
}
