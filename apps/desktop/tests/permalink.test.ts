import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseEntryPath } from "../src/ui/routes";
import { messagePermalink, parseCanvasLink, parseDriveLink, parseEquipmentLink, parseEventLink, parsePageLink, parsePermalink } from "../src/ui/permalink";

describe("message permalinks (M12b)", () => {
  const id = "01a0df3f-14b2-7d1a-8759-53c8a8d8a198";
  it("builds <server>/m/<id> without doubling slashes", () => {
    expect(messagePermalink("https://chat.example.com/", id)).toBe(`https://chat.example.com/m/${id}`);
    expect(messagePermalink("http://127.0.0.1:8000", id)).toBe(`http://127.0.0.1:8000/m/${id}`);
  });
  it("recognises only our own server and a well-formed id", () => {
    expect(parsePermalink("https://chat.example.com", `https://chat.example.com/m/${id}`)).toBe(id);
    expect(parsePermalink("https://chat.example.com/", `HTTPS://CHAT.EXAMPLE.COM/m/${id.toUpperCase()}?x=1#y`)).toBe(id);
    expect(parsePermalink("https://chat.example.com", `https://chat.example.com/m/${id}/extra`)).toBe(id);
    expect(parsePermalink("https://chat.example.com", "https://chat.example.com/m/not-an-id")).toBeNull();
    expect(parsePermalink("https://chat.example.com", `https://other.example.com/m/${id}`)).toBeNull();
    expect(parsePermalink("https://chat.example.com", `https://chat.example.com/files/${id}`)).toBeNull();
  });
});

interface LinkCases {
  cases: Array<{ name: string; base: string; url: string; kind: "m" | "c" | "p" | "e" | "d" | "eq"; id: string | null }>;
}

const linkCases = JSON.parse(readFileSync(new URL("../../shared/message-links.json", import.meta.url), "utf8")) as LinkCases;
const parsers = { m: parsePermalink, c: parseCanvasLink, p: parsePageLink, e: parseEventLink, d: parseDriveLink, eq: parseEquipmentLink };

describe("links to the server's things (apps/shared/message-links.json)", () => {
  it("has the cases", () => {
    expect(linkCases.cases.length).toBeGreaterThan(20);
  });
  it.each(linkCases.cases)("$name", ({ base, url, kind, id }) => {
    expect(parsers[kind](base, url)).toBe(id);
  });
});

describe("the browser opened at a link (M12j)", () => {
  const id = "0190a8c2-7d3e-7b1a-9c4e-1f2a3b4c5d6e";
  it("takes the message of a link whose closing mark another app kept in it (2026-11-05)", () => {
    expect(parseEntryPath(`/m/${id}`)).toEqual({ kind: "message", id });
    expect(parseEntryPath(`/m/${id.toUpperCase()}/`)).toEqual({ kind: "message", id });
    // 「…/m/<id>）」 and 「…/m/<id>。」 linked by a chat or mail app that kept the mark: the browser asks for it encoded.
    expect(parseEntryPath(`/m/${id}%EF%BC%89`)).toEqual({ kind: "message", id });
    expect(parseEntryPath(`/m/${id}%E3%80%82`)).toEqual({ kind: "message", id });
    expect(parseEntryPath(`/m/${id}.`)).toEqual({ kind: "message", id });
    expect(parseEntryPath(`/c/${id})`)).toEqual({ kind: "canvas", id });
    // Not an id: letters or digits run on.
    expect(parseEntryPath(`/m/${id}a`)).toBeNull();
    expect(parseEntryPath(`/m/${id}0`)).toBeNull();
    expect(parseEntryPath(`/m/${id.slice(0, -1)}`)).toBeNull();
    expect(parseEntryPath(`/m/${id}/extra`)).toBeNull();
  });
});
