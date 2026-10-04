/** LAB.md 「肩書と名簿」: the roster label is shown as the title; the shared cases (apps/shared/title-display.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { LabProfileOut } from "../src/api/types";
import { displayTitle, titleExtra } from "../src/ui/roster";

type Case = { name: string; roster: Partial<LabProfileOut> | null; title: string | null; display: string | null; extra: string | null };
const vectors = JSON.parse(readFileSync(new URL("../../shared/title-display.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("title-display (apps/shared/title-display.json)", () => {
  it("has the cases", () => expect(vectors.cases.length).toBeGreaterThan(10));
  for (const c of vectors.cases) {
    it(c.name, () => {
      const line = c.roster as LabProfileOut | null;
      expect(displayTitle(c.title, line)).toBe(c.display);
      expect(titleExtra(c.title, line)).toBe(c.extra);
    });
  }
});
