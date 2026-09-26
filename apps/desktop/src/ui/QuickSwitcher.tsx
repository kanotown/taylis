import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { channelTitle } from "./MainScreen";

/** Cmd/Ctrl+K: jump to a channel or DM by typing part of its name. */
export function QuickSwitcher({ controller, onOpen, onClose }: { controller: AppController; onOpen: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const q = query.trim().toLowerCase();
  const channels: ChannelState[] = [...controller.store.channels.values()]
    .filter((c) => c.isMember && !c.archived)
    .filter((c) => !q || channelTitle(c, controller).toLowerCase().includes(q))
    .sort((a, b) => Number(b.unreadCount > 0) - Number(a.unreadCount > 0) || channelTitle(a, controller).localeCompare(channelTitle(b, controller)))
    .slice(0, 12);
  const index = Math.min(active, Math.max(channels.length - 1, 0));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index + 1) % Math.max(channels.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index - 1 + channels.length) % Math.max(channels.length, 1));
    } else if (event.key === "Enter") {
      const target = channels[index];
      if (target) onOpen(target.id);
    } else if (event.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal quick-switcher" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={query}
          placeholder="チャンネルや相手の名前で移動…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul>
          {channels.map((channel, i) => (
            <li key={channel.id} className={i === index ? "active" : ""} onMouseDown={() => onOpen(channel.id)}>
              <span>{channelTitle(channel, controller)}</span>
              {channel.unreadCount > 0 && <span className="badge">{channel.unreadCount}</span>}
            </li>
          ))}
          {channels.length === 0 && <li className="muted">該当なし</li>}
        </ul>
        <div className="muted hint">↑↓ で選択、Enter で開く、Esc で閉じる</div>
      </div>
    </div>
  );
}
