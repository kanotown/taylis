/**
 * M99 (docs/RESERVATIONS.md §6): a channel's reservation pools — shared, limited seats (e.g. the lab's Claude Premium
 * seats) that members queue for and operators hand out by hand.
 *
 * - ReservationBar: under the conversation's header, one chip per pool (「🎫 Claude Premium シート 2/3 · 待ち 1」 and my
 *   status); a chip opens the pool's card.
 * - ReservationCard: the holders (since when, guaranteed until), the queue, who goes next, my status and buttons
 *   (予約する / 取り消す / 返却する); operators also get 割り当てた / 外した / 入れ替えた and the members' addresses.
 * - ReservationSettings: the channel's pools for its owners and administrators (in the channel details and ⋯).
 */
import { Pencil, Plus, Ticket, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { MemberOut, PoolOut, ReservationOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar } from "./Avatar";
import { shortDateTime } from "./recurring";
import { Badge, Button, cn, Input, Modal } from "./primitives";
import { deviceZone, holderBadge, holderLine, myReservation, myStatusText, myStatusUrgent, poolFormProblem, poolSummary, waiterLine } from "./reservationPools";

const MAX_POOLS = 5;

function userName(controller: AppController, userId: string): string {
  return controller.store.users.get(userId)?.display_name ?? "(不明)";
}

/** The pools as chips under the header; nothing when the channel has none. */
export function ReservationBar({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const pools = controller.store.poolsOf(channel.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = pools.filter((p) => p.enabled || p.holders.length > 0 || p.waiting.length > 0);
  const open = pools.find((p) => p.id === openId) ?? null;
  if (shown.length === 0 && !open) return null;
  return (
    <>
      <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-line px-3 py-1" aria-label="共有枠の予約" data-reservation-bar>
        {shown.map((pool) => {
          const status = myStatusText(pool);
          return (
            <button
              key={pool.id}
              type="button"
              onClick={() => setOpenId(pool.id)}
              className={cn(
                "inline-flex max-w-[360px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink hover:bg-panel",
                myStatusUrgent(pool) && "bg-rose-500/10",
              )}
              title={`${pool.name}: ${poolSummary(pool)}`}
            >
              <Ticket size={13} className="shrink-0 text-muted" />
              <span className="truncate font-medium">{pool.name}</span>
              <span className="shrink-0 text-muted" data-pool-summary>{poolSummary(pool)}</span>
              {status && <span className={cn("shrink-0", myStatusUrgent(pool) ? "font-semibold text-danger" : "text-accent")}>· {status}</span>}
            </button>
          );
        })}
      </div>
      {open && (
        <Modal onClose={() => setOpenId(null)} title={open.name} description={`${open.capacity} 枠 · 割り当てから ${open.min_hours} 時間は保証`} className="w-[560px]">
          <ReservationCard controller={controller} channel={channel} pool={open} />
        </Modal>
      )}
    </>
  );
}

type Confirm = { text: string; label: string; danger?: boolean; run: () => Promise<unknown> };

/** One pool's card (in the dialog the chip opens). */
export function ReservationCard({ controller, channel, pool }: { controller: AppController; channel: ChannelState; pool: PoolOut }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();
  const mine = myReservation(pool);
  const name = (id: string) => userName(controller, id);
  const operate = pool.can_operate && !channel.archived;

  const run = async (call: () => Promise<PoolOut | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await call();
      if (!out) setError(controller.error ?? "操作できませんでした");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  const act = (row: ReservationOut, action: "cancel" | "return" | "assign" | "remove") => run(() => controller.reservationAction(row.id, action));

  const canReserve = mine.kind === "none" && pool.enabled && channel.isMember && !channel.archived && !controller.isGuest;
  const person = (row: ReservationOut, line: string, badge: ReactNode, buttons: ReactNode) => (
    <li key={row.id} className="flex items-start gap-2.5 py-2" data-reservation={row.id}>
      <Avatar id={row.user_id} name={name(row.user_id)} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-medium">{name(row.user_id)}</span>
          {row.id === pool.my_reservation_id && <span className="text-xs text-muted">(自分)</span>}
          {badge}
        </div>
        {row.email && <div className="select-text text-xs text-muted" data-email>{row.email}</div>}
        <div className="text-xs text-muted">{line}</div>
      </div>
      {buttons && <div className="flex shrink-0 flex-wrap justify-end gap-1">{buttons}</div>}
    </li>
  );

  return (
    <div className="mt-3 space-y-4" data-reservation-card>
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-panel-2 px-3 py-2 text-sm">
        <span className="min-w-0 flex-1">
          {mine.kind === "none" && (pool.enabled ? "予約していません" : "この枠は今は予約を受け付けていません")}
          {mine.kind === "waiting" && <>予約中: 待ち <strong>{mine.row.position}</strong> 番目{mine.row.step === "assign" ? " (空きあり、担当者の割り当て待ち)" : ""}</>}
          {mine.kind === "holding" && (
            <>
              利用中{mine.row.guarantee_until ? <> · 保証 <strong>{shortDateTime(mine.row.guarantee_until)}</strong> まで</> : null}
              {mine.row.evict_at && <span className="block text-danger">待っている人がいます。{shortDateTime(mine.row.evict_at)} 以降に担当者が外します</span>}
            </>
          )}
          {mine.kind === "returning" && "返却しました。担当者が外すのを待っています"}
        </span>
        {canReserve && <Button size="sm" disabled={busy} onClick={() => void run(() => controller.reservePool(pool.id))}>予約する</Button>}
        {mine.kind === "waiting" && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(mine.row, "cancel")}>取り消す</Button>
        )}
        {mine.kind === "holding" && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setConfirm({ text: `「${pool.name}」を返却しますか？ 担当者が外します。`, label: "返却する", run: () => act(mine.row, "return") })}
          >
            返却する
          </Button>
        )}
      </div>

      {confirm && (
        <div className="space-y-2 rounded-lg border border-line px-3 py-2 text-sm" role="alertdialog" aria-label="確認">
          <p>{confirm.text}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirm(null)}>キャンセル</Button>
            <Button size="sm" variant={confirm.danger ? "danger" : "primary"} disabled={busy} onClick={() => void confirm.run()}>{confirm.label}</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}

      <section aria-label="利用中">
        <h3 className="text-xs font-semibold text-muted">利用中 {pool.holders.length}/{pool.capacity}</h3>
        {pool.holders.length === 0 ? (
          <p className="py-2 text-sm text-muted">いません</p>
        ) : (
          <ul className="divide-y divide-line">
            {pool.holders.map((row) => {
              const badge = holderBadge(row, pool, now);
              const early = row.status === "holding" && !row.evict_at && !!row.guarantee_until && new Date(row.guarantee_until) > now;
              return person(
                row,
                holderLine(row),
                badge && <Badge tone={badge.tone}>{badge.text}</Badge>,
                operate && (
                  <Button
                    size="sm"
                    variant={row.ready ? "primary" : "secondary"}
                    disabled={busy}
                    onClick={() =>
                      setConfirm({
                        text: early
                          ? `${name(row.user_id)} さんはまだ保証時間内です (${shortDateTime(row.guarantee_until!)} まで)。管理画面で外しましたか？`
                          : `${name(row.user_id)} さんを管理画面で外しましたか？`,
                        label: "外した",
                        danger: early,
                        run: () => act(row, "remove"),
                      })
                    }
                  >
                    外した
                  </Button>
                ),
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="待っている人">
        <h3 className="text-xs font-semibold text-muted">待ち {pool.waiting.length} 人</h3>
        {pool.waiting.length === 0 ? (
          <p className="py-2 text-sm text-muted">いません</p>
        ) : (
          <ul className="divide-y divide-line">
            {pool.waiting.map((row) => {
              const holder = row.step === "swap" ? pool.holders.find((h) => h.id === row.pair_id) : undefined;
              return person(
                row,
                waiterLine(row, pool, name),
                <span className="text-xs text-muted">{row.position} 番目</span>,
                operate && (
                  <>
                    {row.step === "assign" && (
                      <Button size="sm" disabled={busy} onClick={() => void act(row, "assign")}>割り当てた</Button>
                    )}
                    {holder && row.ready && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            text: `管理画面で ${name(holder.user_id)} さんを外して ${name(row.user_id)} さんを割り当てましたか？`,
                            label: "入れ替えた",
                            run: () => run(() => controller.swapReservations(pool.id, holder.id, row.id)),
                          })
                        }
                      >
                        入れ替えた
                      </Button>
                    )}
                    {row.id !== pool.my_reservation_id && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setConfirm({ text: `${name(row.user_id)} さんの予約を取り消しますか？ 本人に知らせます。`, label: "取り消す", danger: true, run: () => act(row, "cancel") })}
                      >
                        取り消す
                      </Button>
                    )}
                  </>
                ),
              );
            })}
          </ul>
        )}
      </section>
      <p className="text-xs text-muted">
        割り当てから {pool.min_hours} 時間は外されません。過ぎた後に待つ人がいれば、保証の終わりが早い人から {pool.grace_minutes} 分の猶予の後に入れ替えます。
        {pool.can_operate ? " 担当者の操作 (割り当てた・外した・入れ替えた) は、管理画面で実際に変えた後に押してください。" : ""}
      </p>
    </div>
  );
}

