import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { badgeCount, hasUnread, isMutedChannel, sectionChannels } from "./channels";
import { channelTitle } from "./MainScreen";

interface Props {
  controller: AppController;
  channels: ChannelState[];
  currentId: string | null;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  onOpen: (id: string) => void;
  onJoin: (id: string) => void;
  onNewDm: () => void;
  onNewChannel: () => void;
  onSearch?: () => void;
  onSettings?: () => void;
}

export function Sidebar({ controller, channels, currentId, unreadOnly, onToggleUnreadOnly, onOpen, onJoin, onNewDm, onNewChannel, onSearch, onSettings }: Props) {
  const engine = controller.engine;
  const me = controller.store.me ?? controller.me;
  const sections = sectionChannels(channels, (c) => channelTitle(c, controller), { unreadOnly, currentId });
  const status = engine?.status ?? "idle";

  const item = (channel: ChannelState) => {
    const muted = isMutedChannel(channel);
    const unread = hasUnread(channel) && channel.id !== currentId;
    const badge = badgeCount(channel);
    return (
      <li key={channel.id} className={`${channel.id === currentId ? "active" : ""}${unread ? " unread" : ""}${muted ? " muted-channel" : ""}`}>
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
      <div className="tools-row">
        <button className="switcher-hint" onClick={() => window.dispatchEvent(new CustomEvent("chikuwa:quick-switch"))}>
          移動… <kbd>Ctrl/⌘ K</kbd>
        </button>
        <button
          className={`filter${unreadOnly ? " active" : ""}`}
          title={unreadOnly ? "すべて表示" : "未読のみ表示"}
          aria-pressed={unreadOnly}
          onClick={onToggleUnreadOnly}
        >
          未読
        </button>
      </div>
      <section>
        <h2>
          チャンネル
          <button className="icon" title="チャンネルを作成" onClick={onNewChannel}>
            +
          </button>
        </h2>
        <ul>{sections.channels.map(item)}</ul>
        {sections.channels.length === 0 && <p className="hint">{unreadOnly ? "未読のチャンネルはありません" : "まだチャンネルがありません"}</p>}
      </section>
      <section>
        <h2>
          ダイレクトメッセージ
          <button className="icon" title="DM を開始 (Ctrl/⌘+Shift+K)" onClick={onNewDm}>
            +
          </button>
        </h2>
        <ul>{sections.dms.map(item)}</ul>
        {sections.dms.length === 0 && <p className="hint">{unreadOnly ? "未読の DM はありません" : "+ から相手を選んで開始"}</p>}
      </section>
      {sections.browse.length > 0 && (
        <section>
          <h2>参加できるチャンネル</h2>
          <ul>
            {sections.browse.map((c) => (
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
