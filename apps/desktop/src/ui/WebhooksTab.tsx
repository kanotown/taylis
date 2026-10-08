import { Copy, Pencil, Power, Trash2, Webhook } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { WebhookOut } from "../api/types";
import type { AppController } from "../state/app";
import { fullTimestamp } from "./format";
import { Badge, Button, cn, Field, Input, Modal } from "./primitives";
import { t } from "../i18n";
import { tRich } from "../i18n/rich";

/** The URL a tool posts to: `POST <server>/api/v1/hooks/<token>` with `{"text": "..."}`. */
export function webhookUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1/hooks/${token}`;
}

/** Administration → Webhook (M13a): incoming webhooks that post as their own bot user. */
export function WebhooksTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const channels = [...store.channels.values()]
    .filter((c) => !c.archived && (c.type === "public" || c.type === "private") && c.isMember)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const [rows, setRows] = useState<WebhookOut[] | null>(null);
  const [editing, setEditing] = useState<WebhookOut | "new" | null>(null);
  const [issued, setIssued] = useState<{ url: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<WebhookOut | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!controller.api) return;
    try {
      setRows(await controller.api.adminListWebhooks());
    } catch (error) {
      controller.setError(error);
    }
  };
  useEffect(() => {
    void load();
  }, [controller.api]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      await load();
      return true;
    } catch (error) {
      controller.setError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const copy = (url: string) => controller.copyToClipboard(url, t("webhooks.copied"));

  const channelName = (id: string) => {
    const channel = store.channels.get(id);
    return channel ? `${channel.type === "private" ? "🔒" : "#"}${channel.name}` : t("webhooks.hiddenChannel");
  };

  return (
    <div className="mt-4 space-y-3">
      {issued && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft/50 p-3 text-sm">
          <div className="font-medium">{t("webhooks.urlOf", { name: issued.name })}</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-canvas px-2 py-1 font-mono text-xs" title={issued.url}>{issued.url}</code>
            <Button size="sm" variant="secondary" onClick={() => void copy(issued.url)}>
              <Copy size={14} /> {t("common.copy")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>{t("common.close")}</Button>
          </div>
          <div className="mt-1 text-xs text-muted">
            {tRich("webhooks.issuedNote", { code: (s) => <code className="font-mono">{s}</code> })}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{t("webhooks.intro")}{rows && rows.length > 0 && ` ${t("common.count", { count: rows.length })}`}</span>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Webhook size={14} /> {t("webhooks.create")}
        </Button>
      </div>
      {rows && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rows.map((row) => (
            <li key={row.id} className={cn("flex items-center gap-3 px-3 py-2 text-sm", !row.enabled && "opacity-60")}>
              <Webhook size={16} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{row.name}</span>
                  <Badge tone={row.enabled ? "accent" : "neutral"}>{row.enabled ? t("admin.users.filter.active") : t("workflow.paused")}</Badge>
                  <span className="text-xs text-muted">{channelName(row.channel_id)}</span>
                </div>
                <div className="truncate text-[11px] text-muted">
                  {t("webhooks.posts", { count: row.post_count })}{row.last_post_at ? t("webhooks.last", { at: fullTimestamp(row.last_post_at) }) : ""} · {t("admin.users.createdAt", { at: fullTimestamp(row.created_at) })}
                </div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(row)}>
                <Pencil size={14} /> {t("canvas.edit")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} title={row.enabled ? t("webhooks.stopTitle") : t("settings.pause.resume")} onClick={() => void run(async () => { await controller.api!.adminUpdateWebhook(row.id, { enabled: !row.enabled }); })}>
                <Power size={14} /> {row.enabled ? t("webhooks.stop") : t("settings.pause.resume")}
              </Button>
              <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setDeleting(row)}>
                <Trash2 size={14} /> {t("common.delete")}
              </Button>
            </li>
          ))}
          {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("webhooks.none")}</li>}
        </ul>
      )}
      {editing && (
        <WebhookEditor
          row={editing === "new" ? null : editing}
          channels={channels.map((c) => ({ id: c.id, label: `${c.type === "private" ? "🔒" : "#"}${c.name}` }))}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(form) =>
            void run(async () => {
              const api = controller.api!;
              if (editing === "new") {
                const created = await api.adminCreateWebhook({ name: form.name, channel_id: form.channelId });
                setIssued({ url: webhookUrl(api.baseUrl, created.token), name: created.webhook.name });
              } else {
                await api.adminUpdateWebhook(editing.id, { name: form.name, channel_id: form.channelId });
              }
            }).then((ok) => { if (ok) setEditing(null); })
          }
        />
      )}
      {deleting && (
        <Modal onClose={() => setDeleting(null)} title={t("aiAdmin.deleteTitle", { name: deleting.name })} className="w-[420px]">
          <p className="mt-3 text-sm text-muted">{t("webhooks.deleteNote")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => { const target = deleting; void run(async () => { await controller.api!.adminDeleteWebhook(target.id); }).then((ok) => { if (ok) setDeleting(null); }); }}>
              {t("common.deleteConfirm")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function WebhookEditor({ row, channels, busy, onClose, onSave }: {
  row: WebhookOut | null;
  channels: Array<{ id: string; label: string }>;
  busy: boolean;
  onClose: () => void;
  onSave: (form: { name: string; channelId: string }) => void;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [channelId, setChannelId] = useState(row?.channel_id ?? channels[0]?.id ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!channelId) return;
    onSave({ name: name.trim(), channelId });
  };
  return (
    <Modal onClose={onClose} title={row ? t("aiAdmin.editTitle", { name: row.name }) : t("webhooks.create")} className="w-[460px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Field label={t("aiAdmin.nameLabel")}>
          <Input value={name} maxLength={80} required autoFocus placeholder={t("webhooks.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("webhooks.channel")}>
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm" required>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim() || !channelId}>{row ? t("common.save") : t("webhooks.createAndIssue")}</Button>
        </div>
      </form>
    </Modal>
  );
}