// --- settings ------------------------------------------------------------------------------------

type Form = { name: string; capacity: string; minHours: string; graceMinutes: string; operatorIds: string[]; enabled: boolean };

function formOf(pool: PoolOut | null): Form {
  return pool
    ? { name: pool.name, capacity: String(pool.capacity), minHours: String(pool.min_hours), graceMinutes: String(pool.grace_minutes), operatorIds: [...pool.operator_ids], enabled: pool.enabled }
    : { name: "", capacity: "3", minHours: "6", graceMinutes: "15", operatorIds: [], enabled: true };
}

/** Add or edit one pool. */
function PoolForm({ controller, channel, pool, members, onDone }: { controller: AppController; channel: ChannelState; pool: PoolOut | null; members: MemberOut[] | null; onDone: () => void }) {
  const [form, setForm] = useState<Form>(() => formOf(pool));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useMemo(
    () =>
      (members ?? [])
        .map((m) => controller.store.users.get(m.user_id))
        .filter((u): u is NonNullable<typeof u> => !!u && u.role !== "bot" && u.role !== "guest" && !u.deactivated_at)
        .sort((a, b) => a.display_name.localeCompare(b.display_name, "ja")),
    [members, controller],
  );
  const submit = async () => {
    const problem = poolFormProblem(form);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      capacity: Number(form.capacity),
      min_hours: Number(form.minHours),
      grace_minutes: Number(form.graceMinutes),
      operator_ids: form.operatorIds,
      enabled: form.enabled,
    };
    const out = pool ? await controller.updateReservationPool(pool.id, body) : await controller.createReservationPool(channel.id, { ...body, tz: deviceZone() });
    setBusy(false);
    if (out) onDone();
    else setError(controller.error ?? "保存できませんでした");
  };
  const field = "block text-xs font-semibold text-muted";
  return (
    <form
      className="space-y-3 rounded-lg border border-line px-3 py-3"
      aria-label={pool ? "枠を編集" : "枠を追加"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className={field}>
        名前
        <Input className="mt-1" maxLength={80} placeholder="例: Claude Premium シート" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
      </label>
      <div className="grid grid-cols-3 gap-2">
        <label className={field}>
          枠の数
          <Input className="mt-1" inputMode="numeric" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
        </label>
        <label className={field}>
          最低保証 (時間)
          <Input className="mt-1" inputMode="numeric" value={form.minHours} onChange={(e) => setForm({ ...form, minHours: e.target.value })} />
        </label>
        <label className={field}>
          猶予 (分)
          <Input className="mt-1" inputMode="numeric" value={form.graceMinutes} onChange={(e) => setForm({ ...form, graceMinutes: e.target.value })} />
        </label>
      </div>
      <fieldset>
        <legend className={field}>担当者 (割り当て・外す人。通知が届き、予約した人のメールアドレスが見えます)</legend>
        {members === null ? (
          <p className="mt-1 text-xs text-muted">メンバーを読み込み中…</p>
        ) : (
          <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-line px-2 py-1">
            {candidates.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.operatorIds.includes(u.id)}
                  onChange={(e) => setForm({ ...form, operatorIds: e.target.checked ? [...form.operatorIds, u.id] : form.operatorIds.filter((id) => id !== u.id) })}
                />
                {u.display_name} <span className="text-xs text-muted">@{u.username}</span>
              </label>
            ))}
          </div>
        )}
        <p className="mt-1 text-xs text-muted">選ばないと、チャンネルのオーナーに通知が届きます。</p>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        予約を受け付ける
      </label>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onDone}>キャンセル</Button>
        <Button size="sm" type="submit" disabled={busy}>{pool ? "保存" : "追加"}</Button>
      </div>
    </form>
  );
}

