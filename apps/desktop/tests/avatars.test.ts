import { describe, expect, it } from "vitest";

import type { UserPublic } from "../src/api/types";
import { avatarCacheKey, avatarPath, avatarUrl, configureAvatars, noteVersions } from "../src/ui/avatars";

const user = (id: string, version: string | null): UserPublic => ({ id, username: id, display_name: id, role: "member", deactivated_at: null, created_at: "", updated_at: "", avatar_updated_at: version });

describe("profile pictures (M14a)", () => {
  it("builds the cache key and the versioned path", () => {
    expect(avatarCacheKey("u1", "2026-09-27T00:00:00+00:00")).toBe("u1|2026-09-27T00:00:00+00:00");
    expect(avatarPath("u1", "2026-09-27T00:00:00+00:00")).toBe("/api/v1/users/u1/avatar?v=2026-09-27T00%3A00%3A00%2B00%3A00");
  });

  it("fetches once per version and forgets users without a picture", async () => {
    const fetched: string[] = [];
    configureAvatars(async (path) => {
      fetched.push(path);
      return new Blob(["png"]);
    });
    noteVersions([user("u1", "v1"), user("u2", null)]);
    expect(avatarUrl("u2")).toBeNull();
    expect(avatarUrl("u1")).toBeNull(); // not loaded yet
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(avatarUrl("u1")).toMatch(/^blob:/);
    expect(fetched).toEqual(["/api/v1/users/u1/avatar?v=v1"]);
    noteVersions([user("u1", null)]);
    expect(avatarUrl("u1")).toBeNull();
    configureAvatars(null);
  });
});
