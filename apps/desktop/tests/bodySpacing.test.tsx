// @vitest-environment jsdom
/**
 * 2026-10-04: blank lines around a heading (or any block) give the same visible gap on both sides, in the timeline
 * and in the composer's preview (both MessageBody). Before, the blank line before a heading drew nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { paragraphLayout, parseBlocks, type Token } from "../src/ui/markdown";
import { MessageBody } from "../src/ui/MessageBody";

afterEach(cleanup);
const users = new Map();

it("text, blank, heading, blank, text: a gap on both sides of the heading, no empty <br> lines", () => {
  const { container } = render(<MessageBody body={"text\n\n# Heading\n\ntext"} users={users} />);
  const [before, heading, after] = [...container.firstElementChild!.children] as HTMLElement[];
  expect(before!.tagName).toBe("P");
  expect(before!.className).toContain("mb-2.5");
  expect(before!.querySelector("br")).toBeNull();
  expect(heading!.textContent).toBe("Heading");
  expect(after!.className).toContain("mt-2.5");
  expect(after!.querySelector("br")).toBeNull();
});

it("without blank lines nothing is added; a blank line inside a paragraph is the same gap, not an empty line", () => {
  const { container } = render(<MessageBody body={"one\n# H\ntwo\n\nthree"} users={users} />);
  const [first, , second, third] = [...container.firstElementChild!.children] as HTMLElement[];
  expect(first!.className).not.toMatch(/m[bt]-2\.5/);
  expect(second!.className).not.toMatch(/m[bt]-2\.5/);
  expect(second!.querySelector("br")).toBeNull();
  expect(third!.tagName).toBe("P");
  expect(third!.className).toContain("mt-2.5");
  expect(third!.textContent).toBe("three");
});

it("2026-10-05: 「あ\\n\\nあ」 is two paragraphs with a gap; several blank lines one gap; one newline a <br>", () => {
  const twice = render(<MessageBody body={"あ\n\n\n\nあ\nい"} users={users} />).container;
  const paragraphs = [...twice.firstElementChild!.children] as HTMLElement[];
  expect(paragraphs.map((p) => p.tagName)).toEqual(["P", "P"]);
  expect(paragraphs[0]!.querySelector("br")).toBeNull();
  expect(paragraphs[1]!.className).toContain("mt-2.5");
  expect(paragraphs[1]!.querySelectorAll("br")).toHaveLength(1);
});

it("a blank line between two blocks is one gap", () => {
  const { container } = render(<MessageBody body={"# A\n\n- item"} users={users} />);
  const children = [...container.firstElementChild!.children] as HTMLElement[];
  expect(children.map((el) => el.tagName)).toEqual(["DIV", "DIV", "UL"]);
  expect(children[1]!.getAttribute("aria-hidden")).toBe("true");
});

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "body-paragraphs.json"), "utf8")) as {
  cases: Array<{ name: string; body: string; paragraphs: unknown[] }>;
};
const text = (tokens: Token[]): string => tokens.map((t) => ("text" in t ? t.text : t.kind === "link" ? t.label ?? t.url : "")).join("");

describe("paragraph gaps (apps/shared/body-paragraphs.json)", () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const paragraphs = parseBlocks(c.body).flatMap((block) => (block.kind === "paragraph" ? [paragraphLayout(block.lines)] : []));
    expect(paragraphs.map((p) => ({ gap_before: p.gapBefore, gap_after: p.gapAfter, groups: p.groups.map((g) => g.map(text)) }))).toEqual(c.paragraphs);
  });
});
