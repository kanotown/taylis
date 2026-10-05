/**
 * M44 (CANVAS.md §4.12): the administrators' canvas templates, a tab of 「管理」. Every template (hidden ones too) in the
 * order the new-canvas picker shows them: add, edit (name, description, title, body), reorder, hide or show. The five
 * built-in ones can be hidden but not deleted (the server says template_builtin); added ones can be deleted. Placeholders
 * are filled by the server when a canvas is made from the template.
 */
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { CanvasTemplateOut } from "../api/types";
import type { AppController } from "../state/app";
import { Badge, Button, Field, IconButton, Input, Modal } from "./primitives";
import { t } from "../i18n";

type Draft = { id: string | null; name: string; description: string; title: string; body: string };


export function CanvasTemplatesTab({ controller }: { controller: AppController }) {
  const [rows, setRows] = useState<CanvasTemplateOut[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<CanvasTemplateOut | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: (api: NonNullable<AppController["api"]>) => Promise<unknown>): Promise<boolean> => {
    const api = controller.api;
    if (!api) return false;
    setBusy(true);
    try {
      await work(api);
      setRows(sorted(await api.adminCanvasTemplates()));
      return true;
    } catch (error) {
      controller.setError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(async () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.api]);

  const move = (index: number, by: -1 | 1) => {
    if (!rows) return;
    const order = [...rows];
    const [row] = order.splice(index, 1);
    if (!row) return;
    order.splice(index + by, 0, row);
    void run(async (api) => {
      for (const [position, template] of order.entries()) {
        if (template.position !== position) await api.adminUpdateCanvasTemplate(template.id, { position });
      }
    });
  };

  const save = async () => {
    if (!draft) return;
    const fields = { name: draft.name.trim(), description: draft.description.trim() || null, title: draft.title.trim(), body: draft.body };
    const ok = await run((api) => (draft.id ? api.adminUpdateCanvasTemplate(draft.id, { ...fields, description: fields.description ?? "" }) : api.adminCreateCanvasTemplate(fields)));
    if (ok) setDraft(null);
  };

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-sm text-muted">{t("canvasTemplates.intro")}</p>
        <Button size="sm" onClick={() => setDraft({ id: null, name: "", description: "", title: "", body: "" })}><Plus size={14} /> {t("common.add")}</Button>
      </div>
      {rows === null ? (
        <div className="py-6 text-center text-sm text-muted">{t("common.loading")}</div>
      ) : (
        <ul aria-label={t("canvasTemplates.list")} className="divide-y divide-line rounded-xl border border-line">
          {rows.map((template, index) => (
            <li key={template.id} data-template={template.key} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={template.hidden ? "truncate text-sm font-medium text-muted line-through" : "truncate text-sm font-medium"}>{template.name}</span>
                  {template.builtin && <Badge>{t("canvasTemplates.builtin")}</Badge>}
                  {template.hidden && <Badge tone="danger">{t("canvasTemplates.hidden")}</Badge>}
                </div>
                <div className="truncate text-xs text-muted">{template.description || template.title}</div>
              </div>
              <IconButton label={t("common.moveUp")} disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></IconButton>
              <IconButton label={t("common.moveDown")} disabled={busy || index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></IconButton>
              <IconButton label={template.hidden ? t("canvasTemplates.show") : t("canvasTemplates.hide")} disabled={busy} onClick={() => void run((api) => api.adminUpdateCanvasTemplate(template.id, { hidden: !template.hidden }))}>
                {template.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
              </IconButton>
              <IconButton label={t("canvas.edit")} disabled={busy} onClick={() => setDraft({ id: template.id, name: template.name, description: template.description ?? "", title: template.title, body: template.body })}><Pencil size={15} /></IconButton>
              {!template.builtin && (
                <IconButton label={t("common.delete")} className="text-danger" disabled={busy} onClick={() => setDeleting(template)}><Trash2 size={15} /></IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {draft && (
        <Modal title={draft.id ? t("canvasTemplates.edit") : t("canvasTemplates.add")} description={t("canvasTemplates.placeholders")} onClose={() => setDraft(null)} className="w-[640px]">
          <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <Field label={t("reservations.name")}>
              <Input value={draft.name} maxLength={80} autoFocus placeholder={t("canvasTemplates.namePlaceholder")} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t("canvasTemplates.descriptionOptional")}>
              <Input value={draft.description} maxLength={200} placeholder={t("canvasTemplates.descriptionPlaceholder")} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <Field label={t("canvasTemplates.canvasTitle")}>
              <Input value={draft.title} maxLength={200} placeholder={t("canvasTemplates.titlePlaceholder")} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <Field label={t("canvasTemplates.body")}>
              <textarea
                aria-label={t("canvasTemplates.body")}
                value={draft.body}
                rows={10}
                className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-sm leading-6 outline-none focus:border-accent"
                placeholder={t("canvasTemplates.bodyPlaceholder")}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={busy || !draft.name.trim() || !draft.title.trim()}>{draft.id ? t("common.save") : t("common.add")}</Button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title={t("canvasTemplates.deleteTitle", { name: deleting.name })} description={t("canvasTemplates.deleteNote")} onClose={() => setDeleting(null)}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void run((api) => api.adminDeleteCanvasTemplate(deleting.id)).then((ok) => { if (ok) setDeleting(null); })}>{t("common.deleteConfirm")}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function sorted(rows: CanvasTemplateOut[]): CanvasTemplateOut[] {
  return [...rows].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, "ja"));
}
