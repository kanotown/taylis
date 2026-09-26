import { type FormEvent, useEffect, useState } from "react";

import type { MemberOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";

interface DialogProps {
  controller: AppController;
  onClose: () => void;
  onOpen: (channelId: string) => void;
}

export function NewDmDialog({ controller, onClose, onOpen }: DialogProps) {
  const me = controller.store.me?.id;
  const users = [...controller.store.users.values()].filter((u) => u.id !== me && !u.deactivated_at);
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
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>ダイレクトメッセージ</h2>
        <ul className="user-list">
          {users.map((u) => (
            <li key={u.id}>
              <label>
                <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} /> {u.display_name}{" "}
                <span className="muted">@{u.username}</span>
              </label>
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button onClick={() => void create()} disabled={selected.length === 0 || selected.length > 8}>
            開く
          </button>
          <button className="secondary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

export function AddMemberDialog({ controller, channelId, onClose }: { controller: AppController; channelId: string; onClose: () => void }) {
  const me = controller.store.me?.id;
  const [members, setMembers] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const users = [...controller.store.users.values()].filter((u) => u.id !== me && !u.deactivated_at && !members?.has(u.id));

  if (members === null && controller.api) {
    void controller.api.members(channelId).then((list) => setMembers(new Set(list.map((m) => m.user_id))), () => setMembers(new Set()));
  }

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const add = async () => {
    if (!controller.api) return;
    try {
      for (const userId of selected) await controller.api.addMember(channelId, userId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>メンバーを追加</h2>
        {members === null ? (
          <p className="muted">読み込み中…</p>
        ) : users.length === 0 ? (
          <p className="muted">追加できるユーザーはいません</p>
        ) : (
          <ul className="user-list">
            {users.map((u) => (
              <li key={u.id}>
                <label>
                  <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} /> {u.display_name}{" "}
                  <span className="muted">@{u.username}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button onClick={() => void add()} disabled={selected.length === 0}>
            追加
          </button>
          <button className="secondary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
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
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={create}>
        <h2>チャンネルを作成</h2>
        <label>
          名前
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="general" pattern="[^\s#@/]{1,80}" required />
        </label>
        <label>
          <input type="radio" checked={type === "public"} onChange={() => setType("public")} /> パブリック
        </label>
        <label>
          <input type="radio" checked={type === "private"} onChange={() => setType("private")} /> プライベート
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="submit">作成</button>
          <button type="button" className="secondary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </form>
    </div>
  );
}

/** Members of a channel with the option to add more (channels only). */
export function MembersDialog({ controller, channel, onClose, onAdd }: { controller: AppController; channel: ChannelState; onClose: () => void; onAdd: () => void }) {
  const [members, setMembers] = useState<MemberOut[] | null>(null);
  useEffect(() => {
    if (!controller.api) return;
    void controller.api.members(channel.id).then(setMembers, (error) => controller.setError(error));
  }, [controller, channel.id]);
  const users = controller.store.users;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>メンバー {members ? `(${members.length})` : ""}</h2>
        {members === null ? (
          <p className="muted">読み込み中…</p>
        ) : (
          <ul className="user-list members">
            {members
              .map((m) => ({ member: m, user: users.get(m.user_id) }))
              .sort((a, b) => (a.user?.display_name ?? "").localeCompare(b.user?.display_name ?? "", "ja"))
              .map(({ member, user }) => (
                <li key={member.user_id}>
                  <Avatar id={member.user_id} name={user?.display_name ?? "?"} size={28} />
                  <span>{user?.display_name ?? "?"}</span>
                  <span className="muted">@{user?.username ?? ""}</span>
                  {member.role === "owner" && <span className="badge">オーナー</span>}
                </li>
              ))}
          </ul>
        )}
        <div className="row">
          {channel.isMember && !channel.archived && <button onClick={onAdd}>メンバーを追加</button>}
          <button className="secondary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
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
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>トピック</h2>
        <p className="muted">このチャンネルで何を話すのかを一行で。</p>
        <input value={topic} maxLength={250} autoFocus onChange={(e) => setTopic(e.target.value)} placeholder="例: 週次の進捗共有" />
        <div className="row">
          <button type="submit" disabled={busy}>
            保存
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            キャンセル
          </button>
        </div>
      </form>
    </div>
  );
}

/** Profile (display name), password change and logout. */
export function SettingsDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  const me = controller.store.me ?? controller.me;
  const [displayName, setDisplayName] = useState(me?.display_name ?? "");
  const [savedName, setSavedName] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await controller.updateDisplayName(displayName);
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <h2>設定</h2>
        {me && (
          <div className="profile">
            <Avatar id={me.id} name={me.display_name} size={44} />
            <div>
              <strong>{me.display_name}</strong>
              <div className="muted">@{me.username}</div>
            </div>
          </div>
        )}
        <form onSubmit={saveName}>
          <label>
            表示名
            <input value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} required />
          </label>
          <div className="row">
            <button type="submit" disabled={busy || !displayName.trim() || displayName.trim() === me?.display_name}>
              表示名を保存
            </button>
            {savedName && <span className="muted">保存しました</span>}
          </div>
        </form>
        <form onSubmit={savePassword}>
          <h3>パスワードの変更</h3>
          <label>
            現在のパスワード
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </label>
          <label>
            新しいパスワード (8 文字以上)
            <input type="password" value={next} minLength={8} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
          </label>
          <label>
            新しいパスワード (確認)
            <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
          </label>
          {passwordMessage && <p className={passwordMessage.includes("しました") ? "muted" : "error"}>{passwordMessage}</p>}
          <div className="row">
            <button type="submit" disabled={busy}>
              変更する
            </button>
          </div>
        </form>
        <div className="row footer">
          <button className="secondary" onClick={() => void controller.logout()}>
            ログアウト
          </button>
          <button className="secondary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
