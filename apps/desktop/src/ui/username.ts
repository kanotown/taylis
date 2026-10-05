/**
 * M96: usernames can change (the person: 3 times in 24 hours; administrators: any account). The forms check what the
 * server checks before sending (DATA_MODEL.md users「ユーザー名の変更」); uniqueness and group names only the server knows.
 */
import { t } from "../i18n";

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
/** groups.schemas.RESERVED_NAMES on the server, plus the anonymized accounts' prefix. */
const RESERVED = new Set(["channel", "here", "everyone", "all", "group"]);
const ANONYMIZED_PREFIX = "deleted-";

/** The creation forms (people and bots): what the name is for, and that it can change later. */
export function usernameHint(): string {
  return t("username.hint");
}

/** What the profile and the admin dialog say next to the field. */
export function renameHint(hasPassword: boolean): string {
  return (hasPassword ? t("username.renamePassword") : "") + t("username.renameNote");
}

/** Typed input as the field keeps it: usernames are lowercase, with no surrounding spaces. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Why `value` cannot be a username (null: send it and let the server decide). */
export function usernameProblem(value: string): string | null {
  const name = normalizeUsername(value);
  if (name.length === 0) return t("username.empty");
  if (name.length < 3 || name.length > 32) return t("username.length");
  if (!USERNAME_PATTERN.test(name)) return t("username.chars");
  if (RESERVED.has(name) || name.startsWith(ANONYMIZED_PREFIX)) return t("username.reserved");
  return null;
}
