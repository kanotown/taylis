/**
 * A checkerboard behind a transparent picture in the full-screen viewers (docs/PREVIEWS.md §15): on the viewers' black,
 * a transparent PNG / WebP / GIF looks the same as a black one. The pattern is the picture's own background, so it is
 * exactly the picture's shown rectangle (fit or at its own size, scrolled), and only a picture with a transparent
 * pixel gets it: the format first (a JPEG never has one), then the decoded pixels, read once from a small canvas.
 */
import { type CSSProperties, type SyntheticEvent, useCallback, useState } from "react";

/** The two greys of the squares (the same on the phones: iOS `Checkerboard`, Android `Checkerboard`). */
export const CHECKER_LIGHT = "#e6e6e6";
export const CHECKER_DARK = "#c4c4c4";
/** A square's side in CSS px (pt / dp on the phones). */
export const CHECKER_CELL = 8;

export const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundColor: CHECKER_LIGHT,
  backgroundImage: `repeating-conic-gradient(${CHECKER_DARK} 0 25%, transparent 0 50%)`,
  backgroundSize: `${CHECKER_CELL * 2}px ${CHECKER_CELL * 2}px`,
};

const ALPHA_TYPES = new Set([
  "image/png", "image/apng", "image/webp", "image/gif", "image/avif", "image/heic", "image/heif", "image/tiff",
  "image/bmp", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml",
]);

/** Whether a picture of this type can have transparent pixels at all (worth reading them). */
export function mayHaveAlpha(contentType: string | null | undefined): boolean {
  return ALPHA_TYPES.has((contentType ?? "").split(";")[0]!.trim().toLowerCase());
}

/** Any pixel of RGBA bytes (a canvas's ImageData) not fully opaque. */
export function hasTransparentPixel(rgba: ArrayLike<number>): boolean {
  for (let at = 3; at < rgba.length; at += 4) if (rgba[at]! < 255) return true;
  return false;
}

/** The size the pixels are read at: the long edge at most `max` (a scaled-down transparent pixel stays below 255). */
export function sampleSize(width: number, height: number, max = 256): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether a loaded picture has a transparent pixel; false when it cannot be read (no canvas, a tainted one). */
export function imageHasAlpha(image: HTMLImageElement): boolean {
  if (!image.naturalWidth || !image.naturalHeight) return false;
  try {
    const { width, height } = sampleSize(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(image, 0, 0, width, height);
    return hasTransparentPixel(context.getImageData(0, 0, width, height).data);
  } catch {
    return false;
  }
}

/**
 * For a viewer's <img>: `onLoad` reads the picture once (when its type may have alpha), `style` is the checkerboard
 * while the shown picture is the transparent one (a new src starts without it).
 */
export function useTransparentBackdrop(src: string | null, contentType: string | null | undefined, read: (image: HTMLImageElement) => boolean = imageHasAlpha) {
  const [found, setFound] = useState<string | null>(null);
  const candidate = mayHaveAlpha(contentType);
  const onLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    setFound(candidate && read(image) ? image.getAttribute("src") : null);
  }, [candidate, read]);
  const transparent = candidate && src !== null && found === src;
  return { transparent, onLoad, style: transparent ? CHECKERBOARD_STYLE : undefined };
}
