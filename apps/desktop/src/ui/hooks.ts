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
