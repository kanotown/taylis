/**
 * M96: usernames can change (the person: 3 times in 24 hours; administrators: any account). The forms check what the
 * server checks before sending (DATA_MODEL.md users「ユーザー名の変更」); uniqueness and group names only the server knows.
 */

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
/** groups.schemas.RESERVED_NAMES on the server, plus the anonymized accounts' prefix. */
const RESERVED = new Set(["channel", "here", "everyone", "all", "group"]);
const ANONYMIZED_PREFIX = "deleted-";

/** The creation forms (people and bots): what the name is for, and that it can change later. */
export const USERNAME_HINT = "メンションの @名前 とパスワードでのログインに使います (あとから変更できます)";

/** What the profile and the admin dialog say next to the field. */
export function renameHint(hasPassword: boolean): string {
  return (hasPassword ? "パスワードでのログインには新しいユーザー名を使います。" : "")
    + "過去のメッセージとメンションはそのままです。古いユーザー名はすぐにほかの人が使えるようになります。";
}

/** Typed input as the field keeps it: usernames are lowercase, with no surrounding spaces. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Why `value` cannot be a username (null: send it and let the server decide). */
export function usernameProblem(value: string): string | null {
  const name = normalizeUsername(value);
  if (name.length === 0) return "ユーザー名を入力してください";
  if (name.length < 3 || name.length > 32) return "3〜32 文字にしてください";
  if (!USERNAME_PATTERN.test(name)) return "使えるのは a-z、0-9、. _ - だけです";
  if (RESERVED.has(name) || name.startsWith(ANONYMIZED_PREFIX)) return "このユーザー名は予約されているため使えません";
  return null;
}
