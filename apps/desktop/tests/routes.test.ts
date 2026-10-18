import { describe, expect, it } from "vitest";

import { attachmentRefId, eventLink, pageLink, pageRefId, parseEventLink, parsePageLink } from "../src/ui/permalink";
import { parseEntryPath } from "../src/ui/routes";

describe("browser entry routes (M12j)", () => {
  const id = "01a0df3f-14b2-7d1a-8759-53c8a8d8a198";
  const token = "Zy9_-abcdefghijklmnopqrstuvwxyz0123456789ABC";

  it("recognises permalinks and invite links", () => {
    expect(parseEntryPath(`/m/${id.toUpperCase()}`)).toEqual({ kind: "message", id });
    expect(parseEntryPath(`/invite/${token}/`)).toEqual({ kind: "invite", token });
    expect(parseEntryPath(`/c/${id}`)).toEqual({ kind: "canvas", id }); // M44
    expect(parseEntryPath("/c/not-an-id")).toBeNull();
    expect(parseEntryPath(`/p/${id.toUpperCase()}`)).toEqual({ kind: "page", id }); // M121
    expect(parseEntryPath("/p/not-an-id")).toBeNull();
    expect(parseEntryPath(`/e/${id.toUpperCase()}`)).toEqual({ kind: "event", id }); // CALENDAR.md §11
    expect(parseEntryPath("/e/not-an-id")).toBeNull();
  });

  it("CALENDAR.md §11: event links `<server>/e/<id>` on this server only", () => {
    expect(parseEventLink("https://chat.example.com/", `https://CHAT.example.com/e/${id.toUpperCase()}#x`)).toBe(id);
    expect(parseEventLink("https://chat.example.com", `https://other.example.com/e/${id}`)).toBeNull();
    expect(parseEventLink("https://chat.example.com", `https://chat.example.com/e/nope`)).toBeNull();
    expect(parseEventLink("https://chat.example.com", `https://chat.example.com/m/${id}`)).toBeNull();
    expect(eventLink("https://chat.example.com/", id)).toBe(`https://chat.example.com/e/${id}`);
  });

  it("M121: Docs links — `<server>/p/<id>`, `page:<id>` and a page's file `attachment:<id>`", () => {
    expect(parsePageLink("https://chat.example.com", `https://chat.example.com/p/${id}?x=1`)).toBe(id);
    expect(parsePageLink("https://chat.example.com", `https://other.example.com/p/${id}`)).toBeNull();
    expect(pageRefId(`page:${id.toUpperCase()}`)).toBe(id);
    expect(pageRefId("page:nope")).toBeNull();
    expect(attachmentRefId(`attachment:${id}`)).toBe(id);
    expect(pageLink("https://chat.example.com/", id)).toBe(`https://chat.example.com/p/${id}`);
  });

  it("ignores the root and anything else", () => {
    expect(parseEntryPath("/")).toBeNull();
    expect(parseEntryPath("/m/not-an-id")).toBeNull();
    expect(parseEntryPath("/invite/short")).toBeNull();
    expect(parseEntryPath(`/files/${id}`)).toBeNull();
    expect(parseEntryPath(`/m/${id}/extra`)).toBeNull();
  });
});
