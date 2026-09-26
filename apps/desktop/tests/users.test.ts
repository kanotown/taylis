import { describe, expect, it } from "vitest";

import type { UserPublic } from "../src/api/types";
import { activeStatus, expiryAt, expiryLabel } from "../src/ui/users";

const base: UserPublic = {
  id: "u1", username: "alice", display_name: "Alice", role: "member", deactivated_at: null, created_at: "", updated_at: "",
  title: null, status_text: null, status_emoji: null, status_expires_at: null,
};

describe("custom status (M11d)", () => {
  it("shows a status until it expires", () => {
    const now = Date.parse("2026-09-27T10:00:00Z");
    expect(activeStatus(base, now)).toBeNull();
    expect(activeStatus({ ...base, status_emoji: "🚌", status_text: "移動中" }, now)).toEqual({ emoji: "🚌", text: "移動中" });
    expect(activeStatus({ ...base, status_text: "会議中", status_expires_at: "2026-09-27T11:00:00Z" }, now)).toEqual({ emoji: "", text: "会議中" });
    expect(activeStatus({ ...base, status_text: "会議中", status_expires_at: "2026-09-27T09:59:59Z" }, now)).toBeNull();
    expect(activeStatus(undefined, now)).toBeNull();
  });

  it("computes expiry times relative to now", () => {
    const now = new Date(2026, 8, 30, 10, 0, 0); // a Wednesday, local time
    expect(expiryAt("never", now)).toBeNull();
    expect(Date.parse(expiryAt("30m", now)!) - now.getTime()).toBe(30 * 60_000);
    expect(Date.parse(expiryAt("4h", now)!) - now.getTime()).toBe(4 * 3_600_000);
    expect(new Date(expiryAt("today", now)!).getHours()).toBe(23);
    expect(new Date(expiryAt("week", now)!).getDay()).toBe(0); // the coming Sunday
    expect(expiryLabel(null)).toBeNull();
    expect(expiryLabel("not a date")).toBeNull();
  });
});
