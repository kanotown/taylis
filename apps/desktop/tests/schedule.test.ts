import { describe, expect, it } from "vitest";

import { scheduleLabel, schedulePresets } from "../src/ui/schedule";

describe("scheduled send presets (M12d)", () => {
  it("offers only future choices and a next-Monday morning", () => {
    const friday = new Date(2026, 9, 2, 19, 30); // 2026-10-02 (Fri) 19:30 local
    const presets = schedulePresets(friday);
    expect(presets.map((p) => p.key)).toEqual(["1h", "tomorrow9", "monday9"]); // 18:00 already passed
    expect(presets[0]?.at.getTime()).toBe(new Date(2026, 9, 2, 20, 30).getTime());
    expect(presets[2]?.at.getTime()).toBe(new Date(2026, 9, 5, 9, 0).getTime());
    const mondayMorning = new Date(2026, 9, 5, 8, 0);
    expect(schedulePresets(mondayMorning).map((p) => p.key)).toEqual(["1h", "today18", "tomorrow9", "monday9"]);
    expect(schedulePresets(mondayMorning)[3]?.at.getDate()).toBe(12); // next Monday, not today
  });
  it("labels times relative to today", () => {
    const now = new Date(2026, 9, 2, 10, 0);
    expect(scheduleLabel(new Date(2026, 9, 2, 18, 0).toISOString(), now)).toBe("今日 18:00");
    expect(scheduleLabel(new Date(2026, 9, 3, 9, 5).toISOString(), now)).toBe("明日 9:05");
    expect(scheduleLabel(new Date(2026, 9, 5, 9, 0).toISOString(), now)).toBe("10月5日(月) 9:00");
    expect(scheduleLabel(new Date(2027, 0, 4, 9, 0).toISOString(), now)).toBe("2027年1月4日(月) 9:00");
  });
});
