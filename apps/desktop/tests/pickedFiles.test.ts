// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readPickedFiles } from "../src/platform/pickedFiles";

describe("readPickedFiles", () => {
  it("copies each picked file into memory (name, type and bytes kept), so clearing the input cannot break the upload", async () => {
    const a = new File([new Uint8Array([137, 80, 78, 71])], "icon.png", { type: "image/png", lastModified: 5 });
    const b = new File(["hello"], "メモ.txt", { type: "text/plain" });
    const list = { 0: a, 1: b, length: 2, item: (i: number) => [a, b][i] ?? null, [Symbol.iterator]: function* () { yield a; yield b; } } as unknown as FileList;
    const copies = await readPickedFiles(list);
    expect(copies.map((f) => [f.name, f.type])).toEqual([["icon.png", "image/png"], ["メモ.txt", "text/plain"]]);
    expect(copies[0]).not.toBe(a);
    expect(new Uint8Array(await copies[0]!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(await copies[1]!.text()).toBe("hello");
    expect(copies[0]!.lastModified).toBe(5);
  });

  it("is empty for no files", async () => {
    expect(await readPickedFiles(null)).toEqual([]);
    expect(await readPickedFiles(undefined)).toEqual([]);
  });
});
