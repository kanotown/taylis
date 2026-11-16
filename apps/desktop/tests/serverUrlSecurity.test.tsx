// @vitest-environment jsdom
/**
 * M190 (SECURITY.md §6.1): the server URL classes against the cases every client shares
 * (apps/shared/server-url-security.json), and the confirmation the Tauri app's login form, Google button and invite
 * link show before plain HTTP to a server on the internet (none for https or a LAN server).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppController } from "../src/state/app";
import { classifyServerHost, classifyServerUrl, httpsVariant } from "../src/state/serverUrlSecurity";
import { normalizeServerUrl } from "../src/state/workspaces";
import { InviteScreen } from "../src/ui/InviteScreen";
import { LoginScreen } from "../src/ui/LoginScreen";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

type Expect = "secure" | "local" | "insecure";
const vectors = JSON.parse(readFileSync(join(process.cwd(), "..", "shared", "server-url-security.json"), "utf8")) as {
  inputs: { name: string; input: string; expect: Expect | "invalid" }[];
  hosts: { host: string; expect: Expect }[];
};

describe("server-url-security (apps/shared/server-url-security.json)", () => {
  it("has cases", () => {
    expect(vectors.inputs.length).toBeGreaterThan(30);
    expect(vectors.hosts.length).toBeGreaterThan(30);
  });

  it.each(vectors.inputs)("input: $name ($input → $expect)", ({ input, expect: expected }) => {
    const normalized = normalizeServerUrl(input);
    if (expected === "invalid") {
      expect(normalized).toBeNull();
      return;
    }
    expect(normalized).not.toBeNull();
    expect(classifyServerUrl(normalized!)).toBe(expected);
  });

  it.each(vectors.hosts)("host: $host → $expect", ({ host, expect: expected }) => {
    expect(classifyServerHost(host)).toBe(expected);
  });

  it("offers the same URL with https", () => {
    expect(httpsVariant("http://chat.example.com:8080/taylis")).toBe("https://chat.example.com:8080/taylis");
    expect(httpsVariant("HTTP://chat.example.com")).toBe("https://chat.example.com");
    expect(classifyServerUrl("http://chat.example.com/invite")).toBe("insecure"); // an invite link's server, not normalized
    expect(classifyServerUrl("not a url")).toBe("insecure");
  });
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function Login({ controller }: { controller: AppController }) {
  useSyncExternalStore((listener) => controller.subscribe(listener), () => controller.version);
  return <LoginScreen controller={controller} onDone={() => {}} />;
}

describe("the Tauri app asks before plain HTTP across the internet", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
    // GET /server for the workspace icon as the address is typed: no server here.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
  });

  function setUp(google = false) {
    const controller = new AppController();
    vi.spyOn(controller, "authMethods").mockResolvedValue(google ? { password: true, google: { enabled: true } } : null);
    const login = vi.spyOn(controller, "login").mockResolvedValue(undefined);
    const startGoogle = vi.spyOn(controller, "startGoogleSignIn").mockResolvedValue(undefined);
    const view = render(<Login controller={controller} />);
    return { controller, login, startGoogle, view };
  }

  async function fill(view: ReturnType<typeof render>, server: string) {
    fireEvent.change(screen.getByPlaceholderText("https://chat.example.com"), { target: { value: server } });
    fireEvent.change(view.container.querySelector('input[autocomplete="username"]')!, { target: { value: "taro" } });
    fireEvent.change(view.container.querySelector('input[type="password"]')!, { target: { value: "secret-pass" } });
    await flush();
  }

  it("http to a domain: the confirmation first, then 「https で接続」 signs in to the https URL and shows it", async () => {
    const { login, view } = setUp();
    await fill(view, "http://Chat.Example.com:8080/");
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    await flush();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("暗号化されていない接続です")).toBeTruthy();
    expect(within(dialog).getByText(/パスワードやメッセージが暗号化されずに送られ/)).toBeTruthy();
    expect(login).not.toHaveBeenCalled();
    // The default action has the focus.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "https で接続" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "https で接続" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith("https://chat.example.com:8080", "taro", "secret-pass", undefined);
    expect((screen.getByPlaceholderText("https://chat.example.com") as HTMLInputElement).value).toBe("https://chat.example.com:8080");
  });

  it("「このまま接続」 signs in over http as typed; 「キャンセル」 does nothing; each sign-in asks again", async () => {
    const { login, view } = setUp();
    await fill(view, "http://203.0.113.5:8000");
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "キャンセル" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(login).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "このまま接続" }));
    await flush();
    expect(login).toHaveBeenCalledWith("http://203.0.113.5:8000", "taro", "secret-pass", undefined);
    expect((screen.getByPlaceholderText("https://chat.example.com") as HTMLInputElement).value).toBe("http://203.0.113.5:8000");

    // Not remembered: the next attempt asks again.
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("the authenticator-code step of the same sign-in is not asked again", async () => {
    const { controller, login, view } = setUp();
    login.mockImplementation(async () => {
      controller.totpRequired = true;
      (controller as unknown as { setScreen: (screen: string, error: string | null) => void }).setScreen("login", null);
    });
    await fill(view, "http://chat.example.com");
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "このまま接続" }));
    await flush();
    expect(login).toHaveBeenCalledOnce();

    fireEvent.change(view.container.querySelector('input[autocomplete="one-time-code"]')!, { target: { value: "123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "コードを確認してログイン" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(login).toHaveBeenLastCalledWith("http://chat.example.com", "taro", "secret-pass", "123456");
  });

  it.each(["http://192.168.1.10:8000", "http://localhost:8000", "http://taylis:8000", "http://100.101.102.103", "https://chat.example.com", "chat.example.com"])(
    "%s: no confirmation",
    async (server) => {
      const { login, view } = setUp();
      await fill(view, server);
      fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
      await flush();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(login).toHaveBeenCalledWith(server, "taro", "secret-pass", undefined);
    },
  );

  it("the Google button asks too, and starts on the https URL", async () => {
    const { startGoogle, view } = setUp(true);
    await fill(view, "http://chat.example.com");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); }); // the methods of the typed server
    fireEvent.click(screen.getByRole("button", { name: "Google でログイン" }));
    await flush();
    expect(startGoogle).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "https で接続" }));
    await flush();
    expect(startGoogle).toHaveBeenCalledWith("https://chat.example.com");
  });

  describe("invite link", () => {
    const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

    function invite(link: string) {
      const controller = new AppController();
      const previewInvite = vi.spyOn(controller, "previewInvite").mockResolvedValue({
        invited_by: "加納", role: "member", channels: [], expires_at: "2026-12-01T00:00:00Z", password_min_length: 8,
      } as unknown as Awaited<ReturnType<AppController["previewInvite"]>>);
      render(<InviteScreen controller={controller} onBack={() => {}} onDone={() => {}} />);
      fireEvent.change(screen.getByPlaceholderText("https://chat.example.com/invite/…"), { target: { value: link } });
      fireEvent.click(screen.getByRole("button", { name: "リンクを確認" }));
      return previewInvite;
    }

    it("a link to a server on the internet over http asks before the server is asked", async () => {
      const previewInvite = invite(`http://chat.example.com/invite/${TOKEN}`);
      await flush();
      expect(within(screen.getByRole("dialog")).getByText("暗号化されていない接続です")).toBeTruthy();
      expect(previewInvite).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "https で接続" }));
      await flush();
      expect(previewInvite).toHaveBeenCalledWith("https://chat.example.com", TOKEN);
    });

    it("「このまま接続」 keeps http; a LAN link is not asked about", async () => {
      const previewInvite = invite(`http://chat.example.com:8000/invite/${TOKEN}`);
      await flush();
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "このまま接続" }));
      await flush();
      expect(previewInvite).toHaveBeenCalledWith("http://chat.example.com:8000", TOKEN);
      cleanup();

      const lan = invite(`http://192.168.1.10:8000/invite/${TOKEN}`);
      await flush();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(lan).toHaveBeenCalledWith("http://192.168.1.10:8000", TOKEN);
    });
  });
});
