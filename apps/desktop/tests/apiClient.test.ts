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
