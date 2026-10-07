/**
 * M140 (docs/PRESENCE.md §3.3, §5, §7): administration → 「在室状況」. The switch, the workspace's states (name, emoji,
 * colour, kind, order), who may add their own states, how long the log is kept, someone else's state, the integrations
 * (outgoing webhook URL + the name of its signing key's file, the inbound token, 「テスト送信」, the deliveries) and the
 * latest changes.
 */
import { ArrowDown, ArrowUp, Copy, KeyRound, Pencil, Plus, Power, Send, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { AttendanceAdminSettingsOut, AttendanceDeliveryOut, AttendanceIntegrationOut, AttendanceLogOut, AttendancePersonalRule, AttendanceStateOut } from "../api/types";
import type { AppController } from "../state/app";
import { kindLabel, onBoard, stateText } from "./attendance";
import { StateBadge } from "./attendanceIcons";
import { StateForm } from "./AttendanceView";
import { fullTimestamp } from "./format";
import { Badge, Button, cn, Field, Input, Modal } from "./primitives";
import { t } from "../i18n";

const RULES: readonly AttendancePersonalRule[] = ["nobody", "everyone", "admins", "groups"];
const RULE_KEYS = {
  nobody: "attendanceAdmin.rule.nobody",
  everyone: "attendanceAdmin.rule.everyone",
  admins: "attendanceAdmin.rule.admins",
  groups: "attendanceAdmin.rule.groups",
} as const;

export function AttendanceAdminTab({ controller }: { controller: AppController }) {
  const [settings, setSettings] = useState<AttendanceAdminSettingsOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AttendanceStateOut | "new" | null>(null);

  const load = async () => {
    if (!controller.api) return;
    try {
      setSettings(await controller.api.adminAttendanceSettings());
    } catch (error) {
      controller.setError(error);
    }
  };
  useEffect(() => {
    void load();
  }, [controller.api]);

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
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

  if (!settings) return <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>;
  const api = controller.api!;
  const states = settings.states;
  const move = (index: number, by: number) => {
    const ids = states.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved!);
    void run(() => api.adminReorderAttendanceStates(ids));
  };
  const groups = [...controller.store.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  // M142 (docs/ROLES.md §2): managers edit the states and set someone's state; the switch, the rules, the retention and
  // everyone's log are attendance.configure, the integrations integrations.manage (administrators).
  const configure = controller.can("attendance.configure");
  const integrations = controller.can("integrations.manage");

  return (
    <div className="mt-4 space-y-6" data-attendance-admin>
      <section className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            role="switch"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={settings.enabled}
            disabled={busy || !configure}
            onChange={(e) => void run(() => api.adminUpdateAttendanceSettings({ enabled: e.target.checked }))}
          />
          {t("attendanceAdmin.enabled")}
        </label>
        <p className="text-xs text-muted">{t("attendanceAdmin.intro")}</p>
      </section>

      {settings.enabled && (
        <>
          <section className="space-y-2" aria-label={t("attendanceAdmin.states")}>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">{t("attendanceAdmin.states")}</h3>
              <Button size="sm" className="ml-auto" disabled={busy || states.length >= 20} onClick={() => setEditing("new")}>
                <Plus size={14} /> {t("attendance.add")}
              </Button>
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {states.map((state, index) => (
                <li key={state.id} data-admin-state={state.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="flex min-w-0 flex-1"><StateBadge state={state} /></span>
                  <span className="text-xs text-muted">{kindLabel(state.kind)}</span>
                  <button type="button" className="rounded p-1 text-muted hover:bg-panel-2 disabled:opacity-30" disabled={busy || index === 0} aria-label={t("settings.navItems.up", { item: state.label })} onClick={() => move(index, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button type="button" className="rounded p-1 text-muted hover:bg-panel-2 disabled:opacity-30" disabled={busy || index === states.length - 1} aria-label={t("settings.navItems.down", { item: state.label })} onClick={() => move(index, 1)}>
                    <ArrowDown size={14} />
                  </button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(state)} aria-label={t("attendance.editOwn", { name: state.label })}>
                    <Pencil size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" disabled={busy || states.length <= 1} aria-label={t("attendance.deleteOwn", { name: state.label })} onClick={() => void run(() => api.adminDeleteAttendanceState(state.id))}>
                    <Trash2 size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          {configure && (
          <section className="space-y-2" aria-label={t("attendanceAdmin.personal")}>
            <h3 className="text-sm font-semibold">{t("attendanceAdmin.personal")}</h3>
            <select
              aria-label={t("attendanceAdmin.personal")}
              value={settings.personal_rule}
              disabled={busy}
              onChange={(e) => void run(() => api.adminUpdateAttendanceSettings({ personal_rule: e.target.value as AttendancePersonalRule }))}
              className="h-9 w-full max-w-sm rounded-lg border border-line bg-canvas px-3 text-sm"
            >
              {RULES.map((rule) => <option key={rule} value={rule}>{t(RULE_KEYS[rule])}</option>)}
            </select>
            {settings.personal_rule === "groups" && (
              <div className="flex flex-wrap gap-3">
                {groups.length === 0 && <span className="text-xs text-muted">{t("attendanceAdmin.noGroups")}</span>}
                {groups.map((group) => {
                  const on = settings.personal_group_ids.includes(group.id);
                  return (
                    <label key={group.id} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--accent)]"
                        checked={on}
                        disabled={busy}
                        onChange={() => void run(() => api.adminUpdateAttendanceSettings({ personal_group_ids: on ? settings.personal_group_ids.filter((g) => g !== group.id) : [...settings.personal_group_ids, group.id] }))}
                      />
                      @{group.name}
                    </label>
                  );
                })}
              </div>
            )}
          </section>
          )}

          {configure && <RetentionField key={settings.log_retention_days} days={settings.log_retention_days} busy={busy} onSave={(days) => void run(() => api.adminUpdateAttendanceSettings({ log_retention_days: days }))} />}

          <SetForSomeone controller={controller} />

          {integrations && <Integrations controller={controller} />}

          {configure && <RecentLog controller={controller} />}
        </>
      )}

      {editing !== null && (
        <Modal onClose={() => setEditing(null)} title={editing === "new" ? t("attendanceAdmin.addState") : t("attendance.editOwn", { name: editing.label })} className="w-[420px]">
          <StateForm
            initial={editing === "new" ? null : editing}
            busy={busy}
            submitLabel={editing === "new" ? t("attendance.add") : t("common.save")}
            onCancel={() => setEditing(null)}
            onSubmit={(form) => {
              const target = editing;
              void run(() => (target === "new" ? api.adminCreateAttendanceState(form) : api.adminUpdateAttendanceState(target.id, form))).then((ok) => {
                if (ok) setEditing(null);
              });
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function RetentionField({ days, busy, onSave }: { days: number; busy: boolean; onSave: (days: number) => void }) {
  const [value, setValue] = useState(String(days));
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650;
  return (
    <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); if (valid) onSave(parsed); }}>
      <label htmlFor="attendance-retention" className="block text-sm font-semibold">{t("attendanceAdmin.retention")}</label>
      <div className="flex items-center gap-2">
        <Input id="attendance-retention" type="number" min={0} max={3650} value={value} onChange={(e) => setValue(e.target.value)} className="w-32" />
        <Button type="submit" size="sm" variant="secondary" disabled={busy || !valid || parsed === days}>{t("common.save")}</Button>
      </div>
      <p className="text-xs text-muted">{t("attendanceAdmin.retentionHint")}</p>
    </form>
  );
}

/** An administrator sets someone else's state (audited, docs/PRESENCE.md §3.3). */
function SetForSomeone({ controller }: { controller: AppController }) {
  const store = controller.store;
  const board = store.attendance;
  const people = [...store.users.values()].filter(onBoard).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  const [userId, setUserId] = useState("");
  const [stateId, setStateId] = useState("");
  const [busy, setBusy] = useState(false);
  const choices = (board?.states ?? []).filter((s) => !s.archived && (s.owner_id === null || s.owner_id === userId));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!controller.api || !userId || !stateId) return;
    setBusy(true);
    try {
      store.applyAttendanceEntry(await controller.api.adminSetAttendance(userId, stateId, null));
      controller.setNotice(t("attendanceAdmin.setDone"));
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2" aria-label={t("attendanceAdmin.setFor")}>
      <h3 className="text-sm font-semibold">{t("attendanceAdmin.setFor")}</h3>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => void submit(e)}>
        <select aria-label={t("attendanceAdmin.person")} value={userId} onChange={(e) => { setUserId(e.target.value); setStateId(""); }} className="h-9 min-w-[12em] rounded-lg border border-line bg-canvas px-3 text-sm">
          <option value="">{t("attendanceAdmin.person")}</option>
          {people.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
        </select>
        <select aria-label={t("attendanceAdmin.state")} value={stateId} disabled={!userId} onChange={(e) => setStateId(e.target.value)} className="h-9 min-w-[10em] rounded-lg border border-line bg-canvas px-3 text-sm">
          <option value="">{t("attendanceAdmin.state")}</option>
          {choices.map((s) => <option key={s.id} value={s.id}>{stateText(s)}</option>)}
        </select>
        <Button type="submit" size="sm" variant="secondary" disabled={busy || !userId || !stateId}>{t("attendanceAdmin.setButton")}</Button>
      </form>
      <p className="text-xs text-muted">{t("attendanceAdmin.setNote")}</p>
    </section>
  );
}

function Integrations({ controller }: { controller: AppController }) {
  const [rows, setRows] = useState<AttendanceIntegrationOut[] | null>(null);
  const [editing, setEditing] = useState<AttendanceIntegrationOut | "new" | null>(null);
  const [token, setToken] = useState<{ name: string; token: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const api = controller.api!;
  const load = async () => {
    try {
      setRows(await api.adminAttendanceIntegrations());
    } catch (error) {
      controller.setError(error);
    }
  };
  useEffect(() => {
    void load();
  }, [controller.api]);
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
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
  const inboundUrl = `${api.baseUrl.replace(/\/+$/, "")}/api/v1/integrations/attendance`;
  return (
    <section className="space-y-2" aria-label={t("attendanceAdmin.integrations")}>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t("attendanceAdmin.integrations")}</h3>
        <Button size="sm" className="ml-auto" disabled={busy} onClick={() => setEditing("new")}>
          <Plus size={14} /> {t("attendanceAdmin.addIntegration")}
        </Button>
      </div>
      <p className="text-xs text-muted">{t("attendanceAdmin.integrationsIntro")}</p>
      {token && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft/50 p-3 text-sm" data-attendance-token>
          <div className="font-medium">{t("attendanceAdmin.tokenOf", { name: token.name })}</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-canvas px-2 py-1 font-mono text-xs">{token.token}</code>
            <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(token.token).then(() => controller.setNotice(t("webhooks.copied")), (error: unknown) => controller.setError(error))}>
              <Copy size={14} /> {t("common.copy")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setToken(null)}>{t("common.close")}</Button>
          </div>
          <div className="mt-1 text-xs text-muted">{t("attendanceAdmin.tokenNote", { url: inboundUrl })}</div>
        </div>
      )}
      {rows && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("attendanceAdmin.noIntegrations")}</li>}
          {rows.map((row) => (
            <li key={row.id} data-integration={row.id} className={cn("space-y-1 px-3 py-2 text-sm", !row.enabled && "opacity-60")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                {row.url && <Badge>{t("attendanceAdmin.outgoing")}</Badge>}
                {row.inbound && <Badge>{t("attendanceAdmin.inbound")}</Badge>}
                {!row.enabled && <Badge>{t("workflow.paused")}</Badge>}
              </div>
              <div className="truncate text-xs text-muted">
                {row.url ? `${row.url} · ${t("attendanceAdmin.secretNameIs", { name: row.secret_name ?? "-" })}` : t("attendanceAdmin.noUrl")}
                {row.last_inbound_at && ` · ${t("attendanceAdmin.lastInbound", { at: fullTimestamp(row.last_inbound_at) })}`}
              </div>
              <div className="flex flex-wrap gap-1">
                {row.url && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
                    const sent = await api.adminTestAttendanceIntegration(row.id);
                    controller.setNotice(sent.delivery.status === "delivered" ? t("attendanceAdmin.testOk", { code: sent.delivery.last_status_code ?? "" }) : t("attendanceAdmin.testFailed", { error: sent.delivery.last_error ?? String(sent.delivery.last_status_code ?? "") }));
                    setOpen(row.id);
                  })}>
                    <Send size={14} /> {t("attendanceAdmin.test")}
                  </Button>
                )}
                {row.url && (
                  <Button size="sm" variant="ghost" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}>
                    {t("attendanceAdmin.deliveries")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
                  const out = await api.adminRotateAttendanceToken(row.id);
                  setToken({ name: row.name, token: out.token });
                })}>
                  <KeyRound size={14} /> {row.inbound ? t("attendanceAdmin.rotateToken") : t("attendanceAdmin.makeToken")}
                </Button>
                {row.inbound && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.adminRevokeAttendanceToken(row.id))}>
                    {t("attendanceAdmin.revokeToken")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(row)}>
                  <Pencil size={14} /> {t("canvas.edit")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.adminUpdateAttendanceIntegration(row.id, { enabled: !row.enabled }))}>
                  <Power size={14} /> {row.enabled ? t("webhooks.stop") : t("settings.pause.resume")}
                </Button>
                <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => void run(() => api.adminDeleteAttendanceIntegration(row.id))}>
                  <Trash2 size={14} /> {t("common.delete")}
                </Button>
              </div>
              {open === row.id && <Deliveries controller={controller} integrationId={row.id} />}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <IntegrationEditor
          row={editing === "new" ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(form) =>
            void run(async () => {
              if (editing === "new") {
                const created = await api.adminCreateAttendanceIntegration({ name: form.name, url: form.url, secret_name: form.secretName, inbound: form.inbound });
                if (created.token) setToken({ name: created.integration.name, token: created.token });
              } else {
                await api.adminUpdateAttendanceIntegration(editing.id, { name: form.name, url: form.url, ...(form.secretName ? { secret_name: form.secretName } : {}) });
              }
            }).then((ok) => {
              if (ok) setEditing(null);
            })
          }
        />
      )}
    </section>
  );
}

