/**
 * Google sign-in (M48, docs/SSO.md §6) in the browser build: the page makes a secret `verifier`, keeps it in
 * sessionStorage while the tab visits Google, and sends the server only its SHA-256 (`challenge`). The server returns
 * to `/#sso_ticket=…` (or `#sso_error=…`); the ticket is worth nothing without the verifier.
 */
import { ERROR_MESSAGES } from "../api/errorMessages";

const PENDING_KEY = "chikuwa.sso";
const CODE = /^[a-z_]{1,40}$/;

export interface SsoPending {
  serverUrl: string;
  verifier: string;
}

export type SsoReturn = { kind: "ticket"; ticket: string } | { kind: "error"; code: string };

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes: 43 base64url characters (RFC 7636's minimum). */
export function newVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** base64url(SHA-256(verifier)), what the start URL carries. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function ssoStartUrl(serverUrl: string, platform: string, challenge: string): string {
  const params = new URLSearchParams({ platform, challenge });
  return `${serverUrl.replace(/\/+$/, "")}/api/v1/auth/sso/google/start?${params}`;
}

/** Kept for the tab's trip to Google; false when the browser refuses storage (the sign-in cannot finish then). */
export function saveSsoPending(pending: SsoPending): boolean {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

/** The pending sign-in, removed as it is read: a verifier serves one exchange. */
export function takeSsoPending(): SsoPending | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (value && typeof value === "object" && typeof (value as SsoPending).serverUrl === "string" && typeof (value as SsoPending).verifier === "string") return value as SsoPending;
  } catch {
    // unreadable storage: treated as no pending sign-in
  }
  return null;
}

/** What the server's redirect left in the fragment (`#sso_ticket=` / `#sso_error=`), if anything. */
export function parseSsoReturn(hash: string): SsoReturn | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const ticket = params.get("sso_ticket");
  if (ticket) return { kind: "ticket", ticket };
  const code = params.get("sso_error");
  if (code !== null) return { kind: "error", code: CODE.test(code) ? code : "provider_error" };
  return null;
}

/** Reads the return and removes the fragment from the address bar and history at once (the ticket must not linger). */
export function takeSsoReturn(): SsoReturn | null {
  const found = parseSsoReturn(location.hash);
  if (found) history.replaceState(history.state, "", location.pathname + location.search);
  return found;
}

/** The Japanese text for a returned `sso_error` code (apps/shared/errors.json). */
export function ssoErrorText(code: string): string {
  return ERROR_MESSAGES[code] ?? "Google でのログインに失敗しました。もう一度お試しください";
}
