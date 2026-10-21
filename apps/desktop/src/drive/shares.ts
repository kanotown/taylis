/**
 * External share links (M163, docs/DRIVE.md §9, §17.4): the share dialog's choices and texts, kept apart from the
 * dialog so they can be tested without a DOM.
 */
import type { DriveLinkPolicyOut, DriveShareLinkOut } from "../api/types";
import { t } from "../i18n";

/** The dialog's expiry presets (days), the date picker and 「期限なし」 (only when the workspace allows it). */
export type ExpiryChoice = { kind: "days"; days: number } | { kind: "date" } | { kind: "none" };

const PRESETS = [1, 7, 30, 90];

export function expiryChoices(policy: Pick<DriveLinkPolicyOut, "max_days">): ExpiryChoice[] {
  const max = policy.max_days;
  const days = PRESETS.filter((n) => max === null || max === undefined || n <= max);
  if (max !== null && max !== undefined && !days.includes(max)) days.push(max);
  days.sort((a, b) => a - b);
  const out: ExpiryChoice[] = days.map((n) => ({ kind: "days", days: n }));
  out.push({ kind: "date" });
  if (max === null || max === undefined) out.push({ kind: "none" });
  return out;
}

export function defaultChoice(policy: Pick<DriveLinkPolicyOut, "max_days" | "default_days">): ExpiryChoice {
  const choices = expiryChoices(policy);
  return choices.find((c) => c.kind === "days" && c.days === policy.default_days) ?? choices[0]!;
}

export function choiceKey(choice: ExpiryChoice): string {
  return choice.kind === "days" ? `d${choice.days}` : choice.kind;
}

export function choiceLabel(choice: ExpiryChoice): string {
  if (choice.kind === "date") return t("drive.share.expiryDate");
  if (choice.kind === "none") return t("drive.share.expiryNone");
  return t("drive.share.expiryDays", { count: choice.days });
}

/** The latest day the date picker allows ("YYYY-MM-DD", local time), or "" when there is no limit. */
export function maxDate(policy: Pick<DriveLinkPolicyOut, "max_days">, now: Date = new Date()): string {
  if (policy.max_days === null || policy.max_days === undefined) return "";
  return localDay(new Date(now.getTime() + policy.max_days * 86_400_000));
}

export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The `expires_at` to send: an ISO time, null for 「期限なし」, or undefined when the picked date is not usable (empty,
 * past or beyond the workspace's longest). A date means the end of that day, local time, capped at the longest.
 */
export function expiresAt(choice: ExpiryChoice, date: string, policy: Pick<DriveLinkPolicyOut, "max_days">, now: Date = new Date()): string | null | undefined {
  if (choice.kind === "none") return null;
  if (choice.kind === "days") return new Date(now.getTime() + choice.days * 86_400_000).toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 0);
  if (Number.isNaN(end.getTime()) || end.getTime() <= now.getTime()) return undefined;
  if (policy.max_days !== null && policy.max_days !== undefined) {
    const latest = now.getTime() + policy.max_days * 86_400_000;
    if (end.getTime() > latest + 86_400_000) return undefined;
    return new Date(Math.min(end.getTime(), latest)).toISOString();
  }
  return end.toISOString();
}

/** The address to copy: the server's answer (absolute when it knows its address) on this server's origin. */
export function shareUrl(baseUrl: string, url: string, origin: string = typeof window === "undefined" ? "" : window.location.origin): string {
  if (/^https?:\/\//.test(url)) return url;
  const base = (baseUrl || origin).replace(/\/+$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

export function stateLabel(state: DriveShareLinkOut["state"]): string {
  return t(`drive.share.state.${state}` as const);
}

/** 「3 / 20 回」, 「3 回」. */
export function downloadsLabel(link: Pick<DriveShareLinkOut, "download_count" | "max_downloads">): string {
  return link.max_downloads === null || link.max_downloads === undefined
    ? t("drive.share.downloads", { count: link.download_count })
    : t("drive.share.downloadsOf", { count: link.download_count, max: link.max_downloads });
}

export interface ShareForm {
  usePassword: boolean;
  password: string;
  limit: string;
  note: string;
}

/** What is wrong with the form (a message), or null. */
export function formProblem(form: ShareForm, policy: Pick<DriveLinkPolicyOut, "password_required">, expiry: string | null | undefined): string | null {
  if (expiry === undefined) return t("drive.share.badDate");
  const needsPassword = policy.password_required || form.usePassword;
  if (needsPassword && form.password.length < 4) return t("drive.share.passwordShort");
  if (form.limit.trim() !== "") {
    const n = Number(form.limit.trim());
    if (!Number.isInteger(n) || n < 1 || n > 100_000) return t("drive.share.badLimit");
  }
  if (form.note.length > 80) return t("drive.share.noteLong");
  return null;
}

/** The share dialog's message when links cannot be made here. */
export function blockedReason(policy: DriveLinkPolicyOut): string | null {
  if (!policy.enabled) return t("drive.share.disabledWorkspace");
  if (!policy.location_enabled) return t("drive.share.disabledLocation");
  if (!policy.can_share) return t("drive.share.cannotShare");
  return null;
}
