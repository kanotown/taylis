/**
 * M57 (CANVAS.md §17): the table editor's text rules, from the cases the three clients share
 * (apps/shared/canvas_table.json), plus the desktop's write-back and where a new table goes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  anchorLine, applyTableOp, findTable, insertTable, lineOf, lineStart, parseTable, serializeTable, type Table, type TableOp,
  writeBackTable,
} from "../src/ui/canvasTable";

interface Fixture {
  parse: Array<{ lines: string[]; table: Table }>;
  serialize: Array<{ table: Table; lines: string[] }>;
  round_trip: Array<{ lines: string[]; lines_out: string[] }>;
  find: { text: string; cases: Array<{ caret_line: number; range: [number, number] | null }> };
  /** `text` the input and `text_out` the output. */
  insert: Array<{ text: string; caret_line: number; text_out: string; range: [number, number] }>;
  ops: { base: Table; cases: Array<{ op: string; args: unknown[]; base?: Table; table: Table }> };
}

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "canvas_table.json"), "utf8")) as Fixture;

const insertCase = (c: Fixture["insert"][number]) => ({ input: c.text, output: c.text_out });

describe("the table rules (apps/shared/canvas_table.json)", () => {
  it.each(fixture.parse.map((c, i) => [i, c] as const))("parse %i", (_i, c) => {
    expect(parseTable(c.lines)).toEqual(c.table);
  });

  it.each(fixture.serialize.map((c, i) => [i, c] as const))("serialize %i", (_i, c) => {
    expect(serializeTable(c.table)).toEqual(c.lines);
  });

  it.each(fixture.round_trip.map((c, i) => [i, c] as const))("round trip %i", (_i, c) => {
    expect(serializeTable(parseTable(c.lines))).toEqual(c.lines_out);
  });

  it.each(fixture.find.cases.map((c) => [c.caret_line, c] as const))("find at line %i", (_line, c) => {
    expect(findTable(fixture.find.text, c.caret_line)).toEqual(c.range);
  });

  it.each(fixture.insert.map((c, i) => [i, c] as const))("insert %i", (_i, c) => {
    const { input, output } = insertCase(c);
    const out = insertTable(input, c.caret_line);
    expect(out).toEqual({ text: output, range: c.range });
    expect(findTable(out.text, out.range[0])).toEqual(c.range);
  });

  it.each(fixture.ops.cases.map((c, i) => [`${i} ${c.op}(${c.args.join(", ")})`, c] as const))("op %s", (_name, c) => {
    const base = c.base ?? fixture.ops.base;
    const before = JSON.stringify(base);
    expect(applyTableOp(base, [c.op, ...c.args] as TableOp)).toEqual(c.table);
    expect(JSON.stringify(base)).toBe(before); // the given table is left as it is
  });
});

describe("writing an edited table back (desktop)", () => {
  const text = "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n本文";
  const origin = { range: [2, 4] as [number, number], lines: text.split("\n").slice(2, 5) };
  const edited: Table = { align: [null, "right"], header: ["名前", "締切"], rows: [["予稿", "10/3"], ["旅費", "10/10"]] };
  const block = "| 名前 | 締切 |\n| --- | ---: |\n| 予稿 | 10/3 |\n| 旅費 | 10/10 |";

  it("replaces the table's lines where it was", () => {
    expect(writeBackTable(text, origin, edited)).toEqual({ text: `# 学会\n\n${block}\n\n本文`, range: [2, 5], inserted: false });
  });

  it("finds it again when lines came in above it meanwhile (a merged edit)", () => {
    const moved = "# 学会\n追記1\n追記2\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n本文";
    expect(writeBackTable(moved, origin, edited)).toEqual({ text: `# 学会\n追記1\n追記2\n\n${block}\n\n本文`, range: [4, 7], inserted: false });
  });

  it("puts it in as a new table after theirs when someone changed the table itself", () => {
    const changed = "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/5 |\n\n本文";
    expect(writeBackTable(changed, origin, edited)).toEqual({
      text: `# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/5 |\n\n${block}\n\n本文`,
      range: [6, 9],
      inserted: true,
    });
    // A row added to it is a change too: the lines are there, but not as the whole table.
    const grown = text.replace("| 予稿 | 10/3 |", "| 予稿 | 10/3 |\n| 宿 | 10/7 |");
    expect(writeBackTable(grown, origin, edited).inserted).toBe(true);
  });

  it("puts it where it was when the table is gone", () => {
    expect(writeBackTable("# 学会\n\n本文", origin, edited)).toEqual({ text: `# 学会\n\n${block}\n\n本文`, range: [2, 5], inserted: true });
  });
});

it("a new table goes after the caret's line as it read when the editor opened, found again when lines moved", () => {
  expect(anchorLine("a\nb\nc", 1, "b")).toBe(1);
  expect(anchorLine("x\ny\na\nb\nc", 1, "b")).toBe(3); // two lines merged in above
  expect(anchorLine("b\na\nb\nc\nb", 2, "b")).toBe(2);
  expect(anchorLine("a\nB\nc", 1, "b")).toBe(1); // the line itself changed: the same place
  expect(anchorLine("a", 5, "b")).toBe(0);
});

it("lines and offsets", () => {
  const text = "a\nbc\n\nd";
  expect([0, 1, 2, 4, 5, 6, 7].map((at) => lineOf(text, at))).toEqual([0, 0, 1, 1, 2, 3, 3]);
  expect([0, 1, 2, 3, 9].map((line) => lineStart(text, line))).toEqual([0, 2, 5, 6, 7]);
});
