/**
 * M140 (docs/PRESENCE.md): 「在室状況」 — the board's rules, shared by the page, the chip and the admin tab.
 *
 * The board groups people by state, the states in kind order (in_room → on_site → off_site → gone), the workspace's
 * states first in their order, then personal ones; people without a row are 「未設定」 at the end. 「在室 n 人」 counts
 * the in_room kind.
 */
import type { AttendanceBoardOut, AttendanceEntryOut, AttendanceKind, AttendanceStateOut, UserPublic } from "../api/types";
import { type MessageKey, t } from "../i18n";
import { attendanceIcon } from "./attendanceIcons";

export const ATTENDANCE_KINDS: readonly AttendanceKind[] = ["in_room", "on_site", "off_site", "gone"];
/** The text emoji palette (apps/shared/text-emoji.json): the states' colours. */
export const ATTENDANCE_COLORS = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;

const KIND_KEYS: Readonly<Record<AttendanceKind, MessageKey>> = {
  in_room: "attendance.kind.in_room",
  on_site: "attendance.kind.on_site",
  off_site: "attendance.kind.off_site",
  gone: "attendance.kind.gone",
};

export function kindLabel(kind: AttendanceKind): string {
  return t(KIND_KEYS[kind]);
}

/** Who can be on the board: active people, not guests, not bots (the server's rule). */
export function onBoard(user: UserPublic): boolean {
  return !user.deactivated_at && (user.role === "admin" || user.role === "manager" || user.role === "member");
}

/** The buttons for me: the workspace's states, then mine (archived ones are not offered). */
export function myChoices(board: AttendanceBoardOut, meId: string | null | undefined): AttendanceStateOut[] {
  const live = board.states.filter((s) => !s.archived);
  return [...live.filter((s) => s.owner_id === null), ...live.filter((s) => meId && s.owner_id === meId)];
}

/** My own personal states (for the editor). */
export function myOwnStates(board: AttendanceBoardOut, meId: string | null | undefined): AttendanceStateOut[] {
  return board.states.filter((s) => !s.archived && !!meId && s.owner_id === meId);
}

export function entryOf(board: AttendanceBoardOut | null, userId: string): AttendanceEntryOut | null {
  return board?.entries.find((e) => e.user_id === userId) ?? null;
}

export function stateOf(board: AttendanceBoardOut | null, stateId: string | null | undefined): AttendanceStateOut | null {
  return (stateId && board?.states.find((s) => s.id === stateId)) || null;
}

export interface BoardGroup {
  /** The state, or null for 「未設定」. */
  state: AttendanceStateOut | null;
  people: Array<{ user: UserPublic; entry: AttendanceEntryOut | null }>;
}

function stateOrder(a: AttendanceStateOut, b: AttendanceStateOut): number {
  const kind = ATTENDANCE_KINDS.indexOf(a.kind) - ATTENDANCE_KINDS.indexOf(b.kind);
  if (kind !== 0) return kind;
  if ((a.owner_id === null) !== (b.owner_id === null)) return a.owner_id === null ? -1 : 1;
  return a.position - b.position || a.label.localeCompare(b.label, "ja");
}

/** The board's groups: states with people (in kind order), then 「未設定」 (people without a row). Empty states are left out. */
export function boardGroups(board: AttendanceBoardOut, users: Iterable<UserPublic>): BoardGroup[] {
  const people = [...users].filter(onBoard).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  const byUser = new Map(board.entries.map((e) => [e.user_id, e]));
  const groups = new Map<string, BoardGroup>();
  const unset: BoardGroup = { state: null, people: [] };
  for (const user of people) {
    const entry = byUser.get(user.id) ?? null;
    const state = entry ? stateOf(board, entry.state_id) : null;
    if (!entry || !state) {
      unset.people.push({ user, entry: null });
      continue;
    }
    const group = groups.get(state.id) ?? { state, people: [] };
    group.people.push({ user, entry });
    groups.set(state.id, group);
  }
  for (const group of groups.values()) group.people.sort((a, b) => (a.entry!.since < b.entry!.since ? -1 : 1));
  const ordered = [...groups.values()].sort((a, b) => stateOrder(a.state!, b.state!));
  return unset.people.length ? [...ordered, unset] : ordered;
}

/** 「在室 n 人」: people whose state is of the in_room kind. */
export function inRoomCount(board: AttendanceBoardOut, users: Iterable<UserPublic>): number {
  const present = new Set([...users].filter(onBoard).map((u) => u.id));
  return board.entries.filter((e) => present.has(e.user_id) && stateOf(board, e.state_id)?.kind === "in_room").length;
}

/** 「9:15 から」 today, 「10/6 18:02 から」 earlier. */
export function sinceLabel(since: string, now: Date = new Date()): string {
  const at = new Date(since);
  const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return t("attendance.since", { when: sameDay ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}` });
}

/**
 * A state as plain text (a select's option, a log line): the name, with the emoji in front only when the state has no
 * icon this client draws (「🟢 在室」); where a picture can be drawn, use StateBadge / StateGlyph (attendanceIcons.tsx).
 */
export function stateText(state: AttendanceStateOut): string {
  return state.emoji && !attendanceIcon(state.icon) ? `${state.emoji} ${state.label}` : state.label;
}

/** My state now (null: none, or the board is off). */
export function myState(board: AttendanceBoardOut | null, meId: string | null | undefined): AttendanceStateOut | null {
  return meId ? stateOf(board, entryOf(board, meId)?.state_id) : null;
}
