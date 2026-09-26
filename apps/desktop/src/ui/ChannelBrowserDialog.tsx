import { Hash, Lock, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ChannelOut } from "../api/types";
import type { AppController } from "../state/app";
import { Badge, Button, cn, Input, Modal } from "./primitives";

/** Channel browser (M11h): every public channel plus my private ones, with member counts, join / leave and create. */
export function ChannelBrowserDialog({ controller, onClose, onOpen, onCreate }: { controller: AppController; onClose: () => void; onOpen: (id: string) => void; onCreate: () => void }) {
  const store = controller.store;
  const [query, setQuery] = useState("");
  const [listed, setListed] = useState<ChannelOut[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    if (!controller.api) return;
    try {
      setListed((await controller.api.channels(true)).filter((c) => c.type === "public" || c.type === "private"));
    } catch (error) {
      controller.setError(error);
    }
  };
  useEffect(() => {
    void load();
  }, [controller.api]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (listed ?? [])
      .filter((c) => !q || (c.name ?? "").toLowerCase().includes(q) || (c.topic ?? "").toLowerCase().includes(q) || (c.purpose ?? "").toLowerCase().includes(q))
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || (b.member_count ?? 0) - (a.member_count ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""));
  }, [listed, query]);

  const join = async (channel: ChannelOut) => {
    if (!controller.api) return;
    setBusy(channel.id);
    try {
      const joined = await controller.api.joinChannel(channel.id);
      store.upsertChannel(joined, { isMember: true });
      onOpen(channel.id);
      onClose();
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(null);
    }
  };
  const leave = async (channel: ChannelOut) => {
    setBusy(channel.id);
    const ok = await controller.leaveChannel(channel.id);
    setBusy(null);
    if (ok) await load();
  };

  return (
    <Modal onClose={onClose} title="チャンネルを探す" className="w-[640px]">
      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={query} autoFocus placeholder="名前やトピックで絞り込む" className="pl-9" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Button size="sm" onClick={() => { onClose(); onCreate(); }}>チャンネルを作成</Button>
      </div>
      <ul className="mt-3 max-h-[440px] divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {listed === null && <li className="px-3 py-6 text-center text-sm text-muted">読み込み中…</li>}
        {rows.map((channel) => {
          const mine = store.getChannel(channel.id)?.isMember || channel.membership !== null;
          return (
            <li key={channel.id} className={cn("flex items-center gap-3 px-3 py-2.5 text-sm", channel.archived && "opacity-60")}>
              <span className="text-muted">{channel.type === "private" ? <Lock size={15} /> : <Hash size={15} />}</span>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { if (mine) { onOpen(channel.id); onClose(); } }}>
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{channel.name}</span>
                  {channel.archived && <Badge>アーカイブ済み</Badge>}
                  {mine && !channel.archived && <Badge tone="accent">参加中</Badge>}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="inline-flex items-center gap-1"><Users size={12} /> {channel.member_count ?? 0} 人</span>
                  {(channel.purpose || channel.topic) && <span className="truncate">· {channel.purpose || channel.topic}</span>}
                </div>
              </button>
              {!channel.archived && (mine ? (
                <Button size="sm" variant="ghost" disabled={busy === channel.id} onClick={() => void leave(channel)}>退出</Button>
              ) : (
                <Button size="sm" variant="secondary" disabled={busy === channel.id} onClick={() => void join(channel)}>参加</Button>
              ))}
            </li>
          );
        })}
        {listed !== null && rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">見つかりません</li>}
      </ul>
    </Modal>
  );
}
