/** The default avatar's letters and colour against the cases every client shares (apps/shared/avatar-initials.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { avatarHue, initials } from "../src/ui/format";

type Vectors = { initials: { name: string; initials: string }[]; colors: { id: string; hue: number; rgb: number[] }[] };
const vectors = JSON.parse(readFileSync(new URL("../../shared/avatar-initials.json", import.meta.url), "utf8")) as Vectors;

describe("avatar-initials (apps/shared/avatar-initials.json)", () => {
  it.each(vectors.initials)("initials of $name", (c) => {
    expect(initials(c.name)).toBe(c.initials);
  });

  it.each(vectors.colors)("hue of $id", (c) => {
    expect(avatarHue(c.id)).toBe(c.hue);
  });
});
