import { isTauri } from "./env";

/** OS notification (tauri-plugin-notification; the Notification API in browser dev). */
export async function notify(title: string, body: string): Promise<void> {
  if (isTauri()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    let granted = await plugin.isPermissionGranted();
    if (!granted) granted = (await plugin.requestPermission()) === "granted";
    if (granted) plugin.sendNotification({ title, body });
    return;
  }
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission === "granted") new Notification(title, { body });
}
