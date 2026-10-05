import { SmilePlus } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import { EmojiPicker, readRecentEmoji } from "./EmojiPicker";
import { Button, cn, Field, Input, Modal, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import { SectionIcon } from "./SectionDialog";
import { activeStatus, EXPIRY_OPTIONS, expiryAt, expiryLabel, STATUS_PRESETS, type StatusExpiry } from "./users";
import { t } from "../i18n";

/**
 * Custom status editor (M11d): emoji + text + expiry, quick presets, clear. Since M40 the status only: pausing
 * notifications and the quiet hours have screens of their own in the settings (MOBILE_UI.md §6.5).
 */
export function StatusDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title={t("popover.setStatus")} className="w-[440px]">
      <StatusForm controller={controller} onDone={onClose} onCancel={onClose} className="mt-4" />
    </Modal>
  );
}

/**
 * The status form: in the dialog above, as the phone's 「自分」 → 「ステータスを更新」 screen and as the settings dialog's
 * section. `onDone` runs after a save or a clear went through; `onCancel` adds a 「キャンセル」.
 */
export function StatusForm({ controller, onDone, onCancel, className }: { controller: AppController; onDone?: () => void; onCancel?: () => void; className?: string }) {
  const me = controller.store.me;
  const current = activeStatus(me ? controller.store.users.get(me.id) ?? me : null);
  const [emoji, setEmoji] = useState(current?.emoji ?? "");
  // The emoji comes from the picker: a text field there only brought up the keyboard (testers, 2026-09-30).
  const [picking, setPicking] = useState(false);
  const [text, setText] = useState(current?.text ?? "");
  const [expiry, setExpiry] = useState<StatusExpiry>("never");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await controller.updateProfile({ status_emoji: emoji.trim() || null, status_text: text.trim() || null, status_expires_at: expiryAt(expiry) });
    setBusy(false);
    setSaved(ok);
    if (ok) onDone?.();
  };
  const clear = async () => {
    setBusy(true);
    const ok = await controller.updateProfile({ status_emoji: null, status_text: null, status_expires_at: null });
    setBusy(false);
    if (ok) {
      setEmoji("");
      setText("");
      setExpiry("never");
    }
    setSaved(ok);
    if (ok) onDone?.();
  };

  return (
    <form className={cn("space-y-4", className)} onSubmit={save}>
      <div className="flex gap-2">
        <PopoverRoot open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <button type="button" aria-label={emoji ? t("status.changeEmoji") : t("status.pickEmoji")} title={t("composer.emoji")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas text-muted hover:bg-panel">
              {emoji ? <SectionIcon controller={controller} emoji={emoji} size={18} /> : <SmilePlus size={16} />}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-3">
            <EmojiPicker
              recent={readRecentEmoji()}
              custom={[...controller.store.customEmoji.values()]}
              controller={controller}
              onPick={(entry) => {
                setEmoji(entry.glyph);
                setSaved(false);
                setPicking(false);
              }}
            />
            {emoji && (
              <div className="mt-2 border-t border-line pt-2 text-right">
                <Button type="button" variant="ghost" size="sm" onClick={() => { setEmoji(""); setSaved(false); setPicking(false); }}>{t("status.removeEmoji")}</Button>
              </div>
            )}
          </PopoverContent>
        </PopoverRoot>
        <Input value={text} maxLength={100} placeholder={t("status.placeholder")} aria-label={t("settings.status.label")} className="flex-1" onChange={(e) => { setText(e.target.value); setSaved(false); }} autoFocus={!!onCancel} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {STATUS_PRESETS.map((preset) => (
          <button
            key={preset.text}
            type="button"
            onClick={() => { setEmoji(preset.emoji); setText(preset.text); setSaved(false); }}
            className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors", text === preset.text ? "border-accent bg-accent-soft" : "border-line hover:bg-panel")}
          >
            {preset.emoji} {preset.text}
          </button>
        ))}
      </div>
      <Field label={t("status.clearAfter")}>
        <select value={expiry} onChange={(e) => { setExpiry(e.target.value as StatusExpiry); setSaved(false); }} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
          {EXPIRY_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {expiry !== "never" && <div className="mt-1 text-xs text-muted">{expiryLabel(expiryAt(expiry))}</div>}
      </Field>
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" onClick={() => void clear()} disabled={busy || !current}>{t("status.clear")}</Button>
        <div className="flex items-center gap-2">
          {saved && !onDone && <span className="text-xs text-muted">{t("common.saved")}</span>}
          {onCancel && <Button type="button" variant="secondary" onClick={onCancel}>{t("common.cancel")}</Button>}
          <Button type="submit" disabled={busy || (!emoji.trim() && !text.trim())}>{t("common.save")}</Button>
        </div>
      </div>
    </form>
  );
}
