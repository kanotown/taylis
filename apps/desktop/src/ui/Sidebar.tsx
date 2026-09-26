import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { channelTitle } from "./MainScreen";

interface Props {
  controller: AppController;
  channels: ChannelState[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onJoin: (id: string) => void;
  onNewDm: () => void;
  onNewChannel: () => void;
}

export function Sidebar({ controller, channels, currentId, onOpen, onJoin, onNewDm, onNewChannel }: Props) {
  const engine = controller.engine;
  const mine = channels.filter((c) => c.isMember && (c.type === "public" || c.type === "private") && !c.archived);
  const dms = channels.filter((c) => c.isMember && (c.type === "dm" || c.type === "group_dm"));
  const browse = channels.filter((c) => !c.isMember && c.type === "public" && !c.archived);
  const status = engine?.status ?? "idle";

  const item = (channel: ChannelState) => {
    const unread = channel.unreadCount > 0 && channel.id !== currentId;
    const badge = channel.type === "dm" || channel.type === "group_dm" ? channel.unreadCount : channel.mentionCount;
    return (
      <li key={channel.id} className={`${channel.id === currentId ? "active" : ""}${unread ? " unread" : ""}`}>
        <button onClick={() => onOpen(channel.id)}>
          <span>{channelTitle(channel, controller)}</span>
          {unread && badge > 0 ? <span className="badge">{badge}</span> : unread ? <span className="dot" /> : null}
        </button>
      </li>
    );
  };

  return (
    <nav className="sidebar">
      <div className="me">
        <strong>{controller.store.me?.display_name ?? controller.me?.display_name ?? ""}</strong>
        <span className={`status status-${status}`}>{statusLabel(status)}</span>
        <button className="link" onClick={() => void controller.logout()}>
          ログアウト
        </button>
      </div>
      <section>
        <h2>
          チャンネル <button className="link" onClick={onNewChannel}>+</button>
        </h2>
        <ul>{mine.map(item)}</ul>
      </section>
      <section>
        <h2>
          ダイレクトメッセージ <button className="link" onClick={onNewDm}>+</button>
        </h2>
        <ul>{dms.map(item)}</ul>
      </section>
      {browse.length > 0 && (
        <section>
          <h2>参加できるチャンネル</h2>
          <ul>
            {browse.map((c) => (
              <li key={c.id}>
                <button onClick={() => onJoin(c.id)}>#{c.name} ↗</button>
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
      return "オフライン (再接続中)";
    default:
      return status;
  }
}
