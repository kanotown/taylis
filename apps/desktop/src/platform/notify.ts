import { isTauri } from "./env";
import { clearNotificationAvatars, notificationAvatar, pngDataUrl, type AvatarSender, type NotificationAvatar } from "./notificationAvatar";

/** Browser notifications still on screen, closed at sign-out (§11). */
const shownInBrowser = new Set<Notification>();

/**
 * What the Rust side says about native notifications (macOS app: UNUserNotificationCenter; Windows: WinRT toasts, always
 * "granted"); "unavailable" = use tauri-plugin-notification (Linux, `tauri dev` on macOS).
 */
type NativeState = "granted" | "denied" | "default" | "unavailable";

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(command, args);
}

/** Read again each time: the reader may change it in System Settings while the app runs. A failure: the plugin. */
async function nativePermission(): Promise<NativeState> {
  try {
    return await invoke<NativeState>("native_notification_permission");
  } catch (err) {
    console.warn("native notifications unavailable", err);
    return "unavailable";
  }
}

function nativeRequest(): Promise<NativeState> {
  return invoke<NativeState>("native_notification_request");
}

/** Click actions of native notifications by their id, the newest kept (a click on an old one only raises the window). */
const clickActions = new Map<string, () => void>();
const MAX_CLICK_ACTIONS = 100;
let clickListener: Promise<unknown> | null = null;
let nextId = 0;

/** What the native side takes for a message's sender (src-tauri/src/lib.rs `NotificationPerson`). */
interface NativePerson {
  id: string;
  name: string;
  conversationId: string;
  groupName: string | null;
  text: string;
  avatarKey: string | null;
  avatarPng: number[] | null;
}

async function sendNative(title: string, body: string, onClick?: () => void, person?: NativePerson): Promise<void> {
  const id = `taylis-${Date.now()}-${nextId++}`;
  if (onClick) {
    clickListener ??= import("@tauri-apps/api/event").then(({ listen }) =>
      listen<string>("notification-clicked", (event) => {
        const action = clickActions.get(event.payload);
        clickActions.delete(event.payload);
        action?.();
      }),
    );
    await clickListener;
    clickActions.set(id, onClick);
    if (clickActions.size > MAX_CLICK_ACTIONS) clickActions.delete(clickActions.keys().next().value as string);
  }
  await invoke<void>("native_notification_send", person ? { id, title, body, person } : { id, title, body });
}

/** A message's sender: their picture on the notification (docs/PUSH_NOTIFICATIONS.md §9.1). */
export interface NotificationSender extends AvatarSender {
  /** The conversation (channel id). */
  conversationId: string;
  /** A channel's or group DM's title; null for a 1:1 DM. */
  groupName: string | null;
  /** The message text alone (the body without 「名前: 」), for macOS' communication notifications. */
  text: string;
}

export interface NotifyOptions {
  sender?: NotificationSender;
}

/** Shown one after another, in the order asked: a picture being fetched must not let a later notification pass it. */
let queue: Promise<void> = Promise.resolve();

async function senderAvatar(sender: NotificationSender | undefined): Promise<NotificationAvatar | null> {
  if (!sender) return null;
  try {
    return await notificationAvatar(sender);
  } catch (err) {
    console.warn("no picture for the notification", err);
    return null;
  }
}

/**
 * OS notification: in the macOS app, our own UNUserNotificationCenter commands (src-tauri/src/mac_notify.rs: shown as a
 * banner while Taylis is frontmost too, and clicks come back); on Windows our own toasts (src-tauri/src/win_notify.rs:
 * the plugin dropped their clicks, so a click only dismissed the toast); tauri-plugin-notification elsewhere on the
 * desktop (Linux, `tauri dev` on macOS); the Notification API in browser dev. A click brings the window up (Rust side)
 * and runs `onClick` (open the message / thread / DM, the task, …) where clicks are reported (macOS app, Windows,
 * browser). A message's notification (`options.sender`) shows the sender's picture or initials avatar
 * (platform/notificationAvatar.ts): macOS as a communication notification where the build is entitled, else as an
 * attachment; Windows as the toast's logo; the browser as the `icon`. The plugin shows none.
 */
export function notify(title: string, body: string, onClick?: () => void, options: NotifyOptions = {}): Promise<void> {
  const shown = queue.then(() => show(title, body, onClick, options));
  queue = shown.catch(() => {});
  return shown;
}

async function show(title: string, body: string, onClick: (() => void) | undefined, { sender }: NotifyOptions): Promise<void> {
  if (isTauri()) {
    const native = await nativePermission();
    if (native !== "unavailable") {
      const granted = native === "granted" || (native === "default" && (await nativeRequest()) === "granted");
      if (!granted) return;
      const avatar = await senderAvatar(sender);
      const person: NativePerson | undefined = sender && {
        id: sender.userId,
        name: sender.name,
        conversationId: sender.conversationId,
        groupName: sender.groupName,
        text: sender.text,
        avatarKey: avatar?.key ?? null,
        avatarPng: avatar ? Array.from(avatar.png) : null,
      };
      await sendNative(title, body, onClick, person).catch((err: unknown) => console.warn("could not show the notification", err));
      return;
    }
    const plugin = await import("@tauri-apps/plugin-notification");
    let granted = await plugin.isPermissionGranted();
    if (!granted) granted = (await plugin.requestPermission()) === "granted";
    if (granted) plugin.sendNotification({ title, body });
    return;
  }
  // Not asked for here: a browser takes the request only from the reader's own click (the settings' 「通知を許可」),
  // and one made when a message arrived was ignored.
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const avatar = await senderAvatar(sender);
  const notification = new Notification(title, avatar ? { body, icon: pngDataUrl(avatar.png) } : { body });
  shownInBrowser.add(notification);
  notification.onclose = () => shownInBrowser.delete(notification);
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
    const native = await nativePermission();
    if (native !== "unavailable") return native;
    const plugin = await import("@tauri-apps/plugin-notification");
    return (await plugin.isPermissionGranted()) ? "granted" : "default";
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** 「通知を許可」 in the settings: ask now, from the click, and say what was decided. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isTauri()) {
    const native = await nativePermission();
    if (native === "default") {
      const decided = await nativeRequest();
      return decided === "unavailable" ? "default" : decided;
    }
    if (native !== "unavailable") return native;
    const plugin = await import("@tauri-apps/plugin-notification");
    if (await plugin.isPermissionGranted()) return "granted";
    return (await plugin.requestPermission()) === "granted" ? "granted" : "denied";
  }
  if (typeof Notification === "undefined") return "unsupported";
  await Notification.requestPermission();
  return Notification.permission;
}

/**
 * Sign-out (§11): take our notifications off the screen, and the senders' pictures out of memory (and, natively, off
 * the disk). Possible in a browser and in the macOS app (native); the desktop notification plugin cannot remove
 * delivered notifications (its removeAllActive is mobile only).
 */
export function clearNotifications(): void {
  if (isTauri()) {
    clickActions.clear();
    void invoke<void>("native_notification_clear").catch((err: unknown) => console.warn("could not clear notifications", err));
  }
  for (const notification of shownInBrowser) notification.close();
  shownInBrowser.clear();
  clearNotificationAvatars();
}
