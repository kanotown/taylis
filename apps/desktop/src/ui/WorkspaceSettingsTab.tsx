import { forEachPicked, refusePicked, takePicked } from "../platform/pickedFiles";
import { ArrowDown, ArrowUp, Eye, Hash, ImageUp, Phone, Trash2, UsersRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AdminWorkspaceSettingsOut, ChannelOut, DefaultChannelsApplyOut, WorkspaceSettingsUpdate } from "../api/types";
import type { AppController } from "../state/app";
import { fullTimestamp } from "./format";
import { Button, cn, Input } from "./primitives";
import { WorkspaceIcon } from "./workspaceIcons";
import { t } from "../i18n";

const CARD = "flex items-center gap-3 rounded-xl border border-line px-3 py-2";

/**
 * Administration → 設定 (M88, docs/MEMBERSHIP.md §3): the workspace-wide switches. Each one saves when flipped (PATCH
 * /admin/workspace-settings); every device follows through workspace.settings_updated. A server before M88 answers 404:
 * the tab says so instead of showing switches that would do nothing.
 */
export function WorkspaceSettingsTab({ controller }: { controller: AppController }) {
  const [settings, setSettings] = useState<AdminWorkspaceSettingsOut | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    let cancelled = false;
    api.adminWorkspaceSettings().then(
      (row) => {
        if (!cancelled) setSettings(row);
      },
      (error: unknown) => {
        if (cancelled) return;
        if ((error as { status?: number }).status === 404) setUnsupported(true);
        else controller.setError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller.api]);

  const save = async (patch: WorkspaceSettingsUpdate) => {
    const api = controller.api;
    if (!api || !settings || busy) return;
    const before = settings;
    setSettings({ ...settings, ...patch } as AdminWorkspaceSettingsOut); // at once; put back when refused
    setBusy(true);
    try {
      setSettings(await api.adminUpdateWorkspaceSettings(patch));
    } catch (error) {
      setSettings(before);
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  if (unsupported) return <p className="mt-4 text-sm text-muted">{t("workspace.unsupported")}</p>;
  if (!settings) return <p role="status" className="mt-6 text-center text-sm text-muted">{t("common.loading")}</p>;
  const changedBy = settings.updated_by ? controller.store.users.get(settings.updated_by)?.display_name : null;
  // M142 (docs/ROLES.md §5): a manager sees and changes the default channels only (channels.manage).
  const full = controller.can("workspace.settings");
  return (
    <div className="mt-4 space-y-3">
      {full && (
      <>
      <WorkspaceIconSection controller={controller} settings={settings} onSaved={setSettings} />
      <label className={cn(CARD, "cursor-pointer")}>
        <UsersRound size={18} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 text-sm">
          {t("workspace.joinLeave")}
          <span className="block text-xs text-muted">{t("workspace.joinLeaveNote")}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label={t("workspace.joinLeave")}
          className="h-4 w-4 accent-[var(--accent)]"
          disabled={busy}
          checked={settings.show_membership_messages}
          onChange={(e) => void save({ show_membership_messages: e.target.checked })}
        />
      </label>
      <label className={cn(CARD, "cursor-pointer")}>
        <Eye size={18} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 text-sm">
          {t("workspace.preview")}
          <span className="block text-xs text-muted">{t("workspace.previewNote")}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label={t("workspace.preview")}
          className="h-4 w-4 accent-[var(--accent)]"
          disabled={busy}
          checked={settings.preview_before_join}
          onChange={(e) => void save({ preview_before_join: e.target.checked })}
        />
      </label>
      </>
      )}
      {controller.can("channels.manage") && <DefaultChannelsSection controller={controller} settings={settings} onSaved={setSettings} />}
      {settings.updated_at && changedBy && (
        <p className="text-xs text-muted">
          {t("workspace.lastChanged", { who: changedBy, at: fullTimestamp(settings.updated_at) })}
        </p>
      )}
    </div>
  );
}

/** M93: the picture types the server takes for the icon (it crops the middle square and makes a 256 px PNG). */
export const ICON_ACCEPT = "image/png,image/jpeg,image/webp";
/** The server's default `avatar_max_bytes`, which the workspace icon uses too (server/app/core/settings.py). */
export const ICON_MAX_BYTES = 5 * 1024 * 1024;

/**
 * M93 (WORKSPACES.md §3.4) 「アイコン」: the workspace's logo on everyone's rail, switcher and login screen (public, before
 * signing in). Choosing a file uploads it at once; 「削除」 returns to the letter tile. A server before M93 has no
 * `icon_version` in the settings: the section is not shown.
 */
export function WorkspaceIconSection({ controller, settings, onSaved }: {
  controller: AppController;
  settings: AdminWorkspaceSettingsOut;
  onSaved: (row: AdminWorkspaceSettingsOut) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (settings.icon_version === undefined) return null;
  const entry = controller.activeEntry;
  const name = controller.workspaceName;
  const version = settings.icon_version ?? null;

  const apply = async (call: () => Promise<AdminWorkspaceSettingsOut>) => {
    setBusy(true);
    try {
      const row = await call();
      onSaved(row);
      // This device follows at once (the others through workspace.settings_updated).
      controller.store.setWorkspaceSettings({ ...controller.store.workspaceSettings, icon_version: row.icon_version ?? null });
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };
  const upload = (file: File) => {
    const api = controller.api;
    if (api) void apply(() => api.adminUploadWorkspaceIcon(file, file.name));
  };
  const remove = () => {
    const api = controller.api;
    if (api) void apply(() => api.adminDeleteWorkspaceIcon());
  };

  return (
    <div className={CARD} data-testid="workspace-icon-section">
      <WorkspaceIcon serverUrl={entry?.serverUrl ?? controller.serverUrl} version={version} name={name} colorKey={entry?.workspaceId ?? entry?.serverUrl ?? name} className="h-12 w-12 rounded-xl text-lg" />
      <span className="min-w-0 flex-1 text-sm">
        {t("workspace.icon")}
        <span className="block text-xs text-muted">{t("workspace.iconNote")}</span>
      </span>
      <input
        ref={input}
        type="file"
        accept={ICON_ACCEPT}
        aria-label={t("workspace.iconPick")}
        className="hidden"
        onChange={(event) => {
          // Checked before any byte is read; the input is cleared once the copy is made (platform/pickedFiles.ts).
          const picked = takePicked(event.target);
          const refusal = refusePicked(picked.files, { maxFiles: 1, maxBytes: ICON_MAX_BYTES, tooMany: t("workspace.oneImage") });
          if (refusal) { picked.release(); controller.setError(refusal); return; }
          void forEachPicked(picked.files, async (file) => upload(file), picked.release, (error) => controller.setError(error));
        }}
      />
      <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
          <ImageUp size={14} /> {version ? t("workspace.change") : t("workspace.pickImage")}
        </Button>
        {version && (
          <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={remove}>
            <Trash2 size={14} /> {t("common.delete")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The two channels of the user's request (2026-10-03), offered while no default is chosen. */
export const SUGGESTED_DEFAULTS = ["全体連絡", "談話スペース"] as const;

type DefaultChannel = { id: string; name: string };

/**
 * M90 (docs/MEMBERSHIP.md §6) 「既定のチャンネル」: the public channels every new non-guest account joins, in order. Each
 * change saves at once (the whole list, PATCH default_channel_ids). 「今いる人も全員入れる」 counts first (dry run) and
 * asks with the count. A server before M90 has no such fields: the section says so.
 */
export function DefaultChannelsSection({ controller, settings, onSaved }: {
  controller: AppController;
  settings: AdminWorkspaceSettingsOut;
  onSaved: (row: AdminWorkspaceSettingsOut) => void;
}) {
  const supported = Array.isArray(settings.default_channel_ids);
  const chosen: DefaultChannel[] = settings.default_channels ?? [];
  const [publicChannels, setPublicChannels] = useState<ChannelOut[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<DefaultChannelsApplyOut | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const api = controller.api;
    if (!api || !supported) return;
    let cancelled = false;
    api.channels(true).then(
      (rows) => {
        if (!cancelled) setPublicChannels(rows.filter((c) => c.type === "public" && !c.archived && c.name));
      },
      (error: unknown) => {
        if (!cancelled) controller.setError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller.api, supported]);

  if (!supported) {
    return (
      <section aria-label={t("workspace.defaultChannels")} className="rounded-xl border border-line px-3 py-2">
        <h3 className="text-sm">{t("workspace.defaultChannels")}</h3>
        <p className="mt-1 text-xs text-muted">{t("workspace.defaultUnsupported")}</p>
      </section>
    );
  }

  const saveList = async (list: DefaultChannel[]) => {
    const api = controller.api;
    if (!api || busy) return;
    const before = settings;
    onSaved({ ...settings, default_channel_ids: list.map((c) => c.id), default_channels: list, default_channels_set: true }); // at once
    setBusy(true);
    setPending(null);
    setNote(null);
    try {
      onSaved(await api.adminUpdateWorkspaceSettings({ default_channel_ids: list.map((c) => c.id) }));
    } catch (error) {
      onSaved(before);
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, by: number) => {
    const list = [...chosen];
    const [item] = list.splice(index, 1);
    list.splice(index + by, 0, item!);
    void saveList(list);
  };

  const createSuggested = async () => {
    const api = controller.api;
    if (!api || busy) return;
    setBusy(true);
    const list: DefaultChannel[] = [];
    try {
      for (const name of SUGGESTED_DEFAULTS) {
        const existing = publicChannels?.find((c) => c.name === name);
        const channel = existing ?? (await api.createChannel(name, "public"));
        list.push({ id: channel.id, name });
        if (!existing) setPublicChannels((rows) => [...(rows ?? []), channel]);
      }
    } catch (error) {
      controller.setError(error);
      setBusy(false);
      return;
    }
    setBusy(false);
    // saveList checks `busy` from this render: call the API directly instead.
    const before = settings;
    onSaved({ ...settings, default_channel_ids: list.map((c) => c.id), default_channels: list, default_channels_set: true });
    try {
      onSaved(await api.adminUpdateWorkspaceSettings({ default_channel_ids: list.map((c) => c.id) }));
    } catch (error) {
      onSaved(before);
      controller.setError(error);
    }
  };

  const count = async () => {
    const api = controller.api;
    if (!api || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const answer = await api.adminApplyDefaultChannels(true);
      if (answer.memberships === 0) setNote(t("workspace.everyoneIn"));
      else setPending(answer);
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const api = controller.api;
    if (!api || busy) return;
    setBusy(true);
    try {
      const done = await api.adminApplyDefaultChannels(false);
      setPending(null);
      setNote(done.memberships === 0 ? t("workspace.everyoneIn") : t("workspace.added", { count: done.users }));
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  const chosenIds = new Set(chosen.map((c) => c.id));
  const choices = (publicChannels ?? []).filter((c) => !chosenIds.has(c.id)).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const legacy = settings.legacy_sso_default_channels ?? [];
  const ICON = "rounded p-1 text-muted hover:bg-line disabled:opacity-30";
  return (
    <section aria-label={t("workspace.defaultChannels")} className="rounded-xl border border-line px-3 py-2">
      <div className="flex items-center gap-3">
        <Hash size={18} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 text-sm">
          {t("workspace.defaultChannels")}
          <span className="block text-xs text-muted">{t("workspace.defaultNote")}</span>
        </span>
      </div>
      {!settings.default_channels_set && legacy.length > 0 && (
        <p className="mt-2 text-xs text-muted">
          {t("workspace.legacyNote", { channels: legacy.map((n) => `#${n}`).join(t("common.listSeparator")) })}
        </p>
      )}
      {chosen.length > 0 ? (
        <ol className="mt-2 space-y-1">
          {chosen.map((channel, index) => (
            <li key={channel.id} className="flex items-center gap-1 rounded-lg bg-panel-2 px-2 py-1 text-sm">
              <span className="min-w-0 flex-1 truncate">#{channel.name}</span>
              <button type="button" aria-label={t("workspace.up", { name: channel.name ?? "" })} className={ICON} disabled={busy || index === 0} onClick={() => move(index, -1)}>
                <ArrowUp size={14} />
              </button>
              <button type="button" aria-label={t("workspace.down", { name: channel.name ?? "" })} className={ICON} disabled={busy || index === chosen.length - 1} onClick={() => move(index, 1)}>
                <ArrowDown size={14} />
              </button>
              <button type="button" aria-label={t("workspace.removeChannel", { name: channel.name ?? "" })} className={ICON} disabled={busy} onClick={() => void saveList(chosen.filter((c) => c.id !== channel.id))}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-muted">{t("workspace.noneYet")}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label={t("workspace.addDefault")}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel px-2 text-sm"
          disabled={busy || publicChannels === null || choices.length === 0}
          value=""
          onChange={(e) => {
            const picked = choices.find((c) => c.id === e.target.value);
            if (picked) void saveList([...chosen, { id: picked.id, name: picked.name ?? "" }]);
          }}
        >
          <option value="">{publicChannels === null ? t("common.loading") : choices.length === 0 ? t("workspace.noPublicToAdd") : t("workspace.addPublic")}</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
        {chosen.length === 0 && publicChannels !== null && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void createSuggested()}>
            {t("workspace.useSuggested", { names: SUGGESTED_DEFAULTS.join(t("workspace.suggestedJoin")) })}
          </Button>
        )}
      </div>
      <div className="mt-3 border-t border-line pt-2">
        <Button size="sm" variant="secondary" disabled={busy || chosen.length === 0} onClick={() => void count()}>
          <UsersRound size={14} /> {t("workspace.addEveryone")}
        </Button>
        {pending && (
          <div role="alertdialog" aria-label={t("workspace.addEveryone")} className="mt-2 rounded-lg border border-line bg-panel-2 p-2 text-sm">
            <p>{t("workspace.addEveryoneConfirm", { users: pending.users, memberships: pending.memberships })}</p>
            <ul className="mt-1 text-xs text-muted">
              {pending.channels
                .filter((c) => c.added > 0)
                .map((c) => (
                  <li key={c.id}>
                    #{c.name}: {t("common.people", { count: c.added })}
                  </li>
                ))}
            </ul>
            <p className="mt-1 text-xs text-muted">{t("workspace.addEveryoneNote")}</p>
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPending(null)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void apply()}>
                {t("workspace.addConfirm")}
              </Button>
            </div>
          </div>
        )}
        {note && (
          <p role="status" className="mt-2 text-xs text-muted">
            {note}
          </p>
        )}
      </div>
    </section>
  );
}

