import { Check, Hash, Lock, LogOut } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { MemberOut, UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar, presenceLabel } from "./Avatar";
import { StatusEmoji, UserPopover } from "./UserPopover";
import { activeStatus, expiryLabel } from "./users";
import { type SendKey } from "./prefs";
import { Badge, Button, cn, Field, Input, Kbd, Modal } from "./primitives";

interface DialogProps {
  controller: AppController;
  onClose: () => void;
  onOpen: (channelId: string) => void;
}

/** Selectable user rows shared by the DM and add-member dialogs. */
function UserPicker({ users, selected, onToggle, empty }: { users: UserPublic[]; selected: string[]; onToggle: (id: string) => void; empty: string }) {
  if (users.length === 0) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <ul className="max-h-72 overflow-y-auto rounded-xl border border-line">
      {users.map((u) => {
        const on = selected.includes(u.id);
        return (
          <li key={u.id}>
            <button
              type="button"
              onClick={() => onToggle(u.id)}
              aria-pressed={on}
              className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-panel", on && "bg-accent-soft/60")}
            >
              <Avatar id={u.id} name={u.display_name} size={28} />
              <span className="flex-1 truncate">
                {u.display_name} <span className="text-muted">@{u.username}</span>
              </span>
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full border", on ? "border-accent bg-accent text-white" : "border-line")}>{on && <Check size={12} />}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null;
}

export function NewDmDialog({ controller, onClose, onOpen }: DialogProps) {
  const me = controller.store.me?.id;
  const users = [...controller.store.users.values()].filter((u) => u.id !== me && !u.deactivated_at).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const create = async () => {
    if (!controller.api || selected.length === 0) return;
    try {
      const channel = await controller.api.createDm(selected);
      controller.store.upsertChannel(channel, { isMember: true });
      onOpen(channel.id);
      onClose();
    } catch (err) {
      setError(controller.describe(err));
    }
  };

  return (
    <Modal onClose={onClose} title="ダイレクトメッセージ" description="相手を選びます。複数選ぶとグループ DM になります。">
      <div className="mt-4 space-y-3">
        <UserPicker users={users} selected={selected} onToggle={toggle} empty="相手になるユーザーがいません" />
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            閉じる
          </Button>
          <Button onClick={() => void create()} disabled={selected.length === 0 || selected.length > 8}>
            開く
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function AddMemberDialog({ controller, channelId, onClose }: { controller: AppController; channelId: string; onClose: () => void }) {
  const me = controller.store.me?.id;
  const [members, setMembers] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const users = [...controller.store.users.values()].filter((u) => u.id !== me && !u.deactivated_at && !members?.has(u.id)).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));

  useEffect(() => {
    if (!controller.api) return;
    void controller.api.members(channelId).then((list) => setMembers(new Set(list.map((m) => m.user_id))), () => setMembers(new Set()));
  }, [controller.api, channelId]);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const add = async () => {
    if (!controller.api) return;
    try {
      for (const userId of selected) await controller.api.addMember(channelId, userId);
      onClose();
    } catch (err) {
      setError(controller.describe(err));
    }
  };

  return (
    <Modal onClose={onClose} title="メンバーを追加">
      <div className="mt-4 space-y-3">
        {members === null ? <p className="py-6 text-center text-sm text-muted">読み込み中…</p> : <UserPicker users={users} selected={selected} onToggle={toggle} empty="追加できるユーザーはいません" />}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            閉じる
          </Button>
          <Button onClick={() => void add()} disabled={selected.length === 0}>
            追加
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function NewChannelDialog({ controller, onClose, onOpen }: DialogProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"public" | "private">("public");
  const [error, setError] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!controller.api) return;
    try {
      const channel = await controller.api.createChannel(name.trim(), type);
      controller.store.upsertChannel(channel, { isMember: true });
      onOpen(channel.id);
      onClose();
    } catch (err) {
      setError(controller.describe(err));
    }
  };

  const option = (value: "public" | "private", icon: React.ReactNode, title: string, text: string) => (
    <button
      type="button"
      onClick={() => setType(value)}
      aria-pressed={type === value}
      className={cn("flex flex-1 items-start gap-3 rounded-xl border p-3 text-left transition-colors", type === value ? "border-accent bg-accent-soft/60" : "border-line hover:bg-panel")}
    >
      <span className="mt-0.5 text-muted">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{text}</span>
      </span>
    </button>
  );

  return (
    <Modal onClose={onClose} title="チャンネルを作成">
      <form className="mt-4 space-y-4" onSubmit={create}>
        <Field label="名前" hint="小文字の英数字とハイフンがおすすめです">
          <div className="relative">
            <Hash size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="general" pattern="[^\s#@/]{1,80}" required autoFocus className="pl-8" />
          </div>
        </Field>
        <div className="flex gap-2">
          {option("public", <Hash size={18} />, "パブリック", "誰でも参加できます")}
          {option("private", <Lock size={18} />, "プライベート", "招待されたメンバーだけ")}
        </div>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            閉じる
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            作成
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Members of a channel with the option to add more (channels only). */
export function MembersDialog({ controller, channel, onClose, onAdd }: { controller: AppController; channel: ChannelState; onClose: () => void; onAdd: () => void }) {
  const [members, setMembers] = useState<MemberOut[] | null>(null);
  const canManage = controller.isAdmin || channel.membership?.role === "owner";
  useEffect(() => {
    if (!controller.api) return;
    void controller.api.members(channel.id).then(setMembers, (error) => controller.setError(error));
  }, [controller, channel.id]);
  const users = controller.store.users;
  return (
    <Modal onClose={onClose} title={`メンバー${members ? ` (${members.length})` : ""}`}>
      <div className="mt-4 space-y-3">
        {members === null ? (
          <p className="py-6 text-center text-sm text-muted">読み込み中…</p>
        ) : (
          <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {members
              .map((m) => ({ member: m, user: users.get(m.user_id) }))
              .sort((a, b) => (a.user?.display_name ?? "").localeCompare(b.user?.display_name ?? "", "ja"))
              .map(({ member, user }) => (
                <li key={member.user_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <UserPopover controller={controller} userId={member.user_id} className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar id={member.user_id} name={user?.display_name ?? "?"} size={28} presence={controller.store.presenceOf(member.user_id)} />
                    <span className="flex-1 truncate">
                      {user?.display_name ?? "?"} <span className="text-muted">@{user?.username ?? ""}</span>
                      {user?.title && <span className="ml-1 text-xs text-muted">· {user.title}</span>}
                    </span>
                  </UserPopover>
                  <StatusEmoji controller={controller} userId={member.user_id} />
                  {controller.store.presenceOf(member.user_id) !== "offline" && (
                    <span className="text-xs text-muted">{presenceLabel(controller.store.presenceOf(member.user_id))}</span>
                  )}
                  {member.role === "owner" && <Badge tone="accent">オーナー</Badge>}
                  {canManage && member.user_id !== controller.store.me?.id && member.role !== "owner" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted hover:text-danger"
                      title="チャンネルから外す"
                      onClick={() => void controller.removeMember(channel.id, member.user_id).then((ok) => { if (ok) setMembers((list) => list?.filter((m) => m.user_id !== member.user_id) ?? null); })}
                    >
                      外す
                    </Button>
                  )}
                </li>
              ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            閉じる
          </Button>
          {channel.isMember && !channel.archived && <Button onClick={onAdd}>メンバーを追加</Button>}
        </div>
      </div>
    </Modal>
  );
}

export function TopicDialog({ controller, channel, onClose }: { controller: AppController; channel: ChannelState; onClose: () => void }) {
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await controller.updateTopic(channel.id, topic);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} title="トピック" description="このチャンネルで何を話すのかを一行で。">
      <form className="mt-4 space-y-4" onSubmit={save}>
        <Input value={topic} maxLength={250} autoFocus onChange={(e) => setTopic(e.target.value)} placeholder="例: 週次の進捗共有" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" disabled={busy}>
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Rename a channel (owner or admin, M11e). */
export function RenameChannelDialog({ controller, channel, onClose }: { controller: AppController; channel: ChannelState; onClose: () => void }) {
  const [name, setName] = useState(channel.name ?? "");
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await controller.renameChannel(channel.id, name);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} title="チャンネル名を変更" description="小文字の英数字と . _ - が使えます。">
      <form className="mt-4 space-y-4" onSubmit={save}>
        <Input value={name} pattern="[a-z0-9][a-z0-9._-]*" maxLength={80} autoFocus required onChange={(e) => setName(e.target.value.toLowerCase())} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || name.trim() === channel.name}>
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Profile (display name), password change and logout. */
export function SettingsDialog({ controller, onClose, onStatus }: { controller: AppController; onClose: () => void; onStatus?: () => void }) {
  const me = controller.store.me ?? controller.me;
  const [displayName, setDisplayName] = useState(me?.display_name ?? "");
  const [title, setTitle] = useState(me?.title ?? "");
  const [savedName, setSavedName] = useState(false);
  const status = activeStatus(me ? controller.store.users.get(me.id) ?? me : null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = (displayName.trim() !== me?.display_name ? await controller.updateDisplayName(displayName) : true)
      && ((title.trim() || null) !== (me?.title ?? null) ? await controller.updateProfile({ title: title.trim() || null }) : true);
    setBusy(false);
    setSavedName(ok);
  };
  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== repeat) {
      setPasswordMessage("新しいパスワードが一致しません");
      return;
    }
    setBusy(true);
    const error = await controller.changePasswordInSession(current, next);
    setBusy(false);
    setPasswordMessage(error ?? "パスワードを変更しました");
    if (!error) {
      setCurrent("");
      setNext("");
      setRepeat("");
    }
  };

  return (
    <Modal onClose={onClose} title="設定" className="w-[480px]">
      <div className="mt-4 space-y-6">
        {me && (
          <div className="flex items-center gap-3 rounded-xl bg-panel p-3">
            <Avatar id={me.id} name={me.display_name} size={44} className="rounded-xl" />
            <div className="min-w-0">
              <div className="truncate font-semibold">{me.display_name}</div>
              <div className="text-sm text-muted">@{me.username}</div>
            </div>
          </div>
        )}
        {onStatus && (
          <div className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
            <div className="min-w-0 flex-1 text-sm">
              {status ? (
                <span>
                  <span className="mr-1.5">{status.emoji}</span>
                  {status.text}
                  {expiryLabel(me?.status_expires_at) && <span className="ml-2 text-xs text-muted">{expiryLabel(me?.status_expires_at)}</span>}
                </span>
              ) : (
                <span className="text-muted">ステータスは未設定です</span>
              )}
            </div>
            <Button size="sm" variant="secondary" onClick={onStatus}>
              {status ? "ステータスを変更" : "ステータスを設定"}
            </Button>
          </div>
        )}
        <form className="space-y-3" onSubmit={saveName}>
          <Field label="表示名">
            <Input value={displayName} maxLength={80} onChange={(e) => { setDisplayName(e.target.value); setSavedName(false); }} required />
          </Field>
          <Field label="肩書 (任意)">
            <Input value={title} maxLength={80} placeholder="例: 開発 / 営業" onChange={(e) => { setTitle(e.target.value); setSavedName(false); }} />
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={busy || !displayName.trim() || (displayName.trim() === me?.display_name && (title.trim() || null) === (me?.title ?? null))}>
              プロフィールを保存
            </Button>
            {savedName && <span className="text-xs text-muted">保存しました</span>}
          </div>
        </form>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">送信キー</h3>
          <div className="flex gap-2">
            {(
              [
                ["shift-enter", "Shift+Enter で送信", "Enter は改行"],
                ["enter", "Enter で送信", "Shift+Enter は改行"],
              ] as Array<[SendKey, string, string]>
            ).map(([value, title, text]) => (
              <button
                key={value}
                type="button"
                aria-pressed={controller.sendKey === value}
                onClick={() => controller.setSendKey(value)}
                className={cn("flex-1 rounded-xl border p-3 text-left transition-colors", controller.sendKey === value ? "border-accent bg-accent-soft/60" : "border-line hover:bg-panel")}
              >
                <span className="block text-sm font-medium">{title}</span>
                <span className="block text-xs text-muted">{text}</span>
              </button>
            ))}
          </div>
        </div>
        <form className="space-y-3" onSubmit={savePassword}>
          <h3 className="text-sm font-semibold">パスワードの変更</h3>
          <Field label="現在のパスワード">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Field label="新しいパスワード (8 文字以上)">
            <Input type="password" value={next} minLength={8} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
          </Field>
          <Field label="新しいパスワード (確認)">
            <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
          </Field>
          {passwordMessage && <p className={cn("text-sm", passwordMessage.includes("しました") ? "text-muted" : "text-danger")}>{passwordMessage}</p>}
          <Button type="submit" size="sm" disabled={busy}>
            変更する
          </Button>
        </form>
        <div className="flex items-center justify-between border-t border-line pt-4">
          <Button variant="secondary" size="sm" onClick={() => void controller.logout()}>
            <LogOut size={14} /> ログアウト
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl/⌘ + K", "チャンネルや DM に移動"],
  ["Ctrl/⌘ + Shift + K", "新しい DM"],
  ["Ctrl/⌘ + F", "検索"],
  ["Ctrl/⌘ + Shift + T", "フォロー中のスレッド一覧"],
  ["Ctrl/⌘ + Shift + E", "チャンネルを探す"],
  ["Alt/⌥ + ↑ / ↓", "前 / 次のチャンネル"],
  ["Alt/⌥ + Shift + ↑ / ↓", "前 / 次の未読チャンネル"],
  ["Esc", "パネルを閉じる。何も開いていなければ表示中のチャンネルを既読にする"],
  ["↑ (空の入力欄)", "自分の最後のメッセージを編集"],
  ["Shift + ↑ (空の入力欄)", "最後のメッセージにスレッドで返信"],
  ["Shift + Enter / Enter", "送信 / 改行 (設定で入れ替え可能)"],
  ["Alt/⌥ + クリック", "そのメッセージから未読にする"],
  ["Ctrl/⌘ + B / I", "太字 / 斜体"],
  ["Ctrl/⌘ + Shift + X / C", "取り消し線 / コード"],
  ["Ctrl/⌘ + Shift + U", "リンクを挿入"],
  ["Tab / Shift + Tab", "リスト項目の字下げ / 戻し"],
  ["Ctrl/⌘ + U", "ファイルを添付"],
  ["Ctrl/⌘ + Shift + L", "入力欄にフォーカス"],
  ["Ctrl/⌘ + /", "この一覧"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} title="キーボードショートカット" className="w-[520px]">
      <table className="mt-4 w-full text-sm">
        <tbody className="divide-y divide-line">
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td className="whitespace-nowrap py-2 pr-4 align-top">
                <Kbd>{keys}</Kbd>
              </td>
              <td className="py-2 text-ink">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
