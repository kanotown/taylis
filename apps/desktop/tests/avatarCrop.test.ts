import { describe, expect, it } from "vitest";

import { clampCrop, sourceRect, zoomAt } from "../src/ui/avatarCrop";

const landscape = { width: 4000, height: 3000 };

describe("avatar crop", () => {
  it("starts with the centre square of the picture", () => {
    expect(sourceRect({ zoom: 1, x: 0, y: 0 }, landscape, 240)).toEqual({ x: 500, y: 0, side: 3000 });
  });

  it("never pans past the picture's edges", () => {
    // 3000 px high fits the 240 px frame; 4000 px wide shows 320 px, so 40 px of pan each way.
    expect(clampCrop({ zoom: 1, x: 500, y: 30 }, landscape, 240)).toEqual({ zoom: 1, x: 40, y: 0 });
    const left = sourceRect(clampCrop({ zoom: 1, x: 500, y: 0 }, landscape, 240), landscape, 240);
    expect(left.x).toBeCloseTo(0);
  });

  it("keeps the zoom between 1 and 4", () => {
    expect(clampCrop({ zoom: 0.2, x: 0, y: 0 }, landscape, 240).zoom).toBe(1);
    expect(clampCrop({ zoom: 9, x: 0, y: 0 }, landscape, 240).zoom).toBe(4);
  });

  it("zooms around the pinch point", () => {
    // Doubling the zoom around the frame's top-left corner keeps that corner's picture point in place.
    const crop = zoomAt({ zoom: 1, x: 0, y: 0 }, 2, { x: -120, y: -120 }, landscape, 240);
    const before = sourceRect({ zoom: 1, x: 0, y: 0 }, landscape, 240);
    const after = sourceRect(crop, landscape, 240);
    expect(after.side).toBeCloseTo(before.side / 2);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});
