import { useSyncExternalStore } from "react";

import type { AppController } from "../state/app";

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
