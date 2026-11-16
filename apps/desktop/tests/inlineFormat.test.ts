/**
 * M107: inline markup (DATA_MODEL.md 「本文の形式」): `_` emphasis never inside a word, URLs and e-mail addresses never
 * read for emphasis, backslash escapes. The cases every client and the server share (apps/shared/inline-format.json).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { type EmphasisPiece, emphasisPieces, plainText, tokenize, tokenizeInline, type Token } from "../src/ui/markdown";

interface Vectors {
  cases: Array<{ name: string; line: string; tokens: string[][]; plain: string }>;
  emphasis_mentions: Array<{ name: string; text: string; pieces: string[][] }>;
}

const vectors = JSON.parse(readFileSync(new URL("../../shared/inline-format.json", import.meta.url), "utf8")) as Vectors;

function simple(tokens: Token[]): string[][] {
  return tokens.map((token) => {
    if (token.kind === "link") return token.label ? ["link", token.url, token.label] : ["link", token.url];
    if ("text" in token) return [token.kind, token.text];
    return [token.kind];
  });
}

describe("inline format (apps/shared/inline-format.json)", () => {
  it.each(vectors.cases)("tokens: $name", ({ line, tokens }) => {
    expect(simple(tokenizeInline(line))).toEqual(tokens);
    // The whole-body tokenizer (search highlighting) reads a line the same way.
    expect(simple(tokenize(line))).toEqual(tokens);
  });

  it.each(vectors.cases)("plain: $name", ({ line, plain }) => {
    expect(plainText(line)).toBe(plain);
  });

  it("has the cases", () => {
    expect(vectors.cases.length).toBeGreaterThan(20);
  });

  it("an intraword underscore on one line does not stop italics on the next", () => {
    expect(simple(tokenize("my_var_ x\n_it_"))).toEqual([["text", "my_var_ x"], ["newline"], ["italic", "it"]]);
  });
});

/**
 * 2026-11-16 (a hostile-server review): a body of many emphasis openers is read in linear time. `_a ` repeated took
 * seconds on every client before; the shared `timing` list holds each tokenizer to `max_ms`.
 */
describe("linear time (apps/shared/inline-format.json timing)", () => {
  const timing = (JSON.parse(readFileSync(new URL("../../shared/inline-format.json", import.meta.url), "utf8")) as { timing: Timing[] }).timing;
  // Snake_case and dunder chains: an underscore after a word character never opens emphasis, so none of them may make
  // the scan go back over the rest of the line (the opener's check runs after the match here, not in a lookbehind).
  const local: Timing[] = [
    { name: "a snake_case chain", unit: "a_", repeat: 10000, max_ms: 250 },
    { name: "dunder chains", unit: "a__", repeat: 7000, max_ms: 250 },
    { name: "a chain that ends in an emphasis", unit: "ab_", repeat: 6000, max_ms: 250 },
  ];
  const readers: Array<[string, (body: string) => unknown]> = [
    ["tokenizeInline", (body) => tokenizeInline(body)],
    ["tokenizeInline (canvas)", (body) => tokenizeInline(body, true)],
    ["tokenize", (body) => tokenize(body)],
    ["plainText", (body) => plainText(body)],
  ];

  it("has the shared cases", () => {
    expect(timing.length).toBeGreaterThanOrEqual(3);
  });

  it.each([...timing, ...local])("$name ($repeat × $unit) within $max_ms ms", ({ unit, repeat, max_ms }) => {
    const body = unit.repeat(repeat);
    for (const [name, read] of readers) {
      read(body.slice(0, 200)); // compiled and warm
      const started = performance.now();
      read(body);
      const ms = performance.now() - started;
      expect(ms, `${name}: ${ms.toFixed(0)} ms`).toBeLessThan(max_ms);
    }
  });
});

interface Timing {
  name: string;
  unit: string;
  repeat: number;
  max_ms: number;
}

/**
 * The tokenizer avoids lookbehinds (older WebKit); the server's rule is written with them. Over random lines of
 * letters, digits, CJK, underscores, spaces and punctuation (no other markup), both read the same italics and text.
 */
describe("the italic rule matches the server's (mentions.py)", () => {
  const SERVER_ITALIC = /(?<![\p{L}\p{N}_])_(?![\s　_])((?:[^\n\\_]|(?<=[\p{L}\p{N}])_)*?[^\s　_\\])_(?![\p{L}\p{N}_])/gu;
  function serverTokens(line: string): string[][] {
    const out: string[][] = [];
    const text = (value: string) => {
      if (!value) return;
      const last = out[out.length - 1];
      if (last?.[0] === "text") last[1] += value;
      else out.push(["text", value]);
    };
    let at = 0;
    for (const match of line.matchAll(SERVER_ITALIC)) {
      text(line.slice(at, match.index));
      out.push(["italic", match[1]!]);
      at = match.index + match[0].length;
    }
    text(line.slice(at));
    return out;
  }

  it("on 5,000 random lines", () => {
    const alphabet = ["a", "b", "1", "日", "_", "_", " ", ",", ".", "　"];
    let seed = 20261116;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 5000; i++) {
      const line = Array.from({ length: Math.floor(next() * 14) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      expect(simple(tokenizeInline(line)), JSON.stringify(line)).toEqual(serverTokens(line));
    }
  });
});

/** M188: an emphasis piece as the shared file writes it. */
function piece(p: EmphasisPiece): string[] {
  switch (p.kind) {
    case "text":
      return ["text", p.text];
    case "mention":
      return ["mention", p.userId];
    case "mention_group":
      return ["mention_group", p.groupId];
    case "mention_all":
      return ["mention_all", p.target];
  }
}

describe("mentions in emphasis (apps/shared/inline-format.json emphasis_mentions, M188)", () => {
  it.each(vectors.emphasis_mentions)("pieces: $name", ({ text, pieces }) => {
    expect(emphasisPieces(text).map(piece)).toEqual(pieces);
  });

  it.each(vectors.emphasis_mentions)("bold, italic and strike hold the text whole: $name", ({ text }) => {
    expect(simple(tokenizeInline(`**${text}**`))).toEqual([["bold", text]]);
    expect(simple(tokenizeInline(`~~${text}~~`))).toEqual([["strike", text]]);
  });

  it("has the cases", () => {
    expect(vectors.emphasis_mentions.length).toBeGreaterThan(4);
  });
});
