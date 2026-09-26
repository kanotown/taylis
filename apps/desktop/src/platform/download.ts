/** Save a downloaded attachment: a native save dialog in Tauri, an <a download> in the browser. */
import { isTauri } from "./env";

export async function saveDownload(filename: string, blob: Blob): Promise<void> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: filename });
    if (!path) return;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
