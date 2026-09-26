import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import { Button, cn, Field, Input, Modal } from "./primitives";
import { activeStatus, EXPIRY_OPTIONS, expiryAt, expiryLabel, STATUS_PRESETS, type StatusExpiry } from "./users";

/** Custom status editor (M11d): emoji + text + expiry, quick presets, clear. */
export function StatusDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  const me = controller.store.me;
  const current = activeStatus(me ? controller.store.users.get(me.id) ?? me : null);
  const [emoji, setEmoji] = useState(current?.emoji ?? "");
  const [text, setText] = useState(current?.text ?? "");
  const [expiry, setExpiry] = useState<StatusExpiry>("never");
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await controller.updateProfile({ status_emoji: emoji.trim() || null, status_text: text.trim() || null, status_expires_at: expiryAt(expiry) });
    setBusy(false);
    if (ok) onClose();
  };
  const clear = async () => {
    setBusy(true);
    const ok = await controller.updateProfile({ status_emoji: null, status_text: null, status_expires_at: null });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal onClose={onClose} title="ステータスを設定" className="w-[440px]">
      <form className="mt-4 space-y-4" onSubmit={save}>
        <div className="flex gap-2">
          <Input value={emoji} maxLength={8} placeholder="絵文字" aria-label="絵文字" className="w-16 text-center text-lg" onChange={(e) => setEmoji(e.target.value)} />
          <Input value={text} maxLength={100} placeholder="今なにしてる？" aria-label="ステータス" className="flex-1" onChange={(e) => setText(e.target.value)} autoFocus />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_PRESETS.map((preset) => (
            <button
              key={preset.text}
              type="button"
              onClick={() => { setEmoji(preset.emoji); setText(preset.text); }}
              className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors", text === preset.text ? "border-accent bg-accent-soft" : "border-line hover:bg-panel")}
            >
              {preset.emoji} {preset.text}
            </button>
          ))}
        </div>
        <Field label="消えるタイミング">
          <select value={expiry} onChange={(e) => setExpiry(e.target.value as StatusExpiry)} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
            {EXPIRY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          {expiry !== "never" && <div className="mt-1 text-xs text-muted">{expiryLabel(expiryAt(expiry))}</div>}
        </Field>
        <div className="flex justify-between gap-2">
          <Button type="button" variant="ghost" onClick={() => void clear()} disabled={busy || !current}>クリア</Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
            <Button type="submit" disabled={busy || (!emoji.trim() && !text.trim())}>保存</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
