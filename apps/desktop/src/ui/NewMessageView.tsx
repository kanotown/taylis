import { ArrowLeft, Check, NotebookPen, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { SELF_NOTES_HINT } from "./channels";
import { pickerChannels, pickerPeople } from "./home";
import { matchScore } from "./jumpMatch";
import { ConversationRowBody } from "./JumpView";
import { channelTitle, myDisplayName } from "./MainScreen";
import { Button, cn, IconButton } from "./primitives";

/** The most people a group DM takes besides me (as the new-DM dialog). */
const GROUP_MAX = 8;

/**
 * M37 ✏️ 新しいメッセージ (MOBILE_UI.md §6.1): one search field for the destination — a channel (mine first, then public
 * ones I can join), people (several make a group DM) or my own DM. The chosen conversation opens with its input focused
 * (the caller's `onOpen`). People are picked (a tap each) and 「開く」 opens the DM with them.
 */
export function NewMessageView({ controller, onOpen, onClose }: { controller: AppController; onOpen: (channelId: string) => void; onClose: () => void }) {
  const store = controller.store;
  const me = store.me ?? controller.me;
  const meId = me?.id ?? null;
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const query = text.trim();
  const title = (c: ChannelState) => channelTitle(c, controller).replace(/^#/, "");
  const context = { users: store.users, meId, me, title };
  const { mine, joinable } = pickerChannels(query, store.channels.values(), context);
  const people = pickerPeople(query, store.users.values(), meId);
  const myName = myDisplayName(controller);
  const showSelf = !!meId && selected.length === 0 && (!query || matchScore(query, [myName, me?.username ?? ""]) !== null);
  // With people picked, the destination is a DM: the channels step aside.
  const showChannels = selected.length === 0;

  const toggle = (id: string) => {
    setError(null);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    setText("");
    input.current?.focus();
  };

  const openDm = async (userIds: string[]) => {
    if (busy || userIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (userIds.length === 1) {
        const id = await controller.openDmWith(userIds[0]!);
        if (id) onOpen(id);
        return;
      }
      if (!controller.api) return;
      const channel = await controller.api.createDm(userIds);
      store.upsertChannel(channel, { isMember: true });
      onOpen(channel.id);
    } catch (err) {
      setError(controller.describe(err));
    } finally {
      setBusy(false);
    }
  };

  const heading = (label: string) => <div className="px-4 pb-1 pt-3 text-[12px] font-semibold text-muted">{label}</div>;
  const nothing = !showSelf && (!showChannels || (mine.length === 0 && joinable.length === 0)) && people.length === 0;

  return (
    <section role="dialog" aria-label="新しいメッセージ" className="fixed inset-0 z-40 flex flex-col bg-canvas text-ink" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line pl-2 pr-3">
        <IconButton label="戻る" className="h-11 w-11" onClick={onClose}>
          <ArrowLeft size={20} />
        </IconButton>
        <strong className="min-w-0 flex-1 truncate text-[17px]">新しいメッセージ</strong>
        {selected.length > 0 && (
          <Button size="sm" disabled={busy || selected.length > GROUP_MAX} onClick={() => void openDm(selected)}>
            開く
          </Button>
        )}
      </div>
      <div className="shrink-0 border-b border-line px-3 py-2">
        <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl bg-panel px-3 py-1.5">
          <Search size={16} className="shrink-0 text-muted" />
          {selected.map((id) => {
            const user = store.users.get(id);
            return (
              <span key={id} className="flex items-center gap-1 rounded-lg bg-accent-soft py-0.5 pl-1 pr-1.5 text-[13px] text-ink">
                <Avatar id={id} name={user?.display_name ?? "?"} size={18} className="rounded text-[8px]" />
                {user?.display_name ?? "…"}
                <button type="button" aria-label={`${user?.display_name ?? ""} を外す`} className="rounded text-muted hover:text-ink" onClick={() => toggle(id)}>
                  <X size={13} />
                </button>
              </span>
            );
          })}
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !text && selected.length > 0) setSelected((s) => s.slice(0, -1));
            }}
            placeholder={selected.length ? "ほかの人を追加" : "宛先: チャンネル名や人の名前"}
            aria-label="宛先"
            className="min-w-24 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
        </div>
        {selected.length > GROUP_MAX && <p className="mt-1.5 text-xs text-danger">グループ DM は自分のほかに {GROUP_MAX} 人までです</p>}
        {error && <p className="mt-1.5 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {showSelf && meId && (
          <button type="button" data-pick="self" disabled={busy} onClick={() => void openDm([meId])} className={PICK_ROW}>
            <Avatar id={meId} name={myName} size={24} className="rounded-md text-[10px]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{myName}</span>
              <span className="flex min-w-0 items-center gap-1 text-[12.5px] text-muted"><NotebookPen size={12} className="shrink-0" /><span className="min-w-0 truncate">{SELF_NOTES_HINT}</span></span>
            </span>
          </button>
        )}
        {showChannels && mine.length > 0 && (
          <>
            {heading("チャンネル")}
            {mine.map((channel) => (
              <button key={channel.id} type="button" data-pick="channel" onClick={() => onOpen(channel.id)} className={PICK_ROW}>
                <ConversationRowBody controller={controller} channel={channel} meId={meId} />
              </button>
            ))}
          </>
        )}
        {showChannels && joinable.length > 0 && (
          <>
            {heading("参加できるチャンネル")}
            {joinable.map((channel) => (
              <button key={channel.id} type="button" data-pick="joinable" onClick={() => onOpen(channel.id)} className={cn(PICK_ROW, "text-ink/80")}>
                <ConversationRowBody controller={controller} channel={channel} meId={meId} />
              </button>
            ))}
          </>
        )}
        {people.length > 0 && (
          <>
            {heading(selected.length ? "人 (複数選ぶとグループ DM)" : "人")}
            {people.map((user) => {
              const on = selected.includes(user.id);
              return (
                <button key={user.id} type="button" data-pick="person" aria-pressed={on} onClick={() => toggle(user.id)} className={cn(PICK_ROW, on && "bg-accent-soft/60")}>
                  <Avatar id={user.id} name={user.display_name} size={24} className="rounded-md text-[10px]" presence={store.presenceOf(user.id)} presenceClassName="border border-canvas" />
                  <span className="min-w-0 truncate">{user.display_name}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted">@{user.username}</span>
                  <span aria-hidden="true" className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", on ? "border-accent bg-accent text-white" : "border-line")}>
                    {on && <Check size={13} />}
                  </span>
                </button>
              );
            })}
          </>
        )}
        {nothing && <p className="px-6 py-12 text-center text-sm text-muted">一致する宛先はありません</p>}
      </div>
    </section>
  );
}

const PICK_ROW = "flex min-h-11 w-full items-center gap-3 px-4 py-1.5 text-left text-[15px] transition-colors hover:bg-panel active:bg-panel disabled:opacity-60";