/** The channel's pools for its owners and administrators: add, edit, delete. Others see the list only. */
export function ReservationSettings({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const pools = controller.store.poolsOf(channel.id);
  const [editing, setEditing] = useState<PoolOut | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberOut[] | null>(null);
  const canManage = (controller.isAdmin || channel.membership?.role === "owner") && channel.isMember && !channel.archived;

  useEffect(() => {
    void controller.engine?.loadReservationPools(channel.id);
  }, [controller, channel.id]);
  useEffect(() => {
    const api = controller.api;
    if (!api || !editing) return;
    let current = true;
    api.members(channel.id).then(
      (list) => { if (current) setMembers(list); },
      () => { if (current) setMembers([]); },
    );
    return () => { current = false; };
  }, [controller, channel.id, editing]);

  return (
    <div className="space-y-2" data-reservation-settings>
      {pools.length === 0 ? (
        <p className="py-1 text-sm text-muted">
          予約の枠はありません。{canManage ? "共有のアカウントやシートなど、数に限りのあるものを順番に使う枠を作れます。" : ""}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {pools.map((pool) => (
            <li key={pool.id} className="px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <Ticket size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium">{pool.name}</span>
                {!pool.enabled && <Badge>停止中</Badge>}
                {canManage && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(pool)} aria-label={`${pool.name} を編集`}><Pencil size={13} /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(pool.id)} aria-label={`${pool.name} を削除`}><Trash2 size={13} /></Button>
                  </>
                )}
              </div>
              <div className="text-xs text-muted">
                {pool.capacity} 枠 · 利用中 {pool.holders.length} · 待ち {pool.waiting.length} · 保証 {pool.min_hours} 時間 · 猶予 {pool.grace_minutes} 分
                {pool.operator_ids.length > 0 && <> · 担当: {pool.operator_ids.map((id) => userName(controller, id)).join("、")}</>}
              </div>
              {confirmDelete === pool.id && (
                <div className="mt-1.5 space-y-1.5 rounded-lg bg-panel-2 px-2 py-1.5 text-xs">
                  <p>
                    「{pool.name}」を削除しますか？ 予約の待ちと利用中の記録が消えます (ボットの投稿は残ります)。
                    {pool.holders.length > 0 ? ` 利用中の ${pool.holders.length} 人のシートは管理画面で手で外してください。` : ""}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(null)}>キャンセル</Button>
                    <Button size="sm" variant="danger" onClick={() => void controller.deleteReservationPool(channel.id, pool.id).then(() => setConfirmDelete(null))}>削除</Button>
                  </div>
                </div>
              )}
              {editing !== null && editing !== "new" && editing.id === pool.id && (
                <div className="mt-2">
                  <PoolForm controller={controller} channel={channel} pool={pool} members={members} onDone={() => setEditing(null)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing === "new" ? (
        <PoolForm controller={controller} channel={channel} pool={null} members={members} onDone={() => setEditing(null)} />
      ) : (
        canManage && pools.length < MAX_POOLS && (
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}><Plus size={13} /> 枠を追加</Button>
        )
      )}
    </div>
  );
}

export function ReservationSettingsDialog({ controller, channel, onClose }: { controller: AppController; channel: ChannelState; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title="共有枠の予約" description="数に限りのあるもの (共有のシートなど) を順番待ちで使う枠。メンバーは会話の上の枠から予約します" className="w-[560px]">
      <div className="mt-3">
        <ReservationSettings controller={controller} channel={channel} />
      </div>
    </Modal>
  );
}
