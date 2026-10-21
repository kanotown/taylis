/**
 * 「管理 → ドライブ」's external links (M163, docs/DRIVE.md §3.4, §17.5): the workspace's switch (off stops every link at
 * once; none is removed, so they work again when it is on), the longest expiry, whether a password is required, and
 * every link that is not revoked, in every location — the item's and the location's names, who made it, until when,
 * how often it was used — with 「取り消す」. Never the contents.
 */
import { Link2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { describeError } from "../api/errors";
import type { DriveShareLinkOut, DriveShareSettingsOut, DriveShareSettingsPatch } from "../api/types";
import type { AppController } from "../state/app";
import { LinkList } from "./DriveShareDialog";
import { Button, cn } from "./primitives";
import { t } from "../i18n";

const CARD = "flex items-center gap-3 rounded-xl border border-line px-3 py-2";
const MAX_DAYS = [7, 30, 90, 180, 365];

export function AdminDriveLinks({ controller }: { controller: AppController }) {
  const [settings, setSettings] = useState<DriveShareSettingsOut | null>(null);
  const [links, setLinks] = useState<DriveShareLinkOut[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (after: string | null) => {
    const api = controller.api;
    if (!api) return;
    try {
      const [found, page] = await Promise.all([after ? Promise.resolve(null) : api.adminDriveShareSettings(), api.adminDriveLinks(after)]);
      if (found) setSettings(found);
      setLinks((held) => [...(after ? held ?? [] : []), ...page.links]);
      setCursor(page.next_cursor ?? null);
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [controller.api]);
  useEffect(() => {
    void load(null);
  }, [load]);

  const save = async (patch: DriveShareSettingsPatch) => {
    const api = controller.api;
    if (!api) return;
    setBusy(true);
    try {
      setSettings(await api.updateAdminDriveShareSettings(patch));
      controller.setNotice(t("admin.driveLinks.saved"));
      void load(null);
    } catch (failure) {
      controller.setError(failure);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p role="alert" className="py-3 text-sm text-danger">{error}</p>;
  if (!settings || !links) return <div className="flex justify-center py-6 text-muted"><Loader2 size={18} className="animate-spin" /></div>;
  const days = settings.link_max_days;
  const choices = days !== null && !MAX_DAYS.includes(days) ? [...MAX_DAYS, days].sort((a, b) => a - b) : MAX_DAYS;
  return (
    <section aria-label={t("admin.driveLinks.title")} data-admin-drive-links="" className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Link2 size={15} className="text-muted" /> {t("admin.driveLinks.title")}</h3>
      <p className="text-xs text-muted">{t("admin.driveLinks.description")}</p>
      <label className={cn(CARD, "cursor-pointer")}>
        <span className="min-w-0 flex-1 text-sm">
          {t("admin.driveLinks.enabled")}
          <span className="block text-xs text-muted">{t("admin.driveLinks.enabledNote")}</span>
        </span>
        <input type="checkbox" role="switch" aria-label={t("admin.driveLinks.enabled")} className="h-4 w-4 accent-[var(--accent)]" disabled={busy} checked={settings.external_links_enabled} onChange={(event) => void save({ external_links_enabled: event.target.checked })} />
      </label>
      <label className={CARD}>
        <span className="min-w-0 flex-1 text-sm">
          {t("admin.driveLinks.maxDays")}
          <span className="block text-xs text-muted">{t("admin.driveLinks.maxDaysNote", { days: settings.default_days })}</span>
        </span>
        <select
          aria-label={t("admin.driveLinks.maxDays")}
          className="h-8 rounded-lg border border-line bg-canvas px-2 text-sm"
          disabled={busy}
          value={days === null ? "none" : String(days)}
          onChange={(event) => void save({ link_max_days: event.target.value === "none" ? null : Number(event.target.value) })}
        >
          {choices.map((n) => <option key={n} value={String(n)}>{t("drive.share.expiryDays", { count: n })}</option>)}
          <option value="none">{t("admin.driveLinks.noMax")}</option>
        </select>
      </label>
      <label className={cn(CARD, "cursor-pointer")}>
        <span className="min-w-0 flex-1 text-sm">
          {t("admin.driveLinks.password")}
          <span className="block text-xs text-muted">{t("admin.driveLinks.passwordNote")}</span>
        </span>
        <input type="checkbox" role="switch" aria-label={t("admin.driveLinks.password")} className="h-4 w-4 accent-[var(--accent)]" disabled={busy} checked={settings.link_password_required} onChange={(event) => void save({ link_password_required: event.target.checked })} />
      </label>
      <LinkList
        controller={controller}
        links={links}
        showItem
        title={t("admin.driveLinks.all", { count: links.length })}
        revoke={async (link) => { await controller.api?.adminRevokeDriveLink(link.id); }}
        onRevoked={(gone) => setLinks((held) => (held ?? []).filter((link) => link.id !== gone.id))}
      />
      {cursor && <Button size="sm" variant="ghost" onClick={() => void load(cursor)}>{t("drive.share.moreLinks")}</Button>}
    </section>
  );
}
