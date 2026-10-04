import { AiChannelNotice } from "./ai";
import { Check, Hash, Lock, NotebookPen } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { MemberOut, UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar, presenceLabel } from "./Avatar";
import { myName, SELF_NOTES_HINT } from "./channels";
import { StatusEmoji, UserPopover } from "./UserPopover";
import { compareByRoster, rosterLabel, titleExtra } from "./roster";
import { Badge, Button, cn, Field, Input, Kbd, Modal } from "./primitives";

// The settings (M40) are in Settings.tsx: the phone's 「自分」 list and the wide layout's dialog.

interface DialogProps {
  controller: AppController;
  onClose: () => void;
  onOpen: (channelId: string) => void;
}

/** Selectable user rows shared by the DM and add-member dialogs. */
export function UserPicker({ users, selected, onToggle, empty }: { users: UserPublic[]; selected: string[]; onToggle: (id: string) => void; empty: string }) {
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
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full border", on ? "border-accent bg-accent-solid text-white" : "border-line")}>{on && <Check size={12} />}</span>
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

  const create = () => open(selected);
  const open = async (userIds: string[]) => {
    if (!controller.api || userIds.length === 0) return;
    try {
      const channel = await controller.api.createDm(userIds);
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
        {/* A DM with only myself, titled with my name (as in Slack / Mattermost). */}
        {me && (
          <button
            type="button"
            onClick={() => void open([me])}
            className="flex w-full items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-left text-sm hover:bg-panel"
          >
            <NotebookPen size={16} className="shrink-0 text-muted" />
            <span className="shrink-0 font-medium">{myName(controller.store.users, me, controller.store.me)}</span>
            <span className="min-w-0 truncate text-xs text-muted">{SELF_NOTES_HINT}</span>
          </button>
        )}
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);
  const users = [...controller.store.users.values()].filter((u) => u.id !== me && !u.deactivated_at && !members?.has(u.id)).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));

  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    setSelected([]);
    setLoadError(null);
    setError(null);
    const api = controller.api;
    void (async () => {
      try {
        if (!api) throw new Error("接続を確認してください");
        const list = await api.members(channelId);
        if (!cancelled) setMembers(new Set(list.map((m) => m.user_id)));
      } catch (error) {
        if (!cancelled) setLoadError(controller.describe(error));
      }
    })();
    return () => { cancelled = true; };
  }, [controller, controller.api, channelId, attempt]);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const add = async () => {
    if (!controller.api || members === null || adding || selected.length === 0) return;
    setAdding(true);
    setError(null);
    try {
      // M88: everyone chosen in one request (one 「追加しました」 line in the channel).
      await controller.api.addMembers(channelId, selected);
      onClose();
    } catch (err) {
      setError(controller.describe(err));
    } finally { setAdding(false); }
  };

  return (
    <Modal onClose={onClose} title="メンバーを追加">
      <div className="mt-4 space-y-3">
        {loadError !== null ? (
          <div className="space-y-2 py-4 text-sm">
            <p role="alert">メンバー一覧を読み込めませんでした</p>
            <p className="text-muted">{loadError}</p>
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>再試行</Button>
          </div>
        ) : members === null ? <p role="status" className="py-6 text-center text-sm text-muted">読み込み中…</p> : <UserPicker users={users} selected={selected} onToggle={toggle} empty="追加できるユーザーはいません" />}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            閉じる
          </Button>
          <Button onClick={() => void add()} disabled={members === null || adding || selected.length === 0}>
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
  const [members, setMembers] = useMembers(controller, channel.id);
  return (
    <Modal onClose={onClose} title={`メンバー${members ? ` (${members.length})` : ""}`}>
      <div className="mt-4 space-y-3">
        {/* M65 (docs/AI.md §4): an AI bot among the members. */}
        <AiChannelNotice controller={controller} memberIds={members ? members.map((m) => m.user_id) : null} />
        <MemberList controller={controller} channel={channel} members={members} onChange={setMembers} className="max-h-80" />
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

/**
 * A conversation's members, fetched on open and again when `reload` changes or the members change (added, removed, an
 * owner made or taken back: the store's revision, L4); null while loading.
 */
export function useMembers(controller: AppController, channelId: string, reload: unknown = null) {
  const [members, setMembers] = useState<MemberOut[] | null>(null);
  const revision = controller.store.membersRevision(channelId);
  useEffect(() => {
    if (!controller.api) return;
    let current = true;
    void controller.api.members(channelId).then((list) => { if (current) setMembers(list); }, (error) => controller.setError(error));
    return () => { current = false; };
  }, [controller, channelId, reload, revision]);
  return [members, setMembers] as const;
}

/**
 * The member rows (roster order, badges, and for owners and admins 「オーナーにする」 / 「オーナーから外す」 (L4) and 「外す」);
 * in the dialog and the channel details (M29).
 */
export function MemberList({ controller, channel, members, onChange, className }: {
  controller: AppController;
  channel: ChannelState;
  members: MemberOut[] | null;
  onChange: (update: (members: MemberOut[] | null) => MemberOut[] | null) => void;
  className?: string;
}) {
  // Not in a DM (its members are the conversation itself).
  const canManage = (controller.isAdmin || channel.membership?.role === "owner") && (channel.type === "public" || channel.type === "private");
  const users = controller.store.users;
  const roster = controller.store.roster;
  const setMembers = onChange;
  return members === null ? (
          <p className="py-6 text-center text-sm text-muted">読み込み中…</p>
        ) : (
          <ul className={cn("divide-y divide-line overflow-y-auto rounded-xl border border-line", className)}>
            {members
              .map((m) => ({ member: m, user: users.get(m.user_id) }))
              // M23: roster order when either is on the lab roster, else by name.
              .sort((a, b) => (a.user && b.user && (roster.has(a.user.id) || roster.has(b.user.id)) ? compareByRoster(a.user, b.user, roster) : (a.user?.display_name ?? "").localeCompare(b.user?.display_name ?? "", "ja")))
              .map(({ member, user }) => (
                <li key={member.user_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <UserPopover controller={controller} userId={member.user_id} className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar id={member.user_id} name={user?.display_name ?? "?"} size={28} presence={controller.store.presenceOf(member.user_id)} />
                    <span className="flex-1 truncate">
                      {user?.display_name ?? "?"} <span className="text-muted">@{user?.username ?? ""}</span>
                      {/* The roster label is the badge below; the title adds the rest (LAB.md 「肩書と名簿」). */}
                      {titleExtra(user?.title, roster.get(member.user_id)) && <span className="ml-1 text-xs text-muted">· {titleExtra(user?.title, roster.get(member.user_id))}</span>}
                    </span>
                  </UserPopover>
                  <StatusEmoji controller={controller} userId={member.user_id} />
                  {controller.store.presenceOf(member.user_id) !== "offline" && (
                    <span className="text-xs text-muted">{presenceLabel(controller.store.presenceOf(member.user_id))}</span>
                  )}
                  {roster.get(member.user_id) && <Badge>{rosterLabel(roster.get(member.user_id)!)}</Badge>}
                  {member.role === "owner" && <Badge tone="accent">オーナー</Badge>}
                  {controller.store.users.get(member.user_id)?.role === "guest" && <Badge>ゲスト</Badge>}
                  {/* L4: not for guests and bots (403 owner_not_allowed); the last owner is the server's to keep (409 last_owner). */}
                  {canManage && !channel.archived && (member.role === "owner" || (user?.role !== "guest" && user?.role !== "bot")) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted hover:text-ink"
                      onClick={() => {
                        const role = member.role === "owner" ? "member" : "owner";
                        void controller.setMemberRole(channel.id, member.user_id, role).then((updated) => {
                          if (updated) setMembers((list) => list?.map((m) => (m.user_id === updated.user_id ? updated : m)) ?? null);
                        });
                      }}
                    >
                      {member.role === "owner" ? "オーナーから外す" : "オーナーにする"}
                    </Button>
                  )}
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

const SHORTCUTS: Array<[string, string]> = [
  ["F6 / Shift + F6", "サイドバー・メッセージ一覧・入力欄へ移動"],
  ["↑ / ↓・Home / End (メッセージ上)", "前後・読み込み済みの先頭/末尾のメッセージへ移動"],
  ["Enter / Shift + F10 (メッセージ上)", "メッセージの操作ボタンへ移動 (Tab で選択)"],
  ["→ / T (メッセージ上)", "スレッドを開く"],
  ["Ctrl/⌘ + K", "チャンネルや DM に移動"],
  ["Ctrl/⌘ + Shift + K", "新しい DM"],
  ["Ctrl/⌘ + F", "検索 (↑↓ で候補を選び Enter)"],
  ["Ctrl/⌘ + 1〜9", "n 番目のワークスペースに切り替え (デスクトップ版)"],
  ["Ctrl/⌘ + Shift + T", "フォロー中のスレッド一覧"],
  ["Ctrl/⌘ + Shift + E", "チャンネルを探す"],
  ["Alt/⌥ + ↑ / ↓", "前 / 次のチャンネル"],
  ["Alt/⌥ + Shift + ↑ / ↓", "前 / 次の未読チャンネル"],
  ["⌘ + [ / ]・Alt + ← / → (Windows)", "履歴を戻る / 進む (マウスの戻る / 進むボタンも)"],
  ["⌘ + ← / → (Mac、入力欄の外)", "履歴を戻る / 進む"],
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
