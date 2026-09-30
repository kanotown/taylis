import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import { Button, cn, Field, Input, Modal } from "./primitives";
import { activeStatus, EXPIRY_OPTIONS, expiryAt, expiryLabel, STATUS_PRESETS, type StatusExpiry } from "./users";

/**
 * Custom status editor (M11d): emoji + text + expiry, quick presets, clear. Since M40 the status only: pausing
 * notifications and the quiet hours have screens of their own in the settings (MOBILE_UI.md §6.5).
 */
export function StatusDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title="ステータスを設定" className="w-[440px]">
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
        <Input value={emoji} maxLength={8} placeholder="絵文字" aria-label="絵文字" className="w-20 text-center text-lg" onChange={(e) => { setEmoji(e.target.value); setSaved(false); }} />
        <Input value={text} maxLength={100} placeholder="今なにしてる？" aria-label="ステータス" className="flex-1" onChange={(e) => { setText(e.target.value); setSaved(false); }} autoFocus={!!onCancel} />
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
      <Field label="消えるタイミング">
        <select value={expiry} onChange={(e) => { setExpiry(e.target.value as StatusExpiry); setSaved(false); }} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
          {EXPIRY_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {expiry !== "never" && <div className="mt-1 text-xs text-muted">{expiryLabel(expiryAt(expiry))}</div>}
      </Field>
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" onClick={() => void clear()} disabled={busy || !current}>クリア</Button>
        <div className="flex items-center gap-2">
          {saved && !onDone && <span className="text-xs text-muted">保存しました</span>}
          {onCancel && <Button type="button" variant="secondary" onClick={onCancel}>キャンセル</Button>}
          <Button type="submit" disabled={busy || (!emoji.trim() && !text.trim())}>保存</Button>
        </div>
      </div>
    </form>
  );
}
