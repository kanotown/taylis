import { isTauri } from "./env";

/** Browser notifications still on screen, closed at sign-out (§11). */
const shown = new Set<Notification>();

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
  if (Notification.permission !== "granted") return;
  const notification = new Notification(title, { body });
  shown.add(notification);
  notification.onclose = () => shown.delete(notification);
}

/**
 * Sign-out (§11): take our notifications off the screen. Only possible in a browser: the desktop
 * notification plugin cannot remove delivered notifications (its removeAllActive is mobile only).
 */
export function clearNotifications(): void {
  for (const notification of shown) notification.close();
  shown.clear();
}
