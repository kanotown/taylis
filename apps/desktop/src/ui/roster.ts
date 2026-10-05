/**
 * The lab roster (M23, DATA_MODEL.md lab_profiles): labels and the roster order, the same as the server's
 * (`GET /lab/roster`) and the phone apps'. Names compare by code point, as on the server, so every client agrees.
 */
import type { Affiliation, FacultyRank, Grade, InviteLabPreview, LabPreset, LabProfileOut, UserPublic } from "../api/types";
import { t, labelled } from "../i18n";

export const AFFILIATIONS: ReadonlyArray<[Affiliation, string]> = [
  labelled("faculty", "roster.faculty"),
  labelled("student", "roster.student"),
  labelled("other", "roster.other"),
  labelled("alumni", "roster.alumni"),
];
export const RANKS: ReadonlyArray<[FacultyRank, string]> = [
  labelled("professor", "roster.professor"),
  labelled("associate_professor", "roster.associateProfessor"),
  labelled("lecturer", "roster.lecturer"),
  labelled("assistant_professor", "roster.assistantProfessor"),
];
/** Roster order: from D3 down to B3. */
export const GRADES: readonly Grade[] = ["D3", "D2", "D1", "M2", "M1", "B4", "B3"];

const AFFILIATION_ORDER: readonly Affiliation[] = AFFILIATIONS.map(([value]) => value);
const RANK_ORDER: readonly FacultyRank[] = RANKS.map(([value]) => value);

function place<T>(values: readonly T[], value: T | null | undefined): number {
  const index = value == null ? -1 : values.indexOf(value);
  return index < 0 ? values.length : index;
}

/** By Unicode code point, as Python compares str on the server (`<` on JS strings compares UTF-16 units instead). */
export function byCodePoint(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!.codePointAt(0)!;
    const y = right[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length === 0 ? 0 : left.length < right.length ? -1 : 1;
}

/** Where a person sorts: on the roster by step then reading (or name), off it after everyone on it. */
export function compareByRoster(a: UserPublic, b: UserPublic, roster: ReadonlyMap<string, LabProfileOut>): number {
  const pa = roster.get(a.id);
  const pb = roster.get(b.id);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : byCodePoint(a.display_name, b.display_name) || byCodePoint(a.username, b.username);
  return (
    place(AFFILIATION_ORDER, pa.affiliation) - place(AFFILIATION_ORDER, pb.affiliation) ||
    step(pa) - step(pb) ||
    byCodePoint(pa.reading || a.display_name, pb.reading || b.display_name) ||
    byCodePoint(a.username, b.username)
  );
}

function step(profile: LabProfileOut): number {
  if (profile.affiliation === "faculty") return place(RANK_ORDER, profile.rank);
  if (profile.affiliation === "student") return place(GRADES, profile.grade);
  return 0;
}

/** The heading a person's line sits under in a roster-ordered list; null off the roster. */
export function rosterSection(profile: LabProfileOut | undefined): string | null {
  if (!profile) return null;
  if (profile.affiliation === "student") return profile.grade ?? t("roster.student");
  return AFFILIATIONS.find(([value]) => value === profile.affiliation)?.[1] ?? null;
}

/** The short label for a line: 教授, M1, 卒業生 … */
export function rosterLabel(profile: LabProfileOut): string {
  if (profile.affiliation === "faculty") return RANKS.find(([value]) => value === profile.rank)?.[1] ?? t("roster.faculty");
  if (profile.affiliation === "student") return profile.grade ?? t("roster.student");
  return AFFILIATIONS.find(([value]) => value === profile.affiliation)?.[1] ?? "";
}

/** 「指導教員: 加納」, or null without one. */
export function supervisorLabel(profile: LabProfileOut, users: ReadonlyMap<string, UserPublic>): string | null {
  const supervisor = profile.supervisor_id ? users.get(profile.supervisor_id)?.display_name : undefined;
  return supervisor ? t("roster.supervisorLabel", { name: supervisor }) : null;
}

/** 「M1 · 指導教員: 加納」: the label and the supervisor, for profile cards (lists show the label as a badge). */
export function rosterSummary(profile: LabProfileOut, users: ReadonlyMap<string, UserPublic>): string {
  return [rosterLabel(profile), supervisorLabel(profile, users)].filter(Boolean).join(" · ");
}

type RosterLine = Pick<LabProfileOut, "affiliation"> & { rank?: FacultyRank | null; grade?: Grade | null };

/** How two titles compare: after NFKC, trimming and lower-casing (「ｄ１」 is 「D1」). */
function titleKey(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase();
}

/**
 * The title (肩書) and the roster label side by side (LAB.md 「肩書と名簿」, cases in apps/shared/title-display.json): the
 * roster's label (教授, M2 …) is shown wherever a title is; the title adds what the roster does not say (研究室長, TA).
 * `label`: the roster label or null; `extra`: the title, unless it is empty or the label again.
 */
export function titleParts(title: string | null | undefined, line: RosterLine | null | undefined): { label: string | null; extra: string | null } {
  const label = (line && rosterLabel(line as LabProfileOut)) || null;
  const text = title?.trim() || null;
  const extra = text && (!label || titleKey(text) !== titleKey(label)) ? text : null;
  return { label, extra };
}

/** The title as shown: 「M2」, 「研究室長」, 「M2 · 研究室長」, or null for nothing. */
export function displayTitle(title: string | null | undefined, line: RosterLine | null | undefined): string | null {
  const { label, extra } = titleParts(title, line);
  return [label, extra].filter(Boolean).join(" · ") || null;
}

/** What a list that shows the roster label as a badge adds after it: the title unless it is empty or the label again. */
export function titleExtra(title: string | null | undefined, line: RosterLine | null | undefined): string | null {
  return titleParts(title, line).extra;
}

type PresetLine ={ affiliation: Affiliation; rank?: FacultyRank | null; grade?: Grade | null };

/** 「学生 B4」 (or 「学生 (B4)」 with `parenthesized`), 「教員 教授」, 「卒業生」: an invite preset's line (L7 / M32). */
export function presetRole(line: PresetLine, parenthesized = false): string {
  const affiliation = AFFILIATIONS.find(([value]) => value === line.affiliation)?.[1] ?? "";
  const detail =
    line.affiliation === "faculty" ? RANKS.find(([value]) => value === line.rank)?.[1] : line.affiliation === "student" ? line.grade : undefined;
  if (!detail) return affiliation;
  return parenthesized ? `${affiliation} (${detail})` : `${affiliation} ${detail}`;
}

/** 「学生 B4 · 指導: 加納 · times」: an invite preset in the admin list. */
export function invitePresetSummary(preset: LabPreset, users: ReadonlyMap<string, UserPublic>): string {
  const supervisor = preset.supervisor_id ? users.get(preset.supervisor_id)?.display_name : undefined;
  return [presetRole(preset), supervisor && t("roster.supervisorShort", { name: supervisor }), preset.times && "times"].filter(Boolean).join(" · ");
}

/** 「研究室の名簿に 学生 (B4)・指導教員 加納 として載ります。times を作ります。」: the acceptance screen's line. */
export function inviteLabLine(lab: InviteLabPreview): string {
  const who = [presetRole(lab, true), lab.supervisor_name && t("roster.supervisorNamed", { name: lab.supervisor_name })].filter(Boolean).join(t("recurring.daySeparator"));
  return t("roster.inviteLine", { who }) + (lab.times ? t("roster.inviteTimes") : "");
}
