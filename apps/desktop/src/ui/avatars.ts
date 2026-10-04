/**
 * Profile pictures (M14a): fetched once per (user, version) with the bearer token and kept, decoded, as object URLs in a
 * module-level cache, so a picture loaded once shows at once on every later mount (no initials flashing first). The cache
 * is an LRU of AVATAR_CACHE_LIMIT pictures; an evicted URL is revoked, and signing out or switching workspaces empties it.
 * `noteVersions` follows the store's users; `useAvatar` gives a component the picture's state.
 */
import { useEffect, useState } from "react";

import type { UserPublic } from "../api/types";

type Fetcher = (path: string) => Promise<Blob>;

/** none: no picture (or it failed: the initials); loading: never loaded yet (a neutral placeholder); ready: show `url`. */
export type AvatarPicture = { state: "none" } | { state: "loading" } | { state: "ready"; url: string };

export const AVATAR_CACHE_LIMIT = 500;
/** A failed picture shows the initials; a later render asks again after this long (or at once for a new version). */
const RETRY_AFTER_MS = 60_000;

const NONE: AvatarPicture = { state: "none" };
const LOADING: AvatarPicture = { state: "loading" };

const versions = new Map<string, string>();
/** key → picture, oldest use first (a hit moves it to the end). The Image keeps the decoded picture alive. */
const cache = new Map<string, { url: string; image: HTMLImageElement | null }>();
const loading = new Set<string>();
const failed = new Map<string, number>();
const listeners = new Set<() => void>();
let fetcher: Fetcher | null = null;
let scope: string | null = null;
let limit = AVATAR_CACHE_LIMIT;
/** Bumped when the cache is emptied, so a fetch started before lands nowhere. */
let generation = 0;

/**
 * The active workspace's fetch (`scope` names it: another scope empties the cache first), or null on sign-out (empties it).
 * `cacheLimit` is for tests.
 */
export function configureAvatars(fetch: Fetcher | null, scopeKey: string | null = null, cacheLimit = AVATAR_CACHE_LIMIT): void {
  limit = cacheLimit;
  if (!fetch || scopeKey !== scope) clear();
  fetcher = fetch;
  scope = fetch ? scopeKey : null;
}

function clear(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
  versions.clear();
  loading.clear();
  failed.clear();
  generation++;
  notify();
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

/** The picture's state, starting a fetch when the user has a picture we have not loaded yet. */
export function avatarPicture(userId: string): AvatarPicture {
  const version = versions.get(userId);
  if (!version) return NONE;
  const key = avatarCacheKey(userId, version);
  const known = cache.get(key);
  if (known) {
    cache.delete(key); // most recently used: to the end
    cache.set(key, known);
    return { state: "ready", url: known.url };
  }
  const failedAt = failed.get(key);
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < RETRY_AFTER_MS) return NONE;
    failed.delete(key);
  }
  if (!fetcher) return NONE;
  if (!loading.has(key)) load(key, userId, version, fetcher);
  return LOADING;
}

/** The cached picture URL or null (still loading, none, or failed). */
export function avatarUrl(userId: string): string | null {
  const picture = avatarPicture(userId);
  return picture.state === "ready" ? picture.url : null;
}

function load(key: string, userId: string, version: string, fetch: Fetcher): void {
  const started = generation;
  loading.add(key);
  void (async () => {
    let url: string | null = null;
    try {
      const blob = await fetch(avatarPath(userId, version));
      if (started !== generation) return;
      url = URL.createObjectURL(blob);
      const image = await decoded(url);
      if (started !== generation) {
        URL.revokeObjectURL(url);
        return;
      }
      cache.set(key, { url, image });
      evict();
    } catch {
      if (url) URL.revokeObjectURL(url);
      if (started === generation) failed.set(key, Date.now()); // the initials stay until a retry or a new version
    } finally {
      if (started === generation) {
        loading.delete(key);
        notify();
      }
    }
  })();
}

/** Decode before showing, so the first paint of the <img> has the picture (where the platform can decode ahead). */
async function decoded(url: string): Promise<HTMLImageElement | null> {
  if (typeof Image === "undefined") return null;
  const image = new Image();
  image.src = url;
  if (typeof image.decode !== "function") return image;
  await image.decode();
  return image;
}

function evict(): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    const entry = cache.get(oldest);
    cache.delete(oldest);
    if (entry) URL.revokeObjectURL(entry.url);
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function useAvatar(userId: string): AvatarPicture {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return avatarPicture(userId);
}

export function useAvatarUrl(userId: string): string | null {
  const picture = useAvatar(userId);
  return picture.state === "ready" ? picture.url : null;
}
