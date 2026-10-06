/**
 * TeX math in bodies (DATA_MODEL.md 「本文の形式」): `$…$` inline and `$$…$$` display, prices and code left alone. The
 * cases every client and the server share (apps/shared/math.json).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MATH_MAX_LENGTH, parseBlocks, plainText, tokenize, tokenizeInline, type Block, type Token } from "../src/ui/markdown";

interface Vectors {
  inline: Array<{ name: string; line: string; tokens: string[][]; plain: string }>;
  blocks: Array<{ name: string; body: string; blocks: string[][] }>;
}

const vectors = JSON.parse(readFileSync(new URL("../../shared/math.json", import.meta.url), "utf8")) as Vectors;

function simple(tokens: Token[]): string[][] {
  return tokens.map((token) => {
    if (token.kind === "math") return token.display ? ["math", token.text, "display"] : ["math", token.text];
    if (token.kind === "link") return token.label ? ["link", token.url, token.label] : ["link", token.url];
    if ("text" in token) return [token.kind, token.text];
    return [token.kind];
  });
}

const blockKind = (block: Block): string[] => (block.kind === "math" ? ["math", block.tex] : [block.kind]);

describe("math (apps/shared/math.json)", () => {
  it.each(vectors.inline)("tokens: $name", ({ line, tokens }) => {
    expect(simple(tokenizeInline(line))).toEqual(tokens);
    expect(simple(tokenize(line))).toEqual(tokens);
  });

  it.each(vectors.inline)("plain: $name", ({ line, plain }) => {
    expect(plainText(line)).toBe(plain);
  });

  it.each(vectors.blocks)("blocks: $name", ({ body, blocks }) => {
    expect(parseBlocks(body).map(blockKind)).toEqual(blocks);
    // The canvas reads display math the same way.
    expect(parseBlocks(body, { canvas: true }).map(blockKind)).toEqual(blocks);
  });

  it("has the cases", () => {
    expect(vectors.inline.length).toBeGreaterThan(20);
    expect(vectors.blocks.length).toBeGreaterThan(10);
  });

  it("a formula over the limit stays text", () => {
    const long = "x".repeat(MATH_MAX_LENGTH + 1);
    expect(simple(tokenizeInline("$" + long + "$"))).toEqual([["text", "$" + long + "$"]]);
    expect(parseBlocks("$$" + long + "$$").map(blockKind)).toEqual([["paragraph"]]);
    expect(simple(tokenizeInline("$" + "x".repeat(MATH_MAX_LENGTH) + "$"))[0]?.[0]).toBe("math");
  });
});
