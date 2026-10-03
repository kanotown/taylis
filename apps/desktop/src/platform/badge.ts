import { isTauri } from "./env";

let shown: number | null = null;
/** The browser tab says which workspace it is (M16c): the name from GET /server. */
let titleBase = "Taylis";

export function setTitleBase(name: string): void {
  titleBase = name || "Taylis";
  if (!isTauri() && typeof document !== "undefined") document.title = shown ? `(${shown}) ${titleBase}` : titleBase;
}

/** The unread count on the Dock / taskbar icon in Tauri, in the tab title in a browser (M13f). */
export async function setUnreadBadge(count: number): Promise<void> {
  if (count === shown) return;
  shown = count;
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
    } catch {
      // Not every platform shows badges; nothing to do.
    }
    return;
  }
  if (typeof document !== "undefined") document.title = count > 0 ? `(${count}) ${titleBase}` : titleBase;
}
