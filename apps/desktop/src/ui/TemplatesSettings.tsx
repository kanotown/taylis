import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { TemplateOut } from "../api/types";
import type { AppController } from "../state/app";
import { Badge, Button, Field, IconButton, Input, Modal, Textarea } from "./primitives";
import { orderTemplates, templateSummary } from "./templates";
import { t } from "../i18n";

type Scope = TemplateOut["scope"];

/**
 * Settings → テンプレート (M30, DATA_MODEL.md message_templates): my own templates, and the workspace's (edited by an
 * administrator, read-only for everyone else). Inserted from the composer's 「テンプレート」 button or `/name`.
 */
export function TemplatesSettings({ controller }: { controller: AppController }) {
  const all = orderTemplates(controller.store.templates.values());
  const mine = all.filter((t) => t.scope === "user");
  const shared = all.filter((t) => t.scope === "workspace");
  const admin = controller.can("templates.manage"); // M142: administrators and managers
  const [editing, setEditing] = useState<{ scope: Scope; template: TemplateOut | null } | null>(null);
  const [deleting, setDeleting] = useState<TemplateOut | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<boolean>) => {
    setBusy(true);
    try {
      return await work();
    } finally {
      setBusy(false);
    }
  };

  const list = (rows: TemplateOut[], scope: Scope, editable: boolean) => (
    <ul className="divide-y divide-line rounded-xl border border-line" aria-label={scope === "user" ? t("templates.mine") : t("templates.shared")}>
      {rows.map((template, index) => (
        <li key={template.id} className="flex items-center gap-2 px-3 py-2 text-sm">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">/{template.name}</span>
              {template.suggest_in === "times" && <Badge tone="accent">{t("templates.timesFirst")}</Badge>}
            </div>
            <div className="truncate text-[11px] text-muted">{templateSummary(template.body)}</div>
          </div>
          {editable && (
            <div className="flex shrink-0 items-center">
              <IconButton label={t("settings.navItems.up", { item: template.name })} className="h-7 w-7 text-muted hover:text-ink" disabled={busy || index === 0} onClick={() => void run(() => controller.moveTemplate(rows, template.id, -1))}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton label={t("settings.navItems.down", { item: template.name })} className="h-7 w-7 text-muted hover:text-ink" disabled={busy || index === rows.length - 1} onClick={() => void run(() => controller.moveTemplate(rows, template.id, 1))}>
                <ArrowDown size={14} />
              </IconButton>
              <IconButton label={t("aiAdmin.editTitle", { name: template.name })} className="h-7 w-7 text-muted hover:text-ink" disabled={busy} onClick={() => setEditing({ scope, template })}>
                <Pencil size={14} />
              </IconButton>
              <IconButton label={t("templates.deleteName", { name: template.name })} className="h-7 w-7 text-danger" disabled={busy} onClick={() => setDeleting(template)}>
                <Trash2 size={14} />
              </IconButton>
            </div>
          )}
        </li>
      ))}
      {rows.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">{t("rollover.none")}</li>}
    </ul>
  );

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t("composer.templates")}</h3>
      <p className="text-xs text-muted">
        {t("templates.intro")}
      </p>
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs font-medium text-muted">{t("templates.mine")}</span>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing({ scope: "user", template: null })}>
          <Plus size={14} /> {t("common.add")}
        </Button>
      </div>
      {list(mine, "user", true)}
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs font-medium text-muted">{t("templates.shared")}{admin ? "" : t("templates.adminEdits")}</span>
        {admin && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing({ scope: "workspace", template: null })}>
            <Plus size={14} /> {t("common.add")}
          </Button>
        )}
      </div>
      {list(shared, "workspace", admin)}
      {editing && (
        <TemplateEditor
          scope={editing.scope}
          template={editing.template}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(form) =>
            void run(async () => {
              const saved = editing.template
                ? await controller.updateTemplate(editing.template.id, form)
                : await controller.createTemplate({ ...form, scope: editing.scope });
              return saved !== null;
            }).then((ok) => { if (ok) setEditing(null); })
          }
        />
      )}
      {deleting && (
        <Modal onClose={() => setDeleting(null)} title={t("templates.deleteTitle", { name: deleting.name })} className="w-[420px]">
          <p className="mt-3 text-sm text-muted">
            {deleting.scope === "workspace" ? t("templates.deleteShared") : t("templates.deleteMine")}{t("templates.deleteNote")}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const target = deleting;
                void run(() => controller.deleteTemplate(target.id)).then((ok) => { if (ok) setDeleting(null); });
              }}
            >
              {t("common.deleteConfirm")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TemplateEditor({ scope, template, busy, onClose, onSave }: {
  scope: Scope;
  template: TemplateOut | null;
  busy: boolean;
  onClose: () => void;
  onSave: (form: { name: string; body: string; suggest_in: TemplateOut["suggest_in"] }) => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [times, setTimes] = useState(template?.suggest_in === "times");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ name: name.trim(), body, suggest_in: times ? "times" : "any" });
  };

  const title = template ? t("templates.editTitle", { name: template.name }) : scope === "workspace" ? t("templates.addShared") : t("canvasTemplates.add");
  return (
    <Modal onClose={onClose} title={title} className="w-[520px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Field label={t("templates.nameLabel")}>
          <Input value={name} maxLength={20} required autoFocus placeholder={t("templates.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("templates.bodyLabel")}>
          <Textarea value={body} maxLength={4000} rows={8} required placeholder={t("templates.bodyPlaceholder")} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={times} onChange={(e) => setTimes(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          {t("templates.timesFirst")}
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim() || !body.trim()}>{template ? t("common.save") : t("common.add")}</Button>
        </div>
      </form>
    </Modal>
  );
}
