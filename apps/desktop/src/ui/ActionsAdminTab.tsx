/**
 * M143 (docs/ACTIONS.md §7.2, §9.1): administration → 「操作ボタン」. The switch, 「在室状況のページにも表示する」, how long the
 * presses are kept, the buttons (order, on / off, whether the key file is there), the form (name, group, icon, emoji, the
 * relay's URL, action_key, the key file's name, the confirmation, who may press, the notice's conversation), 「テスト送信」
 * and the latest presses. Administrators only (integrations.manage).
 */
import { Activity, ArrowDown, ArrowUp, History, KeyRound, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { ActionAdminOut, ActionCreate, ActionInvocationOut, ActionInvokeOut, ActionPressRole, ActionSettingsOut, ActionStatusOut } from "../api/types";
import type { AppController } from "../state/app";
import { actionTitle, resultText, statusDetails, statusFailureText } from "./actions";
import { ActionGlyph } from "./ActionButtons";
import { ATTENDANCE_ICONS, attendanceIconLabel } from "./attendanceIcons";
import { fullTimestamp } from "./format";
import { Badge, Button, cn, Field, Input, Modal } from "./primitives";
import { t } from "../i18n";

const ROLES: readonly ActionPressRole[] = ["member", "manager", "admin"];
const ROLE_KEYS = {
  member: "actionsAdmin.role.member",
  manager: "admin.users.role.manager",
  admin: "admin.users.role.admin",
} as const;

export function ActionsAdminTab({ controller }: { controller: AppController }) {
  const [settings, setSettings] = useState<ActionSettingsOut | null>(null);
  const [actions, setActions] = useState<ActionAdminOut[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ActionAdminOut | "new" | null>(null);
  const [history, setHistory] = useState<ActionAdminOut | null>(null);
  const [tested, setTested] = useState<{ id: string; out: ActionInvokeOut } | null>(null);
  const [checked, setChecked] = useState<{ id: string; out: ActionStatusOut } | null>(null);

  const load = async () => {
    if (!controller.api) return;
    try {
      const [s, list] = await Promise.all([controller.api.adminActionSettings(), controller.api.adminActions()]);
      setSettings(s);
      setActions(list);
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

  if (!settings || !actions) return <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>;
  const api = controller.api!;
  const move = (index: number, by: number) => {
    const ids = actions.map((a) => a.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved!);
    void run(() => api.adminReorderActions(ids));
  };
  const test = async (row: ActionAdminOut) => {
    setBusy(true);
    try {
      setTested({ id: row.id, out: await api.adminTestAction(row.id) });
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  const checkStatus = async (row: ActionAdminOut) => {
    setBusy(true);
    try {
      setChecked({ id: row.id, out: await api.adminCheckActionStatus(row.id) });
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-6" data-actions-admin>
      <section className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            role="switch"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => void run(() => api.adminUpdateActionSettings({ enabled: e.target.checked }))}
          />
          {t("actionsAdmin.enabled")}
        </label>
        <p className="text-xs text-muted">{t("actionsAdmin.intro")}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={settings.show_on_attendance}
            disabled={busy}
            data-show-on-attendance
            onChange={(e) => void run(() => api.adminUpdateActionSettings({ show_on_attendance: e.target.checked }))}
          />
          {t("actionsAdmin.showOnAttendance")}
        </label>
      </section>

      <section className="space-y-2" aria-label={t("actionsAdmin.buttons")}>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t("actionsAdmin.buttons")}</h3>
          <Button size="sm" className="ml-auto" disabled={busy || actions.length >= 50} onClick={() => setEditing("new")}>
            <Plus size={14} /> {t("actionsAdmin.add")}
          </Button>
        </div>
        {actions.length === 0 && <p className="text-xs text-muted">{t("actionsAdmin.none")}</p>}
        <ul className="divide-y divide-line rounded-xl border border-line">
          {actions.map((row, index) => (
            <li key={row.id} data-admin-action={row.id} className={cn("space-y-1.5 px-3 py-2 text-sm", !row.enabled && "opacity-60")}>
              <div className="flex items-center gap-2">
                <ActionGlyph action={row} />
                <span className="min-w-0 flex-1 truncate font-medium">{actionTitle(row)}</span>
                {!row.enabled && <Badge>{t("actionsAdmin.off")}</Badge>}
                {row.provides_status && <Badge tone="accent">{t("actionsAdmin.statusBadge")}</Badge>}
                {!row.secret_present && (
                  <Badge tone="danger">
                    <KeyRound size={11} className="mr-0.5 inline" /> {t("actionsAdmin.noSecret")}
                  </Badge>
                )}
                <button type="button" className="rounded p-1 text-muted hover:bg-panel-2 disabled:opacity-30" disabled={busy || index === 0} aria-label={t("settings.navItems.up", { item: row.name })} onClick={() => move(index, -1)}>
                  <ArrowUp size={14} />
                </button>
                <button type="button" className="rounded p-1 text-muted hover:bg-panel-2 disabled:opacity-30" disabled={busy || index === actions.length - 1} aria-label={t("settings.navItems.down", { item: row.name })} onClick={() => move(index, 1)}>
                  <ArrowDown size={14} />
                </button>
              </div>
              <div className="text-xs text-muted">
                {row.url} · <code>{row.action_key}</code> · {whoText(controller, row)}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <label className="mr-2 flex items-center gap-1.5 text-xs">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={row.enabled} disabled={busy} onChange={(e) => void run(() => api.adminUpdateAction(row.id, { enabled: e.target.checked }))} />
                  {t("actionsAdmin.enabledOne")}
                </label>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test(row)} data-action-test={row.id}>
                  <Send size={14} /> {t("actionsAdmin.test")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void checkStatus(row)} data-action-check-status={row.id}>
                  <Activity size={14} /> {t("actionsAdmin.checkStatus")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setHistory(row)}>
                  <History size={14} /> {t("actionsAdmin.history")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(row)} aria-label={t("actionsAdmin.edit", { name: row.name })}>
                  <Pencil size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={busy}
                  aria-label={t("actionsAdmin.delete", { name: row.name })}
                  onClick={() => {
                    if (window.confirm(t("actionsAdmin.deleteConfirm", { name: actionTitle(row) }))) void run(() => api.adminDeleteAction(row.id));
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              {tested?.id === row.id && (
                <p className={cn("text-xs", tested.out.ok ? "text-accent" : "text-danger")} data-action-test-result>
                  {t("actionsAdmin.testResult", { result: resultText(tested.out, row).text, status: String(tested.out.status_code ?? "—") })}
                </p>
              )}
              {checked?.id === row.id && (
                <p className={cn("text-xs", checked.out.ok ? "text-accent" : "text-danger")} data-action-status-result>
                  {checked.out.ok && checked.out.status
                    ? t("actionsAdmin.statusResult", { text: [checked.out.status.text, statusDetails(checked.out)].filter(Boolean).join(" · "), tone: checked.out.status.tone, state: checked.out.status.state ?? "—" })
                    : statusFailureText(checked.out)}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <RetentionField days={settings.log_retention_days} busy={busy} onSave={(days) => void run(() => api.adminUpdateActionSettings({ log_retention_days: days }))} />

      {editing && (
        <ActionEditor
          controller={controller}
          row={editing === "new" ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(form) => {
            void run(() => (editing === "new" ? api.adminCreateAction(form) : api.adminUpdateAction(editing.id, form))).then((ok) => {
              if (ok) setEditing(null);
            });
          }}
        />
      )}
      {history && <Invocations controller={controller} action={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** 「メンバー・運営、@students、山田 太郎」, or 「誰も押せません」. */
function whoText(controller: AppController, row: ActionAdminOut): string {
  const store = controller.store;
  const parts = [
    ...row.allowed_roles.map((role) => t(ROLE_KEYS[role])),
    ...row.allowed_group_ids.map((id) => `@${store.groups.get(id)?.name ?? "?"}`),
    ...row.allowed_user_ids.map((id) => store.users.get(id)?.display_name ?? "?"),
  ];
  return parts.length ? t("actionsAdmin.who", { list: parts.join(t("common.listSeparator")) }) : t("actionsAdmin.nobody");
}

function RetentionField({ days, busy, onSave }: { days: number; busy: boolean; onSave: (days: number) => void }) {
  const [value, setValue] = useState(String(days));
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650;
  return (
    <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); if (valid) onSave(parsed); }}>
      <label htmlFor="actions-retention" className="block text-sm font-semibold">{t("actionsAdmin.retention")}</label>
      <div className="flex items-center gap-2">
        <Input id="actions-retention" type="number" min={0} max={3650} value={value} onChange={(e) => setValue(e.target.value)} className="w-32" />
        <Button type="submit" size="sm" variant="secondary" disabled={busy || !valid || parsed === days}>{t("common.save")}</Button>
      </div>
      <p className="text-xs text-muted">{t("attendanceAdmin.retentionHint")}</p>
    </form>
  );
}

/** The form of a button (new or existing): what it shows, where it sends, who may press it. */
export function ActionEditor({ controller, row, busy, onClose, onSave }: {
  controller: AppController;
  row: ActionAdminOut | null;
  busy: boolean;
  onClose: () => void;
  onSave: (form: ActionCreate) => void;
}) {
  const store = controller.store;
  const [name, setName] = useState(row?.name ?? "");
  const [group, setGroup] = useState(row?.group_label ?? "");
  const [icon, setIcon] = useState<string | null>(row?.icon ?? null);
  const [emoji, setEmoji] = useState(row?.emoji ?? "");
  const [url, setUrl] = useState(row?.url ?? "");
  const [actionKey, setActionKey] = useState(row?.action_key ?? "");
  const [secretName, setSecretName] = useState(row?.secret_name ?? "");
  const [confirm, setConfirm] = useState(row?.confirm ?? true);
  const [confirmMessage, setConfirmMessage] = useState(row?.confirm_text ?? "");
  const [roles, setRoles] = useState<ActionPressRole[]>(row?.allowed_roles ?? []);
  const [groupIds, setGroupIds] = useState<string[]>(row?.allowed_group_ids ?? []);
  const [userIds, setUserIds] = useState<string[]>(row?.allowed_user_ids ?? []);
  const [channelId, setChannelId] = useState(row?.notice_channel_id ?? "");
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [providesStatus, setProvidesStatus] = useState(row?.provides_status ?? false);
  const [filter, setFilter] = useState("");

  const groups = [...store.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  const people = [...store.users.values()]
    .filter((u) => !u.deactivated_at && u.role !== "guest" && u.role !== "bot")
    .sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  const query = filter.trim().toLowerCase();
  const listed = people.filter((u) => userIds.includes(u.id) || (!!query && (u.display_name.toLowerCase().includes(query) || u.username.toLowerCase().includes(query)))).slice(0, 30);
  const channels = [...store.channels.values()]
    .filter((c) => (c.type === "public" || c.type === "private") && !c.archived)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const toggle = <T,>(list: T[], value: T, on: boolean): T[] => (on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value));
  const nobody = roles.length === 0 && groupIds.length === 0 && userIds.length === 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      name: name.trim(),
      group_label: group.trim() || null,
      icon,
      emoji: emoji.trim() || null,
      url: url.trim(),
      action_key: actionKey.trim(),
      secret_name: secretName.trim(),
      confirm,
      confirm_text: confirmMessage.trim() || null,
      allowed_roles: roles,
      allowed_group_ids: groupIds,
      allowed_user_ids: userIds,
      notice_channel_id: channelId || null,
      enabled,
      provides_status: providesStatus,
    });
  };

  return (
    <Modal onClose={onClose} title={row ? t("actionsAdmin.edit", { name: row.name }) : t("actionsAdmin.add")} className="w-[560px]" growsDown>
      <form className="mt-4 space-y-3" onSubmit={submit} data-action-form>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field label={t("actionsAdmin.group")} hint={t("actionsAdmin.groupHint")}>
            <Input value={group} maxLength={40} placeholder={t("actionsAdmin.groupPlaceholder")} onChange={(e) => setGroup(e.target.value)} />
          </Field>
          <Field label={t("actionsAdmin.name")}>
            <Input value={name} maxLength={40} required autoFocus placeholder={t("actionsAdmin.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field label={t("actionsAdmin.icon")}>
          <div role="radiogroup" aria-label={t("actionsAdmin.icon")} className="flex flex-wrap gap-1">
            <button type="button" role="radio" aria-checked={icon === null} onClick={() => setIcon(null)} className={cn("h-8 rounded-md border px-2 text-xs", icon === null ? "border-accent bg-panel-2" : "border-line")}>
              {t("actionsAdmin.iconNone")}
            </button>
            {ATTENDANCE_ICONS.map(({ key, Icon }) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={icon === key}
                aria-label={attendanceIconLabel(key)}
                title={attendanceIconLabel(key)}
                onClick={() => setIcon(key)}
                className={cn("inline-flex h-8 w-8 items-center justify-center rounded-md border", icon === key ? "border-accent bg-panel-2" : "border-line")}
              >
                <Icon aria-hidden size={15} />
              </button>
            ))}
          </div>
        </Field>
        <Field label={t("actionsAdmin.emoji")} hint={t("actionsAdmin.emojiHint")}>
          <Input value={emoji} maxLength={32} placeholder="🔓" onChange={(e) => setEmoji(e.target.value)} className="w-32" />
        </Field>
        <Field label={t("actionsAdmin.url")} hint={t("actionsAdmin.urlHint")}>
          <Input value={url} type="url" required placeholder="https://example.com/taylis-actions" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field label={t("actionsAdmin.key")} hint={t("actionsAdmin.keyHint")}>
            <Input value={actionKey} required pattern="[A-Za-z0-9][A-Za-z0-9._:\-]{0,99}" placeholder="lab-door.unlock" onChange={(e) => setActionKey(e.target.value)} />
          </Field>
          <Field label={t("actionsAdmin.secretName")} hint={t("actionsAdmin.secretHint", { name: secretName.trim() || "<name>" })}>
            <Input value={secretName} required pattern="[a-z0-9][a-z0-9_\-]{0,63}" placeholder="lab-relay" onChange={(e) => setSecretName(e.target.value)} />
          </Field>
        </div>
        <fieldset className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            {t("actionsAdmin.confirm")}
          </label>
          {confirm && <Input value={confirmMessage} maxLength={200} aria-label={t("actionsAdmin.confirmText")} placeholder={t("actions.confirm", { name: group.trim() ? t("actions.title", { group: group.trim(), name: name.trim() || "…" }) : name.trim() || "…" })} onChange={(e) => setConfirmMessage(e.target.value)} />}
        </fieldset>
        <fieldset className="space-y-2 rounded-xl border border-line p-3" data-action-who>
          <legend className="px-1 text-sm font-semibold">{t("actionsAdmin.whoTitle")}</legend>
          <p className="text-xs text-muted">{t("actionsAdmin.whoHint")}</p>
          <div className="flex flex-wrap gap-3">
            {ROLES.map((role) => (
              <label key={role} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={roles.includes(role)} data-role={role} onChange={(e) => setRoles(toggle(roles, role, e.target.checked))} />
                {t(ROLE_KEYS[role])}
              </label>
            ))}
          </div>
          {groups.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={groupIds.includes(g.id)} data-group={g.name} onChange={(e) => setGroupIds(toggle(groupIds, g.id, e.target.checked))} />
                  @{g.name}
                </label>
              ))}
            </div>
          )}
          <Input value={filter} placeholder={t("actionsAdmin.findPeople")} aria-label={t("actionsAdmin.findPeople")} onChange={(e) => setFilter(e.target.value)} />
          {listed.length > 0 && (
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {listed.map((u) => (
                <label key={u.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={userIds.includes(u.id)} data-person={u.username} onChange={(e) => setUserIds(toggle(userIds, u.id, e.target.checked))} />
                  {u.display_name} <span className="text-xs text-muted">@{u.username}</span>
                </label>
              ))}
            </div>
          )}
          {nobody && <p className="text-xs text-danger">{t("actionsAdmin.nobody")}</p>}
        </fieldset>
        <Field label={t("actionsAdmin.notice")} hint={t("actionsAdmin.noticeHint")}>
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
            <option value="">{t("actionsAdmin.noNotice")}</option>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.type === "private" ? "🔒" : "#"}{c.name}</option>)}
          </select>
        </Field>
        <div className="space-y-0.5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={providesStatus} data-provides-status onChange={(e) => setProvidesStatus(e.target.checked)} />
            {t("actionsAdmin.providesStatus")}
          </label>
          <p className="pl-6 text-xs text-muted">{t("actionsAdmin.providesStatusHint")}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("actionsAdmin.enabledOne")}
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim() || !url.trim() || !actionKey.trim() || !secretName.trim()}>{t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}

const STATUS_KEYS = {
  pending: "actionsAdmin.status.pending",
  succeeded: "actionsAdmin.status.succeeded",
  failed: "actionsAdmin.status.failed",
} as const;

function Invocations({ controller, action, onClose }: { controller: AppController; action: ActionAdminOut; onClose: () => void }) {
  const [rows, setRows] = useState<ActionInvocationOut[] | null>(null);
  useEffect(() => {
    void controller.api?.adminActionInvocations(action.id).then(setRows, (error: unknown) => controller.setError(error));
  }, [controller.api, action.id]);
  return (
    <Modal onClose={onClose} title={t("actionsAdmin.historyTitle", { name: actionTitle(action) })} className="w-[640px]" growsDown>
      {!rows ? (
        <p className="mt-3 text-xs text-muted">{t("common.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted">{t("actionsAdmin.noHistory")}</p>
      ) : (
        <table className="mt-3 w-full text-xs" data-invocations>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-line align-top">
                <td className="py-1 pr-2 text-muted">{fullTimestamp(row.created_at)}</td>
                <td className="py-1 pr-2">{row.kind === "test" ? t("actionsAdmin.test") : controller.store.users.get(row.user_id)?.display_name ?? "?"}</td>
                <td className={cn("py-1 pr-2", row.status === "failed" && "text-danger")}>{t(STATUS_KEYS[row.status])}</td>
                <td className="py-1 pr-2 text-muted">{[row.status_code, row.error].filter((v) => v !== null && v !== undefined).join(" ")}</td>
                <td className="py-1 pr-2 text-muted">{row.latency_ms !== null && row.latency_ms !== undefined ? `${row.latency_ms} ms` : ""}</td>
                <td className="py-1">{row.message ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
