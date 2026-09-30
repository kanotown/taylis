import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { AppController } from "../state/app";
import type { EngineStatus } from "../sync/engine";

/** Re-render when the controller, the engine or the store changes (single source of truth). */
export function useAppVersion(controller: AppController): number {
  return useSyncExternalStore(
    (listener) => {
      const unsubscribers = [controller.subscribe(listener), controller.store.subscribe(listener)];
      return () => unsubscribers.forEach((u) => u());
    },
    () => controller.store.version + controller.version * 1_000 + (controller.engine ? 1 : 0) + screenIndex(controller.screen) * 1_000_000_000,
  );
}

/**
 * The same, for a part the app's re-render no longer reaches: a dialog or a popover inside a memoized message row
 * (M21), which shows more than the row's own props (channels, presence). Only while `enabled` (the popover is open).
 */
export function useStoreUpdates(controller: AppController, enabled = true): void {
  const subscribe = useCallback((listener: () => void) => {
    if (!enabled) return () => {};
    const unsubscribers = [controller.subscribe(listener), controller.store.subscribe(listener)];
    return () => unsubscribers.forEach((u) => u());
  }, [controller, enabled]);
  useSyncExternalStore(subscribe, () => (enabled ? controller.store.version + controller.version * 1_000 : 0));
}

function screenIndex(screen: string): number {
  return ["boot", "login", "change_password", "main"].indexOf(screen) + 1;
}

/** A CSS media query's current answer, kept up to date (false where matchMedia is missing, e.g. in tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );
}

/** How long the socket may be down before the connection strip appears (all clients use 2 s). */
export const CONNECTION_BANNER_GRACE_MS = 2000;

/**
 * The status the connection strip shows, or null. A reconnect that finishes within the grace period (start-up,
 * waking the computer, a phone returning to the page) shows nothing: the strip would only flash and push the
 * conversation down and back. Once shown, it follows the status until the socket is live again.
 */
export function useConnectionBanner(status: EngineStatus, graceMs = CONNECTION_BANNER_GRACE_MS): "connecting" | "offline" | null {
  const [shown, setShown] = useState<"connecting" | "offline" | null>(null);
  const visible = useRef(false);
  visible.current = shown !== null;
  useEffect(() => {
    if (status !== "connecting" && status !== "offline") {
      setShown(null);
      return;
    }
    if (visible.current) {
      setShown(status);
      return;
    }
    const timer = setTimeout(() => setShown(status), graceMs);
    return () => clearTimeout(timer);
  }, [status, graceMs]);
  return shown;
}

/** The time now, renewed every `intervalMs` (values that run out on their own: 「〜 15:30 まで」). */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
