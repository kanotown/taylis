import { describe, expect, it } from "vitest";

import { ApiClient } from "../src/api/client";
import { ApiError, NetworkError } from "../src/api/errors";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const tokens = (n: number) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  token_type: "bearer",
  expires_in: 900,
  session_id: "s",
  device: { id: "d", platform: "desktop", device_name: null, app_version: null, enabled: true, disabled_reason: null, last_seen_at: null, created_at: "", updated_at: "" },
  user: { id: "u", username: "alice", display_name: "Alice", role: "member", deactivated_at: null, created_at: "", updated_at: "", email: null, must_change_password: false },
});

describe("ApiClient", () => {
  it("refreshes once on token_expired and retries the request", async () => {
    const calls: { path: string; auth: string | null }[] = [];
    let refreshed = 0;
    const client = new ApiClient("http://server", {
      fetchImpl: async (input, init) => {
        const path = String(input).replace("http://server", "");
        const headers = init?.headers as Record<string, string>;
        calls.push({ path, auth: headers["Authorization"] ?? null });
        if (path === "/api/v1/auth/refresh") {
          refreshed += 1;
          return jsonResponse(200, tokens(2));
        }
        if (headers["Authorization"] === "Bearer access-1") return jsonResponse(401, { error: { code: "token_expired", message: "expired", details: {} } });
        return jsonResponse(200, { id: "u", username: "alice" });
      },
    });
    client.accessToken = "access-1";
    client.refreshToken = "refresh-1";
    const me = await client.request<{ username: string }>("GET", "/api/v1/users/me");
    expect(me.username).toBe("alice");
    expect(refreshed).toBe(1);
    expect(client.refreshToken).toBe("refresh-2");
    expect(calls.map((c) => c.auth)).toEqual(["Bearer access-1", null, "Bearer access-2"]);
  });

  it("signs out when refresh fails and reports structured errors", async () => {
    let signedOut = false;
    const client = new ApiClient("http://server", {
      fetchImpl: async (input) => {
        if (String(input).endsWith("/auth/refresh")) return jsonResponse(401, { error: { code: "session_revoked", message: "revoked", details: {} } });
        return jsonResponse(401, { error: { code: "token_expired", message: "expired", details: {} } });
      },
      onSignedOut: () => {
        signedOut = true;
      },
    });
    client.accessToken = "a";
    client.refreshToken = "r";
    await expect(client.request("GET", "/api/v1/users/me")).rejects.toMatchObject({ code: "session_revoked", status: 401 });
    expect(signedOut).toBe(true);
    expect(client.accessToken).toBeNull();
  });

  it("classifies network and server errors as retryable", async () => {
    const offline = new ApiClient("http://server", { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await expect(offline.bootstrap()).rejects.toBeInstanceOf(NetworkError);
    const flaky = new ApiClient("http://server", { fetchImpl: async () => jsonResponse(503, { error: { code: "unavailable", message: "down", details: {} } }) });
    const err = await flaky.bootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isRetryable).toBe(true);
    const bad = new ApiClient("http://server", { fetchImpl: async () => jsonResponse(422, { error: { code: "validation_error", message: "bad", details: {} } }) });
    const err2 = await bad.bootstrap().catch((e: unknown) => e);
    expect((err2 as ApiError).isRetryable).toBe(false);
  });

  it("derives the WebSocket URL from the base URL", () => {
    expect(new ApiClient("https://chat.example.com").wsUrl).toBe("wss://chat.example.com/api/v1/ws");
    expect(new ApiClient("http://127.0.0.1:8000/").wsUrl).toBe("ws://127.0.0.1:8000/api/v1/ws");
  });
});


it("refreshes a restored session before issuing an authenticated request", async () => {
  const paths: string[] = [];
  const client = new ApiClient("http://server", { fetchImpl: async (input, init) => {
    paths.push(String(input));
    if (String(input).endsWith("/auth/refresh")) return jsonResponse(200, tokens(2));
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer access-2");
    return jsonResponse(200, tokens(2).user);
  } });
  client.refreshToken = "refresh-1";
  await client.me();
  expect(paths).toEqual(["http://server/api/v1/auth/refresh", "http://server/api/v1/users/me"]);
});

it("does not resurrect credentials when a refresh finishes after sign-out", async () => {
  let complete!: (response: Response) => void;
  const saved: string[] = [];
  const client = new ApiClient("http://server", {
    fetchImpl: () => new Promise((resolve) => { complete = resolve; }),
    onTokens: (response) => saved.push(response.refresh_token),
  });
  client.refreshToken = "refresh-1";
  const refresh = client.refresh();
  client.signOut();
  complete(jsonResponse(200, tokens(2)));
  await expect(refresh).rejects.toMatchObject({ code: "session_changed" });
  expect(client.refreshToken).toBeNull();
  expect(client.accessToken).toBeNull();
  expect(saved).toEqual([]);
});

describe("administration and channel management (M11e)", () => {
  it("calls the admin and channel endpoints with the right methods and bodies", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = new ApiClient("http://server", {
      fetchImpl: async (input, init) => {
        const path = String(input).replace("http://server", "");
        calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (path.endsWith("/sessions") || path.endsWith("/leave") || path.includes("/members/")) return new Response(null, { status: 204 });
        if (path === "/api/v1/admin/users" && init?.method === "POST") return jsonResponse(201, { user: { id: "n", username: "newbie" }, temporary_password: "tmp-pass" });
        if (path.endsWith("/reset-password")) return jsonResponse(200, { temporary_password: "reset-pass" });
        return jsonResponse(200, path.endsWith("/users") ? [] : { id: "x" });
      },
    });
    client.accessToken = "a";
    expect(await client.adminListUsers()).toEqual([]);
    const created = await client.adminCreateUser({ username: "newbie", display_name: "Newbie", email: null, role: "member" });
    expect(created.temporary_password).toBe("tmp-pass");
    await client.adminUpdateUser("u1", { role: "admin" });
    await client.adminUpdateUser("u1", { deactivated: true });
    expect((await client.adminResetPassword("u1")).temporary_password).toBe("reset-pass");
    await client.adminRevokeSessions("u1");
    await client.adminAnonymizeUser("u1");
    await client.archiveChannel("c1");
    await client.leaveChannel("c1");
    await client.removeMember("c1", "u2");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/admin/users",
      "POST /api/v1/admin/users",
      "PATCH /api/v1/admin/users/u1",
      "PATCH /api/v1/admin/users/u1",
      "POST /api/v1/admin/users/u1/reset-password",
      "DELETE /api/v1/admin/users/u1/sessions",
      "POST /api/v1/admin/users/u1/anonymize",
      "POST /api/v1/channels/c1/archive",
      "POST /api/v1/channels/c1/leave",
      "DELETE /api/v1/channels/c1/members/u2",
    ]);
    expect(calls[1]!.body).toEqual({ username: "newbie", display_name: "Newbie", email: null, role: "member" });
    expect(calls[2]!.body).toEqual({ role: "admin" });
    expect(calls[3]!.body).toEqual({ deactivated: true });
  });
});

