/**
 * M140 (docs/PRESENCE.md §7): 「在室状況」 — my quick buttons (one press switches), a note, the board grouped by state
 * (avatars, names, notes, since when), and my own states when the administrator's rule allows them. Also the small chip
 * next to a name (the profile card, member lists).
 */
import { DoorOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { AttendanceColor, AttendanceKind, AttendanceStateOut } from "../api/types";
import type { AppController } from "../state/app";
import { ATTENDANCE_COLORS, ATTENDANCE_KINDS, boardGroups, entryOf, inRoomCount, kindLabel, myChoices, myOwnStates, sinceLabel, stateText } from "./attendance";
import { attendanceColorStyle } from "./AttendanceChip";
import { Avatar } from "./Avatar";
import { BackButton } from "./compact";
import { useStoreUpdates } from "./hooks";
import { Button, cn, Field, Input, Modal } from "./primitives";
import { TEXT_EMOJI_COLOR_NAMES } from "./textEmoji";
import { UserPopover } from "./UserPopover";
import { t } from "../i18n";

const colorStyle = attendanceColorStyle;

/** The page (the centre view on a wide screen, a pushed screen on a phone). */
export function AttendanceView({ controller }: { controller: AppController }) {
  useStoreUpdates(controller);
  const store = controller.store;
  const board = store.attendance;
  const meId = store.me?.id ?? null;
  const mine = entryOf(board, meId ?? "");
  const [note, setNote] = useState(mine?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AttendanceStateOut | "new" | null>(null);
  useEffect(() => {
    void controller.engine?.loadAttendance();
  }, [controller]);
  // Another device (or an outside system) changed my note: show it unless I am typing.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setNote(mine?.note ?? "");
  }, [mine?.note, focused]);

  if (!board) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-attendance-page>
        <Header />
        <p className="p-6 text-sm text-muted">{t("attendance.off")}</p>
      </div>
    );
  }

  const choose = async (stateId: string, nextNote: string | null) => {
    if (!controller.api || busy) return;
    setBusy(true);
    try {
      store.applyAttendanceEntry(await controller.api.setMyAttendance(stateId, nextNote));
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };
  const saveNote = (event: FormEvent) => {
    event.preventDefault();
    if (mine) void choose(mine.state_id, note.trim() || null);
  };
  const groups = boardGroups(board, store.users.values());
  const own = myOwnStates(board, meId);
  const count = inRoomCount(board, store.users.values());

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-attendance-page>
      <Header count={count} />
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-4 max-md:px-3">
        <div className="mx-auto max-w-4xl space-y-6">
          <section aria-label={t("attendance.mine")} className="space-y-3">
            <h2 className="text-[13px] font-semibold text-muted">{t("attendance.mine")}</h2>
            <div role="group" aria-label={t("attendance.choose")} className="flex flex-wrap gap-2">
              {myChoices(board, meId).map((state) => {
                const current = mine?.state_id === state.id;
                return (
                  <button
                    key={state.id}
                    type="button"
                    data-attendance-state={state.id}
                    aria-pressed={current}
                    disabled={busy}
                    onClick={() => void choose(state.id, current ? (mine?.note ?? null) : null)}
                    style={current ? colorStyle(state.color) : undefined}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60",
                      current ? "text-emoji border-transparent shadow-sm" : "border-line bg-canvas hover:bg-panel-2",
                    )}
                  >
                    {state.emoji && <span aria-hidden>{state.emoji}</span>}
                    {state.label}
                    {state.owner_id && <span className="sr-only"> {t("attendance.personal")}</span>}
                  </button>
                );
              })}
            </div>
            {mine && (
              <form onSubmit={saveNote} className="flex max-w-xl items-center gap-2">
                <Input
                  aria-label={t("attendance.note")}
                  placeholder={t("attendance.notePlaceholder")}
                  value={note}
                  maxLength={100}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button type="submit" size="sm" variant="secondary" disabled={busy || (note.trim() || null) === (mine.note ?? null)}>
                  {t("common.save")}
                </Button>
              </form>
            )}
            {!mine && <p className="text-xs text-muted">{t("attendance.notSetYet")}</p>}
          </section>

          {board.can_personalize && (
            <section aria-label={t("attendance.ownStates")} className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold text-muted">{t("attendance.ownStates")}</h2>
                <Button size="sm" variant="ghost" className="ml-auto" disabled={own.length >= 10} onClick={() => setEditing("new")}>
                  <Plus size={14} /> {t("attendance.addOwn")}
                </Button>
              </div>
              {own.length === 0 ? (
                <p className="text-xs text-muted">{t("attendance.ownNone")}</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {own.map((state) => (
                    <li key={state.id} className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-sm">
                      <span>{stateText(state)}</span>
                      <span className="text-xs text-muted">· {kindLabel(state.kind)}</span>
                      <button type="button" className="rounded p-1 text-muted hover:bg-panel-2 hover:text-ink" aria-label={t("attendance.editOwn", { name: state.label })} onClick={() => setEditing(state)}>
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-muted hover:bg-panel-2 hover:text-danger"
                        aria-label={t("attendance.deleteOwn", { name: state.label })}
                        onClick={() => void controller.api?.deleteMyAttendanceState(state.id).then(() => controller.engine?.loadAttendance(), (error: unknown) => controller.setError(error))}
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section aria-label={t("attendance.board")} className="space-y-4">
            <h2 className="text-[13px] font-semibold text-muted">{t("attendance.board")}</h2>
            {groups.map((group) => (
              <div key={group.state?.id ?? "unset"} data-attendance-group={group.state?.id ?? "unset"} className="space-y-1.5">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  {group.state ? (
                    <span className="text-emoji inline-flex items-center rounded px-1.5 leading-6" style={colorStyle(group.state.color)}>{stateText(group.state)}</span>
                  ) : (
                    <span className="text-muted">{t("attendance.unset")}</span>
                  )}
                  <span className="text-xs font-normal text-muted">{t("attendance.people", { count: group.people.length })}</span>
                </h3>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1.5">
                  {group.people.map(({ user, entry }) => (
                    <li key={user.id}>
                      <UserPopover controller={controller} userId={user.id} className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-panel-2">
                        <Avatar id={user.id} name={user.display_name} size={30} presence={store.presenceOf(user.id)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{user.display_name}{user.id === meId ? ` ${t("calendar.me")}` : ""}</span>
                          {entry && (
                            <span className="block truncate text-xs text-muted">
                              {[entry.note, sinceLabel(entry.since)].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </span>
                      </UserPopover>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </div>
      </div>
      {editing !== null && <OwnStateDialog controller={controller} state={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Header({ count }: { count?: number }) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:px-2">
      <BackButton />
      <span className="text-muted max-md:hidden"><DoorOpen size={18} /></span>
      <strong className="text-[15px]">{t("nav.attendance")}</strong>
      {count !== undefined && <span className="ml-auto text-xs text-muted" data-attendance-count>{t("attendance.inRoom", { count })}</span>}
    </header>
  );
}

/** The form of a state: name, emoji, colour, kind (my own states here; the admin tab uses it too). */
export function StateForm({ initial, busy, submitLabel, onCancel, onSubmit }: {
  initial: AttendanceStateOut | null;
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (form: { label: string; emoji: string | null; color: AttendanceColor; kind: AttendanceKind }) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [color, setColor] = useState<AttendanceColor>(initial?.color ?? "gray");
  const [kind, setKind] = useState<AttendanceKind>(initial?.kind ?? "on_site");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return;
    onSubmit({ label: label.trim(), emoji: emoji.trim() || null, color, kind });
  };
  return (
    <form className="mt-4 space-y-3" onSubmit={submit}>
      <Field label={t("attendance.form.label")}>
        <Input value={label} maxLength={40} required autoFocus placeholder={t("attendance.form.labelPlaceholder")} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label={t("attendance.form.emoji")}>
        <Input value={emoji} maxLength={32} placeholder="🗣️" onChange={(e) => setEmoji(e.target.value)} />
      </Field>
      <Field label={t("attendance.form.color")}>
        <select aria-label={t("attendance.form.color")} value={color} onChange={(e) => setColor(e.target.value as AttendanceColor)} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
          {ATTENDANCE_COLORS.map((c) => <option key={c} value={c}>{TEXT_EMOJI_COLOR_NAMES[c]}</option>)}
        </select>
      </Field>
      <Field label={t("attendance.form.kind")} hint={t("attendance.form.kindHint")}>
        <select aria-label={t("attendance.form.kind")} value={kind} onChange={(e) => setKind(e.target.value as AttendanceKind)} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
          {ATTENDANCE_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" size="sm" disabled={busy || !label.trim()}>{submitLabel}</Button>
      </div>
    </form>
  );
}

function OwnStateDialog({ controller, state, onClose }: { controller: AppController; state: AttendanceStateOut | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={onClose} title={state ? t("attendance.editOwn", { name: state.label }) : t("attendance.addOwn")} className="w-[420px]">
      <StateForm
        initial={state}
        busy={busy}
        submitLabel={state ? t("common.save") : t("attendance.add")}
        onCancel={onClose}
        onSubmit={(form) => {
          const api = controller.api;
          if (!api) return;
          setBusy(true);
          const call = state ? api.updateMyAttendanceState(state.id, form) : api.createMyAttendanceState(form);
          void call
            .then(async () => {
              await controller.engine?.loadAttendance();
              onClose();
            })
            .catch((error: unknown) => controller.setError(error))
            .finally(() => setBusy(false));
        }}
      />
    </Modal>
  );
}
