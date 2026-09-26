import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";

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
