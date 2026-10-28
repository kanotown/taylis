/**
 * The search screen's 「ドライブ」 tab (M161, docs/DRIVE.md §12): file and folder names in every drive I can read
 * (GET /search/drive), each with its place. A folder opens in 「ドライブ」; a file opens in its viewer (or downloads),
 * and 「フォルダで表示」 shows it in its folder. §29: the text inside PDF, Office and text files too (`content`): such a
 * hit shows the words around the match, marked, and a document opens at the match's page.
 */
import { FolderInput, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DriveItemOut, DriveSearchHitOut, DriveSearchOrigin } from "../api/types";
import type { AppController } from "../state/app";
import { driveTime, formatBytes, pathLine, viewable, viewerKind } from "../drive/listing";
import { openPage } from "../drive/snippet";
import { itemName, localizedPath } from "../drive/channelFiles";
import { DriveIcon } from "./DriveBrowser";
import { DriveSnippet } from "./DriveSnippet";
import { DriveViewer } from "./DriveViewer";
import { FileName } from "./FileName";
import { Button, IconButton } from "./primitives";
import { t } from "../i18n";

/** The root's name of a hit's path in the UI language (the server names it in Japanese). */
export function hitPath(hit: DriveSearchHitOut): string {
  const root = hit.location_kind === "workspace" ? t("drive.location.workspace") : hit.location_kind === "user" ? t("drive.location.mine") : `#${hit.path[0]?.name ?? ""}`;
  return pathLine(localizedPath(hit.path, hit.location_kind), root);
}

/** Where 「ドライブ」 should open next (a search result shown in its folder). CF2: `itemId`, a file to select there. */
type DriveTarget = { locationId: string; folderId: string; itemId?: string };
const targetListeners = new Set<(target: DriveTarget) => void>();
let pendingTarget: DriveTarget | null = null;
/** CF2 (docs/CHANNEL_FILES.md §12.1): the file 「ドライブで表示」 asked for, selected once its folder is listed. */
let pendingSelection: { folderId: string; itemId: string } | null = null;

export function showInDrive(target: DriveTarget): void {
  const { itemId, ...place } = target;
  pendingSelection = itemId ? { folderId: place.folderId, itemId } : null;
  pendingTarget = place;
  for (const listener of [...targetListeners]) listener(place);
}

/** The item to select in `folderId` (asked for by 「ドライブで表示」), taken once. */
export function takeDriveSelection(folderId: string): string | null {
  if (!pendingSelection || pendingSelection.folderId !== folderId) return null;
  const { itemId } = pendingSelection;
  pendingSelection = null;
  return itemId;
}

/** The target asked for before 「ドライブ」 mounted, taken once. */
export function takeDriveTarget(): DriveTarget | null {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}

export function onDriveTarget(listener: (target: DriveTarget) => void): () => void {
  targetListeners.add(listener);
  return () => {
    targetListeners.delete(listener);
  };
}

const PAGE = 50;

export function DriveResults({ controller, q, onShowInDrive }: { controller: AppController; q: string; onShowInDrive: (target: DriveTarget) => void }) {
  const api = controller.api;
  const [hits, setHits] = useState<DriveSearchHitOut[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<DriveItemOut | null>(null);
  // §29: the page a document was opened at (its match inside); stepping to another file starts at its top.
  const [openAt, setOpenAt] = useState<{ id: string; page: number } | null>(null);
  // CF2 (docs/CHANNEL_FILES.md §12.6): 「投稿のファイルを含む」 (on: every file; off: those not posted in a channel).
  const [withPosts, setWithPosts] = useState(true);
  const origin: DriveSearchOrigin = withPosts ? "all" : "uploads";
  const words = q.trim();

  useEffect(() => {
    if (!api || !words) {
      setHits([]);
      setCursor(null);
      return;
    }
    let cancelled = false;
    setHits(null);
    setLoading(true);
    void api.searchDrive({ q: words, limit: PAGE, content: true, ...(withPosts ? {} : { origin }) }).then(
      (out) => {
        if (cancelled) return;
        setHits(out.items);
        setCursor(out.next_cursor);
        setLoading(false);
      },
      (error) => {
        if (cancelled) return;
        setHits([]);
        setLoading(false);
        controller.setError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, words, controller, origin, withPosts]);

  const more = async () => {
    if (!api || !cursor) return;
    setLoading(true);
    try {
      const out = await api.searchDrive({ q: words, limit: PAGE, cursor, content: true, ...(withPosts ? {} : { origin }) });
      setHits((held) => [...(held ?? []), ...out.items]);
      setCursor(out.next_cursor);
    } catch (error) {
      controller.setError(error);
    } finally {
      setLoading(false);
    }
  };

  const items = useMemo(() => (hits ?? []).map((hit) => hit.item), [hits]);
  const viewables = useMemo(() => viewable(items), [items]);
  const open = (hit: DriveSearchHitOut) => {
    const item = hit.item;
    if (item.kind === "folder") onShowInDrive({ locationId: item.location_id, folderId: item.id });
    else if (viewerKind(item)) {
      const page = openPage(hit);
      setOpenAt(page ? { id: item.id, page } : null);
      setViewing(item);
    }
    // §27: a click never downloads by itself: a file no viewer shows is shown in its folder.
    else if (item.parent_id) onShowInDrive({ locationId: item.location_id, folderId: item.parent_id });
  };

  if (!words) return <p className="p-6 text-center text-sm text-muted">{t("search.drive.empty")}</p>;
  const originToggle = (
    <label className="mb-2 inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
      <input type="checkbox" data-drive-origin={origin} className="h-3.5 w-3.5 accent-[var(--accent)]" checked={withPosts} onChange={(event) => setWithPosts(event.target.checked)} />
      {t("channelFiles.search.includePosts")}
    </label>
  );
  if (hits === null) return <div className="flex justify-center p-6 text-muted"><Loader2 size={18} className="animate-spin" /></div>;
  if (hits.length === 0) {
    return (
      <div className="flex flex-col items-center p-6 text-center">
        {!withPosts && originToggle}
        <p className="text-sm text-muted">{t("search.drive.none", { q: words })}</p>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-drive-results="">
      <p className="mb-1 text-xs text-muted">{t("search.drive.empty")}</p>
      {originToggle}
      <ul className="max-w-3xl space-y-1">
        {hits.map((hit) => (
          <li key={hit.item.id} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-ink/4">
            <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => open(hit)}>
              <DriveIcon item={hit.item} size={20} />
              <span className="min-w-0 flex-1">
                <FileName name={itemName(hit.item)} className="text-sm font-medium" />
                <span className="block truncate text-xs text-muted">
                  {hitPath(hit)} · {driveTime(hit.item.content_modified_at ?? hit.item.updated_at)}
                  {hit.item.kind === "file" ? ` · ${formatBytes(hit.item.size_bytes)}` : ""}
                </span>
                <DriveSnippet hit={hit} className="mt-0.5" />
              </span>
            </button>
            {hit.item.parent_id && (
              <IconButton label={t("drive.showInFolder")} onClick={() => onShowInDrive({ locationId: hit.item.location_id, folderId: hit.item.parent_id!, itemId: hit.item.id })}>
                <FolderInput size={16} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {cursor && <Button variant="ghost" size="sm" className="mt-3" disabled={loading} onClick={() => void more()}>{t("drive.showMore")}</Button>}
      {viewing && <DriveViewer controller={controller} item={viewing} siblings={viewables} onStep={setViewing} onClose={() => setViewing(null)} page={openAt?.id === viewing.id ? openAt.page : null} />}
    </div>
  );
}
