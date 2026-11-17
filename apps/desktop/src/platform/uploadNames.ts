/**
 * Names for files that reach an upload without a real one (docs/CHANNEL_FILES.md §4.4, apps/shared/upload-names.json):
 * every clipboard image is 「image.png」 in a browser, so pasted pictures piled up in a channel's drive as image.png,
 * image (1).png … They are named by the time they were added instead: 「image_20261117_090503.png」, with _2, _3 … for
 * the 2nd, 3rd … unnamed file in the same second. Only pasted and dropped files are renamed; a picked file keeps its
 * name whatever it is (the person chose it).
 */

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "avif"]);
const VIDEO_EXTS = new Set(["mov", "mp4", "m4v", "webm"]);

/** Empty, a client's placeholder (「file」, 「photo.jpg」, 「video.mov」) or a clipboard's 「image.png」. */
export function isUnnamed(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower === "" || lower === "file") return true;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  const stem = lower.slice(0, dot);
  const ext = lower.slice(dot + 1);
  if (stem === "image" || stem === "photo") return IMAGE_EXTS.has(ext);
  if (stem === "video") return VIDEO_EXTS.has(ext);
  return false;
}

/** image/* → image, video/* → video, anything else → file. */
export function kindOf(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  return "file";
}

const two = (n: number) => String(n).padStart(2, "0");

function stampOf(at: Date): string {
  return `${String(at.getFullYear()).padStart(4, "0")}${two(at.getMonth() + 1)}${two(at.getDate())}_${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

/** 「image_20261117_090503_2.png」: `at` in local time; `index` 1 has no suffix; no dot without an extension. */
export function uploadName(kind: string, ext: string, at: Date, index: number): string {
  const suffix = index > 1 ? `_${index}` : "";
  const lower = ext.toLowerCase();
  return `${kind}_${stampOf(at)}${suffix}${lower ? `.${lower}` : ""}`;
}

/** Counts the unnamed files of one second (any kind), so two pasted in the same second get different names. */
export class UploadNamer {
  private stamp = "";
  private count = 0;

  next(kind: string, ext: string, at: Date = new Date()): string {
    const stamp = stampOf(at);
    this.count = stamp === this.stamp ? this.count + 1 : 1;
    this.stamp = stamp;
    return uploadName(kind, ext, at, this.count);
  }
}

const namer = new UploadNamer();

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "video/quicktime": "mov",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

/** The file's extension: by its type, else the one in its name. */
function extOf(file: File): string {
  const byType = EXT_BY_TYPE[file.type.toLowerCase()];
  if (byType) return byType;
  const name = file.name.trim();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A pasted or dropped file under a time name when it has none (isUnnamed); the same File when it has one. */
export function withUploadName(file: File, at: Date = new Date()): File {
  if (!isUnnamed(file.name)) return file;
  const name = namer.next(kindOf(file.type), extOf(file), at);
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

/** withUploadName for each pasted or dropped file, in order (one time for all, so they count up within it). */
export function withUploadNames(files: readonly File[]): File[] {
  const at = new Date();
  return files.map((file) => withUploadName(file, at));
}
