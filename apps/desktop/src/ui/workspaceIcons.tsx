/**
 * M93 (WORKSPACES.md §3.4): the workspace icon an admin set, shown on the rail, over the sidebar and on the login screen.
 * The picture is public (GET /server/icon, no sign-in), fetched once per (server, version) and kept as an object URL; a
 * workspace without one (or while it loads, or when it fails) shows the letter tile.
 */
import { useEffect, useState } from "react";

import { ApiClient } from "../api/client";
import { workspaceColor, workspaceInitials } from "../state/workspaces";
import { cn } from "./primitives";

type Fetcher = (serverUrl: string, version: string) => Promise<Blob>;

const defaultFetcher: Fetcher = (serverUrl, version) => new ApiClient(serverUrl).serverIcon(version);

let fetcher: Fetcher = defaultFetcher;
const urls = new Map<string, string>();
const loading = new Set<string>();
const failed = new Set<string>();
const listeners = new Set<() => void>();

/** Tests swap the fetch (null restores the real one) and start from an empty cache. */
export function configureWorkspaceIcons(fetch: Fetcher | null): void {
  fetcher = fetch ?? defaultFetcher;
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  loading.clear();
  failed.clear();
}

function cacheKey(serverUrl: string, version: string): string {
  return `${serverUrl}|${version}`;
}

/** The cached picture, starting a fetch the first time a (server, version) is asked for. */
export function workspaceIconUrl(serverUrl: string, version: string | null | undefined): string | null {
  if (!version) return null;
  const key = cacheKey(serverUrl, version);
  const known = urls.get(key);
  if (known) return known;
  if (loading.has(key) || failed.has(key)) return null;
  loading.add(key);
  fetcher(serverUrl, version)
    .then((blob) => {
      urls.set(key, URL.createObjectURL(blob));
      notify();
    })
    .catch(() => {
      failed.add(key); // the letter stays; the next version (or start) tries again
    })
    .finally(() => loading.delete(key));
  return null;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function useWorkspaceIconUrl(serverUrl: string | null | undefined, version: string | null | undefined): string | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return serverUrl ? workspaceIconUrl(serverUrl, version) : null;
}

/**
 * A workspace's tile: the admin's icon, else its initials on its colour. `className` sets the size and corners; the
 * letters' size comes from the caller too (`text-*`).
 */
export function WorkspaceIcon({ serverUrl, version, name, colorKey, className }: { serverUrl: string | null | undefined; version: string | null | undefined; name: string; colorKey: string; className?: string }) {
  const url = useWorkspaceIconUrl(serverUrl, version);
  if (url) {
    return <img src={url} alt="" draggable={false} data-testid="workspace-icon" className={cn("shrink-0 object-cover", className)} />;
  }
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center font-bold text-white", className)} style={{ background: workspaceColor(colorKey) }}>
      {workspaceInitials(name)}
    </span>
  );
}
