/**
 * The lab roster (M23, DATA_MODEL.md lab_profiles): labels and the roster order, the same as the server's
 * (`GET /lab/roster`) and the phone apps'. Names compare by code point, as on the server, so every client agrees.
 */
import type { Affiliation, FacultyRank, Grade, LabProfileOut, UserPublic } from "../api/types";

export const AFFILIATIONS: ReadonlyArray<[Affiliation, string]> = [
  ["faculty", "教員"],
  ["student", "学生"],
  ["other", "その他"],
  ["alumni", "卒業生"],
];
export const RANKS: ReadonlyArray<[FacultyRank, string]> = [
  ["professor", "教授"],
  ["associate_professor", "准教授"],
  ["lecturer", "講師"],
  ["assistant_professor", "助教"],
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
  if (profile.affiliation === "student") return profile.grade ?? "学生";
  return AFFILIATIONS.find(([value]) => value === profile.affiliation)?.[1] ?? null;
}

/** The short label for a line: 教授, M1, 卒業生 … */
export function rosterLabel(profile: LabProfileOut): string {
  if (profile.affiliation === "faculty") return RANKS.find(([value]) => value === profile.rank)?.[1] ?? "教員";
  if (profile.affiliation === "student") return profile.grade ?? "学生";
  return AFFILIATIONS.find(([value]) => value === profile.affiliation)?.[1] ?? "";
}

/** 「指導教員: 加納」, or null without one. */
export function supervisorLabel(profile: LabProfileOut, users: ReadonlyMap<string, UserPublic>): string | null {
  const supervisor = profile.supervisor_id ? users.get(profile.supervisor_id)?.display_name : undefined;
  return supervisor ? `指導教員: ${supervisor}` : null;
}

/** 「M1 · 指導教員: 加納」: the label and the supervisor, for profile cards (lists show the label as a badge). */
export function rosterSummary(profile: LabProfileOut, users: ReadonlyMap<string, UserPublic>): string {
  return [rosterLabel(profile), supervisorLabel(profile, users)].filter(Boolean).join(" · ");
}
