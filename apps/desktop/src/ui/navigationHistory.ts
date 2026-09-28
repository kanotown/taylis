import { useLayoutEffect, useRef } from "react";

const FIELD = "chikuwaNavigation";

/** Browser Back/Forward inside the current workspace. History contains opaque IDs, never message bodies or tokens.
 * Entries from an expired screen (logout, reload, another workspace) cannot restore that screen's private state.
 */
export function useNavigationHistory<T>(key: string, snapshot: T, restore: (snapshot: T) => void, enabled: boolean) {
  const records = useRef(new Map<number, { key: string; snapshot: T }>());
  const owner = useRef(crypto.randomUUID());
  const next = useRef(0);
  const current = useRef<number | null>(null);
  const latest = useRef(restore);
  latest.current = restore;

  useLayoutEffect(() => {
    if (!enabled) return;
    const pop = (event: PopStateEvent) => {
      const marker = event.state?.[FIELD];
      if (marker?.owner !== owner.current) return;
      const entry = records.current.get(marker.id);
      if (!entry) return;
      current.current = marker.id;
      latest.current(entry.snapshot);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const previous = current.current === null ? undefined : records.current.get(current.current);
    if (previous?.key === key) {
      previous.snapshot = snapshot;
      return;
    }
    const id = next.current++;
    records.current.set(id, { key, snapshot });
    const state = { ...history.state, [FIELD]: { owner: owner.current, id } };
    if (current.current === null) history.replaceState(state, "");
    else history.pushState(state, "");
    current.current = id;
  });
}
