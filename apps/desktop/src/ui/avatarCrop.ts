/**
 * Square crop of a profile picture (M16g). At zoom 1 the picture just covers the frame (its shorter side fits);
 * the reader pans and zooms, and the frame's square is what gets uploaded. Same rules as iOS and Android.
 */

/** Side of the uploaded picture; the server shrinks it to 256 px. */
export const AVATAR_OUTPUT = 512;
export const MAX_ZOOM = 4;

export interface Size {
  width: number;
  height: number;
}

/** Offset of the picture's centre from the frame's centre, in frame pixels, and the zoom (1 = just covers). */
export interface Crop {
  zoom: number;
  x: number;
  y: number;
}

/** Frame pixels per picture pixel. */
export function cropScale(image: Size, frame: number, zoom: number): number {
  return (frame / Math.min(image.width, image.height)) * zoom;
}

/** Keeps the frame covered: no pan or zoom may show anything outside the picture. */
export function clampCrop(crop: Crop, image: Size, frame: number): Crop {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, crop.zoom));
  const scale = cropScale(image, frame, zoom);
  const maxX = Math.max(0, (image.width * scale - frame) / 2);
  const maxY = Math.max(0, (image.height * scale - frame) / 2);
  return { zoom, x: Math.min(maxX, Math.max(-maxX, crop.x)), y: Math.min(maxY, Math.max(-maxY, crop.y)) };
}

/** Zooms around a point of the frame (relative to its centre): the picture under that point stays under it. */
export function zoomAt(crop: Crop, zoom: number, point: { x: number; y: number }, image: Size, frame: number): Crop {
  const next = Math.min(MAX_ZOOM, Math.max(1, zoom));
  const ratio = next / crop.zoom;
  return clampCrop({ zoom: next, x: point.x - (point.x - crop.x) * ratio, y: point.y - (point.y - crop.y) * ratio }, image, frame);
}

/** The square of the picture, in picture pixels, that the frame shows. */
export function sourceRect(crop: Crop, image: Size, frame: number): { x: number; y: number; side: number } {
  const scale = cropScale(image, frame, crop.zoom);
  const side = frame / scale;
  return { x: image.width / 2 - crop.x / scale - side / 2, y: image.height / 2 - crop.y / scale - side / 2, side };
}
