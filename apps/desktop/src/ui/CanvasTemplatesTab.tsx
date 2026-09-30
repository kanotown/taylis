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

type Draft = { id: string | null; name: string; description: string; title: string; body: string };

const PLACEHOLDERS = "{{date}} 日付 (2026-10-01 (木))、{{week}} 週 (第40週)、{{me_name}} 作った人の名前、{{me}} 作った人 (本文ではメンション)、{{channel}} 会話の名前";

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
        <p className="flex-1 text-sm text-muted">「新しいキャンバス」で選べるテンプレートです。組み込みのテンプレートは削除できませんが、非表示にできます。</p>
        <Button size="sm" onClick={() => setDraft({ id: null, name: "", description: "", title: "", body: "" })}><Plus size={14} /> 追加</Button>
      </div>
      {rows === null ? (
        <div className="py-6 text-center text-sm text-muted">読み込み中…</div>
      ) : (
        <ul aria-label="キャンバスのテンプレート" className="divide-y divide-line rounded-xl border border-line">
          {rows.map((template, index) => (
            <li key={template.id} data-template={template.key} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={template.hidden ? "truncate text-sm font-medium text-muted line-through" : "truncate text-sm font-medium"}>{template.name}</span>
                  {template.builtin && <Badge>組み込み</Badge>}
                  {template.hidden && <Badge tone="danger">非表示</Badge>}
                </div>
                <div className="truncate text-xs text-muted">{template.description || template.title}</div>
              </div>
              <IconButton label="上へ" disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></IconButton>
              <IconButton label="下へ" disabled={busy || index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></IconButton>
              <IconButton label={template.hidden ? "表示する" : "非表示にする"} disabled={busy} onClick={() => void run((api) => api.adminUpdateCanvasTemplate(template.id, { hidden: !template.hidden }))}>
                {template.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
              </IconButton>
              <IconButton label="編集" disabled={busy} onClick={() => setDraft({ id: template.id, name: template.name, description: template.description ?? "", title: template.title, body: template.body })}><Pencil size={15} /></IconButton>
              {!template.builtin && (
                <IconButton label="削除" className="text-danger" disabled={busy} onClick={() => setDeleting(template)}><Trash2 size={15} /></IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {draft && (
        <Modal title={draft.id ? "テンプレートを編集" : "テンプレートを追加"} description={`作成時にサーバが置き換えます: ${PLACEHOLDERS}`} onClose={() => setDraft(null)} className="w-[640px]">
          <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <Field label="名前">
              <Input value={draft.name} maxLength={80} autoFocus placeholder="ゼミ発表" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="説明 (任意)">
              <Input value={draft.description} maxLength={200} placeholder="発表者・資料・質疑のメモ" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <Field label="キャンバスの題名">
              <Input value={draft.title} maxLength={200} placeholder="ゼミ発表 {{date}}" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <Field label="本文 (Markdown)">
              <textarea
                aria-label="本文 (Markdown)"
                value={draft.body}
                rows={10}
                className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-sm leading-6 outline-none focus:border-accent"
                placeholder={"# ゼミ発表 {{date}}\n## 発表者\n\n## 質疑\n- [ ] "}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>キャンセル</Button>
              <Button type="submit" disabled={busy || !draft.name.trim() || !draft.title.trim()}>{draft.id ? "保存" : "追加"}</Button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title={`「${deleting.name}」を削除しますか？`} description="このテンプレートから作ったキャンバスはそのまま残ります。" onClose={() => setDeleting(null)}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => void run((api) => api.adminDeleteCanvasTemplate(deleting.id)).then((ok) => { if (ok) setDeleting(null); })}>削除する</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function sorted(rows: CanvasTemplateOut[]): CanvasTemplateOut[] {
  return [...rows].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, "ja"));
}
