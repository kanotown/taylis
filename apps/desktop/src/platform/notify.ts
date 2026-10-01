import { isTauri } from "./env";

/** Browser notifications still on screen, closed at sign-out (§11). */
const shown = new Set<Notification>();

/**
 * OS notification (tauri-plugin-notification; the Notification API in browser dev). `onClick` (M55: open the task) runs
 * when a browser's notification is clicked; the desktop plugin reports no clicks there (its actions are mobile only).
 */
export async function notify(title: string, body: string, onClick?: () => void): Promise<void> {
  if (isTauri()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    let granted = await plugin.isPermissionGranted();
    if (!granted) granted = (await plugin.requestPermission()) === "granted";
    if (granted) plugin.sendNotification({ title, body });
    return;
  }
  // Not asked for here: a browser takes the request only from the reader's own click (the settings' 「通知を許可」),
  // and one made when a message arrived was ignored.
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const notification = new Notification(title, { body });
  shown.add(notification);
  notification.onclose = () => shown.delete(notification);
  if (onClick) {
    notification.onclick = () => {
      window.focus();
      notification.close();
      onClick();
    };
  }
}

/** Whether notifications may be shown here: "default" while never asked, "unsupported" without the API. */
export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

export async function notificationPermission(): Promise<NotificationPermissionState> {
  if (isTauri()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    return (await plugin.isPermissionGranted()) ? "granted" : "default";
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** 「通知を許可」 in the settings: ask now, from the click, and say what was decided. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isTauri()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    if (await plugin.isPermissionGranted()) return "granted";
    return (await plugin.requestPermission()) === "granted" ? "granted" : "denied";
  }
  if (typeof Notification === "undefined") return "unsupported";
  await Notification.requestPermission();
  return Notification.permission;
}

/**
 * Sign-out (§11): take our notifications off the screen. Only possible in a browser: the desktop
 * notification plugin cannot remove delivered notifications (its removeAllActive is mobile only).
 */
export function clearNotifications(): void {
  for (const notification of shown) notification.close();
  shown.clear();
}
