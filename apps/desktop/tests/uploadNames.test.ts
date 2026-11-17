/** Files without a real name get a time name; the shared cases (apps/shared/upload-names.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isUnnamed, kindOf, UploadNamer, uploadName, withUploadName, withUploadNames } from "../src/platform/uploadNames";

type NameCase = { name: string; kind: string; ext: string; time: string; index: number; expected: string };
type Step = { kind: string; ext: string; time: string; expected: string };
type Vectors = {
  names: NameCase[];
  sequences: { name: string; steps: Step[] }[];
  kinds: { mime: string; kind: string }[];
  unnamed: string[];
  named: string[];
};
const vectors = JSON.parse(readFileSync(new URL("../../shared/upload-names.json", import.meta.url), "utf8")) as Vectors;

/** "2026-11-17T09:05:03" as that wall-clock time here. */
function local(time: string): Date {
  const [date, clock] = time.split("T") as [string, string];
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi, s] = clock.split(":").map(Number) as [number, number, number];
  return new Date(y, mo - 1, d, h, mi, s);
}

describe("upload-names (apps/shared/upload-names.json)", () => {
  it("has the cases", () => {
    expect(vectors.names.length).toBeGreaterThan(5);
    expect(vectors.unnamed.length).toBeGreaterThan(10);
    expect(vectors.named.length).toBeGreaterThan(10);
  });
  for (const c of vectors.names) {
    it(`name: ${c.name}`, () => expect(uploadName(c.kind, c.ext, local(c.time), c.index)).toBe(c.expected));
  }
  for (const sequence of vectors.sequences) {
    it(`sequence: ${sequence.name}`, () => {
      const namer = new UploadNamer();
      expect(sequence.steps.map((step) => namer.next(step.kind, step.ext, local(step.time)))).toEqual(sequence.steps.map((step) => step.expected));
    });
  }
  it("kinds", () => {
    for (const c of vectors.kinds) expect(kindOf(c.mime), c.mime).toBe(c.kind);
  });
  it("unnamed", () => {
    for (const name of vectors.unnamed) expect(isUnnamed(name), JSON.stringify(name)).toBe(true);
  });
  it("named", () => {
    for (const name of vectors.named) expect(isUnnamed(name), JSON.stringify(name)).toBe(false);
  });
});

describe("pasted and dropped files", () => {
  const at = new Date(2026, 10, 17, 9, 5, 3);

  it("a clipboard's image.png becomes image_<time>.png, the bytes and type kept", async () => {
    const pasted = new File(["png"], "image.png", { type: "image/png", lastModified: 5 });
    const named = withUploadName(pasted, at);
    expect(named.name).toMatch(/^image_20261117_090503(_\d+)?\.png$/);
    expect(named.type).toBe("image/png");
    expect(named.lastModified).toBe(5);
    expect(await named.text()).toBe("png");
  });

  it("the extension comes from the type; a file without a name or type is file_<time>", () => {
    expect(withUploadName(new File(["x"], "image.png", { type: "image/jpeg" }), at).name).toMatch(/^image_20261117_090503(_\d+)?\.jpg$/);
    expect(withUploadName(new File(["x"], "", { type: "video/quicktime" }), at).name).toMatch(/^video_20261117_090503(_\d+)?\.mov$/);
    expect(withUploadName(new File(["x"], "", { type: "" }), at).name).toMatch(/^file_20261117_090503(_\d+)?$/);
  });

  it("a real name is kept: the same File", () => {
    const real = new File(["x"], "スクリーンショット 2026-11-17 9.05.03.png", { type: "image/png" });
    expect(withUploadName(real, at)).toBe(real);
  });

  it("several pasted at once count up within the second; named ones are left as they are", () => {
    const named = withUploadNames([
      new File(["a"], "image.png", { type: "image/png" }),
      new File(["b"], "report.pdf", { type: "application/pdf" }),
      new File(["c"], "image.png", { type: "image/png" }),
    ]).map((file) => file.name);
    expect(named[1]).toBe("report.pdf");
    const stamp = /^image_(\d{8}_\d{6})(?:_(\d+))?\.png$/;
    const first = stamp.exec(named[0]!)!;
    const second = stamp.exec(named[2]!)!;
    expect(second[1]).toBe(first[1]);
    expect(Number(second[2])).toBe(Number(first[2] ?? 1) + 1);
  });
});
