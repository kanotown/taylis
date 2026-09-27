import { describe, expect, it } from "vitest";

import { shareBody } from "../src/ui/share";

describe("sharing a message (M13c)", () => {
  const link = "https://chat.example.com/m/01a0df3f-14b2-7d1a-8759-53c8a8d8a198";

  it("quotes the original under the comment and ends with the permalink", () => {
    expect(shareBody("first line\nsecond", link, "見てください")).toBe(`見てください\n> first line\n> second\n${link}`);
    expect(shareBody("plain", link, "")).toBe(`> plain\n${link}`);
  });

  it("clips long bodies and stands in for attachment-only messages", () => {
    const long = "あ".repeat(400);
    expect(shareBody(long, link, "")).toBe(`> ${"あ".repeat(300)}…\n${link}`);
    expect(shareBody("   ", link, "資料です")).toBe(`資料です\n> (添付ファイル)\n${link}`);
  });
});
