import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserPublic } from "../src/api/types";
import { avatarCacheKey, avatarPath, avatarPicture, avatarUrl, configureAvatars, noteVersions } from "../src/ui/avatars";

const user = (id: string, version: string | null): UserPublic => ({ id, username: id, display_name: id, role: "member", deactivated_at: null, created_at: "", updated_at: "", avatar_updated_at: version });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fetch that records the paths it was asked for. */
function recording() {
  const fetched: string[] = [];
  const fetch = async (path: string) => {
    fetched.push(path);
    return new Blob(["png"]);
  };
  return { fetched, fetch };
}

afterEach(() => {
  configureAvatars(null);
  vi.restoreAllMocks();
});

describe("profile pictures (M14a)", () => {
  it("builds the cache key and the versioned path", () => {
    expect(avatarCacheKey("u1", "2026-09-27T00:00:00+00:00")).toBe("u1|2026-09-27T00:00:00+00:00");
    expect(avatarPath("u1", "2026-09-27T00:00:00+00:00")).toBe("/api/v1/users/u1/avatar?v=2026-09-27T00%3A00%3A00%2B00%3A00");
  });

  it("fetches once per version and forgets users without a picture", async () => {
    const { fetched, fetch } = recording();
    configureAvatars(fetch, "https://a");
    noteVersions([user("u1", "v1"), user("u2", null)]);
    expect(avatarUrl("u2")).toBeNull();
    expect(avatarUrl("u1")).toBeNull(); // not loaded yet
    await settle();
    expect(avatarUrl("u1")).toMatch(/^blob:/);
    expect(fetched).toEqual(["/api/v1/users/u1/avatar?v=v1"]);
    noteVersions([user("u1", null)]);
    expect(avatarUrl("u1")).toBeNull();
  });

  it("is loading (a placeholder, not the initials) until the first fetch lands, then a hit at once on every later ask", async () => {
    const { fetched, fetch } = recording();
    configureAvatars(fetch, "https://a");
    noteVersions([user("u1", "v1"), user("u2", null)]);
    expect(avatarPicture("u1")).toEqual({ state: "loading" });
    expect(avatarPicture("u2")).toEqual({ state: "none" });
    await settle();
    const first = avatarPicture("u1");
    expect(first.state).toBe("ready");
    for (let i = 0; i < 5; i++) expect(avatarPicture("u1")).toEqual(first);
    expect(fetched).toHaveLength(1);
  });

  it("fetches again when the version changes", async () => {
    const { fetched, fetch } = recording();
    configureAvatars(fetch, "https://a");
    noteVersions([user("u1", "v1")]);
    avatarPicture("u1");
    await settle();
    noteVersions([user("u1", "v2")]);
    expect(avatarPicture("u1")).toEqual({ state: "loading" });
    await settle();
    expect(avatarPicture("u1").state).toBe("ready");
    expect(fetched).toEqual(["/api/v1/users/u1/avatar?v=v1", "/api/v1/users/u1/avatar?v=v2"]);
  });

  it("shows the initials when the picture fails, without asking again on every render", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    configureAvatars(fetch, "https://a");
    noteVersions([user("u1", "v1")]);
    expect(avatarPicture("u1")).toEqual({ state: "loading" });
    await settle();
    expect(avatarPicture("u1")).toEqual({ state: "none" });
    expect(avatarPicture("u1")).toEqual({ state: "none" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used picture beyond the limit and revokes its URL", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { fetched, fetch } = recording();
    configureAvatars(fetch, "https://a", 2);
    noteVersions([user("u1", "v"), user("u2", "v"), user("u3", "v")]);
    avatarPicture("u1");
    await settle();
    avatarPicture("u2");
    await settle();
    const u1 = avatarUrl("u1"); // used again: u2 is now the oldest
    const u2 = avatarUrl("u2");
    avatarUrl("u1");
    avatarPicture("u3");
    await settle();
    expect(revoke).toHaveBeenCalledWith(u2);
    expect(revoke).not.toHaveBeenCalledWith(u1);
    expect(avatarUrl("u1")).toBe(u1);
    expect(avatarPicture("u2")).toEqual({ state: "loading" }); // evicted: fetched again
    expect(fetched).toHaveLength(4);
  });

  it("empties the cache, revoking its URLs, on sign-out and on a workspace switch", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { fetched, fetch } = recording();
    configureAvatars(fetch, "https://a");
    noteVersions([user("u1", "v1")]);
    avatarPicture("u1");
    await settle();
    const first = avatarUrl("u1");
    configureAvatars(fetch, "https://a"); // the same workspace again: kept
    expect(avatarUrl("u1")).toBe(first);
    configureAvatars(null); // signed out
    expect(revoke).toHaveBeenCalledWith(first);
    expect(avatarPicture("u1")).toEqual({ state: "none" });

    configureAvatars(fetch, "https://a");
    noteVersions([user("u1", "v1")]);
    avatarPicture("u1");
    await settle();
    const second = avatarUrl("u1");
    configureAvatars(fetch, "https://b"); // another workspace
    expect(revoke).toHaveBeenCalledWith(second);
    expect(avatarPicture("u1")).toEqual({ state: "none" }); // its users are not known yet
    expect(fetched).toHaveLength(2);
  });

  it("drops a fetch that lands after the cache was emptied", async () => {
    let resolve: (blob: Blob) => void = () => {};
    configureAvatars(() => new Promise<Blob>((r) => (resolve = r)), "https://a");
    noteVersions([user("u1", "v1")]);
    avatarPicture("u1");
    configureAvatars(null);
    resolve(new Blob(["png"]));
    await settle();
    configureAvatars(async () => new Blob(["png"]), "https://a");
    noteVersions([user("u1", "v1")]);
    expect(avatarPicture("u1")).toEqual({ state: "loading" }); // not the stale one
  });
});
