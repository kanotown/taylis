import { isTauri } from "./env";

/**
 * `chikuwachat://…` links handed to the Tauri app (tauri-plugin-deep-link): each one while the app runs, and the one
 * that launched it, if any. The handler sees every URL and decides which it wants. Nothing happens in a browser.
 */
export async function listenForDeepLinks(handler: (url: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const unlisten = await onOpenUrl((urls) => urls.forEach(handler));
  for (const url of (await getCurrent()) ?? []) handler(url);
  return unlisten;
}
