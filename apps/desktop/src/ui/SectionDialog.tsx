import { Search, SmilePlus } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { channelTitle } from "./MainScreen";
import { CustomEmojiImage, customEmojiName } from "./customEmoji";
import { EmojiPicker, readRecentEmoji } from "./EmojiPicker";
import { Button, Field, Input, Modal, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";

/** A section's icon (M26): an emoji, or a custom emoji drawn from its image. */
export function SectionIcon({ controller, emoji, size = 14 }: { controller: AppController; emoji: string | null | undefined; size?: number }) {
  if (!emoji) return null;
  const name = customEmojiName(emoji);
  const custom = name ? controller.store.customEmoji.get(name) : undefined;
  if (custom) return <CustomEmojiImage controller={controller} emoji={custom} size={size} className="shrink-0" />;
  return <span className="shrink-0 leading-none" style={{ fontSize: size }} aria-hidden>{emoji}</span>;
}

export interface SectionForm {
  name: string;
  emoji: string | null;
  channelIds: string[];
}

/**
 * Making or editing a section (M26, Slack): its name and icon; when making one, also the conversations that go in it
 * (they leave the section they were in). `preselected` ticks the conversation a 「新しいセクション…」 started from.
 */
export function SectionDialog({ controller, title, submitLabel, initial, pickChannels, preselected = [], onClose, onSubmit }: {
  controller: AppController;
  title: string;
  submitLabel: string;
  initial?: { name: string; emoji: string | null };
  pickChannels: boolean;
  preselected?: string[];
  onClose: () => void;
  onSubmit: (form: SectionForm) => Promise<boolean>;
}) {
  const store = controller.store;
  const [name, setName] = useState(initial?.name ?? "");
  const [emoji, setEmoji] = useState<string | null>(initial?.emoji ?? null);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(preselected));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const sectionOf = new Map(store.sidebarSections.flatMap((s) => s.channel_ids.map((id) => [id, s] as const)));
  const q = query.trim().toLowerCase();
  const conversations: ChannelState[] = [...store.channels.values()]
    .filter((c) => c.isMember && !c.archived)
    .filter((c) => !q || channelTitle(c, controller).toLowerCase().includes(q))
    .sort((a, b) => channelTitle(a, controller).localeCompare(channelTitle(b, controller), "ja"));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    const done = await onSubmit({ name: name.trim(), emoji, channelIds: [...chosen] });
    setBusy(false);
    if (done) onClose();
  };

  return (
    <Modal onClose={onClose} title={title} className="w-[460px]">
      <form className="mt-4 space-y-4" onSubmit={(e) => void submit(e)}>
        <Field label="名前とアイコン">
          <div className="flex items-center gap-2">
            <PopoverRoot open={picking} onOpenChange={setPicking}>
              <PopoverTrigger asChild>
                <button type="button" aria-label={emoji ? "アイコンを変更" : "アイコンを選ぶ"} title="アイコン" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas text-muted hover:bg-panel">
                  {emoji ? <SectionIcon controller={controller} emoji={emoji} size={18} /> : <SmilePlus size={16} />}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-3">
                <EmojiPicker
                  recent={readRecentEmoji()}
                  custom={[...store.customEmoji.values()]}
                  controller={controller}
                  onPick={(entry) => {
                    setEmoji(entry.glyph);
                    setPicking(false);
                  }}
                />
                {emoji && (
                  <div className="mt-2 border-t border-line pt-2 text-right">
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setEmoji(null); setPicking(false); }}>アイコンを外す</Button>
                  </div>
                )}
              </PopoverContent>
            </PopoverRoot>
            <Input value={name} maxLength={40} required autoFocus placeholder="例: 研究、授業、事務連絡" onChange={(e) => setName(e.target.value)} />
          </div>
        </Field>
        {pickChannels && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted">入れる会話 ({chosen.size})</span>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="チャンネルや DM を絞り込む" className="pl-8" />
            </div>
            <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {conversations.map((channel) => {
                const current = sectionOf.get(channel.id);
                return (
                  <li key={channel.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-panel">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--accent)]"
                        checked={chosen.has(channel.id)}
                        onChange={(e) => setChosen((all) => { const next = new Set(all); if (e.target.checked) next.add(channel.id); else next.delete(channel.id); return next; })}
                      />
                      <span className="min-w-0 flex-1 truncate">{channelTitle(channel, controller)}</span>
                      {current && <span className="shrink-0 text-[11px] text-muted">{current.name} から移動</span>}
                    </label>
                  </li>
                );
              })}
              {conversations.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">該当する会話がありません</li>}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{busy ? "保存中…" : submitLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}
