/** Two-factor authentication helpers (M12i). */

import { ApiError } from "../api/errors";

/** Spaces dropped; a 6-digit app code or a recovery code (letters, digits, one dash). */
export function normalizeTotpInput(text: string): string {
  return text.replace(/\s+/g, "");
}

export function isTotpCode(text: string): boolean {
  return /^\d{6}$/.test(normalizeTotpInput(text));
}

const ERROR_TEXT: Record<string, string> = {
  invalid_password: "パスワードが違います",
  invalid_totp: "認証コードが違います",
  totp_required: "認証アプリのコードを入力してください",
  totp_already_enabled: "2 要素認証はすでに有効です",
  totp_setup_required: "先に設定を始めてください",
  rate_limited: "しばらく待ってからやり直してください",
};

export function totpErrorText(error: unknown): string {
  if (error instanceof ApiError) return ERROR_TEXT[error.code] ?? `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

/** The recovery codes as one text block for the clipboard or a file. */
export function recoveryCodesText(codes: readonly string[]): string {
  return ["ChikuwaChat の回復コード (各 1 回だけ使えます)", "", ...codes].join("\n");
}
