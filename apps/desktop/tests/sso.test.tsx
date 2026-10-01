// @vitest-environment jsdom
/**
 * Google sign-in in the browser build (M48, docs/SSO.md §6): the login screen's button, the start URL and its S256
 * challenge, the return through the fragment (exchange, or the error text), and 「パスワードを変更」 hidden for an
 * account without a password. The Tauri app (the deep-link plugin mocked): the start page in the system browser, the
 * waiting screen and its キャンセル, and the `chikuwachat://sso` link (exchange as "desktop", error, ignored).
 */
import { createHash } from "node:crypto";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { ERROR_MESSAGES } from "../src/api/errorMessages";
import type { TokenResponse, UserMe } from "../src/api/types";
import { AppController } from "../src/state/app";
import { LoginScreen } from "../src/ui/LoginScreen";
import { base64url, challengeFor, newVerifier, parseSsoDeepLink, parseSsoReturn, saveSsoPending, ssoErrorText, ssoStartUrl, takeSsoPending } from "../src/ui/sso";

// The Tauri app's side (tauri-plugin-deep-link, the credential-store commands), captured for the desktop tests.
const tauri = vi.hoisted(() => ({
  linkHandler: null as ((urls: string[]) => void) | null,
  current: null as string[] | null,
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    tauri.linkHandler = handler;
    return () => {
      tauri.linkHandler = null;
    };
  },
  getCurrent: async () => tauri.current,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

const s256 = (value: string) => createHash("sha256").update(value).digest("base64url");
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const ME: UserMe = {
  id: "u1", username: "taro-2", display_name: "山田 太郎", role: "member", deactivated_at: null, created_at: "", updated_at: "",
  email: "taro@example.ac.jp", must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "mentions", notify_reactions: false, notify_tasks: true, has_password: false,
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

  it("reads the Tauri app's deep link, and only chikuwachat://sso", () => {
    expect(parseSsoDeepLink("chikuwachat://sso?ticket=T-1_x")).toEqual({ kind: "ticket", ticket: "T-1_x" });
    expect(parseSsoDeepLink("chikuwachat://sso/?ticket=T")).toEqual({ kind: "ticket", ticket: "T" });
    expect(parseSsoDeepLink("chikuwachat://sso?sso_error=cancelled")).toEqual({ kind: "error", code: "cancelled" });
    expect(parseSsoDeepLink("chikuwachat://sso?sso_error=%3Cb%3E")).toEqual({ kind: "error", code: "provider_error" });
    expect(parseSsoDeepLink("chikuwachat://sso")).toBeNull();
    expect(parseSsoDeepLink("chikuwachat://other?ticket=T")).toBeNull();
    expect(parseSsoDeepLink("chikuwachat://ssox?ticket=T")).toBeNull();
    expect(parseSsoDeepLink("https://sso?ticket=T")).toBeNull();
    expect(parseSsoDeepLink("not a url")).toBeNull();
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

describe("the Tauri app (deep link)", () => {
  const SERVER = "http://127.0.0.1:8000"; // the login form's default server without a workspace
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  function tokens(): TokenResponse {
    return {
      access_token: "a", refresh_token: "r-token", token_type: "bearer", expires_in: 900, session_id: "s",
      device: { id: "d", platform: "desktop", device_name: "Mac", app_version: "0.1.0", enabled: true, disabled_reason: null, push_provider: "none", push_environment: null, push_registered: false, last_seen_at: null, created_at: "", updated_at: "" },
      user: ME,
    };
  }
  /** The server: GET /server answers, the exchange as `exchange` says; every call recorded. */
  function serve(exchange: () => Response = () => json(tokens())) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/api/v1/auth/sso/exchange")) return exchange();
      if (url.endsWith("/api/v1/server")) return json({ product: "chikuwachat", workspace_id: "w1", name: "研究室" });
      return json({ error: { code: "not_found", message: "x", details: {} } }, 404);
    }));
    return calls;
  }
  const exchanges = <T extends { url: string }>(calls: T[]) => calls.filter((c) => c.url.endsWith("/api/v1/auth/sso/exchange"));
  /** A controller listening for links, with the browser replaced. */
  async function listening() {
    const controller = new AppController();
    const openBrowser = vi.fn(async (_url: string) => {});
    controller.openBrowser = openBrowser;
    const enter = vi.spyOn(controller as unknown as { enterNewSession: (...args: unknown[]) => Promise<void> }, "enterNewSession").mockResolvedValue(undefined);
    handled = vi.spyOn(controller, "handleSsoLink");
    await controller.watchSsoLinks();
    expect(tauri.linkHandler).not.toBeNull();
    return { controller, openBrowser, enter };
  }
  let handled: MockInstance<(url: string) => Promise<void>> | null = null;
  /** A link through the plugin's listener, and the controller done with it. */
  const link = async (url: string) => {
    const before = handled!.mock.results.length;
    tauri.linkHandler!([url]);
    expect(handled!.mock.results).toHaveLength(before + 1);
    await handled!.mock.results[before]!.value;
  };

  beforeEach(() => {
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
    tauri.linkHandler = null;
    tauri.current = null;
    tauri.invoke.mockClear();
  });

  it("offers the button for the typed server, opens the start page in the browser and waits (キャンセル)", async () => {
    serve();
    const controller = new AppController();
    const openBrowser = vi.fn(async (_url: string) => {});
    controller.openBrowser = openBrowser;
    const methods = vi.spyOn(controller, "authMethods").mockResolvedValue({ password: true, google: { enabled: true } });
    render(<Login controller={controller} />);
    await flush();
    expect(methods).toHaveBeenCalledWith(SERVER);
    fireEvent.click(screen.getByRole("button", { name: "Google でログイン" }));
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
    await flush();

    const url = new URL(openBrowser.mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${SERVER}/api/v1/auth/sso/google/start`);
    expect(url.searchParams.get("platform")).toBe("desktop");
    expect(url.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionStorage.getItem("chikuwa.sso")).toBeNull(); // the verifier stays in memory
    expect(controller.ssoState).toBe("waiting");
    expect(screen.getByText("ブラウザでログインを続けてください")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ログイン" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await flush();
    expect(controller.ssoState).toBe("idle");
    expect(screen.getByRole("button", { name: "Google でログイン" })).toBeTruthy();
  });

  it("asks the server again as its URL is typed", async () => {
    const controller = new AppController();
    const methods = vi.spyOn(controller, "authMethods").mockImplementation(async (server) => ({ password: true, google: { enabled: server.includes("univ") } }));
    render(<Login controller={controller} />);
    await flush();
    expect(screen.queryByRole("button", { name: "Google でログイン" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("https://chat.example.com"), { target: { value: "chat.univ.example.ac.jp" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    expect(methods).toHaveBeenLastCalledWith("chat.univ.example.ac.jp");
    expect(screen.getByRole("button", { name: "Google でログイン" })).toBeTruthy();
  });

  it("exchanges the returned ticket as \"desktop\" with the verifier and keeps the refresh token in the credential store", async () => {
    const calls = serve();
    const { controller, openBrowser, enter } = await listening();
    await controller.startGoogleSignIn(SERVER);
    const challenge = new URL(openBrowser.mock.calls[0]![0]).searchParams.get("challenge");

    await link("chikuwachat://sso?ticket=TICKET_123");

    const [exchange] = exchanges(calls);
    expect(exchange!.url).toBe(`${SERVER}/api/v1/auth/sso/exchange`);
    const body = JSON.parse(String(exchange!.init!.body)) as { ticket: string; verifier: string; device: { platform: string } };
    expect(body.ticket).toBe("TICKET_123");
    expect(s256(body.verifier)).toBe(challenge);
    expect(body.device.platform).toBe("desktop");
    expect(enter).toHaveBeenCalledOnce();
    const [api, username] = enter.mock.calls[0]! as [{ baseUrl: string; accessToken: string | null; refreshToken: string | null }, string];
    expect(username).toBe("taro-2");
    expect(api.baseUrl).toBe(SERVER);
    expect(api.accessToken).toBe("a");
    expect(api.refreshToken).toBe("r-token"); // not the browser's cookie session
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("secret_set", { account: `${SERVER}|taro-2`, value: "r-token" }));
    expect(controller.ssoState).toBe("idle");

    // The same link again (a second copy) finds nothing waiting.
    await link("chikuwachat://sso?ticket=TICKET_123");
    expect(exchanges(calls)).toHaveLength(1);
  });

  it("shows a returned sso_error, and the server's refusal of the ticket, on the login screen", async () => {
    const calls = serve(() => json({ error: { code: "invalid_ticket", message: "x", details: {} } }, 401));
    const { controller } = await listening();
    await controller.startGoogleSignIn(SERVER);
    await link("chikuwachat://sso?sso_error=domain_not_allowed");
    expect(exchanges(calls)).toHaveLength(0);
    expect(controller.ssoState).toBe("idle");
    expect(controller.screen).toBe("login");
    expect(controller.error).toBe(ERROR_MESSAGES["domain_not_allowed"]);

    await controller.startGoogleSignIn(SERVER);
    expect(controller.error).toBeNull();
    await link("chikuwachat://sso?ticket=T");
    expect(exchanges(calls)).toHaveLength(1);
    expect(controller.ssoState).toBe("idle");
    expect(controller.error).toBe(ERROR_MESSAGES["invalid_ticket"]);
  });

  it("ignores links when no sign-in waits: the one that launched the app, after キャンセル, and other links", async () => {
    tauri.current = ["chikuwachat://sso?ticket=LAUNCH"];
    const calls = serve();
    const { controller, enter } = await listening();
    await flush();
    await link("chikuwachat://sso?ticket=STRAY");
    expect(exchanges(calls)).toHaveLength(0);
    expect(controller.error).toBeNull();

    await controller.startGoogleSignIn(SERVER);
    await link("chikuwachat://elsewhere?ticket=T"); // not a sign-in return: still waiting
    expect(controller.ssoState).toBe("waiting");
    controller.cancelGoogleSignIn();
    await link("chikuwachat://sso?ticket=LATE");
    expect(exchanges(calls)).toHaveLength(0);
    expect(enter).not.toHaveBeenCalled();
    expect(controller.ssoState).toBe("idle");
  });

  it("says so when the browser cannot be opened", async () => {
    serve();
    const { controller, openBrowser } = await listening();
    openBrowser.mockRejectedValueOnce(new Error("no browser"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await controller.startGoogleSignIn(SERVER);
    expect(controller.ssoState).toBe("idle");
    expect(controller.error).toBe("ブラウザを開けませんでした。もう一度お試しください");
    await link("chikuwachat://sso?ticket=T");
    expect(controller.ssoState).toBe("idle");
  });
});
