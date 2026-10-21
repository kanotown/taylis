/**
 * The drive's dialogs (M161, docs/DRIVE.md §17): a new folder, a new name, moving to a folder picked from the
 * locations I can write, deleting for good from the trash, and the name-conflict question of an upload.
 */
import { ChevronRight, Folder, HardDrive, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import type { DriveCrumb, DriveItemOut, DriveLocationOut } from "../api/types";
import { ApiError, describeError } from "../api/errors";
import type { AppController } from "../state/app";
import { locationName, orderLocations, pathLine } from "../drive/listing";
import type { ConflictChoice, ConflictQuestion } from "../drive/uploads";
import { Button, cn, Input, Modal } from "./primitives";
import { t } from "../i18n";

function newOpId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

/** 「新しいフォルダ」: a name, made in `parentId` (the same op id when sent again). */
export function NewFolderDialog({ controller, parentId, onClose, onMade }: { controller: AppController; parentId: string; onClose: () => void; onMade: (folder: DriveItemOut) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opId] = useState(newOpId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const api = controller.api;
    if (!api || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onMade(await api.createDriveFolder({ parent_id: parentId, name: name.trim(), client_op_id: opId }));
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("drive.newFolder")}>
      <form onSubmit={(event) => void submit(event)} className="mt-4 space-y-3">
        <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("drive.folderNamePlaceholder")} aria-label={t("drive.folderName")} maxLength={255} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{t("drive.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** The selection of a name before its extension (「報告書」 of 「報告書.pdf」), as Finder and Explorer select it. */
export function stemLength(name: string, isFile: boolean): number {
  const dot = name.lastIndexOf(".");
  return isFile && dot > 0 ? dot : name.length;
}

export function RenameDialog({ controller, item, onClose, onDone }: { controller: AppController; item: DriveItemOut; onClose: () => void; onDone: (item: DriveItemOut) => void }) {
  const [name, setName] = useState(item.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const api = controller.api;
    const next = name.trim();
    if (!api || !next) return;
    if (next === item.name) return onClose();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.renameDriveItem(item.id, next));
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("drive.rename")}>
      <form onSubmit={(event) => void submit(event)} className="mt-4 space-y-3">
        <Input
          autoFocus
          value={name}
          maxLength={255}
          aria-label={t("drive.newName")}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.currentTarget.setSelectionRange(0, stemLength(item.name, item.kind === "file"))}
        />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{t("drive.rename")}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 「移動」 and (M162) 「コピー」: a folder picked in any location I can write (moving across locations needs writing in
 * both; the server says so). The items themselves and their folders below cannot be the target (the server refuses
 * with drive_cycle). A copy may go into the items' own folder: the copy is numbered 「名前 (1)」. The same op id is sent
 * again when the copy is retried, so a lost answer never copies twice.
 */
export function MoveDialog({ controller, items, startLocation, startFolderId, onClose, onMoved, mode = "move" }: {
  controller: AppController;
  items: DriveItemOut[];
  startLocation: DriveLocationOut;
  startFolderId: string;
  onClose: () => void;
  onMoved: (targetFolderId: string, failed: number) => void;
  mode?: "move" | "copy";
}) {
  const [opId] = useState(newOpId);
  const [locations, setLocations] = useState<DriveLocationOut[]>([startLocation]);
  const [location, setLocation] = useState(startLocation);
  const [folderId, setFolderId] = useState(startFolderId);
  const [path, setPath] = useState<DriveCrumb[]>([]);
  const [folders, setFolders] = useState<DriveItemOut[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moving = useMemo(() => new Set(items.map((item) => item.id)), [items]);

  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    void api.driveLocations().then((out) => setLocations(orderLocations(out.locations.filter((loc) => loc.can_write))), () => undefined);
  }, [controller.api]);

  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    let cancelled = false;
    setFolders(null);
    void (async () => {
      try {
        let cursor: string | null = null;
        const found: DriveItemOut[] = [];
        let crumbs: DriveCrumb[] = [];
        // Folders come first: read until a file shows up (or the end).
        for (let page = 0; page < 20; page++) {
          const out = await api.driveChildren(folderId, { cursor, limit: 200 });
          crumbs = out.path;
          const pageFolders = out.items.filter((item) => item.kind === "folder");
          found.push(...pageFolders);
          if (!out.next_cursor || pageFolders.length < out.items.length) break;
          cursor = out.next_cursor;
        }
        if (!cancelled) {
          setFolders(found);
          setPath(crumbs);
        }
      } catch (failure) {
        if (!cancelled) {
          setFolders([]);
          setError(describeError(failure));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controller, folderId]);

  const copying = mode === "copy";
  const here = !copying && items.every((item) => item.parent_id === folderId);
  const submit = async () => {
    const api = controller.api;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const ids = items.map((item) => item.id);
      const out = copying ? await api.copyDriveItems(ids, folderId, "rename", opId) : await api.moveDriveItems(ids, folderId, "fail");
      const failed = out.results.filter((result) => !result.ok);
      if (failed.length > 0 && failed.length === items.length) {
        setError(describeError(new ApiError(409, failed[0]!.error ?? "unknown", "")));
        return;
      }
      onMoved(folderId, failed.length);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  const title = copying
    ? items.length === 1 ? t("drive.copyOne", { name: items[0]!.name }) : t("drive.copyMany", { count: items.length })
    : items.length === 1 ? t("drive.moveOne", { name: items[0]!.name }) : t("drive.moveMany", { count: items.length });
  return (
    <Modal onClose={onClose} title={title} growsDown className="w-[520px]">
      <div className="mt-4 flex gap-3 max-sm:flex-col">
        <ul aria-label={t("drive.locations")} className="w-44 shrink-0 space-y-0.5 max-sm:w-full">
          {locations.map((loc) => (
            <li key={loc.id}>
              <button
                type="button"
                onClick={() => {
                  setLocation(loc);
                  setFolderId(loc.root_id);
                }}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", loc.id === location.id ? "bg-accent-soft text-accent" : "hover:bg-ink/6")}
              >
                <HardDrive size={14} className="shrink-0" />
                <span className="truncate">{locationName(loc)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1 rounded-xl border border-line">
          <nav aria-label={t("drive.breadcrumbs")} className="flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1.5 text-xs">
            {path.map((crumb, index) => (
              <span key={crumb.id} className="flex items-center gap-0.5">
                {index > 0 && <ChevronRight size={12} className="text-muted" />}
                <button type="button" className="rounded px-1 py-0.5 hover:bg-ink/6" onClick={() => setFolderId(crumb.id)}>
                  {index === 0 ? locationName(location) : crumb.name}
                </button>
              </span>
            ))}
          </nav>
          <ul className="h-64 overflow-y-auto p-1" aria-label={t("drive.folders")}>
            {folders === null ? (
              <li className="flex h-full items-center justify-center text-muted"><Loader2 size={18} className="animate-spin" /></li>
            ) : folders.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted">{t("drive.noSubfolders")}</li>
            ) : (
              folders.map((folder) => (
                <li key={folder.id}>
                  <button
                    type="button"
                    disabled={moving.has(folder.id)}
                    onClick={() => setFolderId(folder.id)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink/6 disabled:opacity-40"
                  >
                    <Folder size={15} className="shrink-0 text-muted" />
                    <span className="flex-1 truncate">{folder.name}</span>
                    <ChevronRight size={14} className="text-muted" />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
      <p className="mt-2 truncate text-xs text-muted">{t(copying ? "drive.copyTo" : "drive.moveTo", { path: pathLine(path, locationName(location)) })}</p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button onClick={() => void submit()} disabled={busy || here || moving.has(folderId)}>{t(copying ? "drive.copyHere" : "drive.moveHere")}</Button>
      </div>
    </Modal>
  );
}

export function DeleteForeverDialog({ name, count, onClose, onConfirm }: { name: string; count: number; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={onClose} title={t("drive.deleteForever")} description={count > 1 ? t("drive.deleteForeverManyText", { name, count }) : t("drive.deleteForeverText", { name })}>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().finally(() => setBusy(false));
          }}
        >
          {t("drive.deleteForever")}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * The upload's name conflict (§17.3): 「上書きして版にする」 (the previous one stays as an older version), 「名前を変える」
 * (「名前 (1).pdf」), 「スキップ」; 「残りすべてに同じ操作」 answers the rest of this upload. A folder of that name can
 * take no version: only renaming and skipping are offered then.
 */
export function ConflictDialog({ question, onAnswer }: { question: ConflictQuestion; onAnswer: (choice: ConflictChoice, all: boolean) => void }) {
  const [all, setAll] = useState(false);
  const folder = question.existingKind === "folder";
  const where = question.job.relativeDir ? `${question.job.relativeDir}/${question.job.name}` : question.job.name;
  return (
    <Modal onClose={() => onAnswer("skip", false)} title={t("drive.conflict.title")} description={folder ? t("drive.conflict.folderText", { name: where }) : t("drive.conflict.text", { name: where })} hideClose>
      <div className="mt-4 flex flex-col gap-2" data-drive-conflict="">
        {!folder && (
          <Button onClick={() => onAnswer("version", all)} className="justify-start">
            {t("drive.conflict.version")}
          </Button>
        )}
        <Button variant={folder ? "primary" : "secondary"} onClick={() => onAnswer("rename", all)} className="justify-start">
          {t("drive.conflict.rename")}
        </Button>
        <Button variant="secondary" onClick={() => onAnswer("skip", all)} className="justify-start">
          {t("drive.conflict.skip")}
        </Button>
      </div>
      {question.remaining > 0 && (
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
          {t("drive.conflict.all", { count: question.remaining })}
        </label>
      )}
    </Modal>
  );
}
