/** Structured API errors (ARCHITECTURE.md §9). */
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

/** Network failure (no response at all). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "NetworkError";
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof NetworkError || (err instanceof ApiError && err.isRetryable);
}
