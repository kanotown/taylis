/** Two-factor authentication helpers (M12i). */

import { ApiError, describeError } from "../api/errors";
import { t } from "../i18n";

/** Spaces dropped; a 6-digit app code or a recovery code (letters, digits, one dash). */
export function normalizeTotpInput(text: string): string {
  return text.replace(/\s+/g, "");
}

export function isTotpCode(text: string): boolean {
  return /^\d{6}$/.test(normalizeTotpInput(text));
}

const ERROR_TEXT: Record<string, string> = {
  get invalid_password() { return t("totp.error.password"); },
  get invalid_totp() { return t("totp.error.code"); },
  get totp_required() { return t("totp.error.required"); },
  get totp_already_enabled() { return t("totp.error.alreadyEnabled"); },
  get totp_setup_required() { return t("totp.error.setupRequired"); },
  get rate_limited() { return t("invites.error.rateLimited"); },
};

export function totpErrorText(error: unknown): string {
  return (error instanceof ApiError ? ERROR_TEXT[error.code] : undefined) ?? describeError(error);
}

/** The recovery codes as one text block for the clipboard or a file. */
export function recoveryCodesText(codes: readonly string[]): string {
  return [t("totp.recoveryHeader"), "", ...codes].join("\n");
}
