/**
 * AL2 (docs/ALBUMS.md §9, §10.2, §18.4): the albums' dialogs on Desktop / Web.
 *
 * - 「新しいアルバム」: a name, a description and the days of the event; in the location's 「アルバム」 folder (POST
 *   /drive/albums {location_id}, made when missing; §17 Q2) or, inside a folder, in that folder ({parent_id}).
 * - The album's settings (its ⋯): the description, the days, the order, the cover (one of its photos, or the first),
 *   and 「アルバムをやめる」 (a plain folder again, its photos stay).
 * - 「ドライブから追加」: photos and videos picked in any drive I can read, moved within the album's location and
 *   copied from another (`mode: auto`; 「写す」 / 「移す」 can be chosen). A move of posted files asks first
 *   (POST /drive/items/impact, CHANNEL_FILES.md §6.4).
 * - 「アルバムに追加」 (a message's ⋯, the photo viewer): the message's photos into an album — the conversation's own
 *   drive's albums first, then the others, or a new one there (「#学会 2026-09-16」). A posted file goes into an album
 *   of its own channel's drive by a move (the message shows it as before), anywhere else by a copy unless 「移す」.
 */
import { Check, ChevronRight, Folder, FolderPlus, Images, Loader2, Search } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import type { AlbumCreatedOut, AlbumListEntryOut, AlbumOut, AttachmentOut, DriveItemOut, DriveLocationOut } from "../api/types";
import { ApiError, describeError } from "../api/errors";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { addSummary, albumLine, albumNameFor, type AlbumOrder, type AlbumSort, datesProblem, isAlbumMedia } from "../drive/albums";
import { locationName, pathLine, thumbnailPath } from "../drive/listing";
import { itemName, localizedPath } from "../drive/channelFiles";
import { DriveIcon, useThumbnail } from "./DriveBrowser";
import { DialogCrumbs, DialogLocations, ImpactDialog, newOpId, useDriveLocations, useFolderRows, useImpactCheck } from "./DriveDialogs";
import { FileName } from "./FileName";
import { Button, cn, Field, Input, Modal, Textarea } from "./primitives";
import { t } from "../i18n";

const SELECT = "h-9 w-full rounded-lg border border-line bg-canvas px-2 text-sm text-ink";
export const DESCRIPTION_MAX = 2000;

export type AddMode = "auto" | "copy" | "move";

