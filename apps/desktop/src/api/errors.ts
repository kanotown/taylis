/** Structured API errors (ARCHITECTURE.md §9). */
import { getLocale, t } from "../i18n";
import { ERROR_MESSAGES_BY_LOCALE, NETWORK_ERROR_MESSAGE_BY_LOCALE, STATUS_MESSAGES_BY_LOCALE, UNKNOWN_ERROR_MESSAGE_BY_LOCALE } from "./errorMessages";

/** The message for a server error code in the UI language (apps/shared/errors.json), undefined for an unknown code. */
export function errorMessageFor(code: string): string | undefined {
  return ERROR_MESSAGES_BY_LOCALE[getLocale()][code] ?? ERROR_MESSAGES_BY_LOCALE.ja[code];
}

function statusMessageFor(status: string): string | undefined {
  return STATUS_MESSAGES_BY_LOCALE[getLocale()][status] ?? STATUS_MESSAGES_BY_LOCALE.ja[status];
}

/** 「サーバーに接続できません…」 in the UI language. */
export function networkErrorMessage(): string {
  return NETWORK_ERROR_MESSAGE_BY_LOCALE[getLocale()];
}

/** 「エラーが発生しました」 in the UI language. */
export function unknownErrorMessage(): string {
  return UNKNOWN_ERROR_MESSAGE_BY_LOCALE[getLocale()];
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown = undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Authentication errors: refresh (token_expired) or sign out. */
  get isAuth(): boolean {
    return this.status === 401;
  }

  /** Temporary failures worth retrying with backoff; the idempotency key prevents duplicates. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Network failure (no response at all, or one that could not be read). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "NetworkError";
  }
}

/** A failure of the app's own whose message is written for the reader (in the UI language), shown as it is. */
export class UserMessageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UserMessageError";
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof NetworkError || (err instanceof ApiError && err.isRetryable);
}

/**
 * What the user reads for an error (ARCHITECTURE.md §9): the text for the code in the UI language (M115), else
 * for the HTTP status, a fixed text for network failures, never the server's `message`. A string is already
 * written for the reader and passes through.
 */
export function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof UserMessageError) return err.message;
  if (err instanceof ApiError) {
    return errorMessageFor(err.code) ?? statusMessageFor(String(err.status)) ?? (err.status >= 500 ? statusMessageFor("5xx") : undefined) ?? unknownErrorMessage();
  }
  // "Failed to fetch" (Chromium), "Load failed" (WebKit), "NetworkError when attempting…" (Gecko).
  if (err instanceof NetworkError || (err instanceof TypeError && /fetch|load failed|network/i.test(err.message))) return networkErrorMessage();
  return unknownErrorMessage();
}

/**
 * The server has no such route: one older than the feature. 404 with the generic `not_found` (an unknown path; a
 * missing row has its own code such as `channel_not_found`), or 405 where the path exists with other methods.
 */
export function isMissingRoute(err: unknown): boolean {
  return err instanceof ApiError && ((err.status === 404 && err.code === "not_found") || err.status === 405);
}

/** What to say when `feature` (e.g. 「セットの取り込み」) needs a newer server. */
export function serverTooOldMessage(feature: string): string {
  return t("errors.serverTooOld", { feature });
}

/** describeError, except that a missing route says the server is too old for `feature`. */
export function describeFeatureError(err: unknown, feature: string): string {
  return isMissingRoute(err) ? serverTooOldMessage(feature) : describeError(err);
}
