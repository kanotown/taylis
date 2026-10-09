/**
 * The live results of a search box, whatever it asks for (LiveSearch.tsx: the best messages under the top search box;
 * DocsSidebarSearch.tsx: the pages in the Docs sidebar): the server is asked for the typed words once typing pauses
 * for LIVE_DEBOUNCE_MS, never while an IME composition is open (`paused`), and nothing for an empty box. An answer that
 * arrives after newer words were typed is dropped; words seen before are answered from the box's memory, which a
 * change of `version` empties (the Docs tree: a page renamed, moved or shared changes the answer).
 */
import { useEffect, useRef, useState } from "react";

import type { ApiClient } from "../api/client";
import type { AppController } from "../state/app";

/** How long typing must pause before the box asks. */
export const LIVE_DEBOUNCE_MS = 250;

export type LiveStatus = "idle" | "loading" | "done" | "error";

/** The box's answer `T` (hits and the words to mark) with where it stands. */
export type LiveQuery<T> = T & {
  /** idle: nothing typed (no request); loading: asked (the previous words' hits stay meanwhile); error: it failed. */
  status: LiveStatus;
  /** The words the answer is for. */
  query: string;
};

/**
 * `ask` fetches the answer for the words `q` (the latest `ask` is used; the request is keyed by the words); `empty` is
 * the answer with nothing in it (idle, and an error's).
 */
export function useLiveQuery<T extends object>(controller: AppController, text: string, paused: boolean, ask: (api: ApiClient, q: string) => Promise<T>, empty: T, version = 0): LiveQuery<T> {
  const q = text.trim();
  // One object for the whole life of the box, so going back to it changes nothing when it is shown already.
  const [idle] = useState<LiveQuery<T>>(() => ({ ...empty, status: "idle", query: "" }));
  const [state, setState] = useState<LiveQuery<T>>(idle);
  const request = useRef(0);
  const memory = useRef(new Map<string, LiveQuery<T>>());
  const latest = useRef(ask);
  latest.current = ask;
  const seen = useRef(version);
  if (seen.current !== version) {
    seen.current = version;
    memory.current.clear();
  }

  useEffect(() => {
    if (paused) return;
    const id = ++request.current;
    const api = controller.api;
    if (!q || !api) {
      setState(idle);
      return;
    }
    const known = memory.current.get(q);
    if (known) {
      setState(known);
      return;
    }
    setState((current) => ({ ...current, status: "loading" }));
    const timer = setTimeout(() => {
      void latest.current(api, q).then(
        (answer) => {
          const done: LiveQuery<T> = { ...answer, status: "done", query: q };
          memory.current.set(q, done);
          if (id === request.current) setState(done);
        },
        () => {
          // Said in the box only (no toast): the results page reports its own errors.
          if (id === request.current) setState({ ...idle, status: "error", query: q });
        },
      );
    }, LIVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, paused, controller.api, version, idle]);

  return state;
}
