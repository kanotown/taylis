import { RotateCcw } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { describeError } from "../api/errors";
import type { RolloverAction, RolloverOut, RolloverPreviewOut } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { fullTimestamp } from "./format";
import { Badge, Button, cn, Field, Input, Modal } from "./primitives";
import { academicYear, actionOptions, defaultChoice, type RolloverChoice, rolloverBody, rolloverCounts, rolloverSummary } from "./rollover";
import { t } from "../i18n";

const SELECT = "h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm";

type Note = { tone: "ok" | "error"; text: string };

function NoteLine({ note }: { note: Note | null }) {
  if (!note) return null;
  return (
    <p role={note.tone === "error" ? "alert" : "status"} className={cn("rounded-lg px-3 py-2 text-sm", note.tone === "error" ? "bg-danger/10 text-danger" : "bg-accent-soft/60 text-ink")}>
      {note.text}
    </p>
  );
}

/**
 * Administration → 名簿 → 年度更新 (L7 / M32, LAB.md I): every student with the proposal, the choice per person (and for
 * graduates: guest, the channels they keep), the channels every graduate stays in, a confirmation, then one transaction
 * on the server.
 * Below it the years applied, each undoable. Results and errors are said here (the app toast sits behind the dialog).
 */
export function RolloverView({ controller }: { controller: AppController }) {
  const store = controller.store;
  const me = store.me;
  const [year, setYear] = useState(() => String(academicYear(new Date())));
  const [preview, setPreview] = useState<RolloverPreviewOut | null>(null);
  const [choices, setChoices] = useState<Map<string, RolloverChoice>>(new Map());
  // The channels every graduate joins and stays in (OB・OG, 全体連絡…).
  const [stayIds, setStayIds] = useState<Set<string>>(() => new Set());
  const [history, setHistory] = useState<RolloverOut[] | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState<RolloverOut | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const channels = [...store.channels.values()]
    .filter((c) => !c.archived && (c.type === "public" || c.type === "private"))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const nameOf = (userId: string) => store.users.get(userId)?.display_name ?? "?";
  const guestAllowed = (userId: string) => userId !== me?.id; // the server refuses to change my own account

  const loadHistory = async () => {
    try {
      setHistory(await controller.api!.rollovers());
    } catch (error) {
      setNote({ tone: "error", text: describeError(error) });
    }
  };
  useEffect(() => {
    if (controller.api) void loadHistory();
  }, [controller.api]);

  const loadPreview = async (target: number, keepChoices = false) => {
    const out = await controller.api!.rolloverPreview(target);
    setPreview(out);
    if (!keepChoices) {
      setChoices(new Map(out.items.map((item) => [item.user_id, defaultChoice(item, guestAllowed(item.user_id) && store.users.get(item.user_id)?.role !== "admin")])));
    }
  };

  const read = async (event: FormEvent) => {
    event.preventDefault();
    const target = Number(year);
    if (!Number.isInteger(target) || target < 2000 || target > 2100) {
      setNote({ tone: "error", text: t("rollover.yearInvalid") });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await loadPreview(target);
    } catch (error) {
      setNote({ tone: "error", text: describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const choose = (userId: string, patch: Partial<RolloverChoice>) =>
    setChoices((current) => {
      const next = new Map(current);
      const base = next.get(userId);
      if (base) next.set(userId, { ...base, ...patch });
      return next;
    });

  const toggleKeep = (userId: string, channelId: string) => {
    const keep = new Set(choices.get(userId)?.keep ?? []);
    if (keep.has(channelId)) keep.delete(channelId);
    else keep.add(channelId);
    choose(userId, { keep });
  };

  const body = preview ? rolloverBody(preview.academic_year, preview.items, choices, [...stayIds]) : null;
  const counts = body ? rolloverCounts(body) : null;

  const apply = async () => {
    if (!body) return;
    setBusy(true);
    setDialogError(null);
    try {
      const out = await controller.api!.applyRollover(body);
      setConfirming(false);
      setNote({ tone: "ok", text: t("rollover.applied", { year: out.academic_year, summary: rolloverSummary(out) }) });
      await Promise.all([loadPreview(out.academic_year, true), loadHistory()]);
    } catch (error) {
      setDialogError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (row: RolloverOut) => {
    setBusy(true);
    setDialogError(null);
    try {
      await controller.api!.undoRollover(row.academic_year);
      setUndoing(null);
      setNote({ tone: "ok", text: t("rollover.undone", { year: row.academic_year }) });
      await Promise.all([loadHistory(), preview?.academic_year === row.academic_year ? loadPreview(row.academic_year) : Promise.resolve()]);
    } catch (error) {
      setDialogError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {t("rollover.intro")}
      </p>
      <form className="flex items-end gap-2" onSubmit={(e) => void read(e)}>
        <div className="w-32">
          <Field label={t("rollover.year")}>
            <Input type="number" inputMode="numeric" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={busy} className="mb-0.5">{t("rollover.load")}</Button>
      </form>
      <NoteLine note={note} />
      {preview && (
        <div className="space-y-3">
          {preview.applied_at && (
            <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
              {t("rollover.alreadyApplied", { year: preview.academic_year, at: fullTimestamp(preview.applied_at) })}
            </p>
          )}
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label={t("rollover.students")}>
            {preview.items.map((item) => {
              const choice = choices.get(item.user_id);
              const name = nameOf(item.user_id);
              const graduate = choice?.action === "graduate";
              return (
                <li key={item.user_id} className="px-3 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <Avatar id={item.user_id} name={name} size={24} />
                    <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                    <Badge tone="accent">{item.grade ?? t("rollover.noGrade")}</Badge>
                    <select
                      aria-label={t("rollover.forPerson", { name })}
                      value={choice?.action ?? item.action}
                      disabled={!!preview.applied_at}
                      onChange={(e) => choose(item.user_id, { action: e.target.value as RolloverAction })}
                      className={cn(SELECT, "w-40")}
                    >
                      {actionOptions(item).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                  {graduate && !preview.applied_at && (
                    <div className="mt-2 space-y-1 pl-9 text-xs">
                      <label className={cn("flex items-center gap-1.5", !guestAllowed(item.user_id) && "opacity-60")}>
                        <input
                          type="checkbox"
                          checked={choice.guest && guestAllowed(item.user_id)}
                          disabled={!guestAllowed(item.user_id)}
                          onChange={(e) => choose(item.user_id, { guest: e.target.checked })}
                        />
                        {t("rollover.makeGuest")}{!guestAllowed(item.user_id) && t("rollover.notSelf")}
                      </label>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="group" aria-label={t("rollover.keepFor", { name })}>
                        <span className="text-muted">{t("rollover.keep")}</span>
                        {item.channels.map((channel) => (
                          <label key={channel.id} className="flex items-center gap-1">
                            <input type="checkbox" checked={choice.keep.has(channel.id)} onChange={() => toggleKeep(item.user_id, channel.id)} />
                            {channel.type === "private" ? "🔒" : "#"}{channel.name}
                          </label>
                        ))}
                        {item.channels.length === 0 && <span className="text-muted">{t("rollover.noChannels")}</span>}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            {preview.items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("rollover.noStudents")}</li>}
          </ul>
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-muted" id="stay-channels-label">
                {t("rollover.alumniChannels")}
              </div>
              <div className="mt-1 flex max-h-24 flex-wrap gap-x-3 gap-y-1 overflow-y-auto text-sm" role="group" aria-labelledby="stay-channels-label">
                {channels.map((c) => (
                  <label key={c.id} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={stayIds.has(c.id)}
                      disabled={!!preview.applied_at}
                      onChange={(e) => setStayIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(c.id); else next.delete(c.id);
                        return next;
                      })}
                    />
                    {c.type === "private" ? "🔒" : "#"}{c.name}
                  </label>
                ))}
              </div>
            </div>
            <Button
              size="sm"
              className="mb-0.5"
              disabled={busy || !!preview.applied_at || preview.items.length === 0}
              title={preview.applied_at ? t("rollover.appliedTitle") : undefined}
              onClick={() => { setDialogError(null); setConfirming(true); }}
            >
              {t("rollover.applyMenu")}
            </Button>
          </div>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted">{t("rollover.history")}</h3>
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label={t("rollover.history")}>
          {(history ?? []).map((row) => (
            <li key={row.academic_year} className={cn("flex items-center gap-3 px-3 py-2 text-sm", row.undone_at && "opacity-60")}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{t("rollover.yearValue", { year: row.academic_year })}</span>
                  <span className="text-xs text-muted">{rolloverSummary(row)}</span>
                  {row.undone_at && <Badge>{t("rollover.undoneBadge")}</Badge>}
                </div>
                <div className="truncate text-[11px] text-muted">
                  {t("rollover.appliedBy", { name: nameOf(row.applied_by), at: fullTimestamp(row.applied_at) })}{row.undone_at && t("rollover.undoneAt", { at: fullTimestamp(row.undone_at) })}
                </div>
              </div>
              {!row.undone_at && (
                <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => { setDialogError(null); setUndoing(row); }}>
                  <RotateCcw size={14} /> {t("rollover.undo")}
                </Button>
              )}
            </li>
          ))}
          {history?.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">{t("rollover.none")}</li>}
          {history === null && <li className="px-3 py-4 text-center text-sm text-muted">{t("common.loading")}</li>}
        </ul>
      </div>
      {confirming && preview && counts && (
        <Modal onClose={() => setConfirming(false)} title={t("rollover.applyTitle", { year: preview.academic_year })} className="w-[480px]">
          <ul className="mt-3 space-y-0.5 text-sm">
            <li>{t("rollover.countAdvance", { count: counts.advance })}</li>
            <li>{t("rollover.countStay", { count: counts.stay })}</li>
            <li>{t("rollover.countGraduate", { count: counts.graduate })}{counts.graduate > 0 && t("rollover.countGuests", { count: counts.guests })}</li>
            {counts.graduate > 0 && <li>{t("rollover.alumniChannelsList", { channels: stayIds.size ? [...stayIds].map((id) => `#${store.channels.get(id)?.name ?? ""}`).join(t("common.listSeparator")) : t("workflow.none") })}</li>}
          </ul>
          {counts.graduate > 0 && (
            <p className="mt-3 rounded-lg bg-panel-2 px-3 py-2 text-sm">
              {t("rollover.applyNote")}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">{t("rollover.applyNote2")}</p>
          {dialogError && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{dialogError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
            <Button disabled={busy} onClick={() => void apply()}>{t("rollover.apply")}</Button>
          </div>
        </Modal>
      )}
      {undoing && (
        <Modal onClose={() => setUndoing(null)} title={t("rollover.undoTitle", { year: undoing.academic_year })} className="w-[440px]">
          <p className="mt-2 text-sm text-muted">
            {t("rollover.undoNote")}
          </p>
          {dialogError && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{dialogError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setUndoing(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void undo(undoing)}>{t("rollover.undo")}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
