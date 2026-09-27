import { Ban, Copy, Link2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { InviteOut } from "../api/types";
import type { AppController } from "../state/app";
import { fullTimestamp } from "./format";
import { INVITE_STATUS_LABELS, inviteLink, inviteUsesLabel } from "./invite";
import { Badge, Button, cn, Field, Input } from "./primitives";

const USES = [
  ["1", "1 回 (1 人だけ)"],
  ["5", "5 回まで"],
  ["unlimited", "期限内なら何度でも"],
] as const;
const EXPIRY = [
  ["24", "1 日"],
  ["168", "7 日"],
  ["720", "30 日"],
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
    role: "member" as "member" | "admin" | "guest",
    uses: "1" as (typeof USES)[number][0],
    expiry: "168" as (typeof EXPIRY)[number][0],
    channelIds: new Set(channels.filter((c) => c.name === "general").map((c) => c.id)),
  }));

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

  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const api = controller.api!;
      const created = await api.adminCreateInvite({
        note: form.note.trim() || null,
        role: form.role,
        max_uses: form.uses === "unlimited" ? null : Number(form.uses),
        expires_in_hours: Number(form.expiry),
        channel_ids: [...form.channelIds],
      });
      setIssued({ url: inviteLink(api.baseUrl, created.token), note: created.invite.note });
      setCreating(false);
      setForm((f) => ({ ...f, note: "" }));
    });
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      controller.setNotice("招待リンクをコピーしました");
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
          <div className="font-medium">招待リンク{issued.note ? ` (${issued.note})` : ""}</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-canvas px-2 py-1 font-mono text-xs" title={issued.url}>{issued.url}</code>
            <Button size="sm" variant="secondary" onClick={() => void copy(issued.url)}>
              <Copy size={14} /> コピー
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>閉じる</Button>
          </div>
          <div className="mt-1 text-xs text-muted">相手に渡すと、ユーザー名とパスワードを自分で決めて参加できます。この表示を閉じるとリンクは再表示できません。</div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{invites ? `${invites.length} 件` : "読み込み中…"}</span>
        <Button size="sm" onClick={() => setCreating((open) => !open)}>
          <Link2 size={14} /> 招待リンクを作成
        </Button>
      </div>
      {creating && (
        <form className="grid grid-cols-2 gap-3 rounded-xl border border-line p-3" onSubmit={create}>
          <Field label="メモ (任意、誰向けか)">
            <Input value={form.note} maxLength={80} autoFocus onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <Field label="ロール">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "member" | "admin" | "guest" })} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
              <option value="member">メンバー</option>
              <option value="admin">管理者</option>
              <option value="guest">ゲスト (参加したチャンネルだけ)</option>
            </select>
          </Field>
          <Field label="使える回数">
            <select value={form.uses} onChange={(e) => setForm({ ...form, uses: e.target.value as (typeof USES)[number][0] })} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
              {USES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="有効期限">
            <select value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value as (typeof EXPIRY)[number][0] })} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
              {EXPIRY.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <div className="col-span-2">
            <div className="text-xs font-medium text-muted">参加時に加わるチャンネル</div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {channels.map((channel) => (
                <label key={channel.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={form.channelIds.has(channel.id)} onChange={() => toggleChannel(channel.id)} />
                  <span>{channel.type === "private" ? "🔒" : "#"}{channel.name}</span>
                </label>
              ))}
              {channels.length === 0 && <span className="text-xs text-muted">チャンネルがありません</span>}
            </div>
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(false)}>キャンセル</Button>
            <Button type="submit" size="sm" disabled={busy}>リンクを発行</Button>
          </div>
        </form>
      )}
      {invites && (
        <ul className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-xl border border-line">
          {invites.map((invite) => {
            const active = invite.status === "active";
            return (
              <li key={invite.id} className={cn("flex items-center gap-3 px-3 py-2 text-sm", !active && "opacity-60")}>
                <Link2 size={16} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{invite.note || "招待リンク"}</span>
                    <Badge tone={active ? "accent" : "neutral"}>{INVITE_STATUS_LABELS[invite.status]}</Badge>
                    {invite.role === "admin" && <Badge tone="danger">管理者</Badge>}
                    {invite.role === "guest" && <Badge>ゲスト</Badge>}
                    <span className="text-xs text-muted">{inviteUsesLabel(invite)}</span>
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {nameOf(invite.created_by)} が発行 · {active ? "期限" : "期限は"} {fullTimestamp(invite.expires_at)}
                    {invite.channel_ids.length > 0 && ` · ${invite.channel_ids.map((id) => store.channels.get(id)?.name).filter(Boolean).map((name) => `#${name}`).join(" ")}`}
                    {invite.used_by.length > 0 && ` · 参加: ${invite.used_by.map(nameOf).join(", ")}`}
                  </div>
                </div>
                {active && (
                  <Button size="sm" variant="ghost" className="text-danger" title="このリンクを無効にする" disabled={busy} onClick={() => void run(async () => { await controller.api!.adminRevokeInvite(invite.id); })}>
                    <Ban size={14} /> 取り消す
                  </Button>
                )}
              </li>
            );
          })}
          {invites.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">招待リンクはまだありません</li>}
        </ul>
      )}
    </div>
  );
}
