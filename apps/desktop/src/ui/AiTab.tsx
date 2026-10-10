import { Bot, ImageUp, Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { AI_CHARACTER_MAX, AI_EFFORTS, AI_MODELS, AI_PROVIDERS, type AiAgentCreate, type AiAgentOut, type AiAgentUpdate, type AiEffort, type AiModel, aiModelLabel, aiProviderLabel, type AiProviderName, aiProviderOf, type AiProviderOut, type AiUsageOut, defaultModelFor, describeAiError } from "../api/ai";
import { forEachPicked, refusePicked, takePicked } from "../platform/pickedFiles";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { Badge, Button, cn, Field, Input, Modal, Textarea } from "./primitives";
import { usernameHint } from "./username";
import { intlLocale, t } from "../i18n";


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
  /** docs/AI.md §14. */
  web_search: boolean;
  is_default: boolean;
}

/** The form for a bot, or a new one (its model: GPT-6.1 Sol when the server has the OpenAI key, else Opus 5.5; §14). */
export function agentForm(row: AiAgentOut | null, providers: AiProviderOut[] | null = null): AgentForm {
  return row
    ? { name: row.name, username: row.username, character: row.character, model: row.model, effort: row.effort, allow_private: row.allow_private, enabled: row.enabled, web_search: row.web_search ?? false, is_default: row.is_default ?? false }
    : { name: "", username: "", character: "", model: defaultModelFor(providers), effort: "medium", allow_private: false, enabled: true, web_search: false, is_default: false };
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
  if (form.web_search !== (row.web_search ?? false)) patch.web_search = form.web_search;
  if (form.is_default !== (row.is_default ?? false)) patch.is_default = form.is_default;
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
        <span className="text-sm text-muted">{t("aiAdmin.intro")}</span>
        <Button size="sm" className="shrink-0" onClick={() => setEditing("new")}>
          <Bot size={14} /> {t("aiAdmin.create")}
        </Button>
      </div>
      {rows && (
        <ul aria-label={t("aiAdmin.bots")} className="divide-y divide-line rounded-xl border border-line">
          {rows.map((row) => (
            <li key={row.id} className={cn("flex flex-wrap items-center gap-3 px-3 py-2 text-sm", !row.enabled && "opacity-60")}>
              <Avatar id={row.bot_user_id} name={row.name} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{row.name}</span>
                  <span className="text-xs text-muted">@{row.username}</span>
                  <Badge tone={row.enabled ? "accent" : "neutral"}>{row.enabled ? t("admin.users.filter.active") : t("workflow.paused")}</Badge>
                  {row.is_default && <Badge tone="accent">{t("aiAdmin.defaultBadge")}</Badge>}
                  {row.allow_private && <Badge>{t("aiAdmin.privateOk")}</Badge>}
                  {row.web_search && <Badge>{t("aiAdmin.webSearchBadge")}</Badge>}
                  {keyMissing(providers, row.model) && <Badge tone="danger">{t("aiAdmin.noKey")}</Badge>}
                </div>
                <div className="truncate text-[11px] text-muted">
                  {aiModelLabel(row.model)} · {t("aiAdmin.effort")} {AI_EFFORTS.find((e) => e.value === row.effort)?.label ?? row.effort}
                </div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(row)}>
                <Pencil size={14} /> {t("canvas.edit")}
              </Button>
              <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setDeleting(row)}>
                <Trash2 size={14} /> {t("common.delete")}
              </Button>
            </li>
          ))}
          {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("aiAdmin.none")}</li>}
        </ul>
      )}
      {usage && <UsageSection controller={controller} usage={usage} />}
      {editing && (
        <AgentEditor
          key={editing === "new" ? "new" : editing.id}
          controller={controller}
          row={editing === "new" ? null : editing}
          busy={busy}
          providers={providers}
          onPicture={(row) => {
            // The picture is saved at once (its own route); the list and the open form follow.
            setRows((list) => list?.map((r) => (r.id === row.id ? row : r)) ?? list);
            setEditing((open) => (open && open !== "new" && open.id === row.id ? row : open));
          }}
          onClose={() => setEditing(null)}
          onSave={(form) =>
            void run(async () => {
              const api = controller.api!;
              if (editing === "new") {
                const body: AiAgentCreate = { username: form.username.trim(), name: form.name.trim(), character: form.character, model: form.model, effort: form.effort, allow_private: form.allow_private, enabled: form.enabled, web_search: form.web_search, is_default: form.is_default };
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
        <Modal onClose={() => setDeleting(null)} title={t("aiAdmin.deleteTitle", { name: deleting.name })} className="w-[420px]">
          <p className="mt-3 text-sm text-muted">{t("aiAdmin.deleteNote")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => { const target = deleting; void run(async () => { await controller.api!.adminDeleteAiAgent(target.id); }).then((ok) => { if (ok) setDeleting(null); }); }}>
              {t("common.deleteConfirm")}
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
  // §14: the searches column only once a bot has searched this month.
  const searches = usage.by_agent.some((row) => (row.web_search_requests ?? 0) > 0);
  return (
    <section aria-label={t("aiAdmin.usage")} className="space-y-3 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("aiAdmin.usageMonth", { month: usage.month })}</h3>
        <span className="text-sm tabular-nums" data-testid="ai-usage-total">
          {t("aiAdmin.usageLine", { cost: formatUsd(usage.total_cost_usd), budget: formatUsd(usage.budget_usd), runs: usage.total_runs })}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-panel-2" role="meter" aria-label={t("aiAdmin.budgetUse")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <div className={cn("h-full rounded-full", share >= 1 ? "bg-rose-500" : share >= 0.8 ? "bg-amber-500" : "bg-accent")} style={{ width: `${share * 100}%` }} />
      </div>
      {usage.by_agent.length > 0 && (
        <table className="w-full text-xs" aria-label={t("aiAdmin.byBot")}>
          <thead className="text-muted">
            <tr><th className="py-1 text-left font-medium">{t("aiAdmin.bot")}</th><th className="text-right font-medium">{t("aiAdmin.runs")}</th><th className="text-right font-medium">{t("aiAdmin.input")}</th><th className="text-right font-medium">{t("aiAdmin.output")}</th>{searches && <th className="text-right font-medium">{t("aiAdmin.searches")}</th>}<th className="text-right font-medium">{t("aiAdmin.cost")}</th></tr>
          </thead>
          <tbody className="tabular-nums">
            {usage.by_agent.map((row) => (
              <tr key={row.agent_id} className="border-t border-line">
                <td className="py-1">{row.name}</td>
                <td className="text-right">{row.runs}</td>
                <td className="text-right">{row.input_tokens.toLocaleString(intlLocale())}</td>
                <td className="text-right">{row.output_tokens.toLocaleString(intlLocale())}</td>
                {searches && <td className="text-right">{(row.web_search_requests ?? 0).toLocaleString(intlLocale())}</td>}
                <td className="text-right">{formatUsd(row.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {usage.by_user.length > 0 && (
        <table className="w-full text-xs" aria-label={t("aiAdmin.byPerson")}>
          <thead className="text-muted">
            <tr><th className="py-1 text-left font-medium">{t("aiAdmin.requester")}</th><th className="text-right font-medium">{t("aiAdmin.runs")}</th><th className="text-right font-medium">{t("aiAdmin.cost")}</th></tr>
          </thead>
          <tbody className="tabular-nums">
            {usage.by_user.map((row) => {
              const user = users.get(row.user_id);
              return (
                <tr key={row.user_id} className="border-t border-line">
                  <td className="py-1">{user ? `${user.display_name} (@${user.username})` : t("aiAdmin.unknownUser")}</td>
                  <td className="text-right">{row.runs}</td>
                  <td className="text-right">{formatUsd(row.cost_usd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {usage.total_runs === 0 && <p className="text-xs text-muted">{t("aiAdmin.unused")}</p>}
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

/** The picture types the server takes for a bot (as for a person, M14a), and the size the picker refuses past. */
export const AGENT_PICTURE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const AGENT_PICTURE_MAX_BYTES = 5 * 1024 * 1024;

/** docs/AI.md §14: the bot's picture, saved at once through its own route (upload, or back to the initial). */
function AgentPicture({ controller, row, onSaved }: { controller: AppController; row: AiAgentOut; onSaved: (row: AiAgentOut) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const apply = async (call: () => Promise<AiAgentOut>) => {
    setBusy(true);
    try {
      const saved = await call();
      // This device draws it at once (the others follow user.updated).
      const bot = controller.store.users.get(row.bot_user_id);
      if (bot) controller.store.upsertUser({ ...bot, avatar_updated_at: saved.avatar_updated_at ?? null });
      onSaved(saved);
    } catch (error) {
      controller.setError(describeAiError(error));
    } finally {
      setBusy(false);
    }
  };
  const has = !!row.avatar_updated_at;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line p-2" data-testid="ai-agent-picture">
      <Avatar id={row.bot_user_id} name={row.name} size={40} />
      <span className="min-w-0 flex-1 text-sm">
        {t("aiAdmin.picture")}
        <span className="block text-xs text-muted">{t("aiAdmin.pictureNote")}</span>
      </span>
      <input
        ref={input}
        type="file"
        accept={AGENT_PICTURE_ACCEPT}
        aria-label={t("aiAdmin.pickPicture")}
        className="hidden"
        onChange={(event) => {
          const picked = takePicked(event.target);
          const refusal = refusePicked(picked.files, { maxFiles: 1, maxBytes: AGENT_PICTURE_MAX_BYTES, tooMany: t("workspace.oneImage") });
          if (refusal) { picked.release(); controller.setError(refusal); return; }
          void forEachPicked(picked.files, async (file) => apply(() => controller.api!.adminUploadAiAgentAvatar(row.id, file, file.name)), picked.release, (error) => controller.setError(error));
        }}
      />
      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
        <ImageUp size={14} /> {has ? t("aiAdmin.changePicture") : t("aiAdmin.pickPicture")}
      </Button>
      {has && (
        <Button type="button" size="sm" variant="ghost" className="text-danger" disabled={busy} aria-label={t("aiAdmin.removePicture")} onClick={() => void apply(() => controller.api!.adminDeleteAiAgentAvatar(row.id))}>
          <Trash2 size={14} />
        </Button>
      )}
    </div>
  );
}

function AgentEditor({ controller, row, busy, providers, onPicture, onClose, onSave }: { controller: AppController; row: AiAgentOut | null; busy: boolean; providers: AiProviderOut[] | null; onPicture: (row: AiAgentOut) => void; onClose: () => void; onSave: (form: AgentForm) => void }) {
  const [form, setForm] = useState<AgentForm>(() => agentForm(row, providers));
  const defaultModel = defaultModelFor(providers);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(form);
  };
  const tooLong = form.character.length > AI_CHARACTER_MAX;
  return (
    <Modal onClose={onClose} title={row ? t("aiAdmin.editTitle", { name: row.name }) : t("aiAdmin.createTitle")} className="w-[560px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        {row ? <AgentPicture controller={controller} row={row} onSaved={onPicture} /> : <p className="text-xs text-muted">{t("aiAdmin.pictureLater")}</p>}
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field label={t("aiAdmin.nameLabel")}>
            <Input value={form.name} maxLength={80} required autoFocus placeholder={t("aiAdmin.namePlaceholder")} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          {row ? (
            <Field label={t("admin.users.sort.username")} hint={t("aiAdmin.usernameHint")}>
              <Input value={`@${row.username}`} disabled readOnly />
            </Field>
          ) : (
            <Field label={t("admin.users.usernameLabel")} hint={usernameHint()}>
              <Input value={form.username} pattern="[a-z0-9._-]{3,32}" required placeholder={t("aiAdmin.usernamePlaceholder")} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} />
            </Field>
          )}
        </div>
        <Field label={t("aiAdmin.character")} hint={t("aiAdmin.characterCount", { count: form.character.length, max: AI_CHARACTER_MAX })}>
          <Textarea value={form.character} rows={6} className={cn(tooLong && "border-danger")} placeholder={t("aiAdmin.characterPlaceholder")} onChange={(e) => setForm({ ...form, character: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field label={t("aiAdmin.model")} hint={keyMissing(providers, form.model) ? t("aiAdmin.modelNoKey", { provider: aiProviderLabel(aiProviderOf(form.model)) }) : undefined}>
            <select value={form.model} className={SELECT} onChange={(e) => setForm({ ...form, model: e.target.value as AiModel })}>
              {AI_PROVIDERS.map((p) => (
                <optgroup key={p.value} label={`${p.label}${providerConfigured(providers, p.value) === false ? t("aiAdmin.keyNotSet") : ""}`}>
                  {AI_MODELS.filter((m) => m.provider === p.value).map((m) => (
                    <option key={m.value} value={m.value}>{m.label}{m.value === defaultModel ? t("aiAdmin.defaultMark") : ""}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label={t("aiAdmin.effort")}>
            <select value={form.effort} className={SELECT} onChange={(e) => setForm({ ...form, effort: e.target.value as AiEffort })}>
              {AI_EFFORTS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={form.allow_private} onChange={(e) => setForm({ ...form, allow_private: e.target.checked })} />
          <span>
            {t("aiAdmin.allowPrivate")}
            <span className="block text-xs text-muted">{t("aiAdmin.allowPrivateNote")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={form.web_search} onChange={(e) => setForm({ ...form, web_search: e.target.checked })} />
          <span>
            {t("aiAdmin.webSearch")}
            <span className="block text-xs text-muted">{t("aiAdmin.webSearchNote")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} />
          <span>
            {t("aiAdmin.isDefault")}
            <span className="block text-xs text-muted">{t("aiAdmin.isDefaultNote")}</span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          {t("admin.users.filter.active")}
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || !form.name.trim() || tooLong || (!row && !form.username.trim())}>{row ? t("common.save") : t("common.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}
