import { BellOff, Search, SquarePen, Users } from "lucide-react";
import { useRef, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar, presenceLabel } from "./Avatar";
import { badgeCount, hasUnread, isMutedChannel } from "./channels";
import { previewLine } from "./dmPreview";
import { fullTimestamp } from "./format";
import { channelTitle, myDisplayName } from "./MainScreen";
import { dmList, dmTimeLabel, isSelfNotes, showsSelfNotesPlaceholder } from "./mobileTabs";
import { Badge, cn, IconButton } from "./primitives";
import { EmojiText, StatusGlyph } from "./UserPopover";
import { activeStatus } from "./users";
import { t } from "../i18n";

/**
 * My own DM before it exists (the DM tab's and the sidebar's placeholder row): a tap makes it (POST /dms with only me)
 * and opens it. One request at a time: a second tap while it runs does nothing; a failure shows as the app's error.
 */
export function useOpenSelfNotes(controller: AppController, meId: string | null, onOpen: (id: string) => void): { creating: boolean; open: () => void } {
  const [creating, setCreating] = useState(false);
  const inFlight = useRef(false);
  const open = () => {
    if (!meId || inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    // Makes the DM with only me, puts it in the store as mine and opens it (openDmWith reports a failure).
    void controller
      .openDmWith(meId)
      .then((id) => { if (id) onOpen(id); })
      .finally(() => {
        inFlight.current = false;
        setCreating(false);
      });
  };
  return { creating, open };
}

/**
 * M34, the phone's DM tab (MOBILE_UI.md §6.3): my DMs and group DMs, my own DM (titled with my name) first, then the
 * newest. A row shows the name and the time, then the last message (M49, dmPreview.ts; the presence or status while
 * there is none), unread in bold with its count. Until my own DM exists, a placeholder row (my picture and name) stands first; a tap
 * makes it and opens it.
 */
export function DmListView({ controller, onOpen, onNew }: { controller: AppController; onOpen: (id: string) => void; onNew: () => void }) {
  const store = controller.store;
  const meId = store.me?.id ?? controller.me?.id ?? null;
  const [query, setQuery] = useState("");
  const rows = dmList(store.channels.values(), (c) => channelTitle(c, controller), meId, query);
  const placeholder = showsSelfNotesPlaceholder(store.channels.values(), meId, myDisplayName(controller), query);
  const { creating, open: openSelfNotes } = useOpenSelfNotes(controller, meId, onOpen);
  const now = new Date();
  return (
    <section aria-label={t("sidebar.dms")} className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
        <strong className="min-w-0 flex-1 truncate text-[17px]">{t("sidebar.dms")}</strong>
        <IconButton label={t("home.newMessage")} className="h-11 w-11" onClick={onNew}>
          <SquarePen size={20} />
        </IconButton>
      </header>
      <div className="shrink-0 px-3 py-2">
        <label className="flex h-10 items-center gap-2 rounded-xl bg-panel px-3 text-muted">
          <Search size={16} className="shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("dmList.search")}
            aria-label={t("dmList.filter")}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && !placeholder ? (
          <p className="px-6 py-12 text-center text-sm text-muted">{query.trim() ? t("dmList.noMatch") : t("dmList.none")}</p>
        ) : (
          <ul>
            {placeholder && meId && <SelfNotesPlaceholderRow controller={controller} meId={meId} busy={creating} onOpen={openSelfNotes} />}
            {rows.map((channel) => (
              <DmRow key={channel.id} controller={controller} channel={channel} meId={meId} now={now} onOpen={() => onOpen(channel.id)} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** My own DM before it exists: my picture and my name, like any DM row; a tap makes it (once) and opens it. */
function SelfNotesPlaceholderRow({ controller, meId, busy, onOpen }: { controller: AppController; meId: string; busy: boolean; onOpen: () => void }) {
  const name = myDisplayName(controller);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={busy}
        aria-busy={busy}
        data-self-notes-placeholder=""
        className="flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-panel active:bg-panel disabled:opacity-60"
      >
        <Avatar id={meId} name={name} size={40} className="rounded-xl" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-ink/90">{name}</span>
        </span>
      </button>
    </li>
  );
}

function DmRow({ controller, channel, meId, now, onOpen }: { controller: AppController; channel: ChannelState; meId: string | null; now: Date; onOpen: () => void }) {
  const store = controller.store;
  const others = (channel.dm_user_ids ?? []).filter((id) => id !== meId);
  const self = isSelfNotes(channel, meId);
  const other = others[0] ?? meId;
  const single = others.length === 1 ? others[0]! : null;
  const presence = single ? store.presenceOf(single) : undefined;
  const status = single ? activeStatus(store.users.get(single)) : self && meId ? activeStatus(store.users.get(meId)) : null;
  const unread = hasUnread(channel, meId);
  const badge = badgeCount(channel);
  const muted = isMutedChannel(channel);
  const title = channelTitle(channel, controller);
  const time = dmTimeLabel(channel.last_message_at, now);
  // M49: the last message (「あなた: …」 / 「佐藤: …」, dmPreview.ts); without one, the status, presence or size as before.
  const preview = previewLine(channel, channel.last_message, meId, store.users);
  const second = preview || (status ? `${status.emoji ?? ""} ${status.text ?? ""}`.trim() : single ? presenceLabel(presence ?? "offline") : others.length > 1 ? t("common.people", { count: others.length + 1 }) : "");
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-panel active:bg-panel">
        {others.length > 1 ? (
          <span className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-panel-2 text-muted" aria-hidden="true">
            <Users size={18} />
          </span>
        ) : other ? (
          <Avatar id={other} name={store.users.get(other)?.display_name ?? "?"} size={40} className="rounded-xl" presence={presence} presenceClassName="border-2 border-canvas" />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 truncate text-[15px]", unread ? "font-bold text-ink" : "font-medium text-ink/90")}>{title}</span>
            {preview && status?.emoji && (
              <span className="shrink-0 text-[13px]" title={status.text ?? undefined} aria-label={status.text ?? undefined}>
                <StatusGlyph controller={controller} emoji={status.emoji} />
              </span>
            )}
            <span className="flex-1" />
            {time && (
              <span className={cn("shrink-0 text-xs", unread ? "font-semibold text-ink" : "text-muted")} title={channel.last_message_at ? fullTimestamp(channel.last_message_at) : undefined}>
                {time}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span data-dm-preview={preview ? "" : undefined} className={cn("min-w-0 flex-1 truncate text-[13px]", preview && unread ? "font-semibold text-ink" : "text-muted")}>
              <EmojiText controller={controller} text={second} />
            </span>
            {muted && <BellOff size={13} className="shrink-0 text-muted" aria-label={t("home.muted")} />}
            {unread && badge > 0 && <Badge tone="danger">{badge}</Badge>}
            {unread && badge === 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label={t("sidebar.unread")} />}
          </span>
        </span>
      </button>
    </li>
  );
}