describe("files (M11i)", () => {
  it("builds the files query from the scope, the filter and the cursor", async () => {
    const paths: string[] = [];
    const client = new ApiClient("http://server", {
      fetchImpl: async (input) => {
        paths.push(String(input).replace("http://server", ""));
        return jsonResponse(200, { items: [], next_cursor: null });
      },
    });
    client.accessToken = "a";
    await client.listFiles();
    await client.listFiles({ channelId: "c1", q: "報告 書", cursor: "2026-09-27T00:00:00+00:00|a1", limit: 10 });
    expect(paths).toEqual([
      "/api/v1/files?limit=50",
      "/api/v1/files?limit=10&channel_id=c1&q=%E5%A0%B1%E5%91%8A+%E6%9B%B8&cursor=2026-09-27T00%3A00%3A00%2B00%3A00%7Ca1",
    ]);
  });
});

describe("invite links (M12h)", () => {
  it("calls the admin and public invite endpoints; accepting logs in", async () => {
    const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
    const client = new ApiClient("http://server", {
      fetchImpl: async (input, init) => {
        const path = String(input).replace("http://server", "");
        const headers = init?.headers as Record<string, string>;
        calls.push({ method: init?.method ?? "GET", path, auth: headers["Authorization"] ?? null, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (path.endsWith("/accept")) return jsonResponse(201, tokens(3));
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        if (init?.method === "POST") return jsonResponse(201, { invite: { id: "i1", note: "x" }, token: "tok" });
        if (path.startsWith("/api/v1/invites/")) return jsonResponse(200, { invited_by: "Root", role: "member", channels: ["general"], expires_at: "", password_min_length: 8 });
        return jsonResponse(200, []);
      },
    });
    client.accessToken = "a";
    expect(await client.adminListInvites()).toEqual([]);
    expect((await client.adminCreateInvite({ channel_ids: ["c1"], note: "x", max_uses: 1, expires_in_hours: 24, role: "member" })).token).toBe("tok");
    await client.adminRevokeInvite("i1");
    expect((await client.invitePreview("t_k")).invited_by).toBe("Root");
    const accepted = await client.acceptInvite("t_k", { username: "tanaka", display_name: "田中", password: "pw" }, { platform: "desktop" });
    expect(accepted.user.username).toBe("alice");
    expect(client.refreshToken).toBe("refresh-3");
    expect(calls.map((c) => `${c.method} ${c.path} ${c.auth ?? "-"}`)).toEqual([
      "GET /api/v1/admin/invites Bearer a",
      "POST /api/v1/admin/invites Bearer a",
      "DELETE /api/v1/admin/invites/i1 Bearer a",
      "GET /api/v1/invites/t_k -",
      "POST /api/v1/invites/t_k/accept -",
    ]);
    expect(calls[1]!.body).toEqual({ channel_ids: ["c1"], note: "x", max_uses: 1, expires_in_hours: 24, role: "member" });
    expect(calls[4]!.body).toEqual({ username: "tanaka", display_name: "田中", password: "pw", device: { platform: "desktop" } });
  });
});

describe("two-factor authentication (M12i)", () => {
  it("sends the code with the login and drives the setup endpoints", async () => {
    const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
    const client = new ApiClient("http://server", {
      fetchImpl: async (input, init) => {
        const path = String(input).replace("http://server", "");
        const headers = init?.headers as Record<string, string>;
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method: init?.method ?? "GET", path, auth: headers["Authorization"] ?? null, body });
        if (path === "/api/v1/auth/login") {
          if (!body.totp_code) return jsonResponse(401, { error: { code: "totp_required", message: "Two-factor code required", details: {} } });
          return jsonResponse(200, tokens(4));
        }
        if (path === "/api/v1/auth/totp") return jsonResponse(200, { enabled: false, enabled_at: null, recovery_codes_left: 0 });
        if (path.endsWith("/setup")) return jsonResponse(200, { secret: "ABC", otpauth_uri: "otpauth://totp/x", qr_png_base64: "iVBOR" });
        if (path.endsWith("/enable")) return jsonResponse(200, { recovery_codes: ["abcde-fghjk"] });
        return new Response(null, { status: 204 });
      },
    });
    await expect(client.login("alice", "pw", { platform: "desktop" })).rejects.toMatchObject({ code: "totp_required", status: 401 });
    const logged = await client.login("alice", "pw", { platform: "desktop" }, "123456");
    expect(logged.user.username).toBe("alice");
    expect(client.accessToken).toBe("access-4");
    expect((await client.totpStatus()).enabled).toBe(false);
    expect((await client.totpSetup("pw")).secret).toBe("ABC");
    expect((await client.totpEnable("123456")).recovery_codes).toEqual(["abcde-fghjk"]);
    await client.totpDisable("pw");
    await client.adminResetTotp("u1");
    expect(calls.map((c) => `${c.method} ${c.path} ${c.auth ?? "-"}`)).toEqual([
      "POST /api/v1/auth/login -",
      "POST /api/v1/auth/login -",
      "GET /api/v1/auth/totp Bearer access-4",
      "POST /api/v1/auth/totp/setup Bearer access-4",
      "POST /api/v1/auth/totp/enable Bearer access-4",
      "POST /api/v1/auth/totp/disable Bearer access-4",
      "DELETE /api/v1/admin/users/u1/totp Bearer access-4",
    ]);
    expect(calls[0]!.body).toEqual({ username: "alice", password: "pw", device: { platform: "desktop" } });
    expect(calls[1]!.body).toEqual({ username: "alice", password: "pw", device: { platform: "desktop" }, totp_code: "123456" });
  });
});
