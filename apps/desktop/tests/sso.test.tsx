// @vitest-environment jsdom
/**
 * Google sign-in in the browser build (M48, docs/SSO.md §6): the login screen's button, the start URL and its S256
 * challenge, the return through the fragment (exchange, or the error text), and 「パスワードを変更」 hidden for an
 * account without a password.
 */
import { createHash } from "node:crypto";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_MESSAGES } from "../src/api/errorMessages";
import type { TokenResponse, UserMe } from "../src/api/types";
import { AppController } from "../src/state/app";
import { LoginScreen } from "../src/ui/LoginScreen";
import { base64url, challengeFor, newVerifier, parseSsoReturn, saveSsoPending, ssoErrorText, ssoStartUrl, takeSsoPending } from "../src/ui/sso";

const s256 = (value: string) => createHash("sha256").update(value).digest("base64url");
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const ME: UserMe = {
  id: "u1", username: "taro-2", display_name: "山田 太郎", role: "member", deactivated_at: null, created_at: "", updated_at: "",
  email: "taro@example.ac.jp", must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "mentions", notify_reactions: false, has_password: false,
};

beforeEach(() => {
  history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

describe("helpers", () => {
  it("makes 43-character base64url verifiers and their S256 challenge", async () => {
    const verifier = newVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newVerifier()).not.toBe(verifier);
    expect(await challengeFor(verifier)).toBe(s256(verifier));
    expect(base64url(new Uint8Array([251, 255, 191]))).toBe("-_-_");
  });

  it("builds the start URL on the server", () => {
    expect(ssoStartUrl("https://chat.example.ac.jp/", "web", "abc")).toBe("https://chat.example.ac.jp/api/v1/auth/sso/google/start?platform=web&challenge=abc");
  });

  it("reads the return fragment", () => {
    expect(parseSsoReturn("#sso_ticket=T-1_x")).toEqual({ kind: "ticket", ticket: "T-1_x" });
    expect(parseSsoReturn("#sso_error=domain_not_allowed")).toEqual({ kind: "error", code: "domain_not_allowed" });
    expect(parseSsoReturn("#sso_error=<script>")).toEqual({ kind: "error", code: "provider_error" });
    expect(parseSsoReturn("")).toBeNull();
    expect(parseSsoReturn("#something=else")).toBeNull();
    expect(ssoErrorText("not_registered")).toBe(ERROR_MESSAGES["not_registered"]);
    expect(ssoErrorText("unheard_of")).toMatch(/Google/);
  });

  it("keeps the pending sign-in for one exchange", () => {
    expect(saveSsoPending({ serverUrl: "http://localhost:3000", verifier: "v" })).toBe(true);
    expect(takeSsoPending()).toEqual({ serverUrl: "http://localhost:3000", verifier: "v" });
    expect(takeSsoPending()).toBeNull();
  });
});

function Login({ controller }: { controller: AppController }) {
  useSyncExternalStore((listener) => controller.subscribe(listener), () => controller.version);
  return <LoginScreen controller={controller} onDone={() => {}} />;
}

describe("login screen", () => {
  it("offers 「Google でログイン」 under the password form when the server has it, and goes to the start URL", async () => {
    const controller = new AppController();
    const methods = vi.spyOn(controller, "authMethods").mockResolvedValue({ password: true, google: { enabled: true } });
    const navigate = vi.fn();
    controller.navigate = navigate;
    render(<Login controller={controller} />);
    await flush();
    expect(methods).toHaveBeenCalledOnce();
    expect(screen.getByText("または")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Google でログイン" }));
    await flush();

    expect(navigate).toHaveBeenCalledOnce();
    const url = new URL(navigate.mock.calls[0]![0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(`${location.origin}/api/v1/auth/sso/google/start`);
    expect(url.searchParams.get("platform")).toBe("web");
    const pending = JSON.parse(sessionStorage.getItem("chikuwa.sso")!) as { serverUrl: string; verifier: string };
    expect(pending.serverUrl).toBe(location.origin);
    expect(url.searchParams.get("challenge")).toBe(s256(pending.verifier));
  });

  it("shows no Google button when the server does not offer it (or cannot say)", async () => {
    for (const answer of [{ password: true, google: { enabled: false } }, null]) {
      const controller = new AppController();
      vi.spyOn(controller, "authMethods").mockResolvedValue(answer);
      render(<Login controller={controller} />);
      await flush();
      expect(screen.queryByRole("button", { name: "Google でログイン" })).toBeNull();
      cleanup();
    }
  });

  it("hides it in the Tauri app until the deep link exists", async () => {
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
    const controller = new AppController();
    const methods = vi.spyOn(controller, "authMethods").mockResolvedValue({ password: true, google: { enabled: true } });
    render(<Login controller={controller} />);
    await flush();
    expect(methods).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Google でログイン" })).toBeNull();
  });
});

describe("return from Google", () => {
  function tokens(): TokenResponse {
    return {
      access_token: "a", refresh_token: "", token_type: "bearer", expires_in: 900, session_id: "s",
      device: { id: "d", platform: "web", device_name: "ブラウザ", app_version: "0.1.0", enabled: true, disabled_reason: null, push_provider: "none", push_environment: null, push_registered: false, last_seen_at: null, created_at: "", updated_at: "" },
      user: ME,
    };
  }

  it("removes the fragment, exchanges the ticket with the stored verifier and enters the session", async () => {
    saveSsoPending({ serverUrl: location.origin, verifier: "the-verifier" });
    history.replaceState(null, "", "/#sso_ticket=TICKET_123");
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      // The address bar lost the ticket before anything went to the network.
      expect(location.hash).toBe("");
      if (url.endsWith("/api/v1/auth/sso/exchange")) return new Response(JSON.stringify(tokens()), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ name: "研究室", workspace_id: "w1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const controller = new AppController();
    const enter = vi.spyOn(controller as unknown as { enterNewSession: (...args: unknown[]) => Promise<void> }, "enterNewSession").mockResolvedValue(undefined);
    await controller.boot();

    expect(location.hash).toBe("");
    const exchange = calls.find((c) => c.url.endsWith("/api/v1/auth/sso/exchange"))!;
    expect(exchange.url).toBe(`${location.origin}/api/v1/auth/sso/exchange`);
    const body = JSON.parse(String(exchange.init!.body)) as { ticket: string; verifier: string; device: { platform: string } };
    expect(body.ticket).toBe("TICKET_123");
    expect(body.verifier).toBe("the-verifier");
    expect(body.device.platform).toBe("web");
    expect(enter).toHaveBeenCalledOnce();
    const [api, username, me] = enter.mock.calls[0]! as [{ baseUrl: string; accessToken: string | null; refreshToken: string | null }, string, UserMe];
    expect(username).toBe("taro-2");
    expect(me.has_password).toBe(false);
    expect(api.baseUrl).toBe(location.origin);
    expect(api.accessToken).toBe("a");
    expect(api.refreshToken).toBe("cookie"); // the browser's refresh token is the HttpOnly cookie
    expect(sessionStorage.getItem("chikuwa.sso")).toBeNull();
  });

  it("shows the server's refusal of the ticket on the login screen", async () => {
    saveSsoPending({ serverUrl: location.origin, verifier: "the-verifier" });
    history.replaceState(null, "", "/#sso_ticket=TICKET_123");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "invalid_ticket", message: "x", details: {} } }), { status: 401, headers: { "Content-Type": "application/json" } })));
    const controller = new AppController();
    await controller.boot();
    expect(controller.screen).toBe("login");
    expect(controller.error).toBe(ERROR_MESSAGES["invalid_ticket"]);
  });

  it("without the verifier (another tab, cleared storage) the ticket is not even sent", async () => {
    history.replaceState(null, "", "/#sso_ticket=TICKET_123");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AppController();
    await controller.boot();
    expect(fetch).not.toHaveBeenCalled();
    expect(controller.screen).toBe("login");
    expect(controller.error).toBe(ERROR_MESSAGES["invalid_ticket"]);
  });

  it("shows the Japanese text for a returned sso_error", async () => {
    history.replaceState(null, "", "/#sso_error=domain_not_allowed");
    const controller = new AppController();
    await controller.boot();
    expect(location.hash).toBe("");
    expect(controller.screen).toBe("login");
    expect(controller.error).toBe(ERROR_MESSAGES["domain_not_allowed"]);
  });
});
