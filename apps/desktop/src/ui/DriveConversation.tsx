/**
 * M165 (docs/DRIVE.md §13): the drive in the conversations, on the conversation's side.
 *
 * - 「ドライブから」 (the composer's ＋): a file or folder picked in any drive I can read, sent as a **link** (the
 *   default: `<server>/d/<id>` in the draft, a card for whoever can read the item) or a **copy** (a file's current
 *   version as an ordinary attachment, POST /drive/items/{id}/attach-copy). The reach of the pick (how many of this
 *   conversation's members cannot read it) is shown before either is chosen.
 * - The draft's warning: a drive link in the draft that some members cannot read (pasted, or put there by the picker)
 *   says so above the text, with 「コピーとして送る」 (the link out, the copy in) and 「このまま」.
 * - 「ドライブに保存」 (a message's ⋯, the viewers): attachments copied into a drive folder I pick (POST
 *   /drive/save-attachment); the conversation's own drive first, a DM's: マイドライブ.
 */
import { ChevronRight, HardDriveDownload, Hash, Loader2, Lock, Mail, Search, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AttachmentOut, DriveCrumb, DriveItemOut, DriveLocationOut, DriveReachOut, DriveSearchHitOut } from "../api/types";
import { describeError } from "../api/errors";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { defaultSaveLocation, reachWarning } from "../drive/conversation";
import { formatBytes, locationName, pathLine } from "../drive/listing";
import { ATTACHMENT_MAX_BYTES } from "../platform/pickedFiles";
import { DriveIcon } from "./DriveBrowser";
import { DialogCrumbs, DialogLocations, FolderPicker, newOpId, useDriveLocations, useFolderRows } from "./DriveDialogs";
import { hitPath } from "./DriveSearch";
import { FileName } from "./FileName";
import { driveLink, driveLinksIn } from "./permalink";
import { Button, cn, Input, Modal } from "./primitives";
import { t } from "../i18n";

/** The reach of an item in this conversation, asked when `itemId` changes (null while asked, or when it cannot be told). */
export function useDriveReach(controller: AppController, itemId: string | null, channelId: string): DriveReachOut | null {
  const [reach, setReach] = useState<{ key: string; reach: DriveReachOut | null } | null>(null);
  const key = itemId ? `${itemId}|${channelId}` : null;
  useEffect(() => {
    if (!itemId) return;
    let current = true;
    void controller.driveReach(itemId, channelId).then((found) => {
      if (current) setReach({ key: `${itemId}|${channelId}`, reach: found });
    });
    return () => {
      current = false;
    };
  }, [controller, itemId, channelId]);
  return reach && reach.key === key ? reach.reach : null;
}

/** Whether a drive file can go as a copy (a folder cannot; a copy is an attachment, 100 MB at most). */
export function copyRefusal(item: Pick<DriveItemOut, "kind" | "size_bytes">): string | null {
  if (item.kind !== "file") return t("driveLink.copyNoFolder");
  if ((item.size_bytes ?? 0) > ATTACHMENT_MAX_BYTES) return t("driveLink.copyTooLarge", { size: formatBytes(ATTACHMENT_MAX_BYTES) });
  return null;
}

/**
 * 「ドライブから」: the locations I can read on the left (this channel's drive first when it has one), the folder's
 * folders and files (or the search's hits) on the right. A row selects; a folder's ▸ (or a double click) opens it.
 */
