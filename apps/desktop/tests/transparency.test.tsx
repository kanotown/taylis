// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CHECKERBOARD_STYLE, hasTransparentPixel, imageHasAlpha, mayHaveAlpha, sampleSize, useTransparentBackdrop } from "../src/ui/transparency";

afterEach(cleanup);

describe("the viewers' checkerboard behind a transparent picture (PREVIEWS.md §15)", () => {
  it("reads the pixels only of a type that can have alpha", () => {
    for (const type of ["image/png", "image/webp", "image/gif", "image/heic", "IMAGE/PNG", "image/png; charset=binary"]) expect(mayHaveAlpha(type)).toBe(true);
    for (const type of ["image/jpeg", "image/jpg", "video/mp4", "application/pdf", "", null, undefined]) expect(mayHaveAlpha(type)).toBe(false);
  });

  it("finds a pixel that is not fully opaque", () => {
    expect(hasTransparentPixel(new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 255]))).toBe(false);
    expect(hasTransparentPixel(new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 254]))).toBe(true);
    expect(hasTransparentPixel(new Uint8ClampedArray([255, 255, 255, 0]))).toBe(true);
    expect(hasTransparentPixel(new Uint8ClampedArray([]))).toBe(false);
  });

  it("reads a large picture at 256 px at most, keeping its shape", () => {
    expect(sampleSize(4000, 3000)).toEqual({ width: 256, height: 192 });
    expect(sampleSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(sampleSize(10000, 1)).toEqual({ width: 256, height: 1 });
  });

  it("an image that cannot be read (not loaded, no canvas) is opaque", () => {
    expect(imageHasAlpha(document.createElement("img"))).toBe(false);
  });

  function Viewer({ src, type, alpha }: { src: string; type: string; alpha: boolean }) {
    const backdrop = useTransparentBackdrop(src, type, () => alpha);
    return <img alt="" src={src} onLoad={backdrop.onLoad} style={backdrop.style} data-transparent={backdrop.transparent ? "" : undefined} />;
  }

  it("draws the squares behind the shown picture once it loaded and was found transparent", () => {
    const { container, rerender } = render(<Viewer src="blob:a" type="image/png" alpha={true} />);
    const image = container.querySelector("img")!;
    expect(image.hasAttribute("data-transparent")).toBe(false);
    fireEvent.load(image);
    expect(image.hasAttribute("data-transparent")).toBe(true);
    expect(image.style.backgroundSize).toBe(CHECKERBOARD_STYLE.backgroundSize); // jsdom drops the conic gradient itself
    // The next photo starts without it until it has loaded too.
    rerender(<Viewer src="blob:b" type="image/png" alpha={false} />);
    expect(image.hasAttribute("data-transparent")).toBe(false);
    fireEvent.load(image);
    expect(image.hasAttribute("data-transparent")).toBe(false);
    expect(image.style.backgroundSize).toBe("");
  });

  it("a JPEG keeps the black (its pixels are never read)", () => {
    let read = 0;
    function Jpeg() {
      const backdrop = useTransparentBackdrop("blob:c", "image/jpeg", () => { read += 1; return true; });
      return <img alt="" src="blob:c" onLoad={backdrop.onLoad} style={backdrop.style} />;
    }
    const { container } = render(<Jpeg />);
    fireEvent.load(container.querySelector("img")!);
    expect(read).toBe(0);
    expect(container.querySelector("img")!.style.backgroundSize).toBe("");
  });
});
