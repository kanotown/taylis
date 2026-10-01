/**
 * L6 (M59, RECURRING.md §5): a channel's 「定期投稿」 — the list (name, schedule, next time, collecting or not) that every
 * member sees, and for the channel's owners and administrators the create / edit dialog, 止める・再開, 削除 and 今すぐ投稿;
 * and under a collecting post, the chip 「提出 7/10 · 締切 10/9 (金) 18:00」 with who has and has not replied.
 */
import { CalendarClock, ClipboardCheck, Pause, Pencil, Play, Plus, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { describeError } from "../api/errors";
import type { RecurringPostOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState, MessageState } from "../sync/types";
import { Avatar } from "./Avatar";
import { localZone } from "./calendarDates";
import { useMembers } from "./Dialogs";
import { Button, cn, Field, Input, Modal, Textarea } from "./primitives";
import {
  canManageRecurring,
  collectionChip,
  collectionLists,
  createBody,
  draftFromPost,
  dueSummary,
  emptyDraft,
  MAX_AFTER_DAYS,
  MAX_RECURRING_BODY,
  placeholderHint,
  type RecurringDraft,
  recurringDraftProblem,
  scheduleSummary,
  shortDateTime,
  targetsSummary,
  updateBody,
  WEEKDAY_LABELS,
} from "./recurring";

const SELECT =
  "rounded-lg border border-line bg-canvas px-2.5 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60";

/** The list with its actions (in the channel details page, and in a dialog on a wide window). */
export function RecurringPostList({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const store = controller.store;
  const manage = canManageRecurring(channel, controller.isAdmin) && !channel.archived;
  const [rows, setRows] = useState<RecurringPostOut[] | "failed" | null>(null);
  const [editing, setEditing] = useState<RecurringPostOut | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The outcome of the last action, under the list (a toast would sit behind an open dialog).
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [reload, setReload] = useState(0);
  const localTz = useMemo(() => localZone(), []);

  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    let current = true;
    // A failure of any kind (also a client without the call) reads as 「読み込めませんでした」.
    Promise.resolve().then(() => api.recurringPosts(channel.id)).then(
      (list) => { if (current) setRows(list); },
      () => { if (current) setRows("failed"); },
    );
    return () => { current = false; };
  }, [controller, channel.id, reload]);

  const act = useCallback(
    async (post: RecurringPostOut, action: () => Promise<unknown>, done: string) => {
      setBusy(post.id);
      setResult(null);
      try {
        await action();
        setResult({ ok: true, text: done });
        setReload((n) => n + 1);
      } catch (error) {
        setResult({ ok: false, text: describeError(error) });
      } finally {
        setBusy(null);
        setConfirmDelete(null);
      }
    },
    [],
  );
  const api = controller.api;
  const groupName = (id: string) => store.groups.get(id)?.name;
  const userName = (id: string) => store.users.get(id)?.display_name;

  return (
    <div className="space-y-2" data-recurring-list>
      {rows === null ? (
        <p className="py-2 text-sm text-muted">読み込み中…</p>
      ) : rows === "failed" ? (
        <p className="py-2 text-sm text-danger">読み込めませんでした</p>
      ) : rows.length === 0 ? (
        <p className="py-1 text-sm text-muted">
          定期投稿はありません。{manage ? "毎週のスレッド (週報など) をボットが立て、返信で提出を集められます。" : ""}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rows.map((post) => (
            <li key={post.id} className="space-y-1 px-3 py-2.5" data-recurring-post={post.id}>
              <div className="flex items-center gap-2">
                <CalendarClock size={15} className="shrink-0 text-muted" />
                <strong className="min-w-0 flex-1 truncate text-sm">{post.name}</strong>
                {!post.enabled && <span className="shrink-0 rounded bg-panel-2 px-1.5 text-[11px] font-medium text-muted">停止中</span>}
              </div>
              <div className="text-xs text-muted">
                {scheduleSummary(post.schedule, post.tz, localTz)}
                {post.enabled && <> · 次回 {shortDateTime(post.next_run_at)}</>}
              </div>
              <div className="text-xs text-muted">
                {post.collect ? `回収: ${targetsSummary(post.collect, groupName, userName)} · ${dueSummary(post.collect.due)}` : "回収なし"}
              </div>
              {manage && api && (
                confirmDelete === post.id ? (
                  <div className="flex items-center justify-end gap-2 rounded-lg bg-danger/10 px-2 py-1.5">
                    <span className="mr-auto text-xs">「{post.name}」を削除しますか？ これまでの投稿は残ります</span>
                    <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(null)}>キャンセル</Button>
                    <Button variant="danger" size="sm" disabled={busy === post.id} onClick={() => void act(post, () => api.deleteRecurringPost(post.id), "削除しました")}>
                      削除する
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Button variant="secondary" size="sm" disabled={busy === post.id} onClick={() => void act(post, () => api.runRecurringPost(post.id), "投稿しました")}>
                      <Send size={13} /> 今すぐ投稿
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy === post.id}
                      onClick={() => void act(post, () => api.updateRecurringPost(post.id, { enabled: !post.enabled }), post.enabled ? "止めました" : "再開しました")}
                    >
                      {post.enabled ? <><Pause size={13} /> 止める</> : <><Play size={13} /> 再開</>}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(post)}>
                      <Pencil size={13} /> 編集
                    </Button>
                    <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirmDelete(post.id)}>
                      <Trash2 size={13} /> 削除
                    </Button>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {result && <p role={result.ok ? "status" : "alert"} className={cn("text-xs", result.ok ? "text-muted" : "text-danger")}>{result.text}</p>}
      {manage && (
        <Button size="sm" variant="secondary" onClick={() => setEditing("new")} disabled={rows === "failed" || (Array.isArray(rows) && rows.length >= 20)}>
          <Plus size={14} /> 定期投稿を追加
        </Button>
      )}
      {editing && (
        <RecurringPostDialog
          controller={controller}
          channel={channel}
          post={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setResult({ ok: true, text: "保存しました" });
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

/** The wide window's way in: ⋯ → 「定期投稿…」. */
export function RecurringPostsDialog({ controller, channel, onClose }: { controller: AppController; channel: ChannelState; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title="定期投稿" description={`#${channel.name ?? ""} にボットが決まった日時に投稿します`} className="w-[520px]">
      <div className="mt-3">
        <RecurringPostList controller={controller} channel={channel} />
      </div>
    </Modal>
  );
}

/** Create (post = null) or edit a recurring post. */
export function RecurringPostDialog({ controller, channel, post, onClose, onSaved }: {
  controller: AppController;
  channel: ChannelState;
  post: RecurringPostOut | null;
  onClose: () => void;
  onSaved: (post: RecurringPostOut) => void;
}) {
  const [draft, setDraft] = useState<RecurringDraft>(() => (post ? draftFromPost(post) : emptyDraft()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const problem = recurringDraftProblem(draft);
  const localTz = useMemo(() => localZone(), []);
  const zone = post?.tz ?? localTz;
  const set = (patch: Partial<RecurringDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const save = async () => {
    setTouched(true);
    const api = controller.api;
    if (!api || busy) return;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const saved = post ? await api.updateRecurringPost(post.id, updateBody(draft)) : await api.createRecurringPost(channel.id, createBody(draft, localTz));
      onSaved(saved);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  const title = post ? "定期投稿を編集" : "定期投稿を追加";
  return (
    <Modal onClose={onClose} title={title} className="w-[560px]">
      <form
        className="mt-4 space-y-3"
        aria-label={title}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="名前 (ボットの表示名)">
          <Input autoFocus value={draft.name} maxLength={80} placeholder="週報" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="本文" hint={placeholderHint()}>
          <Textarea rows={4} value={draft.body} maxLength={MAX_RECURRING_BODY} placeholder={"**週報 {date}**\nこのスレッドに今週の進捗を返信してください"} onChange={(e) => set({ body: e.target.value })} />
        </Field>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted">繰り返し</span>
          <div role="radiogroup" aria-label="繰り返し" className="flex w-full rounded-lg bg-panel-2 p-0.5 text-sm font-medium">
            {(["weekly", "monthly"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={draft.kind === kind}
                onClick={() => set({ kind })}
                className={cn("flex-1 rounded-md px-2.5 py-1.5 transition-colors", draft.kind === kind ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
              >
                {kind === "weekly" ? "毎週" : "毎月"}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {draft.kind === "weekly" ? (
              <div role="group" aria-label="曜日" className="flex gap-1">
                {WEEKDAY_LABELS.map((label, day) => {
                  const on = draft.weekdays.includes(day);
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={on}
                      aria-label={`${label}曜日`}
                      onClick={() => set({ weekdays: on ? draft.weekdays.filter((d) => d !== day) : [...draft.weekdays, day].sort((a, b) => a - b) })}
                      className={cn("h-8 w-8 rounded-full border text-sm font-medium transition-colors", on ? "border-accent bg-accent text-white" : "border-line text-ink hover:bg-panel")}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <select aria-label="日" className={SELECT} value={draft.day} onChange={(e) => set({ day: Number(e.target.value) })}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                  <option key={day} value={day}>{day === 31 ? "末日" : day >= 29 ? `${day} 日 (ない月は末日)` : `${day} 日`}</option>
                ))}
              </select>
            )}
            <Input type="time" aria-label="時刻" className="w-32" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
          </div>
          {zone !== localTz && <p className="text-xs text-muted">時刻は {zone} の時刻です</p>}
        </div>

        <label className="flex cursor-pointer items-center gap-2.5 pt-1 text-sm">
          <input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--accent)]" checked={draft.collect} onChange={(e) => set({ collect: e.target.checked })} />
          <span>
            返信で提出を集める <span className="ml-1 text-xs text-muted">スレッドに返信した人が提出済みになり、締切を過ぎたら未提出の人にだけリマインドします</span>
          </span>
        </label>
        {draft.collect && (
          <div className="space-y-3 rounded-lg border border-line p-3" data-collect-fields>
            <TargetPicker controller={controller} channel={channel} draft={draft} onChange={set} />
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted">締切</span>
              <div className="flex items-center gap-2">
                <select aria-label="締切の日" className={SELECT} value={draft.afterDays} onChange={(e) => set({ afterDays: Number(e.target.value) })}>
                  {Array.from({ length: MAX_AFTER_DAYS + 1 }, (_, i) => i).map((n) => (
                    <option key={n} value={n}>{n === 0 ? "投稿した日" : `${n} 日後`}</option>
                  ))}
                </select>
                <Input type="time" aria-label="締切の時刻" className="w-32" value={draft.dueTime} onChange={(e) => set({ dueTime: e.target.value })} />
              </div>
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!error && touched && problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button type="submit" disabled={busy}>{post ? "保存" : "追加"}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** 対象: everyone in the channel, or groups and people (the channel's members, not bots). */
function TargetPicker({ controller, channel, draft, onChange }: {
  controller: AppController;
  channel: ChannelState;
  draft: RecurringDraft;
  onChange: (patch: Partial<RecurringDraft>) => void;
}) {
  const store = controller.store;
  const [members] = useMembers(controller, channel.id);
  const [query, setQuery] = useState("");
  const groups = [...store.groups.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const people = (members ?? [])
    .filter((m) => store.users.get(m.user_id)?.role !== "bot")
    .map((m) => ({ id: m.user_id, name: store.users.get(m.user_id)?.display_name ?? "?", username: store.users.get(m.user_id)?.username ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const q = query.trim().toLowerCase();
  const shown = q ? people.filter((p) => p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q)) : people;
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-muted">提出する人</span>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={draft.allMembers} onChange={(e) => onChange({ allMembers: e.target.checked })} />
        チャンネルの全員 <span className="text-xs text-muted">(投稿の時点のメンバー)</span>
      </label>
      {!draft.allMembers && (
        <>
          {groups.length > 0 && (
            <div role="group" aria-label="グループ" className="flex flex-wrap gap-1.5">
              {groups.map((group) => {
                const on = draft.groupIds.includes(group.id);
                return (
                  <button
                    key={group.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onChange({ groupIds: toggle(draft.groupIds, group.id) })}
                    className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors", on ? "border-accent bg-accent-soft text-accent" : "border-line text-ink hover:bg-panel")}
                  >
                    @{group.name}
                  </button>
                );
              })}
            </div>
          )}
          {members === null ? (
            <p className="text-sm text-muted">読み込み中…</p>
          ) : (
            <>
              {people.length > 8 && <Input value={query} aria-label="メンバーを絞り込む" placeholder="名前で絞り込む" className="h-8 text-sm" onChange={(e) => setQuery(e.target.value)} />}
              <ul role="group" aria-label="メンバー" className="max-h-40 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {shown.map((person) => (
                  <li key={person.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-panel">
                      <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" aria-label={person.name} checked={draft.userIds.includes(person.id)} onChange={() => onChange({ userIds: toggle(draft.userIds, person.id) })} />
                      <Avatar id={person.id} name={person.name} size={20} />
                      <span className="min-w-0 flex-1 truncate">{person.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="text-xs text-muted">グループと選んだ人を合わせた、投稿の時点のチャンネルのメンバーが対象です</p>
        </>
      )}
    </div>
  );
}

/** Under a collecting post: 「提出 7/10 · 締切 10/9 (金) 18:00」, 「未提出」 standing out when I owe one; opens the lists. */
export function CollectionChip({ controller, message }: { controller: AppController; message: MessageState }) {
  const collection = message.collection;
  const [open, setOpen] = useState(false);
  if (!collection) return null;
  const chip = collectionChip(collection, controller.store.me?.id);
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-xs" data-collection-chip>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 font-medium transition-colors",
          chip.mine === "pending" ? "border-warning/60 bg-warning/10 text-ink hover:bg-warning/20" : "border-line text-ink hover:bg-panel",
        )}
        aria-label={`${chip.label}${chip.mine === "pending" ? " (未提出)" : chip.mine === "submitted" ? " (提出済み)" : ""}`}
      >
        <ClipboardCheck size={13} className={cn("shrink-0", chip.complete ? "text-success" : "text-muted")} />
        <span className="truncate">{chip.label}</span>
        {chip.mine === "pending" && <span className={cn("shrink-0 rounded px-1 text-[10px] font-bold text-white", chip.overdue ? "bg-danger" : "bg-warning")}>未提出</span>}
        {chip.mine === "submitted" && <span className="shrink-0 rounded bg-accent-soft px-1 text-[10px] font-bold text-accent">提出済み</span>}
      </button>
      {open && <CollectionDialog controller={controller} message={message} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** 提出済み / 未提出 with avatars (any member may look: the thread shows who replied anyway). */
export function CollectionDialog({ controller, message, onClose }: { controller: AppController; message: MessageState; onClose: () => void }) {
  const store = controller.store;
  const collection = message.collection;
  if (!collection) return null;
  const { submitted, missing } = collectionLists(collection);
  const chip = collectionChip(collection, store.me?.id);
  const row = (id: string) => {
    const name = store.users.get(id)?.display_name ?? "?";
    return (
      <li key={id} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
        <Avatar id={id} name={name} size={26} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        {id === store.me?.id && <span className="shrink-0 text-xs text-muted">(自分)</span>}
      </li>
    );
  };
  return (
    <Modal onClose={onClose} title="提出状況" description={`${chip.label}${chip.overdue ? " (締切を過ぎました)" : ""}`} className="w-[380px]">
      <section aria-label="提出済み" className="mt-3">
        <h3 className="text-xs font-semibold text-muted">提出済み {submitted.length} 人</h3>
        {submitted.length === 0 ? <p className="py-2 text-sm text-muted">まだいません</p> : <ul className="mt-1 max-h-60 space-y-1 overflow-y-auto">{submitted.map(row)}</ul>}
      </section>
      <section aria-label="未提出" className="mt-4 border-t border-line pt-3">
        <h3 className="text-xs font-semibold text-muted">未提出 {missing.length} 人</h3>
        {missing.length === 0 ? <p className="py-2 text-sm text-muted">全員が提出しました</p> : <ul className="mt-1 max-h-60 space-y-1 overflow-y-auto">{missing.map(row)}</ul>}
      </section>
      <p className="mt-3 text-xs text-muted">スレッドに返信すると提出済みになります。{collection.reminded_at ? "締切後、未提出の人にリマインドしました。" : "締切を過ぎると、未提出の人にだけリマインドが届きます。"}</p>
    </Modal>
  );
}
