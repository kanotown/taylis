/**
 * M162 (docs/DRIVE.md §7.2, §10.2, §10.3, §11, §17.2): a selection's download (a file, else a ZIP), ⌘X / ⌘C then ⌘V,
 * what may be done with a version, and the administrators' quota field.
 */
import { describe, expect, it } from "vitest";

import type { DriveItemOut } from "../src/api/types";
import { afterPaste, downloadPlan, parseQuotaGb, pasteAction, quotaGbText, usageRatio, versionActions, versionSourceLabel } from "../src/drive/actions";

function item(id: string, kind: "file" | "folder", parent = "root"): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: parent, kind, name: id, size_bytes: kind === "file" ? 1 : null, content_type: null,
    content_modified_at: null, created_by: null, created_at: "2026-10-01T00:00:00Z", updated_by: null, updated_at: "2026-10-01T00:00:00Z",
    version_count: kind === "file" ? 1 : 0, file: null, link_count: 0, posted: false,
  };
}

describe("downloadPlan", () => {
  it("downloads one file as it is, a folder or several items as one ZIP", () => {
    expect(downloadPlan([])).toBeNull();
    expect(downloadPlan([item("a", "file")])).toEqual({ kind: "file", item: item("a", "file") });
    expect(downloadPlan([item("f", "folder")])).toEqual({ kind: "zip", ids: ["f"] });
    expect(downloadPlan([item("a", "file"), item("b", "file")])).toEqual({ kind: "zip", ids: ["a", "b"] });
  });
});

describe("pasteAction", () => {
  it("a cut moves once, leaving what is already there", () => {
    const cut = { mode: "cut" as const, items: [item("a", "file"), item("b", "file", "other")] };
    expect(pasteAction(cut, "root")).toEqual({ action: "move", items: [item("b", "file", "other")] });
    expect(pasteAction({ mode: "cut", items: [item("a", "file")] }, "root")).toBeNull();
    expect(afterPaste(cut)).toBeNull();
  });

  it("a copy copies into any folder, its own too, and stays for the next paste", () => {
    const copy = { mode: "copy" as const, items: [item("a", "file"), item("f", "folder")] };
    expect(pasteAction(copy, "root")).toEqual({ action: "copy", items: copy.items });
    // A folder never into itself.
    expect(pasteAction(copy, "f")).toEqual({ action: "copy", items: [item("a", "file")] });
    expect(afterPaste(copy)).toBe(copy);
    expect(pasteAction(null, "root")).toBeNull();
  });
});

describe("versions", () => {
  it("the current version only downloads; older ones restore for writers and go for managers", () => {
    expect(versionActions({ current: true }, { canWrite: true, canManage: true })).toEqual({ restore: false, remove: false });
    expect(versionActions({ current: false }, { canWrite: true, canManage: false })).toEqual({ restore: true, remove: false });
    expect(versionActions({ current: false }, { canWrite: false, canManage: false })).toEqual({ restore: false, remove: false });
    expect(versionActions({ current: false }, { canWrite: true, canManage: true })).toEqual({ restore: true, remove: true });
  });

  it("says how a version came to be", () => {
    expect(versionSourceLabel({ source: "restore" })).toBe("前のバージョンから戻した");
    expect(versionSourceLabel({ source: "upload" })).toBe("アップロード");
    expect(versionSourceLabel({ source: "something-new" })).toBe("something-new");
  });
});

describe("the quota field", () => {
  it("reads GB (decimals, full-width digits), empty for none, else invalid", () => {
    expect(parseQuotaGb("")).toBeNull();
    expect(parseQuotaGb(" 10 ")).toBe(10 * 1024 ** 3);
    expect(parseQuotaGb("1.5")).toBe(1.5 * 1024 ** 3);
    expect(parseQuotaGb("１５０")).toBe(150 * 1024 ** 3);
    expect(parseQuotaGb("1,000")).toBe(1000 * 1024 ** 3);
    expect(parseQuotaGb("-1")).toBeUndefined();
    expect(parseQuotaGb("ten")).toBeUndefined();
    expect(quotaGbText(null)).toBe("");
    expect(quotaGbText(150 * 1024 ** 3)).toBe("150");
    expect(quotaGbText(1.5 * 1024 ** 3)).toBe("1.5");
  });

  it("how full a location is", () => {
    expect(usageRatio(5, null)).toBeNull();
    expect(usageRatio(5, 10)).toBe(0.5);
    expect(usageRatio(15, 10)).toBe(1.5);
    expect(usageRatio(1, 0)).toBe(Infinity);
  });
});