export function DrivePickerDialog({ controller, channel, onLink, onCopy, onClose }: {
  controller: AppController;
  channel: ChannelState;
  onLink: (item: DriveItemOut) => void;
  onCopy: (attachment: AttachmentOut) => void;
  onClose: () => void;
}) {
  const api = controller.api;
  const locations = useDriveLocations(controller, () => true);
  const [place, setPlace] = useState<{ location: DriveLocationOut; folderId: string } | null>(null);
  useEffect(() => {
    if (place || !locations || locations.length === 0) return;
    const first = locations.find((loc) => loc.kind === "channel" && loc.channel_id === channel.id) ?? locations[0]!;
    setPlace({ location: first, folderId: first.root_id });
  }, [place, locations, channel.id]);
  const { rows, path, error: listError } = useFolderRows(controller, place?.folderId ?? null, true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DriveSearchHitOut[] | null>(null);
  const words = query.trim();
  useEffect(() => {
    if (!api || !words) {
      setHits(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void api.searchDrive({ q: words, limit: 50 }).then(
        (out) => { if (current) setHits(out.items); },
        () => { if (current) setHits([]); },
      );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, words]);
  const [selected, setSelected] = useState<DriveItemOut | null>(null);
  const reach = useDriveReach(controller, selected?.id ?? null, channel.id);
  const warning = reachWarning(reach, channel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refusal = selected ? copyRefusal(selected) : null;

  const open = (folder: DriveItemOut) => {
    if (!place) return;
    const location = locations?.find((loc) => loc.id === folder.location_id) ?? place.location;
    setQuery("");
    setSelected(null);
    setPlace({ location, folderId: folder.id });
  };
  const copy = async () => {
    if (!api || !selected || refusal) return;
    setBusy(true);
    setError(null);
    try {
      onCopy(await api.attachDriveCopy(selected.id));
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  const listed: Array<{ item: DriveItemOut; where?: string }> = hits !== null ? hits.map((hit) => ({ item: hit.item, where: hitPath(hit) })) : (rows ?? []).map((item) => ({ item }));
  const loading = words ? hits === null : rows === null;

  return (
    <Modal onClose={onClose} title={t("driveLink.pickTitle")} description={t("driveLink.pickDescription")} growsDown className="w-[640px]">
      <div className="relative mt-4">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("driveLink.searchPlaceholder")} aria-label={t("driveLink.searchPlaceholder")} className="pl-8" />
      </div>
      <div className="mt-3 flex gap-3 max-sm:flex-col">
        <DialogLocations locations={locations ?? []} current={words ? null : (place?.location ?? null)} onPick={(loc) => { setQuery(""); setSelected(null); setPlace({ location: loc, folderId: loc.root_id }); }} />
        <div className="min-w-0 flex-1 rounded-xl border border-line">
          {words ? <div className="border-b border-line px-3 py-1.5 text-xs text-muted">{t("driveLink.searchAll")}</div> : <DialogCrumbs path={path} location={place?.location ?? null} onPick={(folderId) => place && setPlace({ location: place.location, folderId })} />}
          <ul className="h-72 overflow-y-auto p-1" aria-label={t("driveLink.items")} data-drive-picker="">
            {loading ? (
              <li className="flex h-full items-center justify-center text-muted"><Loader2 size={18} className="animate-spin" /></li>
            ) : listed.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted">{words ? t("search.drive.none", { q: words }) : locations?.length === 0 ? t("driveSave.noLocations") : t("driveLink.emptyFolder")}</li>
            ) : (
              listed.map(({ item, where }) => (
                <li key={item.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-pressed={selected?.id === item.id}
                    onClick={() => setSelected(item)}
                    onDoubleClick={() => (item.kind === "folder" ? open(item) : onLink(item))}
                    className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", selected?.id === item.id ? "bg-accent-soft" : "hover:bg-ink/6")}
                  >
                    <DriveIcon item={item} size={16} />
                    <span className="min-w-0 flex-1">
                      <FileName name={item.name} />
                      {where && <span className="block truncate text-xs text-muted">{where}</span>}
                    </span>
                    {item.kind === "file" && <span className="shrink-0 text-xs text-muted">{formatBytes(item.size_bytes)}</span>}
                  </button>
                  {item.kind === "folder" && (
                    <button type="button" aria-label={t("driveLink.openFolder", { name: item.name })} title={t("driveLink.openFolder", { name: item.name })} className="rounded-md p-1.5 text-muted hover:bg-ink/6 hover:text-ink" onClick={() => open(item)}>
                      <ChevronRight size={14} />
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
      {(listError || error) && <p role="alert" className="mt-2 text-sm text-danger">{error ?? listError}</p>}
      <div className="mt-3 min-h-10 text-sm" aria-live="polite">
        {selected ? (
          warning ? (
            <p data-drive-reach="warning" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ink">
              <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warning" />
              <span>{selected.kind === "file" ? t("driveLink.suggestCopy", { warning }) : warning}</span>
            </p>
          ) : (
            <p className="text-xs text-muted">{reach ? t("driveLink.everyoneCanRead") : t("driveLink.linkNote")}</p>
          )
        ) : (
          <p className="text-xs text-muted">{t("driveLink.pickHint")}</p>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant={warning && !refusal ? "primary" : "secondary"} disabled={!selected || !!refusal || busy} title={refusal ?? undefined} onClick={() => void copy()}>
          {t("driveLink.attachCopy")}
        </Button>
        <Button variant={warning && !refusal ? "secondary" : "primary"} disabled={!selected || busy} onClick={() => selected && onLink(selected)}>
          {t("driveLink.insertLink")}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * The draft's warning (§13.1, 「送る前に」): the first drive link in the draft that some of this conversation's members
 * cannot read. 「コピーとして送る」 hands the item to `onSendCopy` (the composer swaps the link for a copy); 「このまま」
 * leaves the link and says nothing more of it.
 */
export function DriveLinkWarning({ controller, channel, text, onSendCopy }: {
  controller: AppController;
  channel: ChannelState;
  text: string;
  onSendCopy: (itemId: string) => Promise<void>;
}) {
  const base = typeof controller.api?.baseUrl === "string" ? controller.api.baseUrl : null;
  const ids = useMemo(() => (base && text.includes("/d/") ? driveLinksIn(base, text).slice(0, 3) : []), [base, text]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [reaches, setReaches] = useState<ReadonlyMap<string, { reach: DriveReachOut; name: string | null; file: boolean }>>(new Map());
  const [busy, setBusy] = useState(false);
  const key = ids.join(",");
  useEffect(() => {
    if (ids.length === 0) return;
    let current = true;
    void Promise.all(
      ids.map(async (id) => {
        const reach = await controller.driveReach(id, channel.id);
        if (!reach || reach.unreadable <= 0) return null;
        const link = await controller.driveLink(id);
        const item = link.state === "ok" ? link.detail.item : null;
        return [id, { reach, name: item?.name ?? null, file: item?.kind === "file" }] as const;
      }),
    ).then((found) => {
      if (current) setReaches(new Map(found.filter((entry) => entry !== null)));
    });
    return () => {
      current = false;
    };
  }, [controller, channel.id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const id = ids.find((candidate) => reaches.has(candidate) && !dismissed.has(candidate));
  if (!id) return null;
  const entry = reaches.get(id)!;
  const warning = reachWarning(entry.reach, channel);
  if (!warning) return null;
  return (
    <div data-drive-reach="draft" role="status" className="mx-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-ink">
      <TriangleAlert size={13} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        {entry.name ? t("driveLink.draftWarningNamed", { name: entry.name, warning }) : warning}
      </span>
      {entry.file && (
        <button
          type="button"
          disabled={busy}
          className="font-medium text-accent hover:underline disabled:opacity-50"
          onClick={() => {
            setBusy(true);
            void onSendCopy(id).finally(() => setBusy(false));
          }}
        >
          {t("driveLink.sendAsCopy")}
        </button>
      )}
      <button type="button" className="text-muted hover:text-ink" onClick={() => setDismissed((held) => new Set([...held, id]))}>
        {t("driveLink.keepLink")}
      </button>
    </div>
  );
}

/** Attachments that can go to the drive: stored in a conversation (not being sent, not a drive file's own version). */
export function savableAttachments(attachments: readonly AttachmentOut[]): AttachmentOut[] {
  return attachments.filter((attachment) => attachment.status === "attached");
}

/**
 * 「ドライブに保存」 (§13.2): the attachments (all ticked; one: its name can be changed), a folder in a drive I can write
 * — the conversation's own drive first (made on first use), a DM's マイドライブ —, then 「ここに保存」. Each attachment
 * keeps its op id while the dialog is open, so a retry after a lost answer saves it once. The copies are independent
 * of the message.
 */
export function SaveToDriveDialog({ controller, attachments, channel, onClose }: {
  controller: AppController;
  attachments: readonly AttachmentOut[];
  channel: ChannelState | null;
  onClose: () => void;
}) {
  const api = controller.api;
  const [start, setStart] = useState<{ location: DriveLocationOut; folderId: string } | null | undefined>(undefined);
  useEffect(() => {
    if (!api) return;
    let current = true;
    void (async () => {
      let found: DriveLocationOut | null = null;
      try {
        if (channel && (channel.type === "public" || channel.type === "private")) found = await api.resolveDriveLocation({ kind: "channel", channel_id: channel.id });
      } catch {
        /* not a member any more, or offline: the list's choice */
      }
      // マイドライブ is made when first used (as 「ドライブ」 does), so the list offers it too.
      let mine: DriveLocationOut | null = null;
      if (!controller.isGuest) {
        try {
          mine = await api.resolveDriveLocation({ kind: "me" });
        } catch {
          mine = null;
        }
      }
      if (!found?.can_write) found = mine;
      if (current) setStart(found?.can_write ? { location: found, folderId: found.root_id } : null);
    })();
    return () => {
      current = false;
    };
  }, [api, channel, controller.isGuest]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(attachments.map((a) => a.id)));
  const single = attachments.length === 1 ? attachments[0]! : null;
  const [name, setName] = useState(single?.filename ?? "");
  const [opIds] = useState(() => new Map(attachments.map((a) => [a.id, newOpId()])));
  const [place, setPlace] = useState<{ location: DriveLocationOut; folderId: string; path: DriveCrumb[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = attachments.filter((a) => picked.has(a.id));

  const submit = async () => {
    if (!api || !place || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    let saved = 0;
    let firstFailure: unknown = null;
    for (const attachment of chosen) {
      try {
        await api.saveAttachmentToDrive({
          attachment_id: attachment.id,
          folder_id: place.folderId,
          name: single && name.trim() && name.trim() !== attachment.filename ? name.trim() : null,
          on_conflict: "rename",
          client_op_id: opIds.get(attachment.id) ?? null,
        });
        saved += 1;
      } catch (failure) {
        firstFailure ??= failure;
      }
    }
    setBusy(false);
    if (firstFailure && saved === 0) {
      setError(describeError(firstFailure));
      return;
    }
    const where = pathLine(place.path, locationName(place.location));
    const target = { locationId: place.location.id, folderId: place.folderId };
    controller.setNotice(
      firstFailure ? t("driveSave.savedSome", { count: saved, total: chosen.length, path: where }) : t("driveSave.saved", { count: saved, path: where }),
      { label: t("driveSave.show"), run: () => controller.requestShowInDrive(target) },
    );
    onClose();
  };

  return (
    <Modal onClose={onClose} title={t("driveSave.title")} description={t("driveSave.description")} growsDown className="w-[560px]">
      {single ? (
        <label className="mt-4 block text-sm">
          <span className="mb-1 block text-xs font-medium text-muted">{t("driveSave.name")}</span>
          <Input value={name} maxLength={255} onChange={(event) => setName(event.target.value)} aria-label={t("driveSave.name")} />
        </label>
      ) : (
        <ul className="mt-4 max-h-36 space-y-0.5 overflow-y-auto rounded-xl border border-line p-1" aria-label={t("driveSave.files")}>
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-ink/6">
                <input type="checkbox" checked={picked.has(attachment.id)} onChange={(event) => setPicked((held) => { const next = new Set(held); if (event.target.checked) next.add(attachment.id); else next.delete(attachment.id); return next; })} />
                <FileName name={attachment.filename} className="min-w-0 flex-1" />
                <span className="shrink-0 text-xs text-muted">{formatBytes(attachment.size_bytes)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {start === undefined ? (
        <div className="mt-4 flex h-72 items-center justify-center text-muted"><Loader2 size={18} className="animate-spin" /></div>
      ) : (
        <FolderPicker controller={controller} start={start} pickStart={(locations) => defaultSaveLocation(locations, channel?.id ?? null)} onChange={setPlace} />
      )}
      <p className="mt-2 truncate text-xs text-muted">{place ? t("driveSave.to", { path: pathLine(place.path, locationName(place.location)) }) : " "}</p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button onClick={() => void submit()} disabled={busy || !place || chosen.length === 0}>
          <HardDriveDownload size={14} /> {t("driveSave.here")}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * The drive's 「会話に送る」 (§17.2): a conversation picked, the item's link put at the end of its draft and the
 * conversation opened, so the draft's warning (who cannot read it) and 「コピーとして送る」 are there before it is sent.
 */
export function SendToConversationDialog({ controller, item, onClose }: { controller: AppController; item: DriveItemOut; onClose: () => void }) {
  const store = controller.store;
  const me = store.me?.id;
  const label = (channel: ChannelState): string =>
    channel.type === "dm" || channel.type === "group_dm"
      ? (channel.dm_user_ids ?? []).filter((id) => id !== me).map((id) => store.users.get(id)?.display_name ?? "?").join(", ") || t("calendar.me")
      : (channel.name ?? "");
  const targets = [...store.channels.values()].filter((c) => c.isMember && !c.archived).sort((a, b) => label(a).localeCompare(label(b), "ja"));
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase();
  const shown = words ? targets.filter((c) => label(c).toLowerCase().includes(words)) : targets;
  const send = (channel: ChannelState) => {
    const base = controller.api?.baseUrl;
    if (!base) return;
    const draft = store.draft(channel.id, null).text;
    const url = driveLink(base, item.id);
    store.setDraft(channel.id, null, { text: draft.trim() ? `${draft.replace(/\s+$/, "")}\n${url} ` : `${url} ` });
    controller.requestOpenChannel(channel.id);
    onClose();
  };
  return (
    <Modal onClose={onClose} title={t("driveLink.sendTitle", { name: item.name })} description={t("driveLink.sendDescription")} className="w-[440px]">
      <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("driveLink.sendFilter")} aria-label={t("driveLink.sendFilter")} className="mt-4" />
      <ul className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-line p-1" aria-label={t("driveLink.sendTargets")}>
        {shown.map((channel) => (
          <li key={channel.id}>
            <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink/6" onClick={() => send(channel)}>
              {channel.type === "private" ? <Lock size={14} className="shrink-0 text-muted" /> : channel.type === "public" ? <Hash size={14} className="shrink-0 text-muted" /> : <Mail size={14} className="shrink-0 text-muted" />}
              <span className="truncate">{label(channel)}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("share.noTargets")}</li>}
      </ul>
    </Modal>
  );
}
