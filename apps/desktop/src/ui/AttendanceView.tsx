/**
 * M140 (docs/PRESENCE.md §7): 「在室状況」 — my quick buttons (one press switches), a note, the board grouped by state
 * (avatars, names, notes, since when), and my own states when the administrator's rule allows them. Also the small chip
 * next to a name (the profile card, member lists).
 */
import { DoorOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import type { AttendanceColor, AttendanceKind, AttendanceStateOut } from "../api/types";
import type { AppController } from "../state/app";
import { onAttendance } from "./actions";
import { ActionButtons, useActionStatuses } from "./ActionButtons";
import { ATTENDANCE_COLORS, ATTENDANCE_KINDS, boardGroups, entryOf, inRoomCount, kindLabel, myChoices, myOwnStates, sinceLabel } from "./attendance";
import { ATTENDANCE_ICONS, attendanceBadgeColor, attendanceColorStyle, attendanceIconLabel, attendanceTintStyle, StateBadge, StateGlyph } from "./attendanceIcons";
import { Avatar } from "./Avatar";
import { BackButton } from "./compact";
import { useStoreUpdates } from "./hooks";
import { Button, cn, Field, Input, Modal } from "./primitives";
import { TEXT_EMOJI_COLOR_NAMES } from "./textEmoji";
import { UserPopover } from "./UserPopover";
import { t } from "../i18n";

const colorStyle = attendanceColorStyle;

/** The default states' icons (apps/shared/attendance-icons.json "defaults"): a new state's icon until one is picked. */
const DEFAULT_ICON_OF_KIND: Readonly<Record<AttendanceKind, string>> = { in_room: "in_room", on_site: "on_site", off_site: "off_site", gone: "gone" };

/**
 * Sets my state (one press; the page's buttons and the quick switch). The note stays when the same state is chosen
 * again and is cleared by another state (a note belongs to its state: 「15 時に戻ります」 is wrong once back).
 */
export async function chooseMyState(controller: AppController, stateId: string, note: string | null): Promise<boolean> {
  if (!controller.api) return false;
  try {
    controller.store.applyAttendanceEntry(await controller.api.setMyAttendance(stateId, note));
    return true;
  } catch (error) {
    controller.setError(error);
    return false;
  }
}

/** The page (the centre view on a wide screen, a pushed screen on a phone). */
export function AttendanceView({ controller }: { controller: AppController }) {
  useStoreUpdates(controller);
  const store = controller.store;
  const board = store.attendance;
  const meId = store.me?.id ?? null;
  const mine = entryOf(board, meId ?? "");
  // M143 (docs/ACTIONS.md D17, §12): the 操作ボタン here too when the workspace says so, with their state.
  const actions = board ? onAttendance(store.actions) : [];
  const feed = useActionStatuses(controller, actions);
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
    if (busy) return;
    setBusy(true);
    try {
      await chooseMyState(controller, stateId, nextNote);
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
          {/* M143 (docs/ACTIONS.md D17): the 操作ボタン here too when the workspace says so. */}
          {actions.length > 0 && (
            <section aria-label={t("nav.actions")} className="space-y-3" data-attendance-actions>
              <h2 className="text-[13px] font-semibold text-muted">{t("nav.actions")}</h2>
              <ActionButtons controller={controller} actions={actions} compact feed={feed} />
            </section>
          )}
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
                    data-current={current || undefined}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60",
                      current ? "border-transparent shadow-sm hover:brightness-110" : "border-line bg-canvas hover:bg-panel-2",
                    )}
                  >
                    {current ? (
                      <StateGlyph state={state} size={16} />
                    ) : (
                      <span className="attendance-tint inline-flex" style={attendanceTintStyle(state.color)}>
                        <StateGlyph state={state} size={16} />
                      </span>
                    )}
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
                      <StateBadge state={state} />
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
                    <StateBadge state={group.state} />
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
  onSubmit: (form: { label: string; icon: string | null; emoji: string | null; color: AttendanceColor; kind: AttendanceKind }) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  // A new state's icon follows its kind's default (学外 → map pin …) until one is picked.
  const [picked, setPicked] = useState<string | null | undefined>(initial ? initial.icon : undefined);
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [color, setColor] = useState<AttendanceColor>(initial?.color ?? "gray");
  const [kind, setKind] = useState<AttendanceKind>(initial?.kind ?? "on_site");
  const icon = picked === undefined ? DEFAULT_ICON_OF_KIND[kind] : picked;
  const setIcon = setPicked;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return;
    onSubmit({ label: label.trim(), icon, emoji: emoji.trim() || null, color, kind });
  };
  return (
    <form className="mt-4 space-y-3" onSubmit={submit}>
      <Field label={t("attendance.form.label")}>
        <Input value={label} maxLength={40} required autoFocus placeholder={t("attendance.form.labelPlaceholder")} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>{t("attendance.form.preview")}</span>
        <StateBadge state={{ id: "", owner_id: null, label: label.trim() || t("attendance.form.labelPlaceholder"), icon, emoji: emoji.trim() || null, color, kind, position: 0, archived: false }} />
      </div>
      <ChoiceGrid
        label={t("attendance.form.color")}
        name="attendance-color"
        options={ATTENDANCE_COLORS.map((c) => ({ value: c, label: TEXT_EMOJI_COLOR_NAMES[c] }))}
        value={color}
        onChange={(value) => setColor(value as AttendanceColor)}
        render={(value) => <span aria-hidden className="block h-5 w-5 rounded-full border border-black/10" style={{ background: attendanceBadgeColor(value) }} />}
      />
      <ChoiceGrid
        label={t("attendance.form.icon")}
        name="attendance-icon"
        options={[{ value: "", label: t("attendance.form.iconNone") }, ...ATTENDANCE_ICONS.map((i) => ({ value: i.key, label: attendanceIconLabel(i.key) }))]}
        value={icon ?? ""}
        onChange={(value) => setIcon(value || null)}
        render={(value) => (value ? <StateGlyph state={{ icon: value, emoji: null }} size={16} /> : <span aria-hidden className="text-[11px]">—</span>)}
      />
      <Field label={t("attendance.form.emoji")} hint={t("attendance.form.iconHint")}>
        <Input value={emoji} maxLength={32} placeholder="🗣️" onChange={(e) => setEmoji(e.target.value)} />
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

/**
 * A row of square choices (radio buttons: Tab into the group, arrows move; each has its name as tooltip and screen
 * reader label). The colour swatches and the icon picker.
 */
function ChoiceGrid({ label, name, options, value, onChange, render }: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  render: (value: string) => ReactNode;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5" data-choice-grid={name}>
        {options.map((option) => (
          <label
            key={option.value}
            title={option.label}
            className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-line text-ink hover:bg-panel-2 has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:checked]:ring-1 has-[:checked]:ring-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/60"
          >
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} aria-label={option.label} className="sr-only" />
            {render(option.value)}
          </label>
        ))}
      </div>
    </fieldset>
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
