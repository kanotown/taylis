/**
 * M100 「セットを追加」: what the admin picked (a folder, a ZIP, or either dropped on the dialog) as plain files,
 * so the dialog can preview pack.json and a few images before uploading. The server checks everything again.
 */

const PACK_FILE = /(^|\/)pack\.json$|\.(png|gif|jpe?g|webp)$/i;
/** Preview only: a ZIP bigger than this is uploaded without a look inside (the server's own limit decides). */
const PREVIEW_ZIP_MAX = 64 * 1024 * 1024;

function baseName(name: string): string {
  return name.replace(/\\/g, "/").split("/").pop() ?? name;
}

function skipped(path: string): boolean {
  return path.includes("__MACOSX") || baseName(path).startsWith(".");
}

/**
 * The image and pack.json entries of a ZIP, as Files named by their base name (like the server's import does).
 * Stored and deflated entries only; null when the archive cannot be read here (the server still decides).
 */
export async function readZipPackFiles(archive: Blob): Promise<File[] | null> {
  if (archive.size > PREVIEW_ZIP_MAX) return null;
  const buffer = new Uint8Array(await archive.arrayBuffer());
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files: File[] = [];
  try {
    for (let n = 0; n < count; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) return null;
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const path = decoder.decode(buffer.subarray(at + 46, at + 46 + nameLength));
      at = next;
      if (path.endsWith("/") || skipped(path) || !PACK_FILE.test(path)) continue;
      if (view.getUint32(local, true) !== 0x04034b50) return null;
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = buffer.slice(start, start + size);
      let data: BlobPart;
      if (method === 0) data = raw;
      else if (method === 8 && typeof DecompressionStream !== "undefined") {
        data = await new Response(new Response(raw).body!.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      } else return null;
      files.push(new File([data], baseName(path).normalize("NFC")));
    }
  } catch {
    return null; // truncated or not a ZIP after all
  }
  return files;
}

/** A folder's files from a drop (Chromium / WebKit `webkitGetAsEntry`), every level, named by base name. */
async function readEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (skipped(entry.name)) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    // readEntries hands out a batch at a time (100 in Chromium) until an empty one.
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await readEntry(child, out);
  }
}

export type DroppedPack = { archive: File } | { files: File[] } | null;

/** What a drop on the dialog holds: a ZIP file, or a folder (its files); null when it is neither. */
export async function packFromDrop(data: DataTransfer): Promise<DroppedPack> {
  const items = [...(data.items ?? [])].filter((i) => i.kind === "file");
  const entry = items.length === 1 ? items[0]!.webkitGetAsEntry?.() : null;
  if (entry?.isDirectory) {
    const files: File[] = [];
    await readEntry(entry, files);
    return { files };
  }
  const file = data.files?.[0];
  if (file && /\.zip$/i.test(file.name)) return { archive: file };
  return null;
}
