import { Copy, KeyRound, LogOut, MoreHorizontal, Pencil, Search, ShieldCheck, ShieldOff, UserCheck, UserPlus, UserX } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { describeError } from "../api/errors";
import type { AdminUserOut, Role } from "../api/types";
import type { AppController } from "../state/app";
import { readUsersView, USER_FILTERS, USER_SORTS, userFilterCounts, type UserFilter, type UserSort, visibleUsers, matchesUserSearch, writeUsersView } from "./adminUsers";
import { Avatar } from "./Avatar";
import { fullTimestamp } from "./format";
import { Badge, Button, cn, Field, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Modal } from "./primitives";
import { displayTitle } from "./roster";
import { USERNAME_HINT } from "./username";
import { UsernameEditor } from "./UsernameEditor";

const SELECT = "h-9 rounded-lg border border-line bg-canvas px-2 text-sm";

/**
 * 管理 →「ユーザー」 (M11e; 2026-10-04 redesign): one compact row per person (picture, name, @username, email, role and
 * state badges, title, created date) with every action in its ⋯ menu; a search box, filter chips with counts and a sort
 * above the list (the filter and the sort are remembered per device).
 */
export function UsersTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const me = store.me;
  const [users, setUsers] = useState<AdminUserOut[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", display_name: "", email: "", role: "member" as Role });
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);
  const [confirm, setConfirm] = useState<AdminUserOut | null>(null);
  // M96: 「ユーザー名を変更」 (anyone, bots included; administrators are not limited).
  const [renaming, setRenaming] = useState<AdminUserOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState(readUsersView);

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

  const changeView = (patch: Partial<{ filter: UserFilter; sort: UserSort }>) => {
    const next = { ...view, ...patch };
    setView(next);
    writeUsersView(next);
  };

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

  // The chips count what the search leaves, so a chip's number is what choosing it shows.
  const searched = useMemo(() => (users ?? []).filter((user) => matchesUserSearch(user, query)), [users, query]);
  const counts = useMemo(() => userFilterCounts(searched), [searched]);
  const shown = useMemo(() => (users ? visibleUsers(users, query, view.filter, view.sort) : []), [users, query, view]);
  const narrowed = !!users && shown.length !== users.length;

  return (
    <div className="mt-4 space-y-3">
      {issued && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft/50 p-3 text-sm">
          <div className="font-medium [overflow-wrap:anywhere]">@{issued.username} の仮パスワード</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="rounded bg-canvas px-2 py-1 font-mono text-base [overflow-wrap:anywhere]">{issued.password}</code>
            <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(issued.password)}>
              <Copy size={14} /> コピー
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>閉じる</Button>
          </div>
          <div className="mt-1 text-xs text-muted">本人に安全な方法で渡してください。初回ログイン時に変更を求められます。この表示を閉じると再表示できません。</div>
        </div>
      )}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-56">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input type="search" value={query} aria-label="ユーザーを検索" placeholder="名前・ユーザー名・メールで検索" className="h-9 pl-8" onChange={(e) => setQuery(e.target.value)} />
          </label>
          <select aria-label="並び順" value={view.sort} onChange={(e) => changeView({ sort: e.target.value as UserSort })} className={cn(SELECT, "max-sm:flex-1")}>
            {USER_SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div role="group" aria-label="絞り込み" className="flex flex-wrap gap-1">
          {USER_FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view.filter === value}
              onClick={() => changeView({ filter: value })}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors",
                view.filter === value ? "border-accent bg-accent-soft text-ink" : "border-line text-muted hover:text-ink",
              )}
            >
              {label}
              <span className="tabular-nums opacity-70">{counts[value]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted" aria-live="polite">{users ? (narrowed ? `${shown.length} 人 (全 ${users.length} 人)` : `${users.length} 人`) : "読み込み中…"}</span>
        <Button size="sm" onClick={() => setCreating((open) => !open)}>
          <UserPlus size={14} /> ユーザーを作成
        </Button>
      </div>
      {creating && (
        <form className="grid grid-cols-2 gap-3 rounded-xl border border-line p-3 max-sm:grid-cols-1" onSubmit={create}>
          <Field label="ユーザー名 (3〜32 文字、a-z 0-9 . _ -)" hint={USERNAME_HINT}>
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
          <div className="col-span-full flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(false)}>キャンセル</Button>
            <Button type="submit" size="sm" disabled={busy}>作成して仮パスワードを発行</Button>
          </div>
        </form>
      )}
      {users && (
        <ul aria-label="ユーザー" className="divide-y divide-line rounded-xl border border-line">
          {shown.map((user) => {
            const self = user.id === me?.id;
            const off = !!user.deactivated_at;
            const anonymized = user.username.startsWith("deleted-");
            const title = displayTitle(store.users.get(user.id)?.title, store.roster.get(user.id));
            return (
              <li key={user.id} data-user={user.username} className={cn("flex items-start gap-3 px-3 py-2 text-sm", off && "opacity-60")}>
                <Avatar id={user.id} name={user.display_name} size={30} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  {/* The name wraps rather than being cut; the badges follow it and wrap under it when the row is narrow. */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="min-w-0 font-medium [overflow-wrap:anywhere]" title={user.display_name}>{user.display_name}</span>
                    {user.role === "admin" && <Badge tone="accent">管理者</Badge>}
                    {user.role === "guest" && <Badge>ゲスト</Badge>}
                    {user.role === "bot" && <Badge>{store.aiAgentOf(user.id) ? "AI" : "BOT"}</Badge>}
                    {off && <Badge>無効</Badge>}
                    {user.must_change_password && !off && <Badge tone="danger">仮パスワード</Badge>}
                    {user.totp_enabled && <Badge tone="accent">2FA</Badge>}
                    {self && <span className="text-xs text-muted">自分</span>}
                  </div>
                  {/* The username keeps its width (cut only when it alone is wider than the row); the email gives way first. */}
                  <div className="flex min-w-0 items-baseline text-xs text-muted">
                    <span data-part="username" className="max-w-full shrink-0 truncate" title={`@${user.username}`}>@{user.username}</span>
                    {user.email && <span data-part="email" className="min-w-0 truncate" title={user.email}>&nbsp;· {user.email}</span>}
                  </div>
                  <div className="truncate text-[11px] text-muted" title={[title, `作成 ${fullTimestamp(user.created_at)}`].filter(Boolean).join(" · ")}>
                    {title && <>{title} · </>}作成 {fullTimestamp(user.created_at)}
                  </div>
                </div>
                <UserActions
                  user={user}
                  self={self}
                  busy={busy}
                  onRole={(role) => void run(async () => { await controller.api!.adminUpdateUser(user.id, { role }); })}
                  onRename={anonymized ? null : () => setRenaming(user)}
                  onResetPassword={() => void run(async () => { const out = await controller.api!.adminResetPassword(user.id); setIssued({ username: user.username, password: out.temporary_password }); })}
                  onRevokeSessions={() => void run(async () => { await controller.api!.adminRevokeSessions(user.id); })}
                  onResetTotp={() => void run(async () => { await controller.api!.adminResetTotp(user.id); })}
                  onDeactivate={() => void run(async () => { await controller.api!.adminUpdateUser(user.id, { deactivated: true }); })}
                  onReactivate={() => void run(async () => { await controller.api!.adminUpdateUser(user.id, { deactivated: false }); })}
                  onAnonymize={anonymized || self || user.role === "bot" ? null : () => setConfirm(user)}
                />
              </li>
            );
          })}
          {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">該当するユーザーはいません</li>}
        </ul>
      )}
      {renaming && (
        <Modal onClose={() => setRenaming(null)} title={`${renaming.display_name} のユーザー名を変更`} className="w-[480px]">
          <div className="mt-3">
            <UsernameEditor
              current={renaming.username}
              hasPassword={renaming.role !== "bot"}
              autoFocus
              onSubmit={async (name) => {
                try {
                  await controller.api!.adminUpdateUser(renaming.id, { username: name });
                  return null;
                } catch (error) {
                  return describeError(error);
                }
              }}
              onDone={() => { setRenaming(null); void load(); }}
            />
          </div>
        </Modal>
      )}
      {confirm && (
        <Modal onClose={() => setConfirm(null)} title="ユーザーを削除 (匿名化) しますか？" className="w-[440px]">
          <p className="mt-3 text-sm text-muted">@{confirm.username} の名前・メール・プロフィール・ログイン情報を消し、全セッションを終了します。メッセージは「退会したユーザー」として残ります。元に戻せません (本人の「アカウントを削除」と同じ処理です)。</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => { const target = confirm; setConfirm(null); void run(async () => { await controller.api!.adminAnonymizeUser(target.id); }); }}>
              削除 (匿名化) する
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * A row's ⋯ menu: what the row's buttons did before 2026-10-04, by the same rules. Someone else, active: role (not for
 * bots), ユーザー名を変更, パスワード再設定, セッション失効, 2FA を解除 (with 2FA), 無効化. Someone else, deactivated:
 * 再有効化, ユーザー名を変更, 匿名化 (not twice). Me: ユーザー名を変更 only. An anonymized person cannot be renamed.
 */
function UserActions({ user, self, busy, onRole, onRename, onResetPassword, onRevokeSessions, onResetTotp, onDeactivate, onReactivate, onAnonymize }: {
  user: AdminUserOut;
  self: boolean;
  busy: boolean;
  onRole: (role: Role) => void;
  onRename: (() => void) | null;
  onResetPassword: () => void;
  onRevokeSessions: () => void;
  onResetTotp: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onAnonymize: (() => void) | null;
}) {
  const off = !!user.deactivated_at;
  if (self && !onRename) return null;
  const rename = onRename && (
    <MenuItem disabled={busy} onSelect={onRename}>
      <Pencil size={14} /> ユーザー名を変更
    </MenuItem>
  );
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`${user.display_name} の操作`}
          title="操作"
          disabled={busy}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6 disabled:opacity-50"
        >
          <MoreHorizontal size={18} />
        </button>
      </MenuTrigger>
      <MenuContent className="max-w-[min(20rem,calc(100vw-2rem))]">
        <MenuLabel><span className="block truncate normal-case tracking-normal">{user.display_name} (@{user.username})</span></MenuLabel>
        {self ? (
          rename
        ) : !off ? (
          <>
            {user.role !== "bot" && (
              <>
                <MenuLabel><span className="inline-flex items-center gap-1 normal-case tracking-normal"><ShieldCheck size={12} /> ロール</span></MenuLabel>
                <MenuRadioGroup value={user.role} onValueChange={(value) => { if (value !== user.role) onRole(value as Role); }}>
                  <MenuRadioItem value="member" disabled={busy}>メンバー</MenuRadioItem>
                  <MenuRadioItem value="admin" disabled={busy}>管理者</MenuRadioItem>
                  <MenuRadioItem value="guest" disabled={busy}>ゲスト</MenuRadioItem>
                </MenuRadioGroup>
                <MenuSeparator />
              </>
            )}
            {rename}
            <MenuItem disabled={busy} title="仮パスワードを発行" onSelect={onResetPassword}>
              <KeyRound size={14} /> パスワード再設定 (仮パスワードを発行)
            </MenuItem>
            <MenuItem disabled={busy} title="全端末からログアウトさせる" onSelect={onRevokeSessions}>
              <LogOut size={14} /> セッション失効 (全端末からログアウト)
            </MenuItem>
            {user.totp_enabled && (
              <MenuItem disabled={busy} title="認証アプリを失くしたとき: 2 要素認証を解除する" onSelect={onResetTotp}>
                <ShieldOff size={14} /> 2FA を解除
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem disabled={busy} className="text-danger" title="無効化 (ログイン不可、表示は残る)" onSelect={onDeactivate}>
              <UserX size={14} /> 無効化 (ログイン不可、表示は残る)
            </MenuItem>
            {/* M104: the same deletion as the person's own 「アカウントを削除」 (docs/MODERATION.md §2). */}
            {onAnonymize && (
              <MenuItem disabled={busy} className="text-danger" onSelect={onAnonymize}>
                <UserX size={14} /> 削除 (匿名化)…
              </MenuItem>
            )}
          </>
        ) : (
          <>
            <MenuItem disabled={busy} onSelect={onReactivate}>
              <UserCheck size={14} /> 再有効化
            </MenuItem>
            {rename}
            {onAnonymize && (
              <>
                <MenuSeparator />
                <MenuItem disabled={busy} className="text-danger" onSelect={onAnonymize}>
                  <UserX size={14} /> 削除 (匿名化)…
                </MenuItem>
              </>
            )}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
