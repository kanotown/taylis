import { describe, expect, it } from "vitest";

import { parseEntryPath } from "../src/ui/routes";

describe("browser entry routes (M12j)", () => {
  const id = "01a0df3f-14b2-7d1a-8759-53c8a8d8a198";
  const token = "Zy9_-abcdefghijklmnopqrstuvwxyz0123456789ABC";

  it("recognises permalinks and invite links", () => {
    expect(parseEntryPath(`/m/${id.toUpperCase()}`)).toEqual({ kind: "message", id });
    expect(parseEntryPath(`/invite/${token}/`)).toEqual({ kind: "invite", token });
    expect(parseEntryPath(`/c/${id}`)).toEqual({ kind: "canvas", id }); // M44
    expect(parseEntryPath("/c/not-an-id")).toBeNull();
  });

  it("ignores the root and anything else", () => {
    expect(parseEntryPath("/")).toBeNull();
    expect(parseEntryPath("/m/not-an-id")).toBeNull();
    expect(parseEntryPath("/invite/short")).toBeNull();
    expect(parseEntryPath(`/files/${id}`)).toBeNull();
    expect(parseEntryPath(`/m/${id}/extra`)).toBeNull();
  });
});
