/** A long file name keeps its extension visible; the shared cases (apps/shared/file-name-ellipsis.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { splitFileName } from "../src/ui/fileNameEllipsis";

type Case = { name: string; input: string; head: string; tail: string; ext: string };
const vectors = JSON.parse(readFileSync(new URL("../../shared/file-name-ellipsis.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("file-name-ellipsis (apps/shared/file-name-ellipsis.json)", () => {
  it("has the cases", () => expect(vectors.cases.length).toBeGreaterThan(20));
  for (const c of vectors.cases) {
    it(c.name, () => {
      const parts = splitFileName(c.input);
      expect(parts).toEqual({ head: c.head, tail: c.tail, ext: c.ext });
      expect(parts.head + parts.tail + parts.ext).toBe(c.input);
    });
  }
});
