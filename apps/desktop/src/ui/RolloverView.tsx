import { RotateCcw } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { describeError } from "../api/errors";
import type { RolloverAction, RolloverOut, RolloverPreviewOut } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { fullTimestamp } from "./format";
import { Badge, Button, cn, Field, Input, Modal } from "./primitives";
import { academicYear, actionOptions, defaultChoice, type RolloverChoice, rolloverBody, rolloverCounts, rolloverSummary } from "./rollover";

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
 * graduates: guest, the channels they keep), the alumni channel, a confirmation, then one transaction on the server.
 * Below it the years applied, each undoable. Results and errors are said here (the app toast sits behind the dialog).
 */
export function RolloverView({ controller }: { controller: AppController }) {
  const store = controller.store;
  const me = store.me;
  const [year, setYear] = useState(() => String(academicYear(new Date())));
  const [preview, setPreview] = useState<RolloverPreviewOut | null>(null);
  const [choices, setChoices] = useState<Map<string, RolloverChoice>>(new Map());
  const [alumniId, setAlumniId] = useState("");
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
      setNote({ tone: "error", text: "年度は 2000〜2100 の数字で入れてください" });
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

  const body = preview ? rolloverBody(preview.academic_year, preview.items, choices, alumniId || null) : null;
  const counts = body ? rolloverCounts(body) : null;

  const apply = async () => {
    if (!body) return;
    setBusy(true);
    setDialogError(null);
    try {
      const out = await controller.api!.applyRollover(body);
      setConfirming(false);
      setNote({ tone: "ok", text: `${out.academic_year} 年度の年度更新を適用しました (${rolloverSummary(out)})` });
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
      setNote({ tone: "ok", text: `${row.academic_year} 年度の年度更新を取り消しました` });
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
        名簿の学生を 1 年進めます。卒業・修了する人は卒業生になり、times がアーカイブされ、残すチャンネルと卒業生のチャンネル以外の公開・非公開チャンネルから外れます (DM は残ります)。あとから取り消せます。
      </p>
      <form className="flex items-end gap-2" onSubmit={(e) => void read(e)}>
        <div className="w-32">
          <Field label="年度">
            <Input type="number" inputMode="numeric" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={busy} className="mb-0.5">読み込む</Button>
      </form>
      <NoteLine note={note} />
      {preview && (
        <div className="space-y-3">
          {preview.applied_at && (
            <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
              {preview.academic_year} 年度の年度更新は {fullTimestamp(preview.applied_at)} に適用済みです。やり直すには下の履歴で取り消してください。
            </p>
          )}
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label="学生">
            {preview.items.map((item) => {
              const choice = choices.get(item.user_id);
              const name = nameOf(item.user_id);
              const graduate = choice?.action === "graduate";
              return (
                <li key={item.user_id} className="px-3 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <Avatar id={item.user_id} name={name} size={24} />
                    <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                    <Badge tone="accent">{item.grade ?? "学年なし"}</Badge>
                    <select
                      aria-label={`${name} の年度更新`}
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
                        ゲストにする{!guestAllowed(item.user_id) && " (自分自身はゲストにできません)"}
                      </label>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="group" aria-label={`${name} の残すチャンネル`}>
                        <span className="text-muted">残すチャンネル:</span>
                        {item.channels.map((channel) => (
                          <label key={channel.id} className="flex items-center gap-1">
                            <input type="checkbox" checked={choice.keep.has(channel.id)} onChange={() => toggleKeep(item.user_id, channel.id)} />
                            {channel.type === "private" ? "🔒" : "#"}{channel.name}
                          </label>
                        ))}
                        {item.channels.length === 0 && <span className="text-muted">なし (参加しているチャンネルはありません)</span>}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            {preview.items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">名簿に学生がいません</li>}
          </ul>
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <Field label="卒業生のチャンネル (任意、卒業・修了する人が加わります)">
                <select value={alumniId} onChange={(e) => setAlumniId(e.target.value)} disabled={!!preview.applied_at} className={SELECT}>
                  <option value="">なし</option>
                  {channels.map((c) => <option key={c.id} value={c.id}>{c.type === "private" ? "🔒" : "#"}{c.name}</option>)}
                </select>
              </Field>
            </div>
            <Button
              size="sm"
              className="mb-0.5"
              disabled={busy || !!preview.applied_at || preview.items.length === 0}
              title={preview.applied_at ? "適用済みです。やり直すには先に取り消してください" : undefined}
              onClick={() => { setDialogError(null); setConfirming(true); }}
            >
              適用…
            </Button>
          </div>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted">これまでの年度更新</h3>
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="これまでの年度更新">
          {(history ?? []).map((row) => (
            <li key={row.academic_year} className={cn("flex items-center gap-3 px-3 py-2 text-sm", row.undone_at && "opacity-60")}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{row.academic_year} 年度</span>
                  <span className="text-xs text-muted">{rolloverSummary(row)}</span>
                  {row.undone_at && <Badge>取り消し済み</Badge>}
                </div>
                <div className="truncate text-[11px] text-muted">
                  {nameOf(row.applied_by)} が {fullTimestamp(row.applied_at)} に適用{row.undone_at && ` · ${fullTimestamp(row.undone_at)} に取り消し`}
                </div>
              </div>
              {!row.undone_at && (
                <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => { setDialogError(null); setUndoing(row); }}>
                  <RotateCcw size={14} /> 取り消す
                </Button>
              )}
            </li>
          ))}
          {history?.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">まだありません</li>}
          {history === null && <li className="px-3 py-4 text-center text-sm text-muted">読み込み中…</li>}
        </ul>
      </div>
      {confirming && preview && counts && (
        <Modal onClose={() => setConfirming(false)} title={`${preview.academic_year} 年度の年度更新を適用しますか？`} className="w-[480px]">
          <ul className="mt-3 space-y-0.5 text-sm">
            <li>進級: {counts.advance} 人</li>
            <li>据え置き: {counts.stay} 人</li>
            <li>卒業・修了: {counts.graduate} 人{counts.graduate > 0 && ` (うちゲストにする ${counts.guests} 人)`}</li>
            {counts.graduate > 0 && <li>卒業生のチャンネル: {alumniId ? `#${store.channels.get(alumniId)?.name ?? ""}` : "なし"}</li>}
          </ul>
          {counts.graduate > 0 && (
            <p className="mt-3 rounded-lg bg-panel-2 px-3 py-2 text-sm">
              卒業・修了する人は卒業生になり、times はアーカイブされます。残すチャンネルと卒業生のチャンネル以外の、公開・非公開チャンネルからはすべて外れます。DM は残ります。
            </p>
          )}
          <p className="mt-2 text-xs text-muted">全員分を 1 回で適用します。あとから履歴で取り消せます。</p>
          {dialogError && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{dialogError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>キャンセル</Button>
            <Button disabled={busy} onClick={() => void apply()}>適用する</Button>
          </div>
        </Modal>
      )}
      {undoing && (
        <Modal onClose={() => setUndoing(null)} title={`${undoing.academic_year} 年度の年度更新を取り消しますか？`} className="w-[440px]">
          <p className="mt-2 text-sm text-muted">
            学年・名簿・ロール・外したチャンネル (元のロールで)・times のアーカイブを適用前に戻し、加えた卒業生のチャンネルから外します。
          </p>
          {dialogError && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{dialogError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setUndoing(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => void undo(undoing)}>取り消す</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
