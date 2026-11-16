/**
 * Google sign-in (M48, docs/SSO.md §6) in the browser build: the page makes a secret `verifier`, keeps it in
 * sessionStorage while the tab visits Google, and sends the server only its SHA-256 (`challenge`). The server returns
 * to `/#sso_ticket=…` (or `#sso_error=…`); the ticket is worth nothing without the verifier.
 * The Tauri app opens the start page in the system browser and gets `chikuwachat://sso?ticket=…` back through a deep
 * link; it keeps its pending sign-in in memory (AppController).
 */
import { errorMessageFor } from "../api/errors";
import { t } from "../i18n";

const PENDING_KEY = "chikuwa.sso";
const CODE = /^[a-z_]{1,40}$/;

export interface SsoPending {
  serverUrl: string;
  verifier: string;
}

export type SsoReturn = { kind: "ticket"; ticket: string } | { kind: "error"; code: string };

/** The Tauri app's deep link also names the server that answered (`iss`, docs/SSO.md §3 step 6); null when it has none. */
export type SsoDeepLink = SsoReturn & { issuer: string | null };

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

/**
 * The Tauri app's return: `chikuwachat://sso?ticket=…` (or `?sso_error=`), opened by the browser. null for any other
 * link (the scheme is anyone's to open). Read by hand: older WebView2 (Chromium) builds give a custom scheme's URL no
 * host.
 */
export function parseSsoDeepLink(link: string): SsoDeepLink | null {
  const match = /^chikuwachat:\/\/sso\/?\?([^#]*)/i.exec(link.trim());
  if (!match) return null;
  const params = new URLSearchParams(match[1]);
  const issuer = params.get("iss");
  const ticket = params.get("ticket");
  if (ticket) return { kind: "ticket", ticket, issuer };
  const code = params.get("sso_error");
  if (code !== null) return { kind: "error", code: CODE.test(code) ? code : "provider_error", issuer };
  return null;
}

/**
 * docs/SSO.md §3 step 6 (2026-11-16, RFC 9207's idea): whether the answer's `iss` is the server the sign-in started
 * with. A hostile server could send its start on to another server's; that server's ticket would then come back here
 * and be exchanged with the hostile one (PKCE protects the verifier, not which server started). Both sides compared
 * as URLs: scheme and host in lower case, no default port, no trailing slash; a missing or unreadable `iss` never
 * matches.
 */
export function issuerMatches(issuer: string | null, serverUrl: string): boolean {
  if (!issuer) return false;
  const answered = issuerKey(issuer);
  return answered !== null && answered === issuerKey(serverUrl);
}

function issuerKey(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password || url.search || url.hash) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Reads the return and removes the fragment from the address bar and history at once (the ticket must not linger). */
export function takeSsoReturn(): SsoReturn | null {
  const found = parseSsoReturn(location.hash);
  if (found) history.replaceState(history.state, "", location.pathname + location.search);
  return found;
}

/** The Japanese text for a returned `sso_error` code (apps/shared/errors.json). */
export function ssoErrorText(code: string): string {
  return errorMessageFor(code) ?? t("sso.failed");
}

/** What the Google button says (App Store guideline 4.8, docs/SSO.md §6). */
export interface GoogleButtonText {
  title: string;
  /** Set when the server takes only its organisation's accounts: the button names that organisation. */
  subtitle: string | null;
}

/**
 * A server restricted to Workspace domains names the organisation (its label, else the first domain, 「など」 for
 * several): 「example.ac.jp のアカウントでログイン」 over 「組織の Google Workspace アカウント」. An unrestricted answer, or
 * an older server without `domains`, keeps 「Google でログイン」.
 */
export function googleButtonText(method: { domains?: string[]; label?: string | null } | null | undefined): GoogleButtonText {
  const domains = (method?.domains ?? []).filter((domain) => domain.trim());
  if (domains.length === 0) return { title: t("sso.google"), subtitle: null };
  const label = method?.label?.trim();
  const org = label || (domains.length > 1 ? t("sso.andOthers", { domain: domains[0] }) : domains[0]);
  return { title: t("sso.orgTitle", { org }), subtitle: t("sso.orgSubtitle") };
}