/** 「新しいアルバム」. */
export function NewAlbumDialog({ controller, locations, location, folder, defaultName = "", onClose, onMade }: {
  controller: AppController;
  /** The locations it may go to (I can write there); the select shows when there are several. */
  locations: readonly DriveLocationOut[];
  location: DriveLocationOut | null;
  /** The folder open (not the top): 「このフォルダの中」 is offered. */
  folder?: { id: string; name: string } | null;
  defaultName?: string;
  onClose: () => void;
  onMade: (made: AlbumCreatedOut) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [locationId, setLocationId] = useState(location?.id ?? locations[0]?.id ?? "");
  const [inFolder, setInFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opId] = useState(newOpId);
  const here = folder && locationId === location?.id ? folder : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const api = controller.api;
    if (!api || !name.trim() || !locationId) return;
    const wrong = datesProblem(starts, ends);
    if (wrong) {
      setError(wrong);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const made = await api.createDriveAlbum({
        ...(here && inFolder ? { parent_id: here.id } : { location_id: locationId }),
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(starts ? { starts_on: starts } : {}),
        ...(ends ? { ends_on: ends } : {}),
        client_op_id: opId,
      });
      onMade(made);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("albums.new")} description={t("albums.newDescription")} className="w-[480px]">
      <form data-album-new="" onSubmit={(event) => void submit(event)} className="mt-4 space-y-3">
        <Field label={t("albums.name")}>
          <Input autoFocus value={name} maxLength={255} onChange={(event) => setName(event.target.value)} placeholder={t("albums.namePlaceholder")} aria-label={t("albums.name")} />
        </Field>
        {locations.length > 1 && (
          <Field label={t("albums.where")} hint={t("albums.whereHint")}>
            <select aria-label={t("albums.where")} className={SELECT} value={locationId} onChange={(event) => setLocationId(event.target.value)}>
              {locations.map((loc) => <option key={loc.id} value={loc.id}>{locationName(loc)}</option>)}
            </select>
          </Field>
        )}
        {here && (
          <fieldset className="space-y-1 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="album-where" checked={!inFolder} onChange={() => setInFolder(false)} /> {t("albums.inAlbumsFolder")}</label>
            <label className="flex items-center gap-2"><input type="radio" name="album-where" checked={inFolder} onChange={() => setInFolder(true)} /> {t("albums.inThisFolder", { name: here.name })}</label>
          </fieldset>
        )}
        <Field label={t("albums.description")}>
          <Textarea rows={3} maxLength={DESCRIPTION_MAX} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("albums.descriptionPlaceholder")} aria-label={t("albums.description")} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("albums.startsOn")}>
            <Input type="date" value={starts} onChange={(event) => setStarts(event.target.value)} aria-label={t("albums.startsOn")} />
          </Field>
          <Field label={t("albums.endsOn")}>
            <Input type="date" value={ends} min={starts || undefined} onChange={(event) => setEnds(event.target.value)} aria-label={t("albums.endsOn")} />
          </Field>
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !name.trim() || !locationId}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Images size={14} />} {t("albums.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}

function CoverChoice({ controller, item, chosen, onPick }: { controller: AppController; item: DriveItemOut; chosen: boolean; onPick: () => void }) {
  const url = useThumbnail(controller, thumbnailPath(item));
  return (
    <button type="button" data-cover-choice={item.id} aria-pressed={chosen} title={item.name} onClick={onPick} className={cn("relative aspect-square overflow-hidden rounded-md bg-panel", chosen ? "ring-2 ring-accent" : "ring-1 ring-line hover:ring-ink/30")}>
      {url ? <img src={url} alt={item.name} className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center"><DriveIcon item={item} size={20} /></span>}
      {chosen && <span className="absolute right-1 top-1 rounded-full bg-accent p-0.5 text-white"><Check size={11} /></span>}
    </button>
  );
}

/** The album's settings: description, days, order, cover; 「アルバムをやめる」. */
export function AlbumSettingsDialog({ controller, folder, album, photos, onClose, onSaved, onRemoved }: {
  controller: AppController;
  folder: DriveItemOut;
  album: AlbumOut;
  /** The photos listed so far (the cover is picked among them). */
  photos: readonly DriveItemOut[];
  onClose: () => void;
  onSaved: (album: AlbumOut) => void;
  onRemoved: () => void;
}) {
  const [description, setDescription] = useState(album.description);
  const [starts, setStarts] = useState(album.starts_on ?? "");
  const [ends, setEnds] = useState(album.ends_on ?? "");
  const [sort, setSort] = useState<AlbumSort>(album.sort);
  const [order, setOrder] = useState<AlbumOrder>(album.sort_order);
  const [cover, setCover] = useState<string | null>(album.cover_item_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const choices = photos.filter((item) => isAlbumMedia(item) && !!thumbnailPath(item)).slice(0, 48);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const api = controller.api;
    if (!api) return;
    const wrong = datesProblem(starts, ends);
    if (wrong) {
      setError(wrong);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.putDriveAlbum(folder.id, {
        description: description.trim(),
        starts_on: starts || null,
        ends_on: ends || null,
        sort,
        sort_order: order,
        cover_item_id: cover,
      }));
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const api = controller.api;
    if (!api) return;
    setBusy(true);
    try {
      await api.deleteDriveAlbum(folder.id);
      controller.setNotice(t("albums.removed", { name: folder.name }));
      onRemoved();
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("albums.settings.title", { name: folder.name })} growsDown className="w-[560px]">
      <form data-album-settings="" onSubmit={(event) => void save(event)} className="mt-4 space-y-3">
        <Field label={t("albums.description")}>
          <Textarea rows={3} maxLength={DESCRIPTION_MAX} value={description} onChange={(event) => setDescription(event.target.value)} aria-label={t("albums.description")} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("albums.startsOn")}>
            <Input type="date" value={starts} onChange={(event) => setStarts(event.target.value)} aria-label={t("albums.startsOn")} />
          </Field>
          <Field label={t("albums.endsOn")}>
            <Input type="date" value={ends} min={starts || undefined} onChange={(event) => setEnds(event.target.value)} aria-label={t("albums.endsOn")} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("albums.sort")}>
            <select aria-label={t("albums.sort")} className={SELECT} value={sort} onChange={(event) => setSort(event.target.value as AlbumSort)}>
              <option value="taken">{t("albums.sort.taken")}</option>
              <option value="name">{t("albums.sort.name")}</option>
              <option value="added">{t("albums.sort.added")}</option>
            </select>
          </Field>
          <Field label={t("albums.order")}>
            <select aria-label={t("albums.order")} className={SELECT} value={order} onChange={(event) => setOrder(event.target.value as AlbumOrder)}>
              <option value="asc">{t("albums.order.asc")}</option>
              <option value="desc">{t("albums.order.desc")}</option>
            </select>
          </Field>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-muted">{t("albums.cover")}</span>
            <button type="button" className={cn("text-xs", cover === null ? "font-semibold text-ink" : "text-accent hover:underline")} aria-pressed={cover === null} onClick={() => setCover(null)}>{t("albums.coverFirst")}</button>
          </div>
          {choices.length === 0 ? (
            <p className="text-xs text-muted">{t("albums.coverNone")}</p>
          ) : (
            <div className="grid max-h-56 grid-cols-6 gap-1.5 overflow-y-auto p-0.5">
              {choices.map((item) => <CoverChoice key={item.id} controller={controller} item={item} chosen={cover === item.id} onPick={() => setCover(item.id)} />)}
            </div>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button type="button" variant="ghost" className="text-danger" onClick={() => setConfirmRemove(true)}>{t("albums.unmake")}</Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={busy}>{t("common.save")}</Button>
          </div>
        </div>
      </form>
      {confirmRemove && (
        <Modal onClose={() => setConfirmRemove(false)} title={t("albums.unmakeTitle")} description={t("albums.unmakeText", { name: folder.name })}>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmRemove(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>{t("albums.unmake")}</Button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

function ModeChoice({ mode, onMode, autoHint }: { mode: AddMode; onMode: (mode: AddMode) => void; autoHint: string }) {
  return (
    <fieldset data-album-mode={mode} className="mt-3 space-y-1 text-sm">
      <legend className="mb-1 text-xs font-medium text-muted">{t("albums.add.how")}</legend>
      {(["auto", "copy", "move"] as const).map((value) => (
        <label key={value} className="flex items-start gap-2">
          <input type="radio" name="album-add-mode" className="mt-1" checked={mode === value} onChange={() => onMode(value)} />
          <span>
            {t(`albums.add.mode.${value}`)}
            {value === "auto" && <span className="block text-xs text-muted">{autoHint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function PickRow({ controller, item, picked, onToggle }: { controller: AppController; item: DriveItemOut; picked: boolean; onToggle: () => void }) {
  const url = useThumbnail(controller, thumbnailPath(item));
  return (
    <label className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm", picked ? "bg-accent-soft" : "hover:bg-ink/6")}>
      <input type="checkbox" checked={picked} onChange={onToggle} aria-label={t("drive.selectItem", { name: item.name })} />
      {url ? <img src={url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" /> : <span className="flex h-8 w-8 shrink-0 items-center justify-center"><DriveIcon item={item} size={18} /></span>}
      <FileName name={item.name} className="min-w-0 flex-1" />
    </label>
  );
}

/** 「ドライブから追加」. */
export function AddFromDriveDialog({ controller, album, onClose, onAdded }: {
  controller: AppController;
  /** The album's folder. */
  album: DriveItemOut;
  onClose: () => void;
  onAdded: (count: number) => void;
}) {
  const api = controller.api;
  const locations = useDriveLocations(controller, () => true);
  const [place, setPlace] = useState<{ location: DriveLocationOut; folderId: string } | null>(null);
  useEffect(() => {
    if (place || !locations || locations.length === 0) return;
    const first = locations.find((loc) => loc.id === album.location_id) ?? locations[0]!;
    setPlace({ location: first, folderId: first.root_id });
  }, [place, locations, album.location_id]);
  const { rows, path, error: listError } = useFolderRows(controller, place?.folderId ?? null, true);
  const [picked, setPicked] = useState<Map<string, DriveItemOut>>(new Map());
  const [mode, setMode] = useState<AddMode>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opId] = useState(newOpId);
  const impact = useImpactCheck(controller);
  const folders = (rows ?? []).filter((item) => item.kind === "folder" && item.id !== album.id);
  const media = pickablePhotos(rows ?? [], album.id);
  const toggle = (item: DriveItemOut) => setPicked((held) => {
    const next = new Map(held);
    if (next.has(item.id)) next.delete(item.id);
    else next.set(item.id, item);
    return next;
  });
  const submit = async () => {
    if (!api || picked.size === 0) return;
    const items = [...picked.values()];
    // What will move: everything with 「移す」, the same location's with 「自動」.
    const moving = items.filter((item) => mode === "move" || (mode === "auto" && item.location_id === album.location_id)).map((item) => item.id);
    if (moving.length > 0 && !(await impact.confirm(moving, album.id))) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.addToDriveAlbum(album.id, { item_ids: items.map((item) => item.id), mode, client_op_id: opId });
      const summary = addSummary(out.results);
      if (summary.done === 0) {
        setError(summary.error ? describeError(new ApiError(409, summary.error, "")) : t("albums.add.failed"));
        return;
      }
      if (summary.failed > 0) controller.setError(t("albums.add.someFailed", { count: summary.failed }));
      controller.setNotice(t("albums.add.done", { count: summary.done, name: album.name }));
      onAdded(summary.done);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  const location = place?.location ?? null;
  return (
    <Modal onClose={onClose} title={t("albums.add.fromDrive")} description={t("albums.add.fromDriveDescription", { name: album.name })} growsDown className="w-[680px]">
      <div className="mt-4 flex gap-3 max-sm:flex-col">
        <DialogLocations locations={locations ?? []} current={location} onPick={(loc) => setPlace({ location: loc, folderId: loc.root_id })} />
        <div className="min-w-0 flex-1 rounded-xl border border-line">
          <DialogCrumbs path={path} location={location} onPick={(folderId) => location && setPlace({ location, folderId })} />
          <ul className="h-72 overflow-y-auto p-1" aria-label={t("albums.add.files")}>
            {rows === null ? (
              <li className="flex h-full items-center justify-center text-muted"><Loader2 size={18} className="animate-spin" /></li>
            ) : folders.length === 0 && media.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted">{t("albums.add.noPhotosHere")}</li>
            ) : (
              <>
                {folders.map((folder) => (
                  <li key={folder.id}>
                    <button type="button" onClick={() => location && setPlace({ location, folderId: folder.id })} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink/6">
                      {folder.album ? <Images size={15} className="shrink-0 text-muted" /> : <Folder size={15} className="shrink-0 text-muted" />}
                      <span className="flex-1 truncate">{itemName(folder)}</span>
                      <ChevronRight size={14} className="text-muted" />
                    </button>
                  </li>
                ))}
                {media.map((item) => <li key={item.id}><PickRow controller={controller} item={item} picked={picked.has(item.id)} onToggle={() => toggle(item)} /></li>)}
              </>
            )}
          </ul>
        </div>
      </div>
      {listError && <p role="alert" className="mt-2 text-sm text-danger">{listError}</p>}
      <ModeChoice mode={mode} onMode={setMode} autoHint={t("albums.add.autoHintDrive")} />
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{t("albums.add.picked", { count: picked.size })}</span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={busy || picked.size === 0} onClick={() => void submit()}>{busy && <Loader2 size={14} className="animate-spin" />} {t("albums.add.submit")}</Button>
        </div>
      </div>
      {impact.asking && <ImpactDialog controller={controller} asking={impact.asking} />}
    </Modal>
  );
}

function AlbumChoice({ controller, entry, chosen, onPick }: { controller: AppController; entry: AlbumListEntryOut; chosen: boolean; onPick: () => void }) {
  const cover = entry.album.cover?.attachment_id ?? entry.album.preview_attachment_ids[0] ?? null;
  const url = useThumbnail(controller, cover ? `/api/v1/attachments/${cover}/thumbnail` : null);
  const where = pathLine(localizedPath(entry.path, entry.location_kind), entry.location_kind === "workspace" ? t("drive.location.workspace") : entry.location_kind === "user" ? t("drive.location.mine") : `#${entry.path[0]?.name ?? ""}`);
  return (
    <button type="button" data-album-choice={entry.folder.id} aria-pressed={chosen} onClick={onPick} className={cn("flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left", chosen ? "bg-accent-soft" : "hover:bg-ink/6")}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-panel ring-1 ring-line">
        {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <Images size={18} className="text-muted" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{entry.folder.name}</span>
        <span className="block truncate text-xs text-muted">{[albumLine(entry.album), where].filter(Boolean).join(" · ")}</span>
      </span>
      {chosen && <Check size={16} className="shrink-0 text-accent" />}
    </button>
  );
}

/** 「アルバムに追加」 for a message's photos (and the photo viewer's). */
export function AddToAlbumDialog({ controller, attachments, channel, postedAt, onClose }: {
  controller: AppController;
  attachments: readonly AttachmentOut[];
  channel: ChannelState | null;
  /** When the message was posted (a new album's default name). */
  postedAt: string;
  onClose: () => void;
}) {
  const api = controller.api;
  const [albums, setAlbums] = useState<AlbumListEntryOut[] | null>(null);
  const [home, setHome] = useState<DriveLocationOut | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | "new" | null>(null);
  const [name, setName] = useState(() => albumNameFor(channel && channel.type !== "dm" && channel.type !== "group_dm" ? channel.name : null, postedAt));
  const [mode, setMode] = useState<AddMode>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opId] = useState(newOpId);
  const [albumOpId] = useState(newOpId);
  const impact = useImpactCheck(controller);
  useEffect(() => {
    if (!api) return;
    let current = true;
    void (async () => {
      // The conversation's own drive (a channel), else マイドライブ (a DM, a guest has none: the list only).
      let found: DriveLocationOut | null = null;
      try {
        if (channel && (channel.type === "public" || channel.type === "private")) found = await api.resolveDriveLocation({ kind: "channel", channel_id: channel.id });
      } catch {
        found = null;
      }
      if (!found?.can_write && !controller.isGuest) {
        try {
          found = await api.resolveDriveLocation({ kind: "me" });
        } catch {
          found = null;
        }
      }
      if (current) setHome(found?.can_write ? found : null);
    })();
    void api.driveAlbums({ limit: 100 }).then(
      (out) => { if (current) setAlbums(out.items.filter((entry) => !entry.folder.trashed_at)); },
      (failure) => { if (current) { setAlbums([]); setError(describeError(failure)); } },
    );
    return () => {
      current = false;
    };
  }, [api, channel, controller.isGuest]);
  // The conversation's own drive's albums first (§9).
  const listed = useMemo(() => {
    const words = query.trim().toLowerCase();
    const all = (albums ?? []).filter((entry) => !words || entry.folder.name.toLowerCase().includes(words));
    const homeId = home?.id;
    return [...all.filter((entry) => entry.folder.location_id === homeId), ...all.filter((entry) => entry.folder.location_id !== homeId)];
  }, [albums, query, home]);
  const target = chosen && chosen !== "new" ? (albums ?? []).find((entry) => entry.folder.id === chosen) ?? null : null;
  const posted = attachments.filter((attachment) => attachment.drive?.item_id && attachment.drive.state === "available");
  const submit = async () => {
    if (!api || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      let folder: DriveItemOut;
      if (chosen === "new") {
        if (!home || !name.trim()) return;
        folder = (await api.createDriveAlbum({ location_id: home.id, name: name.trim(), client_op_id: albumOpId })).folder;
      } else {
        if (!target) return;
        folder = target.folder;
      }
      // A move that hides posted files from their messages asks first (§9, CHANNEL_FILES.md §6.4).
      if (mode === "move" && posted.length > 0) {
        setBusy(false);
        if (!(await impact.confirm(posted.map((attachment) => attachment.drive!.item_id!), folder.id))) return;
        setBusy(true);
      }
      const out = await api.addToDriveAlbum(folder.id, { attachment_ids: attachments.map((attachment) => attachment.id), mode, client_op_id: opId });
      const summary = addSummary(out.results);
      if (summary.done === 0) {
        setError(summary.error ? describeError(new ApiError(409, summary.error, "")) : t("albums.add.failed"));
        return;
      }
      if (summary.failed > 0) controller.setError(t("albums.add.someFailed", { count: summary.failed }));
      const open = { locationId: folder.location_id, folderId: folder.id };
      controller.setNotice(t("albums.add.done", { count: summary.done, name: folder.name }), { label: t("albums.open"), run: () => controller.requestShowInDrive(open) });
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("albums.add.toAlbum")} description={t("albums.add.toAlbumDescription", { count: attachments.length })} growsDown className="w-[520px]">
      <label className="relative mt-4 flex items-center">
        <Search size={14} className="pointer-events-none absolute left-2.5 text-muted" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("albums.search")} aria-label={t("albums.search")} className="h-8 pl-8 text-[13px]" />
      </label>
      <ul data-album-choices="" className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-line p-1" aria-label={t("albums.title")}>
        {home && (
          <li>
            <button type="button" data-album-choice="new" aria-pressed={chosen === "new"} onClick={() => setChosen("new")} className={cn("flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm", chosen === "new" ? "bg-accent-soft" : "hover:bg-ink/6")}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-panel ring-1 ring-line"><FolderPlus size={18} className="text-muted" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t("albums.new")}</span>
                <span className="block truncate text-xs text-muted">{t("albums.newIn", { where: locationName(home) })}</span>
              </span>
            </button>
          </li>
        )}
        {albums === null ? (
          <li className="flex justify-center py-6 text-muted"><Loader2 size={18} className="animate-spin" /></li>
        ) : listed.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-muted">{query.trim() ? t("albums.noMatch") : t("albums.none")}</li>
        ) : (
          listed.map((entry) => <li key={entry.folder.id}><AlbumChoice controller={controller} entry={entry} chosen={chosen === entry.folder.id} onPick={() => setChosen(entry.folder.id)} /></li>)
        )}
      </ul>
      {chosen === "new" && (
        <Field label={t("albums.name")}>
          <Input autoFocus value={name} maxLength={255} onChange={(event) => setName(event.target.value)} aria-label={t("albums.name")} />
        </Field>
      )}
      <ModeChoice mode={mode} onMode={setMode} autoHint={t("albums.add.autoHintMessage")} />
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={busy || !chosen || (chosen === "new" && !name.trim())} onClick={() => void submit()}>{busy && <Loader2 size={14} className="animate-spin" />} {t("albums.add.submit")}</Button>
      </div>
      {impact.asking && <ImpactDialog controller={controller} asking={impact.asking} />}
    </Modal>
  );
}

/** The photos and videos to offer from a folder listing (the drive picker). */
export function pickablePhotos(rows: readonly DriveItemOut[], albumId: string): DriveItemOut[] {
  return rows.filter((item) => isAlbumMedia(item) && item.parent_id !== albumId);
}
