/**
 * 「ドライブ」 (M161, docs/DRIVE.md §17.1): the locations column — 研究室ドライブ, マイドライブ (not for guests), the drives of
 * my channels and 「チャンネルを選ぶ」 for one of my channels that has none yet — each with what it uses (and a bar
 * against its quota when it has one), beside the open location's folders (DriveBrowser). A channel's own 「ドライブ」 tab
 * is ChannelDrive below: the same browser on that channel's drive.
 */
import { ArrowLeft, Hash, HardDrive, Loader2, Lock, Plus, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, describeError } from "../api/errors";
import type { DriveLocationOut } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { formatBytes, locationName, orderLocations } from "../drive/listing";
import { coalesce } from "../sync/drive";
import { DriveBrowser, type DriveMode } from "./DriveBrowser";
import { onDriveTarget, takeDriveTarget } from "./DriveSearch";
import { Button, cn, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "./primitives";
import { t } from "../i18n";

/** Where 「ドライブ」 was left in this window (a page visited again opens there). */
let lastPlace: { locationId: string; folderId: string } | null = null;

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

export function DriveView({ controller, compact = false }: { controller: AppController; compact?: boolean }) {
  const api = controller.api;
  const engine = controller.engine;
  const [locations, setLocations] = useState<DriveLocationOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<{ locationId: string; folderId: string } | null>(() => takeDriveTarget() ?? lastPlace);
  const [mode, setMode] = useState<DriveMode>("folder");
  const [listOpen, setListOpen] = useState(compact && !lastPlace);

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
    setCurrent(target);
    setMode("folder");
    setListOpen(false);
  }), []);
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
  // Nothing chosen, or the chosen one is gone (left the channel): the first location.
  useEffect(() => {
    if (!locations || locations.length === 0) return;
    if (current && locations.some((loc) => loc.id === current.locationId)) return;
    const first = locations[0]!;
    setCurrent({ locationId: first.id, folderId: first.root_id });
    setMode("folder");
  }, [locations, current]);
  useEffect(() => {
    lastPlace = current;
  }, [current]);

  const choose = (loc: DriveLocationOut) => {
    setCurrent({ locationId: loc.id, folderId: loc.root_id });
    setMode("folder");
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
    <aside aria-label={t("drive.locations")} className={cn("flex shrink-0 flex-col border-line bg-panel/40", compact ? "flex-1" : "w-[240px] border-r")}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <HardDrive size={16} className="text-muted" />
        <strong className="flex-1 text-sm">{t("nav.drive")}</strong>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {locations === null ? (
          <div className="flex justify-center py-6 text-muted"><Loader2 size={18} className="animate-spin" /></div>
        ) : (
          <ul className="space-y-0.5">
            {locations.map((loc, index) => {
              const firstChannel = loc.kind === "channel" && locations[index - 1]?.kind !== "channel";
              return (
                <li key={loc.id}>
                  {firstChannel && <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">{t("drive.channels")}</div>}
                  <button
                    type="button"
                    data-drive-location={loc.kind}
                    aria-current={loc.id === location?.id ? "true" : undefined}
                    onClick={() => choose(loc)}
                    className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm", loc.id === location?.id ? "bg-accent-soft text-ink" : "hover:bg-ink/6")}
                  >
                    <span className={cn("mt-0.5", loc.id === location?.id ? "text-accent" : "text-muted")}><LocationIcon location={loc} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="truncate font-medium">{locationName(loc)}</span>
                        {!loc.can_write && <Lock size={11} className="shrink-0 text-muted" aria-label={t("drive.readOnlyShort")} />}
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
    </aside>
  );

  const browser = location && current ? (
    <DriveBrowser
      key={location.id}
      controller={controller}
      location={location}
      folderId={current.folderId}
      onFolder={(folderId) => setCurrent({ locationId: location.id, folderId })}
      mode={mode}
      onMode={setMode}
      onLost={() => void load()}
      header={compact ? (
        <Button size="sm" variant="ghost" aria-label={t("drive.locations")} onClick={() => setListOpen(true)}><ArrowLeft size={15} /></Button>
      ) : undefined}
    />
  ) : (
    <div className="flex flex-1 items-center justify-center text-sm text-muted">
      {locations && locations.length === 0 ? t("drive.noLocations") : <Loader2 size={18} className="animate-spin" />}
    </div>
  );

  if (compact) return <div className="flex min-h-0 flex-1 flex-col" data-drive-view="compact">{listOpen || !location ? column : browser}</div>;
  return (
    <div className="flex min-h-0 flex-1" data-drive-view="wide">
      {column}
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
