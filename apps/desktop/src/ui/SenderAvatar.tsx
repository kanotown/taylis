import { useCallback, useSyncExternalStore } from "react";

import type { PresenceLook } from "../api/types";
import type { Store } from "../sync/store";
import { Avatar } from "./Avatar";

/**
 * The look of one person's dot, kept current by itself (docs/PRESENCE.md §11.5): a bot or a webhook's bot has none.
 * Each caller subscribes to the store but re-renders only when this person's look changes (the snapshot is a string),
 * so a message list does not redraw its memoized rows when someone comes online, goes away or pauses.
 */
export function usePresenceLook(store: Store, userId: string): PresenceLook | undefined {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(subscribe, () => (store.users.get(userId)?.role === "bot" ? undefined : store.presenceOf(userId)));
}

/**
 * A message's sender, with the presence dot at the picture's corner (channels, DMs, threads, the threads view, search):
 * the dot's ring is cut out of the picture, so it matches the row's background whatever it is (hovered, highlighted,
 * selected, dark mode). Offline is the hollow grey ring (Avatar), in its hole too.
 */
export function SenderAvatar({ store, userId, name, size, className }: { store: Store; userId: string; name: string; size: number; className?: string }) {
  const presence = usePresenceLook(store, userId);
  return <Avatar id={userId} name={name} size={size} className={className} presence={presence} presenceCutout />;
}
