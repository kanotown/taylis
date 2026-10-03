import { Archive, ArchiveRestore, Copy, KeyRound, NotebookPen, Pencil, ShieldCheck, UserPlus, UserX } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { AdminUserOut, Role } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { AiTab, USERNAME_FIXED_HINT } from "./AiTab";
import { Avatar } from "./Avatar";
import { fullTimestamp } from "./format";
import { CanvasTemplatesTab } from "./CanvasTemplatesTab";
import { EmojiAdminTab } from "./customEmoji";
import { GroupsTab } from "./GroupsTab";
import { InvitesTab } from "./InvitesTab";
import { RosterTab } from "./RosterTab";
import { WebhooksTab } from "./WebhooksTab";
import { WorkspaceSettingsTab } from "./WorkspaceSettingsTab";
import { Badge, Button, cn, Field, Input, Modal, UNDERLINE_TAB, UNDERLINE_TAB_ROW } from "./primitives";

type Tab = "users" | "roster" | "groups" | "invites" | "webhooks" | "ai" | "workspace" | "channels" | "emoji" | "canvas-templates";

/** Administration (M11e): users (create, role, deactivate, reset password, sessions, anonymize) and channels (rename, archive). */
export function AdminDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  return (
    // One height for every tab (the body scrolls): sized to its content, the dialog jumped and re-centred on each switch.
    <Modal onClose={onClose} title="管理" className="flex h-[80dvh] w-[760px] flex-col overflow-hidden">
      <AdminBody controller={controller} className="mt-3" />
    </Modal>
  );
}

/**
 * The administration tabs: in the dialog above, and as 「管理」 in the settings (M40: the phone's 「自分」 → 管理 and the
 * wide settings dialog's section), every item as it was.
 */
