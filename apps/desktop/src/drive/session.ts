/**
 * One upload queue per signed-in workspace (M161): it lives across screens (the panel stays while I go elsewhere),
 * keeps its restart notes per account, and hears drive.upload.updated and reconnects through the engine's DriveHub.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { ApiClient } from "../api/client";
import { isTauri } from "../platform/env";
import { reopenNative } from "../platform/driveFiles";
import type { DriveHub } from "../sync/drive";
import { type ConflictChoice, type ConflictQuestion, localUploadStorage, sha256Hex, type UploadJob, UploadQueue } from "./uploads";

interface Entry {
  api: ApiClient;
  queue: UploadQueue;
  version: number;
  listeners: Set<() => void>;
  answer: ((value: { choice: ConflictChoice; all: boolean }) => void) | null;
  doneListeners: Set<(job: UploadJob) => void>;
}

const entries = new Map<string, Entry>();

function bump(entry: Entry): void {
  entry.version += 1;
  for (const listener of [...entry.listeners]) listener();
}

/** The queue of the workspace `key` talking through `api` (made, and restored from its notes, on first use). */
export function uploadQueueFor(key: string, api: ApiClient): UploadQueue {
  const found = entries.get(key);
  if (found && found.api === api) return found.queue;
  found?.queue.stop();
  const entry: Entry = { api, queue: null as unknown as UploadQueue, version: 0, listeners: new Set(), answer: null, doneListeners: new Set() };
  entry.queue = new UploadQueue({
    api,
    sha256: sha256Hex,
    storage: localUploadStorage(key),
    reopen: isTauri() ? reopenNative : undefined,
    ask: (_question: ConflictQuestion) =>
      new Promise((resolve) => {
        entry.answer = (value) => {
          entry.answer = null;
          resolve(value);
        };
        bump(entry);
      }),
    onChange: () => bump(entry),
    onDone: (job) => {
      for (const listener of [...entry.doneListeners]) listener(job);
    },
  });
  entries.set(key, entry);
  void entry.queue.restore();
  if (typeof window !== "undefined") window.addEventListener("online", () => entry.queue.online());
  return entry.queue;
}

/** The panel's answer to the conflict on screen. */
export function answerConflict(key: string, choice: ConflictChoice, all: boolean): void {
  entries.get(key)?.answer?.({ choice, all });
}

/** Re-renders on every change of the queue; null without a session. */
export function useUploadQueue(key: string | null, api: ApiClient | null): UploadQueue | null {
  const queue = key && api ? uploadQueueFor(key, api) : null;
  const entry = key ? entries.get(key) : undefined;
  const subscribe = useCallback((listener: () => void) => {
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }, [entry]);
  useSyncExternalStore(subscribe, () => entry?.version ?? 0);
  return queue;
}

/** Calls `onDone` for each file the queue of `key` finishes (the open folder reads itself again). */
export function useUploadsDone(key: string | null, onDone: (job: UploadJob) => void): void {
  useEffect(() => {
    const entry = key ? entries.get(key) : undefined;
    if (!entry) return;
    entry.doneListeners.add(onDone);
    return () => {
      entry.doneListeners.delete(onDone);
    };
  }, [key, onDone]);
}

/** drive.upload.updated and reconnects reach the queue (one subscription per mounted panel). */
export function useQueueSignals(queue: UploadQueue | null, hub: DriveHub | null | undefined): void {
  useEffect(() => {
    if (!queue || !hub) return;
    return hub.subscribe((signal) => {
      if (signal.kind === "upload") queue.applyEvent(signal.upload);
      else if (signal.kind === "resync") queue.online();
    });
  }, [queue, hub]);
}
