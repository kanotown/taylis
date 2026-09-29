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

  it("reads names in any script (M30: /日程 and templates such as /日報)", () => {
    expect(parseSlashCommand("/日程 ゼミ 10/3 10/4")).toEqual({ name: "日程", args: "ゼミ 10/3 10/4", known: true });
    expect(parseSlashCommand("/日報")).toEqual({ name: "日報", args: "", known: false });
    expect(parseSlashCommand("/日報　今日は短め")).toEqual({ name: "日報", args: "今日は短め", known: false }); // a full-width space
    expect(parseSlashCommand("/Weekly-1_a text")).toEqual({ name: "weekly-1_a", args: "text", known: false });
    expect(parseSlashCommand("/日報/2")).toBeNull();
    expect(commandCandidates("/日").map((c) => c.name)).toEqual(["日程"]);
    expect(commandCandidates("/日報 ")).toEqual([]);
  });

  it("suggests commands while the name is being typed", () => {
    expect(commandCandidates("/").length).toBe(14);
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
