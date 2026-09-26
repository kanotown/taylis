import { describe, expect, it } from "vitest";

import { dndActive, dndUntilAt, inQuietHours, quietHoursLabel } from "../src/ui/dnd";

describe("do not disturb (M12c)", () => {
  const at = (iso: string) => new Date(iso);
  it("evaluates quiet hours in the user's zone with an exclusive end", () => {
    const lunch = { start: "12:00", end: "13:00", tz: "Asia/Tokyo" };
    expect(inQuietHours(lunch, at("2026-09-28T12:30:00+09:00"))).toBe(true);
    expect(inQuietHours(lunch, at("2026-09-28T13:00:00+09:00"))).toBe(false);
    expect(inQuietHours(lunch, at("2026-09-28T12:30:00Z"))).toBe(false); // 21:30 in Tokyo
    expect(inQuietHours({ ...lunch, tz: "Mars/Olympus" }, at("2026-09-28T12:30:00+09:00"))).toBe(false);
  });
  it("lets an overnight window belong to the day it starts on", () => {
    const fridayNight = { start: "22:00", end: "07:00", days: [4], tz: "Asia/Tokyo" };
    expect(inQuietHours(fridayNight, at("2026-10-02T23:00:00+09:00"))).toBe(true);
    expect(inQuietHours(fridayNight, at("2026-10-03T06:30:00+09:00"))).toBe(true);
    expect(inQuietHours(fridayNight, at("2026-10-03T23:00:00+09:00"))).toBe(false);
    expect(inQuietHours({ start: "22:00", end: "07:00", tz: "Asia/Tokyo" }, at("2026-09-28T02:00:00+09:00"))).toBe(true);
  });
  it("treats a manual pause as active until it ends", () => {
    const user = { dnd_until: "2026-09-28T03:30:00Z", quiet_hours: null } as never;
    expect(dndActive(user, at("2026-09-28T03:00:00Z"))).toBe(true);
    expect(dndActive(user, at("2026-09-28T03:31:00Z"))).toBe(false);
    expect(dndActive(null)).toBe(false);
    const tomorrow = new Date(dndUntilAt("tomorrow", at("2026-09-28T15:00:00")));
    expect(tomorrow.getHours()).toBe(8);
    expect(tomorrow.getDate()).toBe(29);
    expect(quietHoursLabel({ start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4], tz: "Asia/Tokyo" })).toBe("22:00〜07:00 (月火水木金)");
    expect(quietHoursLabel({ start: "22:00", end: "07:00", tz: "Asia/Tokyo" })).toBe("22:00〜07:00");
  });
});
