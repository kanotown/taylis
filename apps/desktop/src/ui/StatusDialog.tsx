import { type FormEvent, useState } from "react";

import type { AppController } from "../state/app";
import { Button, cn, Field, Input, Modal } from "./primitives";
import { DAY_LABELS, DND_OPTIONS, deviceTimeZone, dndUntilAt, type QuietHours } from "./dnd";
import { activeStatus, EXPIRY_OPTIONS, expiryAt, expiryLabel, STATUS_PRESETS, type StatusExpiry } from "./users";

/** Custom status editor (M11d): emoji + text + expiry, quick presets, clear. */
export function StatusDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  const me = controller.store.me;
  const current = activeStatus(me ? controller.store.users.get(me.id) ?? me : null);
  const [emoji, setEmoji] = useState(current?.emoji ?? "");
  const [text, setText] = useState(current?.text ?? "");
  const [expiry, setExpiry] = useState<StatusExpiry>("never");
  const [busy, setBusy] = useState(false);
  // M12c: a manual pause applies at once; quiet hours are saved with the form.
  const meNow = me ? controller.store.users.get(me.id) ?? me : null;
  const dndUntil = meNow?.dnd_until && Date.parse(meNow.dnd_until) > Date.now() ? meNow.dnd_until : null;
  const existing = meNow?.quiet_hours ?? null;
  const [quietOn, setQuietOn] = useState(existing !== null);
  const [quiet, setQuiet] = useState<QuietHours>(existing ?? { start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6], tz: deviceTimeZone() });
  const quietChanged = quietOn !== (existing !== null) || (quietOn && JSON.stringify({ ...quiet, days: [...(quiet.days ?? [])].sort() }) !== JSON.stringify({ ...existing, days: [...(existing?.days ?? [])].sort() }));
  const pause = async (until: string | null) => {
    setBusy(true);
    await controller.updateProfile({ dnd_until: until });
    setBusy(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const statusFields = emoji.trim() || text.trim() ? { status_emoji: emoji.trim() || null, status_text: text.trim() || null, status_expires_at: expiryAt(expiry) } : {};
    const ok = await controller.updateProfile({
      ...statusFields,
      ...(quietChanged ? { quiet_hours: quietOn ? { ...quiet, days: quiet.days && quiet.days.length > 0 ? quiet.days : [0, 1, 2, 3, 4, 5, 6] } : null } : {}),
    });
    setBusy(false);
    if (ok) onClose();
  };
  const toggleDay = (day: number) => {
    const days = new Set(quiet.days ?? []);
    if (days.has(day)) days.delete(day);
    else days.add(day);
    setQuiet({ ...quiet, days: [...days].sort() });
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
          <Input value={emoji} maxLength={8} placeholder="絵文字" aria-label="絵文字" className="w-20 text-center text-lg" onChange={(e) => setEmoji(e.target.value)} />
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
        <Field label="通知を一時停止">
          <div className="flex flex-wrap items-center gap-1.5">
            {DND_OPTIONS.map(([choice, label]) => (
              <button key={choice} type="button" disabled={busy} onClick={() => void pause(dndUntilAt(choice))} className="rounded-full border border-line px-2.5 py-1 text-xs transition-colors hover:bg-panel">
                {label}
              </button>
            ))}
            {dndUntil && (
              <button type="button" disabled={busy} onClick={() => void pause(null)} className="rounded-full border border-accent bg-accent-soft px-2.5 py-1 text-xs">
                🔕 {expiryLabel(dndUntil)} · 解除
              </button>
            )}
          </div>
        </Field>
        <Field label="おやすみ時間">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={quietOn} onChange={(e) => setQuietOn(e.target.checked)} />
            毎日この時間帯は通知を止める
          </label>
          {quietOn && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Input type="time" value={quiet.start} aria-label="開始" className="w-28" onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} />
                <span>〜</span>
                <Input type="time" value={quiet.end} aria-label="終了" className="w-28" onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} />
              </div>
              <div className="flex gap-1">
                {DAY_LABELS.map((label, day) => (
                  <button key={label} type="button" onClick={() => toggleDay(day)} className={cn("h-7 w-7 rounded-full border text-xs", quiet.days?.includes(day) ? "border-accent bg-accent-soft" : "border-line text-muted")}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="text-xs text-muted">タイムゾーン: {quiet.tz}</div>
            </div>
          )}
        </Field>
        <div className="flex justify-between gap-2">
          <Button type="button" variant="ghost" onClick={() => void clear()} disabled={busy || !current}>クリア</Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>キャンセル</Button>
            <Button type="submit" disabled={busy || (!emoji.trim() && !text.trim() && !quietChanged)}>保存</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
