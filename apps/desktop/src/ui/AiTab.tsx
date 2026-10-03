import { Bot, Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { AI_CHARACTER_MAX, AI_EFFORTS, AI_MODELS, AI_PROVIDERS, type AiAgentCreate, type AiAgentOut, type AiAgentUpdate, type AiEffort, type AiModel, aiModelLabel, aiProviderLabel, type AiProviderName, aiProviderOf, type AiProviderOut, type AiUsageOut, DEFAULT_AI_MODEL, describeAiError } from "../api/ai";
import type { AppController } from "../state/app";
import { Badge, Button, cn, Field, Input, Modal, Textarea } from "./primitives";
import { USERNAME_HINT } from "./username";


const SELECT = "h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm";

/** "$1.23": costs are small, so two decimals (four below a cent). */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export interface AgentForm {
  name: string;
  username: string;
  character: string;
  model: AiModel;
  effort: AiEffort;
  allow_private: boolean;
  enabled: boolean;
}

export function agentForm(row: AiAgentOut | null): AgentForm {
  return row
    ? { name: row.name, username: row.username, character: row.character, model: row.model, effort: row.effort, allow_private: row.allow_private, enabled: row.enabled }
    : { name: "", username: "", character: "", model: DEFAULT_AI_MODEL, effort: "medium", allow_private: false, enabled: true };
}

/** PATCH sends only what changed (docs/AI.md §5); the username is never sent. */
export function agentPatch(row: AiAgentOut, form: AgentForm): AiAgentUpdate {
  const patch: AiAgentUpdate = {};
  if (form.name.trim() !== row.name) patch.name = form.name.trim();
  if (form.character !== row.character) patch.character = form.character;
  if (form.model !== row.model) patch.model = form.model;
  if (form.effort !== row.effort) patch.effort = form.effort;
  if (form.allow_private !== row.allow_private) patch.allow_private = form.allow_private;
  if (form.enabled !== row.enabled) patch.enabled = form.enabled;
  return patch;
}

/** Administration → AI (M65, docs/AI.md §6): the AI bots and this month's usage. */
export function AiTab({ controller }: { controller: AppController }) {
  const [rows, setRows] = useState<AiAgentOut[] | null>(null);
  const [usage, setUsage] = useState<AiUsageOut | null>(null);
  const [editing, setEditing] = useState<AiAgentOut | "new" | null>(null);
  const [deleting, setDeleting] = useState<AiAgentOut | null>(null);
  const [busy, setBusy] = useState(false);
  // §12: which providers have a key; null when unknown (an older server: no marks at all).
  const [providers, setProviders] = useState<AiProviderOut[] | null>(null);

  const load = async () => {
    const api = controller.api;
    if (!api) return;
    api.adminAiProviders().then(
      (list) => setProviders(Array.isArray(list) && list.length > 0 ? list : null),
      () => setProviders(null),
    );
    try {
      const [agents, month] = await Promise.all([api.adminAiAgents(), api.adminAiUsage()]);
      setRows(agents);
      setUsage(month);
    } catch (error) {
      controller.setError(describeAiError(error));
    }
  };
  useEffect(() => {
    void load();
  }, [controller.api]);

  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await work();
      await load();
      // The bots changed: the menus, the mention list and the rows' badges follow (GET /ai/status).
      void controller.engine?.ai.loadStatus();
      return true;
    } catch (error) {
      controller.setError(describeAiError(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted">メンションに返事をするボットです。要約には、API キーのある最初の有効なボットのモデルを使います。</span>
        <Button size="sm" className="shrink-0" onClick={() => setEditing("new")}>
          <Bot size={14} /> ボットを作成
        </Button>
      </div>
      {rows && (
        <ul aria-label="AI のボット" className="divide-y divide-line rounded-xl border border-line">
          {rows.map((row) => (
            <li key={row.id} className={cn("flex flex-wrap items-center gap-3 px-3 py-2 text-sm", !row.enabled && "opacity-60")}>
              <Bot size={16} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{row.name}</span>
                  <span className="text-xs text-muted">@{row.username}</span>
                  <Badge tone={row.enabled ? "accent" : "neutral"}>{row.enabled ? "有効" : "停止中"}</Badge>
                  {row.allow_private && <Badge>非公開も可</Badge>}
                  {keyMissing(providers, row.model) && <Badge tone="danger">API キー未設定</Badge>}
                </div>
                <div className="truncate text-[11px] text-muted">
                  {aiModelLabel(row.model)} · 考える量 {AI_EFFORTS.find((e) => e.value === row.effort)?.label ?? row.effort}
                </div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(row)}>
                <Pencil size={14} /> 編集
              </Button>
              <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setDeleting(row)}>
                <Trash2 size={14} /> 削除
              </Button>
            </li>
          ))}
          {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">ボットはまだありません</li>}
        </ul>
      )}
      {usage && <UsageSection controller={controller} usage={usage} />}
      {editing && (
        <AgentEditor
          row={editing === "new" ? null : editing}
          busy={busy}
          providers={providers}
          onClose={() => setEditing(null)}
          onSave={(form) =>
            void run(async () => {
              const api = controller.api!;
              if (editing === "new") {
                const body: AiAgentCreate = { username: form.username.trim(), name: form.name.trim(), character: form.character, model: form.model, effort: form.effort, allow_private: form.allow_private, enabled: form.enabled };
                await api.adminCreateAiAgent(body);
              } else {
                const patch = agentPatch(editing, form);
                if (Object.keys(patch).length > 0) await api.adminUpdateAiAgent(editing.id, patch);
              }
            }).then((ok) => { if (ok) setEditing(null); })
          }
        />
      )}
      {deleting && (
        <Modal onClose={() => setDeleting(null)} title={`${deleting.name} を削除しますか？`} className="w-[420px]">
          <p className="mt-3 text-sm text-muted">ボットはすべてのチャンネルから抜けて無効になります。これまでの投稿はそのまま残ります。</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => { const target = deleting; void run(async () => { await controller.api!.adminDeleteAiAgent(target.id); }).then((ok) => { if (ok) setDeleting(null); }); }}>
              削除する
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UsageSection({ controller, usage }: { controller: AppController; usage: AiUsageOut }) {
  const share = usage.budget_usd > 0 ? Math.min(1, usage.total_cost_usd / usage.budget_usd) : 1;
  const users = controller.store.users;
  return (
    <section aria-label="今月の使用量" className="space-y-3 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">今月の使用量 ({usage.month})</h3>
        <span className="text-sm tabular-nums" data-testid="ai-usage-total">
          {formatUsd(usage.total_cost_usd)} / 予算 {formatUsd(usage.budget_usd)} · {usage.total_runs} 回
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-panel-2" role="meter" aria-label="予算の使用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <div className={cn("h-full rounded-full", share >= 1 ? "bg-rose-500" : share >= 0.8 ? "bg-amber-500" : "bg-accent")} style={{ width: `${share * 100}%` }} />
      </div>
      {usage.by_agent.length > 0 && (
        <table className="w-full text-xs" aria-label="ボットごと">
          <thead className="text-muted">
            <tr><th className="py-1 text-left font-medium">ボット</th><th className="text-right font-medium">回数</th><th className="text-right font-medium">入力</th><th className="text-right font-medium">出力</th><th className="text-right font-medium">費用</th></tr>
          </thead>
          <tbody className="tabular-nums">
            {usage.by_agent.map((row) => (
              <tr key={row.agent_id} className="border-t border-line">
                <td className="py-1">{row.name}</td>
                <td className="text-right">{row.runs}</td>
                <td className="text-right">{row.input_tokens.toLocaleString("ja-JP")}</td>
                <td className="text-right">{row.output_tokens.toLocaleString("ja-JP")}</td>
                <td className="text-right">{formatUsd(row.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {usage.by_user.length > 0 && (
        <table className="w-full text-xs" aria-label="人ごと">
          <thead className="text-muted">
            <tr><th className="py-1 text-left font-medium">頼んだ人</th><th className="text-right font-medium">回数</th><th className="text-right font-medium">費用</th></tr>
          </thead>
          <tbody className="tabular-nums">
            {usage.by_user.map((row) => {
              const user = users.get(row.user_id);
              return (
                <tr key={row.user_id} className="border-t border-line">
                  <td className="py-1">{user ? `${user.display_name} (@${user.username})` : "(不明なユーザー)"}</td>
                  <td className="text-right">{row.runs}</td>
                  <td className="text-right">{formatUsd(row.cost_usd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {usage.total_runs === 0 && <p className="text-xs text-muted">今月はまだ使われていません</p>}
    </section>
  );
}

/** Whether the server has the provider's key: true / false, or null when the server does not say (§12). */
export function providerConfigured(providers: AiProviderOut[] | null, name: AiProviderName): boolean | null {
  return providers?.find((p) => p.name === name)?.configured ?? null;
}

/** True only when the server said the model's provider has no key. */
export function keyMissing(providers: AiProviderOut[] | null, model: string): boolean {
  return providerConfigured(providers, aiProviderOf(model)) === false;
}

function AgentEditor({ row, busy, providers, onClose, onSave }: { row: AiAgentOut | null; busy: boolean; providers: AiProviderOut[] | null; onClose: () => void; onSave: (form: AgentForm) => void }) {
  const [form, setForm] = useState<AgentForm>(() => agentForm(row));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(form);
  };
  const tooLong = form.character.length > AI_CHARACTER_MAX;
  return (
    <Modal onClose={onClose} title={row ? `${row.name} を編集` : "AI のボットを作成"} className="w-[560px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field label="名前 (投稿者として表示されます)">
            <Input value={form.name} maxLength={80} required autoFocus placeholder="例: ちくわ" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          {row ? (
            <Field label="ユーザー名" hint="管理 →「ユーザー」の「ユーザー名を変更」で変えられます">
              <Input value={`@${row.username}`} disabled readOnly />
            </Field>
          ) : (
            <Field label="ユーザー名 (3〜32 文字、a-z 0-9 . _ -)" hint={USERNAME_HINT}>
              <Input value={form.username} pattern="[a-z0-9._-]{3,32}" required placeholder="例: ai-chikuwa" onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} />
            </Field>
          )}
        </div>
        <Field label="性格 (口調・役割。システムプロンプトに入ります)" hint={`${form.character.length} / ${AI_CHARACTER_MAX} 字`}>
          <Textarea value={form.character} rows={6} className={cn(tooLong && "border-danger")} placeholder="例: 研究室の先輩。やさしく、短く答える。わからないことはわからないと言う。" onChange={(e) => setForm({ ...form, character: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field label="モデル" hint={keyMissing(providers, form.model) ? `サーバーに ${aiProviderLabel(aiProviderOf(form.model))} の API キーが設定されていません (このボットは応答できません)` : undefined}>
            <select value={form.model} className={SELECT} onChange={(e) => setForm({ ...form, model: e.target.value as AiModel })}>
              {AI_PROVIDERS.map((p) => (
                <optgroup key={p.value} label={`${p.label}${providerConfigured(providers, p.value) === false ? " (キー未設定)" : ""}`}>
                  {AI_MODELS.filter((m) => m.provider === p.value).map((m) => (
                    <option key={m.value} value={m.value}>{m.label}{m.value === DEFAULT_AI_MODEL ? " (既定)" : ""}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="考える量">
            <select value={form.effort} className={SELECT} onChange={(e) => setForm({ ...form, effort: e.target.value as AiEffort })}>
              {AI_EFFORTS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={form.allow_private} onChange={(e) => setForm({ ...form, allow_private: e.target.checked })} />
          <span>
            非公開チャンネルと DM を許す
            <span className="block text-xs text-muted">オフのときは公開チャンネルにだけ入れられます</span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          有効
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>キャンセル</Button>
          <Button type="submit" size="sm" disabled={busy || !form.name.trim() || tooLong || (!row && !form.username.trim())}>{row ? "保存" : "作成"}</Button>
        </div>
      </form>
    </Modal>
  );
}
