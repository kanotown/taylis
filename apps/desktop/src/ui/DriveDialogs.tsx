/**
 * The drive's dialogs (M161, docs/DRIVE.md §17): a new folder, a new name, moving to a folder picked from the
 * locations I can write, deleting for good from the trash, and the name-conflict question of an upload.
 */
import { ChevronRight, Folder, HardDrive, Loader2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DriveCrumb, DriveImpactOut, DriveItemOut, DriveLocationOut } from "../api/types";
import { ApiError, describeError } from "../api/errors";
import type { AppController } from "../state/app";
import { locationName, orderLocations, pathLine } from "../drive/listing";
import { crumbName, impactLines, itemName, localizedPath, needsImpactWarning } from "../drive/channelFiles";
import type { ConflictChoice, ConflictQuestion } from "../drive/uploads";
import { Button, cn, Input, Modal } from "./primitives";
import { t } from "../i18n";

export function newOpId(): string {
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
 * The locations listed in a drive dialog (M165: shared by 「移動」 / 「コピー」, 「ドライブに保存」 and the composer's
 * 「ドライブから」): read once, in the location list's order, filtered (`can_write` for a target).
 */
export function useDriveLocations(controller: AppController, keep: (location: DriveLocationOut) => boolean, initial: DriveLocationOut[] = []): DriveLocationOut[] | null {
  const [locations, setLocations] = useState<DriveLocationOut[] | null>(initial.length > 0 ? initial : null);
  const keepRef = useRef(keep);
  keepRef.current = keep;
  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    let cancelled = false;
    void api.driveLocations().then(
      (out) => { if (!cancelled) setLocations(orderLocations(out.locations.filter((loc) => keepRef.current(loc)))); },
      () => { if (!cancelled) setLocations((held) => held ?? []); },
    );
    return () => {
      cancelled = true;
    };
  }, [controller.api]);
  return locations;
}

/**
 * A folder's rows for a drive dialog: its folders (read until a file shows up, they come first), and with `files` its
 * files too (up to 1,000 rows), and the path from the root. Null while it is being read.
 */
export function useFolderRows(controller: AppController, folderId: string | null, files = false): { rows: DriveItemOut[] | null; path: DriveCrumb[]; error: string | null } {
  const [rows, setRows] = useState<DriveItemOut[] | null>(null);
  const [path, setPath] = useState<DriveCrumb[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const api = controller.api;
    if (!api || !folderId) return;
    let cancelled = false;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        let cursor: string | null = null;
        const found: DriveItemOut[] = [];
        let crumbs: DriveCrumb[] = [];
        for (let page = 0; page < (files ? 5 : 20); page++) {
          const out = await api.driveChildren(folderId, { cursor, limit: 200 });
          crumbs = out.path;
          const kept = files ? out.items : out.items.filter((item) => item.kind === "folder");
          found.push(...kept);
          if (!out.next_cursor || kept.length < out.items.length) break;
          cursor = out.next_cursor;
        }
        if (!cancelled) {
          setRows(found);
          setPath(crumbs);
        }
      } catch (failure) {
        if (!cancelled) {
          setRows([]);
          setError(describeError(failure));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controller, folderId, files]);
  return { rows, path, error };
}

