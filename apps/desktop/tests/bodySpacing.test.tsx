// @vitest-environment jsdom
/**
 * 2026-10-04: blank lines around a heading (or any block) give the same visible gap on both sides, in the timeline
 * and in the composer's preview (both MessageBody). Before, the blank line before a heading drew nothing.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

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

it("without blank lines nothing is added; blank lines inside a paragraph stay lines", () => {
  const { container } = render(<MessageBody body={"one\n# H\ntwo\n\nthree"} users={users} />);
  const [first, , second] = [...container.firstElementChild!.children] as HTMLElement[];
  expect(first!.className).not.toMatch(/m[bt]-2\.5/);
  expect(second!.className).not.toMatch(/m[bt]-2\.5/);
  expect(second!.querySelectorAll("br")).toHaveLength(2); // two, (blank), three
});

it("a blank line between two blocks is one gap", () => {
  const { container } = render(<MessageBody body={"# A\n\n- item"} users={users} />);
  const children = [...container.firstElementChild!.children] as HTMLElement[];
  expect(children.map((el) => el.tagName)).toEqual(["DIV", "DIV", "UL"]);
  expect(children[1]!.getAttribute("aria-hidden")).toBe("true");
});