export function AdminBody({ controller, className }: { controller: AppController; className?: string }) {
  const [tab, setTab] = useState<Tab>("users");
  // M65: 「AI」 only on a server that has the AI routes (GET /ai/status answered; docs/AI.md §5).
  const ai = controller.store.aiStatus !== null;
  const shown: Tab = tab === "ai" && !ai ? "users" : tab;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div role="tablist" aria-label="管理" className={cn(UNDERLINE_TAB_ROW, "gap-1")}>
        {(
          [
            ["users", "ユーザー"],
            ["roster", "名簿"],
            ["groups", "グループ"],
            ["invites", "招待"],
            ["webhooks", "Webhook"],
            ...(ai ? [["ai", "AI"]] : []),
            ["workspace", "設定"],
            ["channels", "チャンネル"],
            ["emoji", "絵文字"],
            ["canvas-templates", "キャンバス"],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={shown === value}
            onClick={() => setTab(value)}
            className={cn(UNDERLINE_TAB, "px-3 py-2 max-md:px-2.5", shown === value ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown === "ai" ? <AiTab controller={controller} /> : shown === "workspace" ? <WorkspaceSettingsTab controller={controller} /> : shown === "users" ? <UsersTab controller={controller} /> : shown === "roster" ? <RosterTab controller={controller} /> : shown === "groups" ? <GroupsTab controller={controller} /> : shown === "invites" ? <InvitesTab controller={controller} /> : shown === "webhooks" ? <WebhooksTab controller={controller} /> : shown === "channels" ? <ChannelsTab controller={controller} /> : shown === "canvas-templates" ? <CanvasTemplatesTab controller={controller} /> : <EmojiAdminTab controller={controller} />}
      </div>
    </div>
  );
}

function UsersTab({ controller }: { controller: AppController }) {
  const me = controller.store.me;
  const [users, setUsers] = useState<AdminUserOut[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", display_name: "", email: "", role: "member" as Role });
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);
  const [confirm, setConfirm] = useState<AdminUserOut | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!controller.api) return;
    try {
      setUsers(await controller.api.adminListUsers());
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
      const created = await controller.api!.adminCreateUser({ username: form.username.trim(), display_name: form.display_name.trim(), email: form.email.trim() || null, role: form.role });
      setIssued({ username: created.user.username, password: created.temporary_password });
      setForm({ username: "", display_name: "", email: "", role: "member" });
      setCreating(false);
    });
  };

  return (
    <div className="mt-4 space-y-4">
      {issued && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft/50 p-3 text-sm">
          <div className="font-medium">@{issued.username} の仮パスワード</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="rounded bg-canvas px-2 py-1 font-mono text-base">{issued.password}</code>
            <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(issued.password)}>
              <Copy size={14} /> コピー
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>閉じる</Button>
          </div>
          <div className="mt-1 text-xs text-muted">本人に安全な方法で渡してください。初回ログイン時に変更を求められます。この表示を閉じると再表示できません。</div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{users ? `${users.length} 人` : "読み込み中…"}</span>
        <Button size="sm" onClick={() => setCreating((open) => !open)}>
          <UserPlus size={14} /> ユーザーを作成
        </Button>
      </div>
      {creating && (
        <form className="grid grid-cols-2 gap-3 rounded-xl border border-line p-3" onSubmit={create}>
          <Field label="ユーザー名 (3〜32 文字、a-z 0-9 . _ -)" hint={USERNAME_FIXED_HINT}>
            <Input value={form.username} pattern="[a-z0-9._-]{3,32}" required autoFocus onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} />
          </Field>
          <Field label="表示名">
            <Input value={form.display_name} maxLength={80} required onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          </Field>
          <Field label="メール (任意)">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="ロール">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
              <option value="member">メンバー</option>
              <option value="admin">管理者</option>
              <option value="guest">ゲスト (参加したチャンネルだけ)</option>
            </select>
          </Field>
          <div className="col-span-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(false)}>キャンセル</Button>
            <Button type="submit" size="sm" disabled={busy}>作成して仮パスワードを発行</Button>
          </div>
        </form>
      )}
      {users && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {users.map((user) => {
            const self = user.id === me?.id;
            const off = !!user.deactivated_at;
            return (
              <li key={user.id} className={cn("flex flex-wrap items-center gap-3 px-3 py-2 text-sm max-md:gap-y-1.5", off && "opacity-60")}>
                <Avatar id={user.id} name={user.display_name} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 max-md:flex-wrap max-md:gap-y-0.5">
                    <span className="truncate font-medium">{user.display_name}</span>
                    <span className="truncate text-xs text-muted">@{user.username}{user.email ? ` · ${user.email}` : ""}</span>
                    {user.role === "admin" && <Badge tone="accent">管理者</Badge>}
                    {user.role === "guest" && <Badge>ゲスト</Badge>}
                    {user.role === "bot" && <Badge>{controller.store.aiAgentOf(user.id) ? "AI" : "BOT"}</Badge>}
                    {off && <Badge>無効</Badge>}
                    {user.must_change_password && !off && <Badge tone="danger">仮パスワード</Badge>}
                    {user.totp_enabled && <Badge tone="accent">2FA</Badge>}
                  </div>
                  <div className="text-[11px] text-muted">作成 {fullTimestamp(user.created_at)}</div>
                </div>
                {/* On a phone the actions take a line of their own under the name. */}
                {!self && !off && (
                  <div className="flex items-center gap-1 max-md:w-full max-md:flex-wrap max-md:pl-[42px]">
                    {user.role !== "bot" && (
                      <label className="flex items-center gap-1 text-xs text-muted" title="ロール">
                        <ShieldCheck size={14} />
                        <select value={user.role} disabled={busy} onChange={(e) => void run(async () => { await controller.api!.adminUpdateUser(user.id, { role: e.target.value as Role }); })} className="h-7 rounded-md border border-line bg-canvas px-1.5 text-xs">
                          <option value="member">メンバー</option>
                          <option value="admin">管理者</option>
                          <option value="guest">ゲスト</option>
                        </select>
                      </label>
                    )}
                    <Button size="sm" variant="ghost" title="仮パスワードを発行" disabled={busy} onClick={() => void run(async () => { const out = await controller.api!.adminResetPassword(user.id); setIssued({ username: user.username, password: out.temporary_password }); })}>
                      <KeyRound size={14} /> 再設定
                    </Button>
                    <Button size="sm" variant="ghost" title="全端末からログアウトさせる" disabled={busy} onClick={() => void run(async () => { await controller.api!.adminRevokeSessions(user.id); })}>
                      セッション失効
                    </Button>
                    {user.totp_enabled && (
                      <Button size="sm" variant="ghost" title="認証アプリを失くしたとき: 2 要素認証を解除する" disabled={busy} onClick={() => void run(async () => { await controller.api!.adminResetTotp(user.id); })}>
                        2FA を解除
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="text-danger" title="無効化 (ログイン不可、表示は残る)" disabled={busy} onClick={() => void run(async () => { await controller.api!.adminUpdateUser(user.id, { deactivated: true }); })}>
                      <UserX size={14} /> 無効化
                    </Button>
                  </div>
                )}
                {!self && off && (
                  <div className="flex items-center gap-1 max-md:w-full max-md:flex-wrap max-md:pl-[42px]">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await controller.api!.adminUpdateUser(user.id, { deactivated: false }); })}>
                      再有効化
                    </Button>
                    {!user.username.startsWith("deleted-") && (
                      <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setConfirm(user)}>
                        匿名化
                      </Button>
                    )}
                  </div>
                )}
                {self && <span className="text-xs text-muted">自分</span>}
              </li>
            );
          })}
        </ul>
      )}
      {confirm && (
        <Modal onClose={() => setConfirm(null)} title="ユーザーを匿名化しますか？" className="w-[440px]">
          <p className="mt-3 text-sm text-muted">@{confirm.username} の名前・メールを消し、全セッションを終了します。メッセージは「削除されたユーザー」として残ります。元に戻せません。</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => { const target = confirm; setConfirm(null); void run(async () => { await controller.api!.adminAnonymizeUser(target.id); }); }}>
              匿名化する
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ChannelsTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const channels = [...store.channels.values()].filter((c) => c.type === "public" || c.type === "private").sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const [renaming, setRenaming] = useState<ChannelState | null>(null);
  const [name, setName] = useState("");
  const [archiving, setArchiving] = useState<ChannelState | null>(null);
  // M24: whose times a channel is (for channels made before times existed, e.g. a Mattermost import).
  const [marking, setMarking] = useState<ChannelState | null>(null);
  const [timesOwner, setTimesOwner] = useState("");
  const people = [...store.users.values()].filter((u) => !u.deactivated_at && u.role !== "guest" && u.role !== "bot").sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  const [busy, setBusy] = useState(false);

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renaming) return;
    setBusy(true);
    const ok = await controller.renameChannel(renaming.id, name);
    setBusy(false);
    if (ok) setRenaming(null);
  };

  return (
    <div className="mt-4 space-y-3">
      <p className="text-xs text-muted">参加していない非公開チャンネルはここに出ません。アーカイブすると投稿できなくなりますが、履歴と検索は残ります。</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {channels.map((channel) => (
          <li key={channel.id} className={cn("flex items-center gap-3 px-3 py-2 text-sm", channel.archived && "opacity-60")}>
            <span className="text-muted">{channel.type === "private" ? "🔒" : "#"}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{channel.name}</span>
                {channel.archived && <Badge>アーカイブ済み</Badge>}
                {!channel.isMember && <Badge>未参加</Badge>}
                {channel.times_owner_id && <Badge tone="accent">{store.users.get(channel.times_owner_id)?.display_name ?? "?"} の times</Badge>}
              </div>
              {channel.topic && <div className="truncate text-xs text-muted">{channel.topic}</div>}
            </div>
            {channel.archived && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setBusy(true); void controller.unarchiveChannel(channel.id).then(() => setBusy(false)); }}>
                <ArchiveRestore size={14} /> アーカイブを解除
              </Button>
            )}
            {!channel.archived && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRenaming(channel); setName(channel.name ?? ""); }}>
                  <Pencil size={14} /> 名前を変更
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} title="誰かの times (作業ログ) として扱う" onClick={() => { setMarking(channel); setTimesOwner(channel.times_owner_id ?? ""); }}>
                  <NotebookPen size={14} /> {channel.times_owner_id ? "times を変更" : "times にする"}
                </Button>
                <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setArchiving(channel)}>
                  <Archive size={14} /> アーカイブ
                </Button>
              </div>
            )}
          </li>
        ))}
        {channels.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">チャンネルがありません</li>}
      </ul>
      {marking && (
        <Modal onClose={() => setMarking(null)} title={`#${marking.name} を times にする`} className="w-[420px]">
          <form
            className="mt-3 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              void controller.setTimesOwner(marking.id, timesOwner || null).then((ok) => { setBusy(false); if (ok) setMarking(null); });
            }}
          >
            <p className="text-xs text-muted">その人の作業ログとして扱います。他の人には静かな未読 (メンションのときだけ通知) になり、その人はチャンネルのオーナーになります。1 人 1 つまでです。</p>
            <Field label="誰の times か">
              <select value={timesOwner} onChange={(e) => setTimesOwner(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
                <option value="">times にしない</option>
                {people.map((u) => <option key={u.id} value={u.id}>{u.display_name} (@{u.username})</option>)}
              </select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setMarking(null)}>キャンセル</Button>
              <Button type="submit" disabled={busy || timesOwner === (marking.times_owner_id ?? "")}>保存</Button>
            </div>
          </form>
        </Modal>
      )}
      {renaming && (
        <Modal onClose={() => setRenaming(null)} title="チャンネル名を変更" className="w-[440px]">
          <form className="mt-4 space-y-4" onSubmit={rename}>
            <Input value={name} pattern="[a-z0-9][a-z0-9._-]*" maxLength={80} autoFocus required onChange={(e) => setName(e.target.value.toLowerCase())} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setRenaming(null)}>キャンセル</Button>
              <Button type="submit" disabled={busy || !name.trim() || name.trim() === renaming.name}>保存</Button>
            </div>
          </form>
        </Modal>
      )}
      {archiving && (
        <ArchiveConfirm channel={archiving} busy={busy} onClose={() => setArchiving(null)} onConfirm={() => { setBusy(true); void controller.archiveChannel(archiving.id).then((ok) => { setBusy(false); if (ok) setArchiving(null); }); }} />
      )}
    </div>
  );
}

export function ArchiveConfirm({ channel, busy, onClose, onConfirm }: { channel: ChannelState; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal onClose={onClose} title={`#${channel.name} をアーカイブしますか？`} className="w-[440px]">
      <p className="mt-3 text-sm text-muted">以後は投稿できなくなります。履歴の閲覧と検索はできます。元に戻す操作は用意していません。</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>キャンセル</Button>
        <Button variant="danger" disabled={busy} onClick={onConfirm}>アーカイブする</Button>
      </div>
    </Modal>
  );
}
