/**
 * Profile pictures (M14a): fetched once per (user, version) with the bearer token and kept as object
 * URLs. `noteVersions` follows the store's users; `useAvatarUrl` gives a component the picture or null.
 */
import { useEffect, useState } from "react";

import type { UserPublic } from "../api/types";

type Fetcher = (path: string) => Promise<Blob>;

const versions = new Map<string, string>();
const urls = new Map<string, string>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
let fetcher: Fetcher | null = null;

export function configureAvatars(fetch: Fetcher | null): void {
  fetcher = fetch;
  if (!fetch) {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    versions.clear();
    loading.clear();
    notify();
  }
}

/** Remember which users have a picture and its version (from bootstrap and user.updated). */
export function noteVersions(users: Iterable<UserPublic>): void {
  let changed = false;
  for (const user of users) {
    const version = user.avatar_updated_at ?? null;
    if ((versions.get(user.id) ?? null) === version) continue;
    if (version === null) versions.delete(user.id);
    else versions.set(user.id, version);
    changed = true;
  }
  if (changed) notify();
}

export function avatarCacheKey(userId: string, version: string): string {
  return `${userId}|${version}`;
}

export function avatarPath(userId: string, version: string): string {
  return `/api/v1/users/${userId}/avatar?v=${encodeURIComponent(version)}`;
}

/** The cached picture URL, starting a fetch when the user has a picture we have not loaded yet. */
export function avatarUrl(userId: string): string | null {
  const version = versions.get(userId);
  if (!version) return null;
  const key = avatarCacheKey(userId, version);
  const known = urls.get(key);
  if (known) return known;
  if (!fetcher || loading.has(key)) return null;
  loading.add(key);
  fetcher(avatarPath(userId, version))
    .then((blob) => {
      urls.set(key, URL.createObjectURL(blob));
      notify();
    })
    .catch(() => {
      // the initials stay; a later render retries
    })
    .finally(() => loading.delete(key));
  return null;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function useAvatarUrl(userId: string): string | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return avatarUrl(userId);
}
