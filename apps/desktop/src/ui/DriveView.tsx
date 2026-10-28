/**
 * 「ドライブ」 (M161, docs/DRIVE.md §17.1): the locations column — 研究室ドライブ, マイドライブ (not for guests), the drives of
 * my channels and 「チャンネルを選ぶ」 for one of my channels that has none yet — each with what it uses (and a bar
 * against its quota when it has one), beside the open location's folders (DriveBrowser). A channel's own 「ドライブ」 tab
 * is ChannelDrive below: the same browser on that channel's drive.
 *
 * §27 (2026-10-22): the open location, folder and trash are the screen's (MainScreen's) state when it passes `place` /
 * `onPlace`: each change is a place of the back / forward history (← →, ⌘[ ⌘], the mouse's and the browser's buttons).
 */
import { ArrowLeft, Hash, HardDrive, Images, Link2, Loader2, Lock, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, describeError } from "../api/errors";
import type { DriveLocationOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { formatBytes, locationName, orderLocations } from "../drive/listing";
import { coalesce } from "../sync/drive";
import { AlbumsHome } from "./AlbumsHome";
import { DriveBrowser, type DriveMode } from "./DriveBrowser";
import { onDriveTarget, takeDriveTarget } from "./DriveSearch";
import { MyLinksDialog } from "./DriveShareDialog";
import type { DrivePlace } from "./placeHistory";
import { Button, cn, IconButton, Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "./primitives";
import { t } from "../i18n";

/** Where 「ドライブ」 was left in this window (a page visited again opens there). */
let lastPlace: DrivePlace | null = null;

const COLUMN_KEY = "taylis.drive.locationsHidden";

/** §27: whether the locations column is put away, remembered on this device. */
export function readLocationsHidden(): boolean {
  try {
    return localStorage.getItem(COLUMN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeLocationsHidden(hidden: boolean): void {
  try {
    localStorage.setItem(COLUMN_KEY, hidden ? "1" : "0");
  } catch {
    /* per-device convenience */
  }
}

function LocationIcon({ location }: { location: DriveLocationOut }) {
  if (location.kind === "workspace") return <HardDrive size={15} className="shrink-0" />;
  if (location.kind === "user") return <User size={15} className="shrink-0" />;
  return <Hash size={15} className="shrink-0" />;
}

function Usage({ location }: { location: DriveLocationOut }) {
  const share = location.quota_bytes ? Math.min(1, location.used_bytes / location.quota_bytes) : null;
  return (
    <span className="mt-0.5 block text-[11px] tabular-nums text-muted">
      {location.quota_bytes ? t("drive.usageOf", { used: formatBytes(location.used_bytes), quota: formatBytes(location.quota_bytes) }) : formatBytes(location.used_bytes)}
      {share !== null && (
        <span aria-hidden className="mt-1 block h-1 overflow-hidden rounded-full bg-ink/10">
          <span className={cn("block h-full rounded-full", share > 0.9 ? "bg-danger" : "bg-accent")} style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      )}
    </span>
  );
}

export function DriveView({ controller, compact = false, place, onPlace }: {
  controller: AppController;
  compact?: boolean;
  /** The location and folder on screen, kept by the caller (null: not chosen yet). Without `onPlace`, kept here. */
  place?: DrivePlace | null;
  onPlace?: (place: DrivePlace) => void;
}) {
  const api = controller.api;
  const engine = controller.engine;
  const [locations, setLocations] = useState<DriveLocationOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [own, setOwn] = useState<DrivePlace | null>(null);
  const current = onPlace ? (place ?? null) : own;
  const setCurrent = useCallback((next: DrivePlace) => (onPlace ? onPlace(next) : setOwn(next)), [onPlace]);
  const mode: DriveMode = current?.trash ? "trash" : "folder";
  const setMode = (next: DriveMode) => {
    if (current) setCurrent({ ...current, trash: next === "trash", albums: false });
  };
  const [listOpen, setListOpen] = useState(compact && !lastPlace && !place);
  // Opened without a place: a search result asked for, else where it was left in this window.
  useEffect(() => {
    const target = takeDriveTarget();
    if (target) setCurrent({ ...target, trash: false });
    else if (!current && lastPlace) setCurrent(lastPlace);
    // Once, on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [myLinks, setMyLinks] = useState(false);
  // §27: the column gives its room to the listing once a location is chosen; the toolbar's button brings it back.
  const [columnHidden, setColumnHidden] = useState(readLocationsHidden);
  const hideColumn = (hidden: boolean) => {
    setColumnHidden(hidden);
    writeLocationsHidden(hidden);
  };

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const out = await api.driveLocations();
      let list = orderLocations(out.locations);
      // マイドライブ is made when first opened: offered to people (not guests) before that.
      if (!controller.isGuest && !list.some((loc) => loc.kind === "user")) {
        try {
          list = orderLocations([...list, await api.resolveDriveLocation({ kind: "me" })]);
        } catch {
          /* a guest, or offline: without it */
        }
      }
      setLocations(list);
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
      setLocations((held) => held ?? []);
    }
  }, [api, controller.isGuest]);

  useEffect(() => {
    void load();
  }, [load]);
  // A search result shown in its folder (the search screen's 「ドライブ」 tab).
  useEffect(() => onDriveTarget(() => {
    const target = takeDriveTarget();
    if (!target) return;
    setCurrent({ ...target, trash: false });
    setListOpen(false);
  }), [setCurrent]);
  // The usage figures follow the changes too (a few at a time: one read per second at most).
  useEffect(() => {
    const again = coalesce(() => void load(), 1000);
    const unsubscribe = engine?.drive.subscribe((signal) => {
      if (signal.kind === "locations" || signal.kind === "resync") void load();
      else if (signal.kind === "changed") again.poke();
    });
    return () => {
      again.cancel();
      unsubscribe?.();
    };
  }, [engine, load]);

  const location = locations?.find((loc) => loc.id === current?.locationId) ?? null;
  // AL2 (docs/ALBUMS.md §10.1): 「アルバム」, every album I can read, is a place of its own.
  const albumsOpen = !!current?.albums;
  const openAlbums = () => {
    const base = location ?? locations?.[0];
    if (!base) return;
    setCurrent({ locationId: base.id, folderId: current?.locationId === base.id ? current.folderId : base.root_id, trash: false, albums: true });
    setListOpen(false);
  };
  // Nothing chosen, or the chosen one is gone (left the channel): the first location.
  useEffect(() => {
    if (!locations || locations.length === 0) return;
    if (current && locations.some((loc) => loc.id === current.locationId)) return;
    const first = locations[0]!;
    setCurrent({ locationId: first.id, folderId: first.root_id, trash: false });
  }, [locations, current, setCurrent]);
  useEffect(() => {
    lastPlace = current;
  }, [current]);

  // M163 (docs/DRIVE.md §3.2): the location's switch for external links, by those who manage it.
  const setLinks = async (loc: DriveLocationOut, on: boolean) => {
    if (!api) return;
    try {
      const changed = await api.setDriveLocationLinks(loc.id, on);
      setLocations((held) => (held ?? []).map((entry) => (entry.id === changed.id ? changed : entry)));
      controller.setNotice(on ? t("drive.share.locationOn", { name: locationName(loc) }) : t("drive.share.locationOff", { name: locationName(loc) }));
    } catch (failure) {
      controller.setError(failure);
    }
  };

  // Choosing a location keeps the column open (2026-10-23: folding it at once was surprising); its own button hides it.
  const choose = (loc: DriveLocationOut, _fromColumn = false) => {
    setCurrent({ locationId: loc.id, folderId: loc.root_id, trash: false });
    setListOpen(false);
  };

  // My channels (public or private, not DMs) whose drive is not listed yet: 「チャンネルを選ぶ」 makes it.
  const listedChannels = new Set((locations ?? []).map((loc) => loc.channel_id).filter(Boolean));
  const others = [...controller.store.channels.values()]
    .filter((channel: ChannelState) => channel.isMember && (channel.type === "public" || channel.type === "private") && !listedChannels.has(channel.id))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const openChannel = async (channel: ChannelState) => {
    if (!api) return;
    try {
      const made = await api.resolveDriveLocation({ kind: "channel", channel_id: channel.id });
      setLocations((held) => orderLocations([...(held ?? []).filter((loc) => loc.id !== made.id), made]));
      choose(made);
    } catch (failure) {
      controller.setError(failure);
    }
  };

  const column = (
    <aside id="drive-locations" aria-label={t("drive.locations")} className={cn("flex shrink-0 flex-col border-line bg-panel/40", compact ? "flex-1" : "w-[240px] border-r")}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <HardDrive size={16} className="text-muted" />
        <strong className="flex-1 text-sm">{t("nav.drive")}</strong>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {locations === null ? (
          <div className="flex justify-center py-6 text-muted"><Loader2 size={18} className="animate-spin" /></div>
        ) : (
          <ul className="space-y-0.5">
            {locations.length > 0 && (
              <li className="pb-1">
                <button
                  type="button"
                  data-drive-albums=""
                  aria-current={albumsOpen ? "true" : undefined}
                  onClick={openAlbums}
                  className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", albumsOpen ? "bg-accent-soft text-ink" : "hover:bg-ink/6")}
                >
                  <Images size={15} className={cn("shrink-0", albumsOpen ? "text-accent" : "text-muted")} />
                  <span className="truncate font-medium">{t("albums.title")}</span>
                </button>
              </li>
            )}
            {locations.map((loc, index) => {
              const firstChannel = loc.kind === "channel" && locations[index - 1]?.kind !== "channel";
              return (
                <li key={loc.id} className="group relative">
                  {firstChannel && <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">{t("drive.channels")}</div>}
                  {loc.can_manage && (
                    <Menu>
                      <MenuTrigger asChild>
                        <button type="button" aria-label={t("drive.share.locationSettings", { name: locationName(loc) })} className="absolute bottom-1.5 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-md text-muted opacity-0 hover:bg-ink/8 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
                          <MoreHorizontal size={14} />
                        </button>
                      </MenuTrigger>
                      <MenuContent align="end">
                        <MenuLabel>{locationName(loc)}</MenuLabel>
                        <MenuCheckboxItem checked={loc.external_links} onCheckedChange={(on) => void setLinks(loc, on === true)}>
                          {t("drive.share.allowHere")}
                        </MenuCheckboxItem>
                      </MenuContent>
                    </Menu>
                  )}
                  <button
                    type="button"
                    data-drive-location={loc.kind}
                    aria-current={!albumsOpen && loc.id === location?.id ? "true" : undefined}
                    onClick={() => choose(loc, true)}
                    className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm", !albumsOpen && loc.id === location?.id ? "bg-accent-soft text-ink" : "hover:bg-ink/6")}
                  >
                    <span className={cn("mt-0.5", !albumsOpen && loc.id === location?.id ? "text-accent" : "text-muted")}><LocationIcon location={loc} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="truncate font-medium">{locationName(loc)}</span>
                        {!loc.can_write && <Lock size={11} className="shrink-0 text-muted" aria-label={t("drive.readOnlyShort")} />}
                        {!loc.external_links && <span className="shrink-0 text-[10.5px] text-muted">{t("drive.share.offShort")}</span>}
                      </span>
                      <Usage location={loc} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {others.length > 0 && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-ink/6 hover:text-ink">
                <Plus size={15} /> {t("drive.pickChannel")}
              </button>
            </MenuTrigger>
            <MenuContent align="start" className="max-h-80 overflow-y-auto">
              <MenuLabel>{t("drive.pickChannelHint")}</MenuLabel>
              {others.map((channel) => (
                <MenuItem key={channel.id} onSelect={() => void openChannel(channel)}>
                  {channel.type === "private" ? <Lock size={13} /> : <Hash size={13} />} {channel.name}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        {error && <p role="alert" className="mt-3 px-2 text-xs text-danger">{error}</p>}
      </div>
      {!controller.isGuest && (
        <div className="shrink-0 border-t border-line p-2">
          <button type="button" data-drive-my-links="" onClick={() => setMyLinks(true)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-ink/6 hover:text-ink">
            <Link2 size={15} /> {t("drive.share.mine")}
          </button>
        </div>
      )}
      {myLinks && <MyLinksDialog controller={controller} onClose={() => setMyLinks(false)} />}
    </aside>
  );

  const toggle = compact ? (
    <Button size="sm" variant="ghost" aria-label={t("drive.locations")} onClick={() => setListOpen(true)}><ArrowLeft size={15} /></Button>
  ) : (
    <IconButton
      label={columnHidden ? t("drive.showLocations") : t("drive.hideLocations")}
      data-drive-locations-toggle=""
      aria-expanded={!columnHidden}
      aria-controls="drive-locations"
      onClick={() => hideColumn(!columnHidden)}
      className="-ml-1 shrink-0"
    >
      {columnHidden ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
    </IconButton>
  );
  const browser = albumsOpen && locations ? (
    <AlbumsHome controller={controller} locations={locations} header={toggle} onOpen={(target) => setCurrent({ ...target, trash: false })} />
  ) : location && current ? (
    <DriveBrowser
      key={location.id}
      controller={controller}
      location={location}
      folderId={current.folderId}
      onFolder={(folderId) => setCurrent({ locationId: location.id, folderId, trash: false })}
      mode={mode}
      onMode={setMode}
      onLost={() => void load()}
      header={toggle}
      locations={locations ? { list: locations, onChoose: (loc) => choose(loc) } : undefined}
    />
  ) : (
    <div className="flex flex-1 items-center justify-center text-sm text-muted">
      {locations && locations.length === 0 ? t("drive.noLocations") : <Loader2 size={18} className="animate-spin" />}
    </div>
  );

  if (compact) return <div className="flex min-h-0 flex-1 flex-col" data-drive-view="compact">{listOpen || (!location && !albumsOpen) ? column : browser}</div>;
  return (
    <div className="flex min-h-0 flex-1" data-drive-view="wide">
      {!columnHidden && column}
      {browser}
    </div>
  );
}

/**
 * A channel's 「ドライブ」 tab (§13.3): its drive, made on first open. DMs have none (the tab is not offered). An archived
 * channel's drive is read-only (the server says can_write false).
 */
export function ChannelDrive({ controller, channel }: { controller: AppController; channel: ChannelState }) {
  const api = controller.api;
  const engine = controller.engine;
  const [location, setLocation] = useState<DriveLocationOut | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [mode, setMode] = useState<DriveMode>("folder");
  const [error, setError] = useState<string | null>(null);
  const resolve = useCallback(async () => {
    if (!api) return;
    try {
      const made = await api.resolveDriveLocation({ kind: "channel", channel_id: channel.id });
      setLocation(made);
      setFolderId((held) => held ?? made.root_id);
      setError(null);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.code === "drive_item_not_found" ? t("drive.channelNotMember") : describeError(failure));
    }
  }, [api, channel.id]);
  useEffect(() => {
    setLocation(null);
    setFolderId(null);
    setMode("folder");
    void resolve();
  }, [resolve]);
  useEffect(() => engine?.drive.subscribe((signal) => {
    if (signal.kind === "locations") void resolve();
  }), [engine, resolve]);
  if (error) return <p role="alert" className="p-6 text-center text-sm text-muted">{error}</p>;
  if (!location || !folderId) return <div className="flex flex-1 items-center justify-center text-muted"><Loader2 size={18} className="animate-spin" /></div>;
  return (
    <DriveBrowser
      controller={controller}
      location={location}
      folderId={folderId}
      onFolder={setFolderId}
      mode={mode}
      onMode={setMode}
      onLost={() => void resolve()}
    />
  );
}
