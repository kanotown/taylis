import { describe, expect, it } from "vitest";

import { customPauseAt, DND_OPTIONS, dndActive, dndUntilAt, inQuietHours, localInputValue, pausedUntil, pauseValue, quietHoursLabel, quietHoursValue } from "../src/ui/dnd";

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

describe("「自分」's values (M40)", () => {
  const now = new Date(2026, 8, 30, 14, 0);
  it("「通知を一時停止」: オフ, 〜 HH:mm まで today, 〜 M/D HH:mm まで on another day", () => {
    expect(pauseValue(null, now)).toBe("オフ");
    expect(pauseValue(new Date(2026, 8, 30, 13, 0).toISOString(), now)).toBe("オフ"); // already over
    expect(pauseValue(new Date(2026, 8, 30, 15, 5).toISOString(), now)).toBe("〜 15:05 まで");
    expect(pauseValue(new Date(2026, 9, 1, 8, 0).toISOString(), now)).toBe("〜 10/1 08:00 まで");
    expect(pauseValue("garbage", now)).toBe("オフ");
    expect(pausedUntil({ dnd_until: new Date(2026, 8, 30, 15, 0).toISOString() }, now)).not.toBeNull();
    expect(pausedUntil({ dnd_until: new Date(2026, 8, 30, 13, 0).toISOString() }, now)).toBeNull();
    expect(pausedUntil(null, now)).toBeNull();
    expect(DND_OPTIONS.map(([, label]) => label)).toEqual(["30 分", "1 時間", "2 時間", "明日 8:00"]);
  });
  it("「おやすみ時間」: the window (with its days) or オフ", () => {
    expect(quietHoursValue(null)).toBe("オフ");
    expect(quietHoursValue({ start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4], tz: "Asia/Tokyo" })).toBe("22:00〜07:00 (月火水木金)");
  });
  it("「日時を指定」 takes a time ahead only; the picker starts from a local value", () => {
    expect(customPauseAt("", now)).toBeNull();
    expect(customPauseAt("2026-09-30T13:59", now)).toBeNull();
    expect(customPauseAt("2026-10-02T09:30", now)).toBe(new Date(2026, 9, 2, 9, 30).toISOString());
    expect(localInputValue(new Date(2026, 0, 5, 7, 3))).toBe("2026-01-05T07:03");
  });
});
