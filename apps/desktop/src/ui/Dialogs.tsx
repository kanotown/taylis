import { Bell, Check, EyeOff, Hash, ImagePlus, Lock, LogOut, NotebookPen, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import type { MemberOut, TotpStatusOut, UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { Avatar, presenceLabel } from "./Avatar";
import { TotpDisableDialog, TotpSetupDialog } from "./TotpDialog";
import { StatusEmoji, UserPopover } from "./UserPopover";
import { activeStatus, expiryLabel } from "./users";
import { type SendKey } from "./prefs";
import { compareByRoster, rosterLabel } from "./roster";
import { TemplatesSettings } from "./TemplatesSettings";
import { isTauri } from "../platform/env";
import { notificationPermission, type NotificationPermissionState, requestNotificationPermission } from "../platform/notify";
import { Badge, Button, cn, Field, Input, Kbd, Modal } from "./primitives";

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
        {/* A DM with only myself: notes to self (as in Slack). */}
        {me && (
          <button
            type="button"
            onClick={() => void open([me])}
            className="flex w-full items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-left text-sm hover:bg-panel"
          >
            <NotebookPen size={16} className="text-muted" />
            <span className="font-medium">自分へのメモ</span>
            <span className="text-xs text-muted">自分だけが見られる DM</span>
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
      for (const userId of selected) {
        await controller.api.addMember(channelId, userId);
        setMembers((values) => new Set([...(values ?? []), userId]));
        setSelected((values) => values.filter((id) => id !== userId));
      }
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
                      {user?.title && <span className="ml-1 text-xs text-muted">· {user.title}</span>}
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

/** Profile (display name), password change and logout. */
export function SettingsDialog({ controller, onClose, onStatus }: { controller: AppController; onClose: () => void; onStatus?: () => void }) {
  return (
    <Modal onClose={onClose} title="設定" className="w-[480px]">
      <SettingsBody controller={controller} onClose={onClose} onStatus={onStatus} className="mt-4" />
    </Modal>
  );
}

/**
 * The settings' content: in the dialog above, and as the phone's 「自分」 tab page (M34), which has no 「閉じる」
 * (`onClose` absent).
 */
export function SettingsBody({ controller, onClose, onStatus, className }: { controller: AppController; onClose?: () => void; onStatus?: () => void; className?: string }) {
  const me = controller.store.me ?? controller.me;
  const [displayName, setDisplayName] = useState(me?.display_name ?? "");
  const [title, setTitle] = useState(me?.title ?? "");
  // M12g: notification keywords, edited as a comma-separated line.
  const [keywords, setKeywords] = useState((me?.notify_keywords ?? []).join(", "));
  // M23: my research topic and reading, when an administrator has put me on the lab roster.
  const line = me ? controller.store.roster.get(me.id) : undefined;
  const [topic, setTopic] = useState(line?.research_topic ?? "");
  const [reading, setReading] = useState(line?.reading ?? "");
  const lineChanged = !!line && ((topic.trim() || null) !== (line.research_topic ?? null) || (reading.trim() || null) !== (line.reading ?? null));
  const parsedKeywords = keywords.split(/[,、\n]/).map((k) => k.trim()).filter(Boolean).slice(0, 20);
  const keywordsChanged = JSON.stringify(parsedKeywords) !== JSON.stringify(me?.notify_keywords ?? []);
  const [savedName, setSavedName] = useState(false);
  const status = activeStatus(me ? controller.store.users.get(me.id) ?? me : null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  // M12i: whether my account asks for an authenticator code, and the setup / disable flows.
  const [totp, setTotp] = useState<TotpStatusOut | null>(null);
  const [totpDialog, setTotpDialog] = useState<"setup" | "disable" | null>(null);
  useEffect(() => {
    void controller.totpStatus().then(setTotp);
  }, [controller]);
  // Whether the OS may show our notifications. A browser grants that only on the reader's own click (「通知を許可」
  // below), never for a request made when a message arrived (platform/notify.ts).
  const [permission, setPermission] = useState<NotificationPermissionState | null>(null);
  useEffect(() => {
    let current = true;
    void notificationPermission().then((state) => { if (current) setPermission(state); });
    return () => { current = false; };
  }, []);

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = (displayName.trim() !== me?.display_name ? await controller.updateDisplayName(displayName) : true)
      && ((title.trim() || null) !== (me?.title ?? null) ? await controller.updateProfile({ title: title.trim() || null }) : true)
      && (keywordsChanged ? await controller.updateProfile({ notify_keywords: parsedKeywords }) : true)
      && (lineChanged ? await controller.updateMyRosterLine({ research_topic: topic.trim() || null, reading: reading.trim() || null }) : true);
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
    <>
      {cropping && (
        <AvatarCropDialog
          file={cropping}
          onCancel={() => setCropping(null)}
          onDone={(picture) => {
            setCropping(null);
            void controller.uploadAvatar(new File([picture], "avatar.jpg", { type: "image/jpeg" }));
          }}
        />
      )}
      <div className={cn("space-y-6", className)}>
        {me && (
          <div className="flex items-center gap-3 rounded-xl bg-panel p-3">
            <Avatar id={me.id} name={me.display_name} size={44} className="rounded-xl" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{me.display_name}</div>
              <div className="text-sm text-muted">@{me.username}</div>
            </div>
            {/* M16g: any photo; the crop dialog turns the chosen square into a small JPEG before it is sent. */}
            <input ref={avatarInput} type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) setCropping(file); }} />
            <Button size="sm" variant="secondary" onClick={() => avatarInput.current?.click()} title="プロフィール画像: 写真を選んで、使う範囲を決めます">
              <ImagePlus size={14} /> 写真
            </Button>
            {me.avatar_updated_at && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => void controller.deleteAvatar()}>
                削除
              </Button>
            )}
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
          {line && (
            <>
              <Field label="研究テーマ (任意)">
                <Input value={topic} maxLength={200} placeholder="例: 拡散モデルによる音声合成" onChange={(e) => { setTopic(e.target.value); setSavedName(false); }} />
              </Field>
              <Field label="よみ (任意、名簿の並び順に使います)">
                <Input value={reading} maxLength={80} placeholder="例: かのう とおる" onChange={(e) => { setReading(e.target.value); setSavedName(false); }} />
              </Field>
            </>
          )}
          <Field label="通知キーワード (任意、コンマ区切り・20 個まで)">
            <Input value={keywords} placeholder="例: 加納, kano, リリース" onChange={(e) => { setKeywords(e.target.value); setSavedName(false); }} />
            <div className="mt-1 text-xs text-muted">本文に含まれると @メンションと同じように知らせます (大文字小文字は区別しません)</div>
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={busy || !displayName.trim() || (displayName.trim() === me?.display_name && (title.trim() || null) === (me?.title ?? null) && !keywordsChanged && !lineChanged)}>
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
        <TemplatesSettings controller={controller} />
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">通知</h3>
          <div className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
            <Bell size={18} className={permission === "granted" ? "text-success" : "text-muted"} />
            <div className="min-w-0 flex-1 text-sm">
              {permission === null ? (
                <span className="text-muted">確認中…</span>
              ) : permission === "granted" ? (
                <span>
                  許可済み <span className="ml-1 text-xs text-muted">新しいメッセージを OS の通知で知らせます</span>
                </span>
              ) : permission === "denied" ? (
                <span>
                  ブロック中 <span className="ml-1 text-xs text-muted">{isTauri() ? "OS の設定" : "ブラウザのサイト設定"}で許可してください</span>
                </span>
              ) : permission === "unsupported" ? (
                <span className="text-muted">このブラウザでは使えません</span>
              ) : (
                <span>
                  未設定 <span className="ml-1 text-xs text-muted">許可すると新しいメッセージを OS の通知で知らせます</span>
                </span>
              )}
            </div>
            {permission === "default" && (
              <Button size="sm" variant="secondary" onClick={() => void requestNotificationPermission().then(setPermission)}>
                通知を許可
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">プライバシー</h3>
          {/* L4 (M31): the server shows me as offline to everyone (me included) while this is on. */}
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2">
            <EyeOff size={18} className="text-muted" />
            <span className="min-w-0 flex-1 text-sm">
              在席を隠す <span className="ml-1 text-xs text-muted">ほかの人からは常にオフラインに見えます</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="h-4 w-4 accent-[var(--accent)]"
              checked={me?.presence_hidden ?? false}
              disabled={busy}
              onChange={(e) => { const hidden = e.target.checked; setBusy(true); void controller.updateProfile({ presence_hidden: hidden }).finally(() => setBusy(false)); }}
            />
          </label>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">2 要素認証</h3>
          <div className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
            <ShieldCheck size={18} className={totp?.enabled ? "text-success" : "text-muted"} />
            <div className="min-w-0 flex-1 text-sm">
              {totp === null ? (
                <span className="text-muted">確認中…</span>
              ) : totp.enabled ? (
                <span>
                  有効 <span className="ml-1 text-xs text-muted">ログイン時に認証アプリのコードが必要です · 回復コード残り {totp.recovery_codes_left}</span>
                </span>
              ) : (
                <span className="text-muted">無効 (パスワードだけでログインできます)</span>
              )}
            </div>
            {totp && (
              <Button size="sm" variant="secondary" onClick={() => setTotpDialog(totp.enabled ? "disable" : "setup")}>
                {totp.enabled ? "無効にする" : "有効にする"}
              </Button>
            )}
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
          {onClose && (
            <Button variant="secondary" size="sm" onClick={onClose}>
              閉じる
            </Button>
          )}
        </div>
      </div>
      {totpDialog === "setup" && <TotpSetupDialog controller={controller} onClose={() => setTotpDialog(null)} onEnabled={() => { setTotpDialog(null); void controller.totpStatus().then(setTotp); }} />}
      {totpDialog === "disable" && <TotpDisableDialog controller={controller} onClose={() => setTotpDialog(null)} onDisabled={() => { setTotpDialog(null); void controller.totpStatus().then(setTotp); }} />}
    </>
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
