/**
 * The search screen's 「ドライブ」 tab (M161, docs/DRIVE.md §12): file and folder names in every drive I can read
 * (GET /search/drive; the contents are not searched in v1), each with its place. A folder opens in 「ドライブ」; a file
 * opens in its viewer (or downloads), and 「フォルダで表示」 shows it in its folder.
 */
import { FolderInput, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DriveItemOut, DriveSearchHitOut } from "../api/types";
import type { AppController } from "../state/app";
import { driveTime, formatBytes, pathLine, viewable, viewerKind } from "../drive/listing";
import { DriveIcon } from "./DriveBrowser";
import { DriveViewer } from "./DriveViewer";
import { FileName } from "./FileName";
import { Button, IconButton } from "./primitives";
import { t } from "../i18n";

/** The root's name of a hit's path in the UI language (the server names it in Japanese). */
export function hitPath(hit: DriveSearchHitOut): string {
  const root = hit.location_kind === "workspace" ? t("drive.location.workspace") : hit.location_kind === "user" ? t("drive.location.mine") : `#${hit.path[0]?.name ?? ""}`;
  return pathLine(hit.path, root);
}

/** Where 「ドライブ」 should open next (a search result shown in its folder). */
type DriveTarget = { locationId: string; folderId: string };
const targetListeners = new Set<(target: DriveTarget) => void>();
let pendingTarget: DriveTarget | null = null;

export function showInDrive(target: DriveTarget): void {
  pendingTarget = target;
  for (const listener of [...targetListeners]) listener(target);
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
    void api.searchDrive({ q: words, limit: PAGE }).then(
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
  }, [api, words, controller]);

  const more = async () => {
    if (!api || !cursor) return;
    setLoading(true);
    try {
      const out = await api.searchDrive({ q: words, limit: PAGE, cursor });
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
    else if (viewerKind(item)) setViewing(item);
    // §27: a click never downloads by itself: a file no viewer shows is shown in its folder.
    else if (item.parent_id) onShowInDrive({ locationId: item.location_id, folderId: item.parent_id });
  };

  if (!words) return <p className="p-6 text-center text-sm text-muted">{t("search.drive.empty")}</p>;
  if (hits === null) return <div className="flex justify-center p-6 text-muted"><Loader2 size={18} className="animate-spin" /></div>;
  if (hits.length === 0) return <p className="p-6 text-center text-sm text-muted">{t("search.drive.none", { q: words })}</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-drive-results="">
      <p className="mb-2 text-xs text-muted">{t("search.drive.empty")}</p>
      <ul className="max-w-3xl space-y-1">
        {hits.map((hit) => (
          <li key={hit.item.id} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-ink/4">
            <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => open(hit)}>
              <DriveIcon item={hit.item} size={20} />
              <span className="min-w-0 flex-1">
                <FileName name={hit.item.name} className="text-sm font-medium" />
                <span className="block truncate text-xs text-muted">
                  {hitPath(hit)} · {driveTime(hit.item.content_modified_at ?? hit.item.updated_at)}
                  {hit.item.kind === "file" ? ` · ${formatBytes(hit.item.size_bytes)}` : ""}
                </span>
              </span>
            </button>
            {hit.item.parent_id && (
              <IconButton label={t("drive.showInFolder")} onClick={() => onShowInDrive({ locationId: hit.item.location_id, folderId: hit.item.parent_id! })}>
                <FolderInput size={16} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {cursor && <Button variant="ghost" size="sm" className="mt-3" disabled={loading} onClick={() => void more()}>{t("drive.showMore")}</Button>}
      {viewing && <DriveViewer controller={controller} item={viewing} siblings={viewables} onStep={setViewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
