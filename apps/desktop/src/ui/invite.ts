/** Invite links (M12h): `<server>/invite/<token>`; the token is 20-128 URL-safe characters. */

import { ApiError, describeError } from "../api/errors";
import type { Affiliation, FacultyRank, Grade, InviteOut, LabPreset } from "../api/types";
import { t } from "../i18n";

const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

export function inviteLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/invite/${token}`;
}

/** The server and the token from a pasted link (trailing path, query and fragment ignored). */
export function parseInviteLink(text: string): { server: string; token: string } | null {
  const match = /^\s*(https?:\/\/[^\s/?#]+)\/invite\/([^\s/?#]+)/i.exec(text);
  if (!match) return null;
  const token = match[2]!;
  return TOKEN.test(token) ? { server: match[1]!, token } : null;
}

export const INVITE_STATUS_LABELS: Record<InviteOut["status"], string> = {
  get active() { return t("invites.status.active"); },
  get expired() { return t("invites.status.expired"); },
  get exhausted() { return t("invites.status.exhausted"); },
  get revoked() { return t("invites.status.revoked"); },
};

export function inviteUsesLabel(invite: InviteOut): string {
  return invite.max_uses === null ? t("invites.usesUnlimited", { count: invite.use_count }) : t("invites.uses", { count: invite.use_count, max: invite.max_uses });
}

const ERROR_TEXT: Record<string, string> = {
  get invite_not_found() { return t("invites.error.notFound"); },
  get invite_expired() { return t("invites.error.expired"); },
  get invite_exhausted() { return t("invites.error.exhausted"); },
  get invite_revoked() { return t("invites.error.revoked"); },
  get username_taken() { return t("invites.error.usernameTaken"); },
  get password_too_short() { return t("invites.error.passwordTooShort"); },
  get validation_error() { return t("workflow.checkInput"); },
  get rate_limited() { return t("invites.error.rateLimited"); },
};

/** Invite failures in words; anything else gets the shared Japanese error text (ARCHITECTURE.md §9). */
export function inviteErrorText(error: unknown): string {
  return (error instanceof ApiError ? ERROR_TEXT[error.code] : undefined) ?? describeError(error);
}

/** The invite form's 「研究室の名簿に載せる」 section (L7 / M32). */
export interface InvitePresetForm {
  on: boolean;
  affiliation: Affiliation;
  rank: FacultyRank | "";
  grade: Grade | "";
  supervisorId: string;
  times: boolean;
}

export const EMPTY_PRESET: InvitePresetForm = { on: false, affiliation: "student", rank: "", grade: "", supervisorId: "", times: true };

/**
 * The `lab` to send, or undefined while the section is off (older servers reject unknown fields). Rank goes with
 * faculty and grade with students only, as on the roster; a guest gets no times (400 guest_restricted).
 */
export function invitePreset(form: InvitePresetForm, role: string): LabPreset | undefined {
  if (!form.on) return undefined;
  return {
    affiliation: form.affiliation,
    rank: form.affiliation === "faculty" && form.rank ? form.rank : null,
    grade: form.affiliation === "student" && form.grade ? form.grade : null,
    supervisor_id: form.supervisorId || null,
    times: role !== "guest" && form.times,
  };
}