/** The dialogs' list of locations on the left. */
export function DialogLocations({ locations, current, onPick }: { locations: readonly DriveLocationOut[]; current: DriveLocationOut | null; onPick: (location: DriveLocationOut) => void }) {
  return (
    <ul aria-label={t("drive.locations")} className="w-44 shrink-0 space-y-0.5 overflow-y-auto max-sm:max-h-40 max-sm:w-full">
      {locations.map((loc) => (
        <li key={loc.id}>
          <button
            type="button"
            onClick={() => onPick(loc)}
            className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", loc.id === current?.id ? "bg-accent-soft text-accent" : "hover:bg-ink/6")}
          >
            <HardDrive size={14} className="shrink-0" />
            <span className="truncate">{locationName(loc)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The pickers' two columns (2026-10-31, docs/DRIVE.md §27.8): one fixed height on a wide screen, the locations scrolling
 * on the left and the rows filling the box on the right. Before, the rows had a fixed height while the box stretched to
 * a long locations column (a lab with many channels), which left an empty band under the list.
 */
export const DIALOG_COLUMNS = "flex gap-3 sm:h-80 max-sm:flex-col";
/** The rows under the breadcrumbs: the rest of the box (a fixed height when the columns stack on a phone). */
export const DIALOG_LIST = "min-h-0 flex-1 overflow-y-auto p-1 max-sm:h-72 max-sm:flex-none";

/** The dialogs' breadcrumbs over a folder's rows (the root named after the location). */
export function DialogCrumbs({ path, location, onPick }: { path: readonly DriveCrumb[]; location: DriveLocationOut | null; onPick: (folderId: string) => void }) {
  return (
    <nav aria-label={t("drive.breadcrumbs")} className="flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1.5 text-xs">
      {path.map((crumb, index) => (
        <span key={crumb.id} className="flex items-center gap-0.5">
          {index > 0 && <ChevronRight size={12} className="text-muted" />}
          <button type="button" className="rounded px-1 py-0.5 hover:bg-ink/6" onClick={() => onPick(crumb.id)}>
            {index === 0 && location ? locationName(location) : crumbName(crumb, index, location?.kind)}
          </button>
        </span>
      ))}
    </nav>
  );
}

/** A folder row of the dialogs: a press opens it. */
export function DialogFolderRow({ folder, disabled = false, onOpen }: { folder: DriveItemOut; disabled?: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink/6 disabled:opacity-40"
    >
      <Folder size={15} className="shrink-0 text-muted" />
      <span className="flex-1 truncate">{itemName(folder)}</span>
      <ChevronRight size={14} className="text-muted" />
    </button>
  );
}

/**
 * A folder to put things in (M165: 「移動」 / 「コピー」 and 「ドライブに保存」): the locations I can write on the left,
 * the folder's subfolders on the right. `start` null: the location `pickStart` chooses once the list is read.
 */
export function FolderPicker({ controller, start, pickStart, disabledIds, onChange }: {
  controller: AppController;
  start: { location: DriveLocationOut; folderId: string } | null;
  pickStart?: (locations: readonly DriveLocationOut[]) => DriveLocationOut | null;
  disabledIds?: ReadonlySet<string>;
  onChange: (place: { location: DriveLocationOut; folderId: string; path: DriveCrumb[] }) => void;
}) {
  const locations = useDriveLocations(controller, (loc) => loc.can_write, start ? [start.location] : []);
  const [place, setPlace] = useState(start);
  useEffect(() => {
    if (place || !locations) return;
    const first = pickStart?.(locations) ?? locations[0] ?? null;
    if (first) setPlace({ location: first, folderId: first.root_id });
  }, [place, locations, pickStart]);
  const { rows: folders, path, error } = useFolderRows(controller, place?.folderId ?? null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (place && folders !== null) onChangeRef.current({ location: place.location, folderId: place.folderId, path });
  }, [place, folders, path]);
  const location = place?.location ?? null;
  return (
    <>
      <div data-dialog-columns="" className={cn("mt-4", DIALOG_COLUMNS)}>
        <DialogLocations locations={locations ?? []} current={location} onPick={(loc) => setPlace({ location: loc, folderId: loc.root_id })} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-line">
          <DialogCrumbs path={path} location={location} onPick={(folderId) => location && setPlace({ location, folderId })} />
          <ul className={DIALOG_LIST} aria-label={t("drive.folders")}>
            {folders === null ? (
              <li className="flex h-full items-center justify-center text-muted"><Loader2 size={18} className="animate-spin" /></li>
            ) : folders.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted">{locations && locations.length === 0 ? t("driveSave.noLocations") : t("drive.noSubfolders")}</li>
            ) : (
              folders.map((folder) => (
                <li key={folder.id}>
                  <DialogFolderRow folder={folder} disabled={disabledIds?.has(folder.id)} onOpen={() => location && setPlace({ location, folderId: folder.id })} />
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </>
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
  const [start] = useState(() => ({ location: startLocation, folderId: startFolderId }));
  const [place, setPlace] = useState<{ location: DriveLocationOut; folderId: string; path: DriveCrumb[] }>({ ...start, path: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moving = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const folderId = place.folderId;

  const copying = mode === "copy";
  const here = !copying && items.every((item) => item.parent_id === folderId);
  // CF2 (docs/CHANNEL_FILES.md §6.4): a move that hides posted files from messages is confirmed here first.
  const [warning, setWarning] = useState<{ impact: DriveImpactOut; folderId: string } | null>(null);
  const submit = async () => {
    const api = controller.api;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const ids = items.map((item) => item.id);
      if (!copying && warning?.folderId !== folderId) {
        const impact = await api.driveImpact(ids, folderId).catch(() => null);
        if (needsImpactWarning(impact)) {
          setWarning({ impact, folderId });
          return;
        }
      }
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
    ? items.length === 1 ? t("drive.copyOne", { name: itemName(items[0]!) }) : t("drive.copyMany", { count: items.length })
    : items.length === 1 ? t("drive.moveOne", { name: itemName(items[0]!) }) : t("drive.moveMany", { count: items.length });
  const warned = warning?.folderId === folderId ? warning.impact : null;
  return (
    <Modal onClose={onClose} title={title} growsDown className="w-[520px]">
      <FolderPicker controller={controller} start={start} disabledIds={moving} onChange={setPlace} />
      <p className="mt-2 truncate text-xs text-muted">{t(copying ? "drive.copyTo" : "drive.moveTo", { path: pathLine(localizedPath(place.path, place.location.kind), locationName(place.location)) })}</p>
      {warned && <ImpactLines controller={controller} impact={warned} mode="move" className="mt-3" />}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button onClick={() => void submit()} disabled={busy || here || moving.has(folderId)}>{warned ? t("channelFiles.impact.move") : t(copying ? "drive.copyHere" : "drive.moveHere")}</Button>
      </div>
    </Modal>
  );
}

/** CF2 (docs/CHANNEL_FILES.md §6.4, §6.5): what a move or a trash would do to the messages showing posted files. */
function ImpactLines({ controller, impact, mode, className }: { controller: AppController; impact: DriveImpactOut; mode: "move" | "trash"; className?: string }) {
  const lines = impactLines(impact, mode, (id) => controller.store.getChannel(id)?.name ?? null);
  return (
    <div data-drive-impact={mode} role="note" className={cn("space-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-[13px]", className)}>
      {lines.map((line, index) => <p key={index}>{line}</p>)}
    </div>
  );
}

export interface ImpactAsk {
  impact: DriveImpactOut;
  mode: "move" | "trash";
  answer: (go: boolean) => void;
}

/**
 * CF2: before a trash (or a move by dragging or ⌘V) the server is asked what it would do to the messages showing posted
 * files (POST /drive/items/impact); only when some message would change is the person asked. A failure to ask (a server
 * before CF1, offline) does not stop the action: the action itself reports what goes wrong.
 */
export function useImpactCheck(controller: AppController): { asking: ImpactAsk | null; confirm: (ids: string[], targetFolderId: string | null) => Promise<boolean> } {
  const [asking, setAsking] = useState<ImpactAsk | null>(null);
  const confirm = useCallback(async (ids: string[], targetFolderId: string | null) => {
    const api = controller.api;
    if (!api || ids.length === 0) return true;
    const impact = await api.driveImpact(ids, targetFolderId).catch(() => null);
    if (!needsImpactWarning(impact)) return true;
    return new Promise<boolean>((resolve) => {
      setAsking({ impact, mode: targetFolderId ? "move" : "trash", answer: (go) => { setAsking(null); resolve(go); } });
    });
  }, [controller]);
  return { asking, confirm };
}

export function ImpactDialog({ controller, asking }: { controller: AppController; asking: ImpactAsk }) {
  const trash = asking.mode === "trash";
  return (
    <Modal onClose={() => asking.answer(false)} title={trash ? t("channelFiles.impact.titleTrash") : t("channelFiles.impact.titleMove")} className="w-[460px]">
      <ImpactLines controller={controller} impact={asking.impact} mode={asking.mode} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => asking.answer(false)}>{t("common.cancel")}</Button>
        <Button variant={trash ? "danger" : "primary"} onClick={() => asking.answer(true)}>{trash ? t("drive.toTrash") : t("channelFiles.impact.move")}</Button>
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
