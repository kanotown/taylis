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
