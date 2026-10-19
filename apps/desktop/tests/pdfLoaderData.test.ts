import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: vi.fn(), GlobalWorkerOptions: {} }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/worker.js" }));

const { BundledBinaryDataFactory } = await import("../src/ui/pdfLoader");

// User report 2026-10-19: a PDF whose Japanese font is not embedded showed no Japanese; PDF.js needs the CMap it names.
describe("the PDF viewer's bundled CMaps and fonts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the CMap or font a PDF asks for from its bundled URL", async () => {
    const fetch = vi.fn(async (_url: string) => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetch);
    const factory = new BundledBinaryDataFactory();
    expect(await factory.fetch({ kind: "cMapUrl", filename: "UniJIS-UCS2-H.bcmap" })).toEqual(new Uint8Array([1, 2, 3]));
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/UniJIS-UCS2-H\.bcmap/);
    await factory.fetch({ kind: "standardFontDataUrl", filename: "LiberationSans-Regular.ttf" });
    expect(String(fetch.mock.calls[1]?.[0])).toMatch(/LiberationSans-Regular\.ttf/);
  });

  it("does not take a longer name ending the same way, and refuses what is not bundled", async () => {
    const fetch = vi.fn(async (_url: string) => new Response(new Uint8Array([0])));
    vi.stubGlobal("fetch", fetch);
    const factory = new BundledBinaryDataFactory();
    await factory.fetch({ kind: "cMapUrl", filename: "H.bcmap" });
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/H\.bcmap|\/H-[^/]*\.bcmap|cmaps\/H\.bcmap/);
    expect(String(fetch.mock.calls[0]?.[0])).not.toMatch(/UCS2-H/);
    await expect(factory.fetch({ kind: "cMapUrl", filename: "Nope-H.bcmap" })).rejects.toThrow(/not bundled/);
  });
});
