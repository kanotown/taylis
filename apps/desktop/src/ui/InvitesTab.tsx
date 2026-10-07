import { Ban, Copy, Link2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { describeError } from "../api/errors";
import type { Affiliation, FacultyRank, Grade, InviteOut, UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import { fullTimestamp } from "./format";
import { EMPTY_PRESET, INVITE_STATUS_LABELS, type InvitePresetForm, inviteLink, invitePreset, inviteUsesLabel } from "./invite";
import { Badge, Button, cn, Field, Input } from "./primitives";
import { AFFILIATIONS, GRADES, grantableAffiliations, invitePresetSummary, RANKS } from "./roster";
import { t, labelled } from "../i18n";
import { assignableRoles } from "./roles";

/** M142: the role choices of an invite (a manager gets member and guest only). */
const ROLE_OPTION_KEYS = { member: "admin.users.role.member", manager: "admin.users.role.managerNote", admin: "admin.users.role.admin", guest: "admin.users.role.guestNote" } as const;

const SELECT = "h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm";

const USES = [
  labelled("1", "invites.uses.once"),
  labelled("5", "invites.uses.five"),
  labelled("unlimited", "invites.uses.unlimited"),
] as const;
const EXPIRY = [
  labelled("24", "invites.expiry.day"),
  labelled("168", "invites.expiry.week"),
  labelled("720", "invites.expiry.month"),
] as const;

/** Administration → 招待 (M12h): issue, copy and revoke invite links. */
export function InvitesTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const channels = [...store.channels.values()]
    .filter((c) => !c.archived && (c.type === "public" || (c.type === "private" && c.isMember)))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const [invites, setInvites] = useState<InviteOut[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ url: string; note: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => ({
    note: "",
    role: "member" as "member" | "manager" | "admin" | "guest",
    uses: "1" as (typeof USES)[number][0],
    expiry: "168" as (typeof EXPIRY)[number][0],
    channelIds: new Set(channels.filter((c) => c.name === "general").map((c) => c.id)),
  }));
  // REVIEW-v0.1.43 #1 (ROLES.md §4.2): a manager presets only their own affiliation (a student: any grade) or "other".
  const grantable = grantableAffiliations(controller.can("users.manage"), store.me ? store.roster.get(store.me.id) : undefined);
  const [preset, setPreset] = useState<InvitePresetForm>(() => (grantable.has(EMPTY_PRESET.affiliation) ? EMPTY_PRESET : { ...EMPTY_PRESET, affiliation: "other" }));
  // The admin toast sits behind this dialog: a failed issue (e.g. 422 invalid_supervisor) is said inside the form.
  const [formError, setFormError] = useState<string | null>(null);
  // The server takes faculty on the roster only as supervisors (422 invalid_supervisor).
  const faculty = [...store.roster.values()]
    .filter((line) => line.affiliation === "faculty")
    .map((line) => store.users.get(line.user_id))
    .filter((u): u is UserPublic => !!u && !u.deactivated_at);

  const load = async () => {
    if (!controller.api) return;
    try {
      setInvites(await controller.api.adminListInvites());
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
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const api = controller.api!;
    const lab = invitePreset(preset, form.role);
    setBusy(true);
    setFormError(null);
    try {
      const created = await api.adminCreateInvite({
        note: form.note.trim() || null,
        role: form.role,
        max_uses: form.uses === "unlimited" ? null : Number(form.uses),
        expires_in_hours: Number(form.expiry),
        channel_ids: [...form.channelIds],
        ...(lab ? { lab } : {}), // only when the section is on: older servers reject unknown fields
      });
      setIssued({ url: inviteLink(api.baseUrl, created.token), note: created.invite.note });
      setCreating(false);
      setForm((f) => ({ ...f, note: "" }));
      await load();
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      controller.setNotice(t("invites.copied"));
    } catch (error) {
      controller.setError(error);
    }
  };

  const toggleChannel = (id: string) =>
    setForm((f) => {
      const next = new Set(f.channelIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...f, channelIds: next };
    });

  const nameOf = (userId: string) => store.users.get(userId)?.display_name ?? "?";

  return (
    <div className="mt-4 space-y-4">
      {issued && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft/50 p-3 text-sm">
          <div className="font-medium">{t("invites.link")}{issued.note ? ` (${issued.note})` : ""}</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-canvas px-2 py-1 font-mono text-xs" title={issued.url}>{issued.url}</code>
            <Button size="sm" variant="secondary" onClick={() => void copy(issued.url)}>
              <Copy size={14} /> {t("common.copy")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>{t("common.close")}</Button>
          </div>
          <div className="mt-1 text-xs text-muted">{t("invites.issuedNote")}</div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{invites ? t("common.count", { count: invites.length }) : t("common.loading")}</span>
        <Button size="sm" onClick={() => setCreating((open) => !open)}>
          <Link2 size={14} /> {t("invites.create")}
        </Button>
      </div>
      {creating && (
        <form className="grid grid-cols-2 gap-3 rounded-xl border border-line p-3" onSubmit={(e) => void create(e)}>
          <Field label={t("invites.note")}>
            <Input value={form.note} maxLength={80} autoFocus onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <Field label={t("admin.users.role")}>
            {/* M142: a manager invites members and guests only (giving a higher role is the administrators'). */}
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "member" | "manager" | "admin" | "guest" })} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
              {assignableRoles((capability) => controller.can(capability)).map((role) => (
                <option key={role} value={role}>{t(ROLE_OPTION_KEYS[role])}</option>
              ))}
            </select>
          </Field>
          <Field label={t("invites.usesLabel")}>
            <select value={form.uses} onChange={(e) => setForm({ ...form, uses: e.target.value as (typeof USES)[number][0] })} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
              {USES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label={t("invites.expiryLabel")}>
            <select value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value as (typeof EXPIRY)[number][0] })} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
              {EXPIRY.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <div className="col-span-2">
            <div className="text-xs font-medium text-muted">{t("invites.channels")}</div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {channels.map((channel) => (
                <label key={channel.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={form.channelIds.has(channel.id)} onChange={() => toggleChannel(channel.id)} />
                  <span>{channel.type === "private" ? "🔒" : "#"}{channel.name}</span>
                </label>
              ))}
              {channels.length === 0 && <span className="text-xs text-muted">{t("invites.noChannels")}</span>}
            </div>
          </div>
          <fieldset className="col-span-2 rounded-lg border border-line p-3">
            <legend className="px-1">
              <label className="flex items-center gap-1.5 text-sm font-medium">
                <input type="checkbox" checked={preset.on} onChange={(e) => setPreset({ ...preset, on: e.target.checked })} />
                {t("invites.addToRoster")}
              </label>
            </legend>
            {preset.on ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("roster.affiliation")} hint={grantable.size < AFFILIATIONS.length ? t("roster.grantHint") : undefined}>
                  <select value={preset.affiliation} onChange={(e) => setPreset({ ...preset, affiliation: e.target.value as Affiliation })} className={SELECT}>
                    {AFFILIATIONS.map(([value, label]) => <option key={value} value={value} disabled={!grantable.has(value)}>{label}</option>)}
                  </select>
                </Field>
                {preset.affiliation === "faculty" && (
                  <Field label={t("roster.rank")}>
                    <select value={preset.rank} onChange={(e) => setPreset({ ...preset, rank: e.target.value as FacultyRank | "" })} className={SELECT}>
                      <option value="">{t("invites.unspecified")}</option>
                      {RANKS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </Field>
                )}
                {preset.affiliation === "student" && (
                  <Field label={t("roster.grade")}>
                    <select value={preset.grade} onChange={(e) => setPreset({ ...preset, grade: e.target.value as Grade | "" })} className={SELECT}>
                      <option value="">{t("invites.unspecified")}</option>
                      {[...GRADES].reverse().map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </Field>
                )}
                <Field label={t("roster.supervisor")} hint={faculty.length === 0 ? t("invites.supervisorHint") : undefined}>
                  <select value={preset.supervisorId} onChange={(e) => setPreset({ ...preset, supervisorId: e.target.value })} className={SELECT} disabled={faculty.length === 0}>
                    <option value="">{t("workflow.none")}</option>
                    {faculty.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                  </select>
                </Field>
                <label className={cn("col-span-2 flex items-center gap-1.5 text-sm", form.role === "guest" && "opacity-60")}>
                  <input type="checkbox" checked={form.role !== "guest" && preset.times} disabled={form.role === "guest"} onChange={(e) => setPreset({ ...preset, times: e.target.checked })} />
                  {t("invites.createTimes")}
                  {form.role === "guest" && <span className="text-xs text-muted">{t("invites.noTimesForGuests")}</span>}
                </label>
              </div>
            ) : (
              <p className="text-xs text-muted">{t("invites.rosterNote")}</p>
            )}
          </fieldset>
          {formError && <p role="alert" className="col-span-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{formError}</p>}
          <div className="col-span-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(false)}>{t("common.cancel")}</Button>
            <Button type="submit" size="sm" disabled={busy}>{t("invites.issue")}</Button>
          </div>
        </form>
      )}
      {invites && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {invites.map((invite) => {
            const active = invite.status === "active";
            return (
              <li key={invite.id} className={cn("flex items-center gap-3 px-3 py-2 text-sm", !active && "opacity-60")}>
                <Link2 size={16} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{invite.note || t("invites.link")}</span>
                    <Badge tone={active ? "accent" : "neutral"}>{INVITE_STATUS_LABELS[invite.status]}</Badge>
                    {invite.role === "admin" && <Badge tone="danger">{t("admin.users.role.admin")}</Badge>}
                    {invite.role === "manager" && <Badge tone="accent">{t("admin.users.role.manager")}</Badge>}
                    {invite.role === "guest" && <Badge>{t("dialogs.guest")}</Badge>}
                    <span className="text-xs text-muted">{inviteUsesLabel(invite)}</span>
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {t("invites.issuedBy", { name: nameOf(invite.created_by) })} · {active ? t("invites.expires") : t("invites.expired")} {fullTimestamp(invite.expires_at)}
                    {invite.channel_ids.length > 0 && ` · ${invite.channel_ids.map((id) => store.channels.get(id)?.name).filter(Boolean).map((name) => `#${name}`).join(" ")}`}
                    {invite.used_by.length > 0 && t("invites.joined", { names: invite.used_by.map(nameOf).join(", ") })}
                  </div>
                  {invite.lab && <div className="truncate text-[11px] text-muted">{t("invites.roster", { summary: invitePresetSummary(invite.lab, store.users) })}</div>}
                </div>
                {active && (
                  <Button size="sm" variant="ghost" className="text-danger" title={t("invites.revokeTitle")} disabled={busy} onClick={() => void run(async () => { await controller.api!.adminRevokeInvite(invite.id); })}>
                    <Ban size={14} /> {t("invites.revoke")}
                  </Button>
                )}
              </li>
            );
          })}
          {invites.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("invites.none")}</li>}
        </ul>
      )}
    </div>
  );
}
