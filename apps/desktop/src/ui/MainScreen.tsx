import { useEffect, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Composer } from "./Composer";
import { AddMemberDialog, NewChannelDialog, NewDmDialog } from "./Dialogs";
import { SearchPane } from "./SearchPane";
import { Sidebar } from "./Sidebar";
import { ThreadPane } from "./ThreadPane";
import { Timeline } from "./Timeline";

export function MainScreen({ controller }: { controller: AppController }) {
  const engine = controller.engine;
  const store = controller.store;
  const [currentId, setCurrentId] = useState<string | null>(engine?.currentChannelId ?? null);
  const [dialog, setDialog] = useState<"dm" | "channel" | "members" | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const channels = [...store.channels.values()];
  const current: ChannelState | undefined = currentId ? store.getChannel(currentId) : undefined;

  useEffect(() => {
    if (!currentId && channels.length > 0) {
      const first = channels.find((c) => c.isMember) ?? channels[0];
      if (first) setCurrentId(first.id);
    }
  }, [currentId, channels.length]);

  useEffect(() => {
    if (currentId && engine) void engine.openChannel(currentId);
  }, [currentId, engine]);

  const open = (id: string) => {
    setCurrentId(id);
    setThreadId(null);
  };

  const join = async (id: string) => {
    if (!controller.api) return;
    const channel = await controller.api.joinChannel(id);
    store.upsertChannel(channel, { isMember: true });
    setCurrentId(id);
  };

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
      />
      <main className="main">
        {current ? (
          <>
            <header className="channel-header">
              <strong>{channelTitle(current, controller)}</strong>
              {current.topic && <span className="muted"> — {current.topic}</span>}
              {current.archived && <span className="badge">アーカイブ済み</span>}
              {!current.isMember && (
                <button className="secondary" onClick={() => void join(current.id)}>
                  参加する
                </button>
              )}
              {current.isMember && (current.type === "public" || current.type === "private") && !current.archived && (
                <button className="secondary" onClick={() => setDialog("members")}>
                  メンバーを追加
                </button>
              )}
            </header>
            <Timeline controller={controller} channel={current} onOpenThread={setThreadId} />
            {current.isMember && !current.archived && <Composer controller={controller} channel={current} />}
          </>
        ) : (
          <div className="centered muted">チャンネルを選択してください</div>
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
      {dialog === "dm" && <NewDmDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "channel" && <NewChannelDialog controller={controller} onClose={() => setDialog(null)} onOpen={open} />}
      {dialog === "members" && current && <AddMemberDialog controller={controller} channelId={current.id} onClose={() => setDialog(null)} />}
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
