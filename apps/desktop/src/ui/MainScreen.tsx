import { useEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, NotificationLevel } from "../sync/types";
import { hasUnread, sectionChannels, stepChannel } from "./channels";
import { Composer } from "./Composer";
import { AddMemberDialog, MembersDialog, NewChannelDialog, NewDmDialog, SettingsDialog, ShortcutsDialog, TopicDialog } from "./Dialogs";
import { formatMuted } from "./format";
import { QuickSwitcher } from "./QuickSwitcher";
import { SearchPane } from "./SearchPane";
import { Sidebar } from "./Sidebar";
import { ThreadPane } from "./ThreadPane";
import { Timeline } from "./Timeline";
import { Toast } from "./Toast";

type Dialog = "dm" | "channel" | "members" | "add-member" | "settings" | "topic" | "shortcuts" | null;

const UNREAD_ONLY_KEY = "chikuwa.sidebar.unreadOnly";

function readUnreadOnly(): boolean {
  try {
    return localStorage.getItem(UNREAD_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function MainScreen({ controller }: { controller: AppController }) {
  const engine = controller.engine;
  const store = controller.store;
  const [currentId, setCurrentId] = useState<string | null>(engine?.currentChannelId ?? null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(readUnreadOnly);

  const channels = [...store.channels.values()];
  const current: ChannelState | undefined = currentId ? store.getChannel(currentId) : undefined;
  const status = engine?.status ?? "idle";

  // The keyboard handler is registered once and reads the latest state through this ref.
  const state = useRef({ currentId, dialog, threadId, searching, switcher });
  state.current = { currentId, dialog, threadId, searching, switcher };

  useEffect(() => {
    if (!currentId && channels.length > 0) {
      const first = channels.find((c) => c.isMember) ?? channels[0];
      if (first) setCurrentId(first.id);
    }
  }, [currentId, channels.length]);

  useEffect(() => {
    if (currentId && engine) void engine.openChannel(currentId).catch((error) => controller.setError(error));
  }, [currentId, engine]);

  const open = (id: string) => {
    controller.clearMessageFocus();
    controller.setEditing(null);
    setCurrentId(id);
    setThreadId(null);
    setSwitcher(false);
  };

  const toggleUnreadOnly = () => {
    setUnreadOnly((value) => {
      try {
        localStorage.setItem(UNREAD_ONLY_KEY, value ? "0" : "1");
      } catch {
        /* per-viewer convenience only */
      }
      return !value;
    });
  };

  useEffect(() => {
    const navigationOrder = () => {
      const all = [...controller.store.channels.values()];
      const sections = sectionChannels(all, (c) => channelTitle(c, controller));
      return [...sections.channels, ...sections.dms];
    };
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const s = state.current;
      if (mod && !event.shiftKey && key === "k") {
        event.preventDefault();
        setSwitcher(true);
      } else if (mod && event.shiftKey && key === "k") {
        event.preventDefault();
        setDialog("dm");
      } else if (mod && !event.shiftKey && key === "f") {
        event.preventDefault();
        setSearching(true);
      } else if (mod && event.shiftKey && key === "l") {
        event.preventDefault();
        document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
      } else if (mod && key === "/") {
        event.preventDefault();
        setDialog((d) => (d === "shortcuts" ? null : "shortcuts"));
      } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const next = stepChannel(navigationOrder(), s.currentId, event.key === "ArrowDown" ? 1 : -1, { unreadOnly: event.shiftKey });
        if (next) open(next.id);
      } else if (event.key === "Escape") {
        if (s.switcher) setSwitcher(false);
        else if (s.dialog) setDialog(null);
        else if (s.searching) setSearching(false);
        else if (s.threadId) setThreadId(null);
        else if (controller.editing) controller.setEditing(null);
        else if (s.currentId) {
          // Nothing to close: Esc marks the open conversation read (Mattermost).
          const channel = controller.store.getChannel(s.currentId);
          if (channel && hasUnread(channel)) controller.engine?.markRead(channel.id, channel.lastSeq, { force: true });
        }
        setBellOpen(false);
      }
    };
    const onSwitch = () => setSwitcher(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("chikuwa:quick-switch", onSwitch);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("chikuwa:quick-switch", onSwitch);
    };
  }, [controller]);

  const join = async (id: string) => {
    if (!controller.api) return;
    try {
      const channel = await controller.api.joinChannel(id);
      store.upsertChannel(channel, { isMember: true });
      setCurrentId(id);
    } catch (error) {
      controller.setError(error);
    }
  };

  const replyToLast = () => {
    if (!current) return;
    const last = store.messages(current.id).filter((m) => !m.pending && !m.deleted).at(-1);
    if (last) setThreadId(last.id);
  };

  const muteLabel = current ? formatMuted(current.mutedUntil) : null;
  const level: NotificationLevel = current?.notificationLevel ?? (current && (current.type === "dm" || current.type === "group_dm") ? "all" : "mentions");
  const isChannel = current?.type === "public" || current?.type === "private";

  return (
    <div className="layout">
      <Sidebar
        controller={controller}
        channels={channels}
        currentId={currentId}
        unreadOnly={unreadOnly}
        onToggleUnreadOnly={toggleUnreadOnly}
        onOpen={open}
        onJoin={(id) => void join(id)}
        onNewDm={() => setDialog("dm")}
        onNewChannel={() => setDialog("channel")}
        onSearch={() => setSearching(true)}
        onSettings={() => setDialog("settings")}
      />
      <main className="main">
        {status !== "online" && status !== "idle" && (
          <div className={`connection ${status}`}>{status === "connecting" ? "サーバに接続しています…" : "オフラインです。再接続を待っています…"}</div>
        )}
        {current ? (
          <>
            <header className="channel-header">
              <div className="title">
                <strong>{channelTitle(current, controller)}</strong>
                {current.archived && <span className="badge">アーカイブ済み</span>}
                {isChannel && current.isMember && !current.archived && (
                  <button className="link topic" onClick={() => setDialog("topic")} title="トピックを編集">
                    {current.topic ? current.topic : "トピックを追加"}
                  </button>
                )}
                {!isChannel && current.topic && <span className="muted">{current.topic}</span>}
              </div>
              <div className="tools">
                {isChannel && (
                  <button className="icon" title="メンバー" onClick={() => setDialog("members")}>
                    👥
                  </button>
                )}
                {current.isMember && (
                  <span className="bell">
                    <button className="icon" title="通知設定" onClick={() => setBellOpen((v) => !v)}>
                      {level === "none" || muteLabel ? "🔕" : "🔔"}
                    </button>
                    {bellOpen && (
                      <div className="menu" onMouseLeave={() => setBellOpen(false)}>
                        {(
                          [
                            ["all", "すべてのメッセージ"],
                            ["mentions", "メンションのみ"],
                            ["none", "通知しない"],
                          ] as Array<[NotificationLevel, string]>
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            className={level === value ? "active" : ""}
                            onClick={() => {
                              setBellOpen(false);
                              void controller.setNotification(current.id, value, null);
                            }}
                          >
                            {level === value ? "✓ " : ""}
                            {label}
                          </button>
                        ))}
                        <hr />
                        {muteLabel ? (
                          <button onClick={() => void controller.setNotification(current.id, level, null)}>ミュート解除 ({muteLabel})</button>
                        ) : (
                          <button onClick={() => void controller.setNotification(current.id, level, new Date(Date.now() + 8 * 3600_000).toISOString())}>
                            8 時間ミュート
                          </button>
                        )}
                      </div>
                    )}
                  </span>
                )}
                <button className="icon" title="キーボードショートカット (Ctrl/⌘+/)" onClick={() => setDialog("shortcuts")}>
                  ⌨️
                </button>
                {!current.isMember && (
                  <button className="secondary" onClick={() => void join(current.id)}>
                    参加する
                  </button>
                )}
              </div>
            </header>
            <Timeline controller={controller} channel={current} onOpenThread={setThreadId} />
            {current.isMember && !current.archived && <Composer key={current.id} controller={controller} channel={current} onReplyLast={replyToLast} />}
            {current.archived && <div className="muted archived-note">アーカイブされたチャンネルには投稿できません</div>}
          </>
        ) : (
          <div className="centered muted">
            <div className="empty-state">
              <strong>チャンネルを選択してください</strong>
              <span>左のリストから選ぶか、Ctrl/⌘+K で移動できます。</span>
            </div>
          </div>
        )}
      </main>
      {searching ? (
        <SearchPane
          controller={controller}
          onClose={() => setSearching(false)}
          onOpen={(message) => {
            void controller.revealMessage(message).then((ok) => {
              if (ok) { setCurrentId(message.channel_id); setThreadId(message.parent_id ?? null); setSearching(false); }
            });
          }}
        />
      ) : current && threadId ? (
        <ThreadPane controller={controller} channel={current} parentId={threadId} onClose={() => setThreadId(null)} />
      ) : (
        <aside className="thread-panel" aria-hidden="true" />
      )}
      <Toast controller={controller} />
      {switcher && <QuickSwitcher controller={controller} onOpen={open} onClose={() => setSwitcher(false)} />}
      {dialog === "dm" && <NewDmDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "channel" && <NewChannelDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "members" && current && (
        <MembersDialog controller={controller} channel={current} onClose={() => setDialog(null)} onAdd={() => setDialog("add-member")} />
      )}
      {dialog === "add-member" && current && <AddMemberDialog controller={controller} channelId={current.id} onClose={() => setDialog("members")} />}
      {dialog === "topic" && current && <TopicDialog controller={controller} channel={current} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <SettingsDialog controller={controller} onClose={() => setDialog(null)} />}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

export function channelTitle(channel: ChannelState, controller: AppController): string {
  if (channel.type === "public" || channel.type === "private") return `#${channel.name ?? ""}`;
  const me = controller.store.me?.id;
  const others = (channel.dm_user_ids ?? []).filter((id) => id !== me);
  if (others.length === 0) return "自分へのメモ";
  return others.map((id) => controller.store.users.get(id)?.display_name ?? "…").join(", ");
}
