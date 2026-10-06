// @vitest-environment jsdom
/** Per-workspace 「テーマの色」 and 「サイドバー」 (2026-10-06): each workspace's own choice, the shared one as the fallback. */
import { afterEach, describe, expect, it } from "vitest";

import { AppController } from "../src/state/app";
import { savedActiveWorkspace, saveWorkspaces, type WorkspaceEntry } from "../src/state/workspaces";
import {
  applyThemeToAllWorkspaces,
  currentThemeWorkspace,
  readPalette,
  readSidebarTone,
  setThemeWorkspace,
  WORKSPACE_THEME_KEY,
  workspaceThemesDiffer,
  writePalette,
  writeSidebarTone,
} from "../src/ui/theme";

const A = "https://a.example.com";
const B = "https://b.example.com";
const C = "https://c.example.com";
const root = document.documentElement;
let flip = 0;

afterEach(() => {
  localStorage.clear();
  // Leave no workspace on screen for the next test (a fresh key, then the attributes cleared).
  setThemeWorkspace(`https://reset-${(flip += 1)}.example.com`);
  delete root.dataset["palette"];
  delete root.dataset["sidebar"];
});

describe("resolution", () => {
  it("a workspace without a choice of its own shows the one for every workspace", () => {
    writePalette("green"); // "all": the shared choice
    expect(readPalette(A)).toBe("green");
    expect(readPalette(B)).toBe("green");
    expect(readSidebarTone(A)).toBe("dark");
    expect(localStorage.getItem(WORKSPACE_THEME_KEY)).toBeNull();
  });

  it("a choice for the workspace on screen leaves the others on the shared one", () => {
    writePalette("green");
    setThemeWorkspace(A);
    writePalette("rose", "workspace");
    writeSidebarTone("light", "workspace");
    expect(root.dataset["palette"]).toBe("rose");
    expect(root.dataset["sidebar"]).toBe("light");
    expect(readPalette(A)).toBe("rose");
    expect(readSidebarTone(A)).toBe("light");
    expect(readPalette(B)).toBe("green");
    expect(readSidebarTone(B)).toBe("dark");
    expect(JSON.parse(localStorage.getItem(WORKSPACE_THEME_KEY)!)).toEqual({ [A]: { palette: "rose", sidebar: "light" } });
    expect(workspaceThemesDiffer()).toBe(true);
  });

  it("a choice for every workspace drops each workspace's own value of that setting only", () => {
    setThemeWorkspace(A);
    writePalette("rose", "workspace");
    writeSidebarTone("light", "workspace");
    setThemeWorkspace(B);
    writePalette("purple", "workspace");
    writePalette("indigo"); // "all"
    expect(readPalette(A)).toBe("indigo");
    expect(readPalette(B)).toBe("indigo");
    expect(readSidebarTone(A)).toBe("light"); // the sidebar stays A's own
    expect(JSON.parse(localStorage.getItem(WORKSPACE_THEME_KEY)!)).toEqual({ [A]: { sidebar: "light" } });
  });

  it("「すべてのワークスペースに使う」: the colours on screen become everyone's, and nothing is left to differ", () => {
    setThemeWorkspace(A);
    writePalette("rose", "workspace");
    writeSidebarTone("light", "workspace");
    setThemeWorkspace(B);
    writePalette("green", "workspace");
    setThemeWorkspace(A);
    applyThemeToAllWorkspaces();
    expect(readPalette(B)).toBe("rose");
    expect(readSidebarTone(B)).toBe("light");
    expect(readPalette(C)).toBe("rose");
    expect(localStorage.getItem(WORKSPACE_THEME_KEY)).toBeNull();
    expect(localStorage.getItem("chikuwa.prefs.palette")).toBe("rose");
    expect(workspaceThemesDiffer()).toBe(false);
  });

  it("an own value equal to the shared one does not count as different", () => {
    writePalette("green");
    setThemeWorkspace(A);
    writePalette("green", "workspace");
    expect(workspaceThemesDiffer()).toBe(false);
  });

  it("unreadable or odd stored values fall back to the shared choice", () => {
    writePalette("gray");
    localStorage.setItem(WORKSPACE_THEME_KEY, "{not json");
    expect(readPalette(A)).toBe("gray");
    localStorage.setItem(WORKSPACE_THEME_KEY, JSON.stringify({ [A]: { palette: "neon", sidebar: "beige" } }));
    expect(readPalette(A)).toBe("gray");
    expect(readSidebarTone(A)).toBe("dark");
    localStorage.setItem(WORKSPACE_THEME_KEY, "[]");
    expect(readPalette(A)).toBe("gray");
  });
});

describe("switching", () => {
  it("puts the workspace's colours on screen at once; null (adding a workspace) keeps them", () => {
    localStorage.setItem(WORKSPACE_THEME_KEY, JSON.stringify({ [A]: { palette: "rose", sidebar: "light" }, [B]: { palette: "green" } }));
    setThemeWorkspace(A);
    expect(currentThemeWorkspace()).toBe(A);
    expect([root.dataset["palette"], root.dataset["sidebar"]]).toEqual(["rose", "light"]);
    setThemeWorkspace(B);
    expect([root.dataset["palette"], root.dataset["sidebar"]]).toEqual(["green", undefined]);
    setThemeWorkspace(C); // none of its own: the shared default
    expect([root.dataset["palette"], root.dataset["sidebar"]]).toEqual([undefined, undefined]);
    setThemeWorkspace(null);
    expect(currentThemeWorkspace()).toBe(C);
  });

  it("the controller's switch changes the colours in the same task (no frame in the old ones)", () => {
    const entry = (serverUrl: string): WorkspaceEntry => ({ serverUrl, workspaceId: null, name: serverUrl, username: "alice", userId: null });
    localStorage.setItem(WORKSPACE_THEME_KEY, JSON.stringify({ [A]: { palette: "rose" }, [B]: { palette: "green", sidebar: "light" } }));
    const controller = new AppController();
    controller.workspaces = [entry(A), entry(B)];
    controller.activeServer = A;
    setThemeWorkspace(A);
    expect(root.dataset["palette"]).toBe("rose");
    void controller.switchWorkspace(B).catch(() => {}); // signing in behind it is not this test's concern
    expect(root.dataset["palette"]).toBe("green");
    expect(root.dataset["sidebar"]).toBe("light");
    controller.beginAddWorkspace(); // the login form for a new server: the colours stay
    expect(root.dataset["palette"]).toBe("green");
  });
});

describe("first paint", () => {
  it("main.tsx reads the last active workspace as saved, without the list", () => {
    expect(savedActiveWorkspace()).toBeNull();
    saveWorkspaces([{ serverUrl: B, workspaceId: null, name: "Beta", username: "alice", userId: null }], B);
    expect(savedActiveWorkspace()).toBe(B);
    localStorage.setItem(WORKSPACE_THEME_KEY, JSON.stringify({ [B]: { palette: "purple" } }));
    setThemeWorkspace(savedActiveWorkspace());
    expect(root.dataset["palette"]).toBe("purple");
    localStorage.setItem("chikuwa.workspace.active", "{broken");
    expect(savedActiveWorkspace()).toBeNull();
  });
});
