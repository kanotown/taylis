// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { hostLabel, isServerInfo, loadWorkspaces, normalizeServerUrl, sameServer, saveWorkspaces, workspaceColor, workspaceInitials, type WorkspaceEntry } from "../src/state/workspaces";

beforeEach(() => localStorage.clear());

const entry = (serverUrl: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({ serverUrl, workspaceId: null, name: hostLabel(serverUrl), username: "alice", userId: null, ...extra });

describe("server addresses", () => {
  it("normalizes what people type", () => {
    expect(normalizeServerUrl("chat.example.com")).toBe("https://chat.example.com");
    expect(normalizeServerUrl(" HTTPS://Chat.Example.com/ ")).toBe("https://chat.example.com");
    expect(normalizeServerUrl("http://127.0.0.1:8000//")).toBe("http://127.0.0.1:8000");
    expect(normalizeServerUrl("https://example.com:443/chat/")).toBe("https://example.com/chat");
    expect(normalizeServerUrl("ftp://example.com")).toBeNull();
    expect(normalizeServerUrl("https://user:pw@example.com")).toBeNull();
    expect(normalizeServerUrl("   ")).toBeNull();
    expect(sameServer("https://Chat.example.com/", "chat.example.com")).toBe(true);
    expect(sameServer("http://chat.example.com", "https://chat.example.com")).toBe(false);
  });

  it("tells a ChikuwaChat server from anything else", () => {
    expect(isServerInfo({ product: "chikuwachat", workspace_id: "w1", name: "開発", api_version: "0.1.0" })).toBe(true);
    expect(isServerInfo({ product: "other", workspace_id: "w1", name: "x" })).toBe(false);
    expect(isServerInfo("<html>")).toBe(false);
    expect(isServerInfo(null)).toBe(false);
  });

  it("draws tiles from the name", () => {
    expect(workspaceInitials("テストチーム")).toBe("テ");
    expect(workspaceInitials("ChikuwaChat")).toBe("C");
    expect(workspaceInitials("dev team")).toBe("DT");
    expect(workspaceInitials("")).toBe("?");
    expect(workspaceColor("a")).toBe(workspaceColor("a"));
  });
});

describe("the saved list", () => {
  it("migrates the single server of an older install once, keeping its exact spelling", () => {
    localStorage.setItem("chikuwa.server", "http://127.0.0.1:8000");
    localStorage.setItem("chikuwa.username", "bob");
    const first = loadWorkspaces();
    expect(first.entries).toEqual([{ serverUrl: "http://127.0.0.1:8000", workspaceId: null, name: "127.0.0.1:8000", username: "bob", userId: null }]);
    expect(first.active).toBe("http://127.0.0.1:8000");
    // Saved now: a later load reads the list, not the old keys.
    localStorage.setItem("chikuwa.username", "someone-else");
    expect(loadWorkspaces().entries[0]!.username).toBe("bob");
  });

  it("round-trips entries and the active one, and keeps the old keys on the active workspace", () => {
    const list = [entry("https://a.example.com", { workspaceId: "w1", name: "A" }), entry("https://b.example.com", { username: "carol" })];
    saveWorkspaces(list, "https://b.example.com");
    expect(loadWorkspaces()).toEqual({ entries: list, active: "https://b.example.com" });
    expect(localStorage.getItem("chikuwa.server")).toBe("https://b.example.com");
    expect(localStorage.getItem("chikuwa.username")).toBe("carol");
    saveWorkspaces([], null);
    expect(loadWorkspaces()).toEqual({ entries: [], active: null });
    expect(localStorage.getItem("chikuwa.server")).toBeNull();
  });

  it("survives damage: a bad list, bad rows, an active key that is gone", () => {
    localStorage.setItem("chikuwa.workspaces", "{oops");
    expect(loadWorkspaces().entries).toEqual([]);
    localStorage.setItem("chikuwa.workspaces", JSON.stringify([{ serverUrl: "https://a.example.com", username: "a", name: "A" }, { nope: true }, 3]));
    localStorage.setItem("chikuwa.workspace.active", JSON.stringify("https://gone.example.com"));
    const loaded = loadWorkspaces();
    expect(loaded.entries.map((e) => e.serverUrl)).toEqual(["https://a.example.com"]);
    expect(loaded.entries[0]!.workspaceId).toBeNull();
    expect(loaded.active).toBe("https://a.example.com");
  });
});
