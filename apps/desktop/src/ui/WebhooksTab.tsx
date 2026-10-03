import { Copy, Pencil, Power, Trash2, Webhook } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { WebhookOut } from "../api/types";
import type { AppController } from "../state/app";
import { fullTimestamp } from "./format";
import { Badge, Button, cn, Field, Input, Modal } from "./primitives";

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

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      controller.setNotice("Webhook の URL をコピーしました");
    } catch (error) {
      controller.setError(error);
    }
  };

  const channelName = (id: string) => {
    const channel = store.channels.get(id);
    return channel ? `${channel.type === "private" ? "🔒" : "#"}${channel.name}` : "(見えないチャンネル)";
  };

  return (
    <div className="mt-4 space-y-3">
      {issued && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft/50 p-3 text-sm">
          <div className="font-medium">{issued.name} の URL</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-canvas px-2 py-1 font-mono text-xs" title={issued.url}>{issued.url}</code>
            <Button size="sm" variant="secondary" onClick={() => void copy(issued.url)}>
              <Copy size={14} /> コピー
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>閉じる</Button>
          </div>
          <div className="mt-1 text-xs text-muted">
            この URL に <code className="font-mono">{"{\"text\": \"…\"}"}</code> を POST すると投稿されます (Slack の Incoming Webhook と同じ形)。この表示を閉じると再表示できません。
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">CI や監視ツールからチャンネルへ投稿する URL です。{rows && rows.length > 0 && ` ${rows.length} 件`}</span>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Webhook size={14} /> Webhook を作成
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
                  <Badge tone={row.enabled ? "accent" : "neutral"}>{row.enabled ? "有効" : "停止中"}</Badge>
                  <span className="text-xs text-muted">{channelName(row.channel_id)}</span>
                </div>
                <div className="truncate text-[11px] text-muted">
                  {row.post_count} 件の投稿{row.last_post_at ? ` · 最終 ${fullTimestamp(row.last_post_at)}` : ""} · 作成 {fullTimestamp(row.created_at)}
                </div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(row)}>
                <Pencil size={14} /> 編集
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} title={row.enabled ? "停止 (URL を無効にする)" : "再開"} onClick={() => void run(async () => { await controller.api!.adminUpdateWebhook(row.id, { enabled: !row.enabled }); })}>
                <Power size={14} /> {row.enabled ? "停止" : "再開"}
              </Button>
              <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setDeleting(row)}>
                <Trash2 size={14} /> 削除
              </Button>
            </li>
          ))}
          {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Webhook はまだありません</li>}
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
        <Modal onClose={() => setDeleting(null)} title={`${deleting.name} を削除しますか？`} className="w-[420px]">
          <p className="mt-3 text-sm text-muted">URL は使えなくなり、bot ユーザーは無効になります。これまでの投稿はそのまま残ります。</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => { const target = deleting; void run(async () => { await controller.api!.adminDeleteWebhook(target.id); }).then((ok) => { if (ok) setDeleting(null); }); }}>
              削除する
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
    <Modal onClose={onClose} title={row ? `${row.name} を編集` : "Webhook を作成"} className="w-[460px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Field label="名前 (投稿者として表示されます)">
          <Input value={name} maxLength={80} required autoFocus placeholder="例: GitHub Actions" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="投稿先チャンネル">
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm" required>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>キャンセル</Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim() || !channelId}>{row ? "保存" : "作成して URL を発行"}</Button>
        </div>
      </form>
    </Modal>
  );
}
