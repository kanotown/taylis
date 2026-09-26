import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { formatMuted } from "./format";
import { channelTitle } from "./MainScreen";

interface Props {
  controller: AppController;
  channels: ChannelState[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onJoin: (id: string) => void;
  onNewDm: () => void;
  onNewChannel: () => void;
  onSearch?: () => void;
  onSettings?: () => void;
}

export function Sidebar({ controller, channels, currentId, onOpen, onJoin, onNewDm, onNewChannel, onSearch, onSettings }: Props) {
  const engine = controller.engine;
  const me = controller.store.me ?? controller.me;
  const mine = channels.filter((c) => c.isMember && (c.type === "public" || c.type === "private") && !c.archived).sort(byName(controller));
  const dms = channels
    .filter((c) => c.isMember && (c.type === "dm" || c.type === "group_dm"))
    .sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  const browse = channels.filter((c) => !c.isMember && c.type === "public" && !c.archived).sort(byName(controller));
  const status = engine?.status ?? "idle";

  const item = (channel: ChannelState) => {
    const unread = channel.unreadCount > 0 && channel.id !== currentId;
    const badge = channel.type === "dm" || channel.type === "group_dm" ? channel.unreadCount : channel.mentionCount;
    const muted = channel.notificationLevel === "none" || formatMuted(channel.mutedUntil) !== null;
    return (
      <li key={channel.id} className={`${channel.id === currentId ? "active" : ""}${unread ? " unread" : ""}`}>
        <button onClick={() => onOpen(channel.id)} title={channelTitle(channel, controller)}>
          <span className="prefix">{channel.type === "private" ? "🔒" : channel.type === "public" ? "#" : "@"}</span>
          <span className="name">{channelTitle(channel, controller).replace(/^#/, "")}</span>
          {muted && <span className="muted-icon" title="通知オフ">🔕</span>}
          {unread && badge > 0 ? <span className="badge">{badge}</span> : unread ? <span className="dot" /> : null}
        </button>
      </li>
    );
  };

  return (
    <nav className="sidebar">
      <div className="me">
        {me && <Avatar id={me.id} name={me.display_name} size={32} />}
        <div className="who">
          <strong>{me?.display_name ?? ""}</strong>
          <span className={`status status-${status}`}>{statusLabel(status)}</span>
        </div>
        <div className="me-actions">
          {onSearch && (
            <button className="icon" title="検索 (Ctrl/⌘+F)" onClick={onSearch}>
              🔍
            </button>
          )}
          {onSettings && (
            <button className="icon" title="設定" onClick={onSettings}>
              ⚙️
            </button>
          )}
        </div>
      </div>
      <button className="switcher-hint" onClick={() => window.dispatchEvent(new CustomEvent("chikuwa:quick-switch"))}>
        移動… <kbd>Ctrl/⌘ K</kbd>
      </button>
      <section>
        <h2>
          チャンネル
          <button className="icon" title="チャンネルを作成" onClick={onNewChannel}>
            +
          </button>
        </h2>
        <ul>{mine.map(item)}</ul>
        {mine.length === 0 && <p className="hint">まだチャンネルがありません</p>}
      </section>
      <section>
        <h2>
          ダイレクトメッセージ
          <button className="icon" title="DM を開始" onClick={onNewDm}>
            +
          </button>
        </h2>
        <ul>{dms.map(item)}</ul>
        {dms.length === 0 && <p className="hint">+ から相手を選んで開始</p>}
      </section>
      {browse.length > 0 && (
        <section>
          <h2>参加できるチャンネル</h2>
          <ul>
            {browse.map((c) => (
              <li key={c.id}>
                <button onClick={() => onJoin(c.id)} title="参加する">
                  <span className="prefix">#</span>
                  <span className="name">{c.name}</span>
                  <span className="join">参加</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}

function byName(controller: AppController) {
  return (a: ChannelState, b: ChannelState) => channelTitle(a, controller).localeCompare(channelTitle(b, controller), "ja");
}

function statusLabel(status: string): string {
  switch (status) {
    case "online":
      return "接続中";
    case "connecting":
      return "接続しています…";
    case "offline":
      return "再接続を待っています";
    default:
      return "";
  }
}
