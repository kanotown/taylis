import { describe, expect, it } from "vitest";

import { commandCandidates, parseDuration, parseSlashCommand, splitStatus, tomorrowMorning } from "../src/ui/commands";

describe("slash commands (M13b)", () => {
  it("parses a command and its arguments", () => {
    expect(parseSlashCommand("/status 🏖 休暇中")).toEqual({ name: "status", args: "🏖 休暇中", known: true });
    expect(parseSlashCommand("  /LEAVE ")).toEqual({ name: "leave", args: "", known: true });
    expect(parseSlashCommand("/foo bar")).toEqual({ name: "foo", args: "bar", known: false });
    expect(parseSlashCommand("hello /me")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("/path/to/file")).toBeNull();
  });

  it("suggests commands while the name is being typed", () => {
    expect(commandCandidates("/").length).toBe(13);
    expect(commandCandidates("/s").map((c) => c.name)).toEqual(["status", "shrug"]);
    expect(commandCandidates("/status ")).toEqual([]);
    expect(commandCandidates("text /s")).toEqual([]);
  });

  it("reads durations and status emoji", () => {
    const now = new Date("2026-09-27T10:00:00");
    expect(parseDuration("30m", now)?.toISOString()).toBe(new Date("2026-09-27T10:30:00").toISOString());
    expect(parseDuration("2h", now)?.getTime()).toBe(now.getTime() + 2 * 3_600_000);
    expect(parseDuration("tomorrow", now)?.getTime()).toBe(tomorrowMorning(now).getTime());
    expect(tomorrowMorning(now).getHours()).toBe(8);
    expect(parseDuration("soon", now)).toBeNull();
    expect(splitStatus("🏖 休暇中")).toEqual({ emoji: "🏖", text: "休暇中" });
    expect(splitStatus(":coffee: 休憩")).toEqual({ emoji: "☕", text: "休憩" });
    expect(splitStatus("会議中")).toEqual({ emoji: null, text: "会議中" });
    expect(splitStatus("👩‍💻")).toEqual({ emoji: "👩‍💻", text: "" });
  });
});
