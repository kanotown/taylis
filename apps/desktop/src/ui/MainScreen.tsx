import { useEffect, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, NotificationLevel } from "../sync/types";
import { Composer } from "./Composer";
import { AddMemberDialog, MembersDialog, NewChannelDialog, NewDmDialog, SettingsDialog, TopicDialog } from "./Dialogs";
import { formatMuted } from "./format";
import { QuickSwitcher } from "./QuickSwitcher";
import { SearchPane } from "./SearchPane";
import { Sidebar } from "./Sidebar";
import { ThreadPane } from "./ThreadPane";
import { Timeline } from "./Timeline";
import { Toast } from "./Toast";

type Dialog = "dm" | "channel" | "members" | "add-member" | "settings" | "topic" | null;

export function MainScreen({ controller }: { controller: AppController }) {
  const engine = controller.engine;
  const store = controller.store;
  const [currentId, setCurrentId] = useState<string | null>(engine?.currentChannelId ?? null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);

  const channels = [...store.channels.values()];
  const current: ChannelState | undefined = currentId ? store.getChannel(currentId) : undefined;
  const status = engine?.status ?? "idle";

  useEffect(() => {
    if (!currentId && channels.length > 0) {
      const first = channels.find((c) => c.isMember) ?? channels[0];
      if (first) setCurrentId(first.id);
    }
  }, [currentId, channels.length]);

  useEffect(() => {
    if (currentId && engine) void engine.openChannel(currentId);
  }, [currentId, engine]);

  // Keyboard: Ctrl/⌘+K quick switcher, Ctrl/⌘+F search, Esc closes the right pane / dialogs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSwitcher(true);
      } else if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearching(true);
      } else if (event.key === "Escape") {
        if (switcher) setSwitcher(false);
        else if (dialog) setDialog(null);
        else if (searching) setSearching(false);
        else if (threadId) setThreadId(null);
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
  }, [switcher, dialog, searching, threadId]);

  const open = (id: string) => {
    setCurrentId(id);
    setThreadId(null);
    setSwitcher(false);
  };

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

  const muteLabel = current ? formatMuted(current.mutedUntil) : null;
  const level: NotificationLevel = current?.notificationLevel ?? (current && (current.type === "dm" || current.type === "group_dm") ? "all" : "mentions");
  const isChannel = current?.type === "public" || current?.type === "private";

  return (
    <div className="layout">
      <Sidebar
        controller={controller}
        channels={channels}
        currentId={currentId}
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
                {!current.isMember && (
                  <button className="secondary" onClick={() => void join(current.id)}>
                    参加する
                  </button>
                )}
              </div>
            </header>
            <Timeline controller={controller} channel={current} onOpenThread={setThreadId} />
            {current.isMember && !current.archived && <Composer controller={controller} channel={current} />}
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
          onOpen={(channelId, parentId) => {
            setCurrentId(channelId);
            setThreadId(parentId);
            setSearching(false);
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