function IntegrationEditor({ row, busy, onClose, onSave }: {
  row: AttendanceIntegrationOut | null;
  busy: boolean;
  onClose: () => void;
  onSave: (form: { name: string; url: string | null; secretName: string | null; inbound: boolean }) => void;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [url, setUrl] = useState(row?.url ?? "");
  const [secretName, setSecretName] = useState(row?.secret_name ?? "");
  const [inbound, setInbound] = useState(true);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ name: name.trim(), url: url.trim() || null, secretName: secretName.trim() || null, inbound });
  };
  const needsSecret = !!url.trim() && !secretName.trim();
  return (
    <Modal onClose={onClose} title={row ? t("aiAdmin.editTitle", { name: row.name }) : t("attendanceAdmin.addIntegration")} className="w-[480px]">
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Field label={t("attendance.form.label")}>
          <Input value={name} maxLength={80} required autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("attendanceAdmin.url")} hint={t("attendanceAdmin.urlHint")}>
          <Input value={url} type="url" placeholder="https://example.com/taylis-hook" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label={t("attendanceAdmin.secretName")} hint={t("attendanceAdmin.secretHint", { name: secretName.trim() || "<name>" })}>
          <Input value={secretName} pattern="[a-z0-9][a-z0-9_\-]{0,63}" placeholder="lab-site" onChange={(e) => setSecretName(e.target.value)} />
        </Field>
        {!row && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={inbound} onChange={(e) => setInbound(e.target.checked)} />
            {t("attendanceAdmin.inboundToo")}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim() || needsSecret}>{t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}

