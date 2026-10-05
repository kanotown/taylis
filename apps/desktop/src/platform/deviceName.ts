import { isTauri } from "./env";
import { t } from "../i18n";

/**
 * The device's name in 「ログイン中の端末」 and the test notification's list (device_name, at most 80 characters on the
 * server). Not navigator.platform: browsers and WebViews freeze it at "MacIntel" on every Mac, Apple silicon too.
 * The desktop app: "Mac (Toru's MacBook Air)" (the OS from the user agent, the computer's name from the Rust side);
 * a browser: "Mac (Safari)", "Windows (Edge)".
 */
export const DEVICE_NAME_MAX = 80;

/** "Mac" / "Windows" / "Linux" / … from a user agent; null when it does not say. */
export function osLabel(userAgent: string): string | null {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux|X11/.test(userAgent)) return "Linux";
  return null;
}

/** The browser's name from its user agent (the order matters: Edge and Opera also say Chrome, Chrome also says Safari). */
export function browserLabel(userAgent: string): string | null {
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/.test(userAgent)) return "Opera";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "Firefox";
  if (/Chrome\/|CriOS\/|Chromium\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return null;
}

function clip(name: string): string {
  return name.length > DEVICE_NAME_MAX ? name.slice(0, DEVICE_NAME_MAX - 1) + "…" : name;
}

/** A browser: "Mac (Safari)"; just one of them, or 「ブラウザ」, when the user agent says less. */
export function browserDeviceName(userAgent: string): string {
  const os = osLabel(userAgent);
  const browser = browserLabel(userAgent);
  if (os && browser) return `${os} (${browser})`;
  return os ?? browser ?? t("device.browser");
}

/** The desktop app: "Mac (computer name)", or "Mac" alone when the name is not known. */
export function desktopDeviceName(userAgent: string, computerName: string | null): string {
  const os = osLabel(userAgent) ?? t("device.desktop");
  const name = computerName?.trim();
  return clip(name ? `${os} (${name})` : os);
}

/** This device's name, read once at start-up (the desktop app asks the Rust side for the computer's name). */
export async function resolveDeviceName(userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): Promise<string> {
  if (!isTauri()) return browserDeviceName(userAgent);
  let computerName: string | null = null;
  try {
    const core = await import("@tauri-apps/api/core");
    computerName = await core.invoke<string | null>("computer_name");
  } catch (err) {
    console.warn("could not read the computer's name", err);
  }
  return desktopDeviceName(userAgent, computerName);
}
