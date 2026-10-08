import { Search, SmilePlus } from "lucide-react";
import { type CSSProperties, type FormEvent, useState } from "react";

import type { TextEmojiColor } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { isPlainEnter } from "./ime";
import { channelTitle } from "./MainScreen";
import { CustomEmojiImage, customEmojiName } from "./customEmoji";
import { EmojiPicker, readRecentEmoji } from "./EmojiPicker";
import { Button, cn, Field, Input, Modal, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import { isLetterText, letterIcon, normalizeLetterInput, parseLetterIcon } from "./sectionIcon";
import { TEXT_EMOJI_COLOR_NAMES, TEXT_EMOJI_COLORS, textEmojiColors } from "./textEmoji";
import { t } from "../i18n";

/**
 * A section's icon (M26): an emoji, or a custom emoji drawn from its image (a text emoji as its pill); M114: a letter
 * badge (`letter:M:blue`).
 */
export function SectionIcon({ controller, emoji, size = 14 }: { controller: AppController; emoji: string | null | undefined; size?: number }) {
  if (!emoji) return null;
  const letter = parseLetterIcon(emoji);
  if (letter) return <LetterBadge text={letter.text} color={letter.color} size={size} />;
  const name = customEmojiName(emoji);
  const custom = name ? controller.store.customEmoji.get(name) : undefined;
  if (custom) return <CustomEmojiImage controller={controller} emoji={custom} size={size} className="shrink-0" square />;
  return <span className="shrink-0 leading-none" style={{ fontSize: size }} aria-hidden>{emoji}</span>;
}

/**
 * M114: one or two letters (or one Japanese character) on a rounded square in a text emoji colour (light and dark,
 * apps/shared/text-emoji.json), `size` pixels square like an emoji icon.
 */
export function LetterBadge({ text, color, size = 14, className }: { text: string; color: TextEmojiColor; size?: number; className?: string }) {
  const colors = textEmojiColors(color);
  const style = {
    width: size,
    height: size,
    fontSize: size * ([...text].length > 1 ? 0.52 : 0.64),
    lineHeight: `${size}px`,
    borderRadius: size * 0.26,
    "--te-bg": colors.light.bg,
    "--te-fg": colors.light.fg,
    "--te-bg-dark": colors.dark.bg,
    "--te-fg-dark": colors.dark.fg,
  } as CSSProperties;
  return (
    <span aria-hidden data-letter-icon={text} className={cn("text-emoji inline-block shrink-0 overflow-hidden whitespace-nowrap text-center font-bold tracking-tight", className)} style={style}>
      {text}
    </span>
  );
}

/** M114: the picker's 「文字」 tab: up to two letters (or one Japanese character) and a colour, previewed as it is typed. */
function LetterIconPicker({ initial, onPick }: { initial: string | null; onPick: (icon: string) => void }) {
  const current = parseLetterIcon(initial);
  // The input as typed (an IME composes 「しゅう」 before 「修」, so nothing is cut while typing); `text` is what is saved.
  const [raw, setRaw] = useState(current?.text ?? "");
  const [color, setColor] = useState<TextEmojiColor>(current?.color ?? "blue");
  const text = normalizeLetterInput(raw);
  const valid = isLetterText(text);
  return (
    <div className="w-[300px] space-y-3" data-testid="letter-icon-picker">
      <div className="flex items-center gap-3">
        <LetterBadge text={valid ? text : text ? "?" : "A"} color={color} size={44} className={valid ? "" : "opacity-50"} />
        <div className="min-w-0 flex-1">
          <Input
            value={raw}
            autoFocus
            aria-label={t("sectionDialog.iconText")}
            placeholder={t("sectionDialog.iconTextPlaceholder")}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              if (isPlainEnter(e)) {
                e.preventDefault();
                if (valid) onPick(letterIcon(text, color));
              }
            }}
          />
          <div className={cn("mt-1 text-[11px]", text && !valid ? "text-danger" : "text-muted")}>{t("sectionDialog.iconTextRule")}</div>
        </div>
      </div>
      {/* Square swatches: a fixed 28 px box (no line box under the badge, never stretched by the row); the selected ring is a box shadow around it. */}
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t("emoji.color")}>
        {(Object.keys(TEXT_EMOJI_COLORS) as TextEmojiColor[]).map((key) => (
          <button key={key} type="button" role="radio" aria-checked={color === key} aria-label={TEXT_EMOJI_COLOR_NAMES[key]} title={TEXT_EMOJI_COLOR_NAMES[key]} onClick={() => setColor(key)} data-swatch={key} className={cn("inline-flex size-7 shrink-0 grow-0 aspect-square items-center justify-center rounded-md p-0 leading-none", color === key ? "ring-2 ring-accent" : "")}>
            <LetterBadge text={valid ? text : "A"} color={key} size={24} className="block" />
          </button>
        ))}
      </div>
      <div className="text-right">
        <Button type="button" size="sm" disabled={!valid} onClick={() => onPick(letterIcon(text, color))}>{t("sectionDialog.useIcon")}</Button>
      </div>
    </div>
  );
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
  const [pickerTab, setPickerTab] = useState<"emoji" | "letter">(() => (parseLetterIcon(initial?.emoji) ? "letter" : "emoji"));
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
        <Field label={t("sectionDialog.nameIcon")}>
          <div className="flex items-center gap-2">
            <PopoverRoot open={picking} onOpenChange={setPicking}>
              <PopoverTrigger asChild>
                <button type="button" aria-label={emoji ? t("sectionDialog.changeIcon") : t("sectionDialog.pickIcon")} title={t("workspace.icon")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas text-muted hover:bg-panel">
                  {emoji ? <SectionIcon controller={controller} emoji={emoji} size={18} /> : <SmilePlus size={16} />}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-3">
                <div className="mb-2 flex gap-1" role="tablist" aria-label={t("sectionDialog.iconKind")}>
                  {(["emoji", "letter"] as const).map((tab) => (
                    <button key={tab} type="button" role="tab" aria-selected={pickerTab === tab} onClick={() => setPickerTab(tab)} className={cn("rounded-md px-3 py-1 text-sm", pickerTab === tab ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel")}>
                      {tab === "emoji" ? t("composer.emoji") : t("emoji.kindText")}
                    </button>
                  ))}
                </div>
                {pickerTab === "emoji" ? (
                  <EmojiPicker
                    recent={readRecentEmoji()}
                    custom={[...store.customEmoji.values()]}
                    controller={controller}
                    onPick={(entry) => {
                      setEmoji(entry.glyph);
                      setPicking(false);
                    }}
                  />
                ) : (
                  <LetterIconPicker
                    initial={emoji}
                    onPick={(icon) => {
                      setEmoji(icon);
                      setPicking(false);
                    }}
                  />
                )}
                {emoji && (
                  <div className="mt-2 border-t border-line pt-2 text-right">
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setEmoji(null); setPicking(false); }}>{t("sectionDialog.removeIcon")}</Button>
                  </div>
                )}
              </PopoverContent>
            </PopoverRoot>
            <Input value={name} maxLength={40} required autoFocus placeholder={t("sectionDialog.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          </div>
        </Field>
        {pickChannels && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted">{t("sectionDialog.conversations", { count: chosen.size })}</span>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("sectionDialog.filter")} className="pl-8" />
            </div>
            <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {conversations.map((channel) => {
                // One place per conversation: a starred one leaves お気に入り (DATA_MODEL.md sidebar_sections).
                const current = store.isFavorite(channel.id) ? { name: t("sidebar.favorites") } : sectionOf.get(channel.id);
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
                      {current && <span className="shrink-0 text-[11px] text-muted">{t("sectionDialog.movesFrom", { name: current.name })}</span>}
                    </label>
                  </li>
                );
              })}
              {conversations.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">{t("sectionDialog.noMatch")}</li>}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{busy ? t("common.saving") : submitLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}
