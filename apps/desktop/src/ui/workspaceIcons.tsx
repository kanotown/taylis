/**
 * M93 (WORKSPACES.md §3.4): the workspace icon an admin set, shown on the rail, over the sidebar and on the login screen.
 * The picture is public (GET /server/icon, no sign-in), fetched once per (server, version) and kept, decoded, as an object
 * URL, so a later mount shows it at once; a workspace without one (or when it fails) shows the letter tile, and one loading
 * for the first time a neutral tile (not the letter, which would flash).
 */
import { useEffect, useState } from "react";

import { ApiClient } from "../api/client";
import { workspaceColor, workspaceInitials } from "../state/workspaces";
import { cn } from "./primitives";

type Fetcher = (serverUrl: string, version: string) => Promise<Blob>;

/** none: no icon or it failed (the letter); loading: the first fetch is under way; ready: show `url`. */
export type WorkspaceIconPicture = { state: "none" } | { state: "loading" } | { state: "ready"; url: string };

const defaultFetcher: Fetcher = (serverUrl, version) => new ApiClient(serverUrl).serverIcon(version);

let fetcher: Fetcher = defaultFetcher;
const urls = new Map<string, string>();
const loading = new Set<string>();
const failed = new Set<string>();
const listeners = new Set<() => void>();
/** Bumped when the cache is emptied, so a fetch started before lands nowhere. */
let generation = 0;

/** Tests swap the fetch (null restores the real one) and start from an empty cache. */
export function configureWorkspaceIcons(fetch: Fetcher | null): void {
  fetcher = fetch ?? defaultFetcher;
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  loading.clear();
  failed.clear();
  generation++;
}

function cacheKey(serverUrl: string, version: string): string {
  return `${serverUrl}|${version}`;
}

/** The cached picture's state, starting a fetch the first time a (server, version) is asked for. */
export function workspaceIcon(serverUrl: string, version: string | null | undefined): WorkspaceIconPicture {
  if (!version) return { state: "none" };
  const key = cacheKey(serverUrl, version);
  const known = urls.get(key);
  if (known) return { state: "ready", url: known };
  if (failed.has(key)) return { state: "none" };
  if (loading.has(key)) return { state: "loading" };
  loading.add(key);
  const started = generation;
  void (async () => {
    let url: string | null = null;
    try {
      url = URL.createObjectURL(await fetcher(serverUrl, version));
      await decoded(url);
      if (started !== generation) URL.revokeObjectURL(url);
      else urls.set(key, url);
    } catch {
      if (url) URL.revokeObjectURL(url);
      if (started === generation) failed.add(key); // the letter stays; the next version (or start) tries again
    } finally {
      if (started === generation) {
        loading.delete(key);
        notify();
      }
    }
  })();
  return { state: "loading" };
}

/** Decode before showing, so the <img>'s first paint has the picture (where the platform can decode ahead). */
async function decoded(url: string): Promise<void> {
  if (typeof Image === "undefined") return;
  const image = new Image();
  image.src = url;
  if (typeof image.decode === "function") await image.decode();
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function useWorkspaceIcon(serverUrl: string | null | undefined, version: string | null | undefined): WorkspaceIconPicture {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return serverUrl ? workspaceIcon(serverUrl, version) : { state: "none" };
}

/**
 * A workspace's tile: the admin's icon, else its initials on its colour (a neutral tile while the icon first loads).
 * `className` sets the size and corners; the letters' size comes from the caller too (`text-*`).
 */
export function WorkspaceIcon({ serverUrl, version, name, colorKey, className }: { serverUrl: string | null | undefined; version: string | null | undefined; name: string; colorKey: string; className?: string }) {
  const picture = useWorkspaceIcon(serverUrl, version);
  if (picture.state === "ready") {
    return <img src={picture.url} alt="" draggable={false} data-testid="workspace-icon" className={cn("shrink-0 object-cover", className)} />;
  }
  if (picture.state === "loading") {
    return <span aria-hidden data-testid="workspace-icon-loading" className={cn("shrink-0", className)} style={{ background: "rgb(128 128 128 / 0.22)" }} />;
  }
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center font-bold text-white", className)} style={{ background: workspaceColor(colorKey) }}>
      {workspaceInitials(name)}
    </span>
  );
}