const STATUS_KEYS = {
  pending: "attendanceAdmin.status.pending",
  delivered: "attendanceAdmin.status.delivered",
  failed: "attendanceAdmin.status.failed",
  superseded: "attendanceAdmin.status.superseded",
  cancelled: "attendanceAdmin.status.cancelled",
} as const;

function Deliveries({ controller, integrationId }: { controller: AppController; integrationId: string }) {
  const [rows, setRows] = useState<AttendanceDeliveryOut[] | null>(null);
  useEffect(() => {
    void controller.api?.adminAttendanceDeliveries(integrationId).then(setRows, (error: unknown) => controller.setError(error));
  }, [controller.api, integrationId]);
  if (!rows) return <p className="text-xs text-muted">{t("common.loading")}</p>;
  if (rows.length === 0) return <p className="text-xs text-muted">{t("attendanceAdmin.noDeliveries")}</p>;
  const name = (id: string | null) => (id ? controller.store.users.get(id)?.display_name ?? "?" : "");
  return (
    <table className="w-full text-xs" data-deliveries>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-t border-line">
            <td className="py-1 pr-2 text-muted">{fullTimestamp(row.created_at)}</td>
            <td className="py-1 pr-2">{row.event === "attendance.test" ? t("attendanceAdmin.test") : `${name(row.user_id)} → ${row.to_label ?? ""}`}</td>
            <td className={cn("py-1 pr-2", row.status === "failed" && "text-danger")}>{t(STATUS_KEYS[row.status])}</td>
            <td className="py-1 pr-2 text-muted">{row.last_status_code ?? ""} {row.last_error ?? ""}</td>
            <td className="py-1 text-muted">{t("attendanceAdmin.attempts", { count: row.attempts })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SOURCE_KEYS = {
  app: "attendanceAdmin.source.app",
  admin: "attendanceAdmin.source.admin",
  integration: "attendanceAdmin.source.integration",
  auto: "attendanceAdmin.source.auto",
} as const;

function RecentLog({ controller }: { controller: AppController }) {
  const [items, setItems] = useState<AttendanceLogOut[] | null>(null);
  const load = () => void controller.api?.attendanceLog({ limit: 50 }).then((page) => setItems(page.items), (error: unknown) => controller.setError(error));
  useEffect(load, [controller.api]);
  const board = controller.store.attendance;
  const label = (id: string | null) => {
    const state = id ? board?.states.find((s) => s.id === id) : null;
    return state ? stateText(state) : id ? "?" : "-";
  };
  return (
    <section className="space-y-2" aria-label={t("attendanceAdmin.log")}>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t("attendanceAdmin.log")}</h3>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={load}>{t("attendanceAdmin.reload")}</Button>
      </div>
      {!items ? (
        <p className="text-xs text-muted">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted">{t("attendanceAdmin.noLog")}</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t border-line">
                <td className="py-1 pr-2 text-muted">{fullTimestamp(item.at)}</td>
                <td className="py-1 pr-2">{controller.store.users.get(item.user_id)?.display_name ?? "?"}</td>
                <td className="py-1 pr-2">{label(item.from_state_id)} → {label(item.to_state_id)}{item.note ? ` (${item.note})` : ""}</td>
                <td className="py-1 text-muted">{t(SOURCE_KEYS[item.source])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
