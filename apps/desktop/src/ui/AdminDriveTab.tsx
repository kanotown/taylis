/**
 * 「管理 → ドライブ」 (M162, docs/DRIVE.md §11.2): how much the drive holds, never what. The whole drive (current
 * versions, older versions, the trash; the chat's attachments apart, which no quota counts), every location by name
 * with its use, its count and its quota (changed here, in GB; empty removes it), and how much each person put there.
 * The server's own free disk space is not visible to the app: the screen says where to look. M163: the external links'
 * switches and every link (AdminDriveLinks).
 */
import { FolderInput, HardDrive, Hash, Loader2, User as UserIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { describeError } from "../api/errors";
import type { DriveLocationUsageOut, DriveUsageOut } from "../api/types";
import { parseQuotaGb, quotaGbText, usageRatio } from "../drive/actions";
import { formatBytes } from "../drive/listing";
import type { AppController } from "../state/app";
import { group3, sinceLabel } from "./format";
import { AdminDriveLinks } from "./AdminDriveLinks";
import { Badge, Button, cn, Input } from "./primitives";
import { t } from "../i18n";

function UsageBar({ used, quota }: { used: number; quota: number | null | undefined }) {
  const ratio = usageRatio(used, quota);
  if (ratio === null) return null;
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/10" role="meter" aria-valuemin={0} aria-valuemax={quota ?? 0} aria-valuenow={used} aria-label={t("admin.drive.usageOf", { used: formatBytes(used), quota: formatBytes(quota) })}>
      <div className={cn("h-full rounded-full", ratio >= 1 ? "bg-danger" : ratio >= 0.9 ? "bg-warning" : "bg-accent")} style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
    </div>
  );
}

function locationLabel(row: DriveLocationUsageOut): string {
  if (row.kind === "workspace") return t("drive.location.workspace");
  if (row.kind === "channel") return `#${row.name}`;
  return t("admin.drive.myDriveOf", { name: row.name });
}

function QuotaField({ controller, row, onSaved }: { controller: AppController; row: DriveLocationUsageOut; onSaved: (row: DriveLocationUsageOut) => void }) {
  const [text, setText] = useState(quotaGbText(row.quota_bytes));
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(quotaGbText(row.quota_bytes)), [row.quota_bytes]);
  const parsed = parseQuotaGb(text);
  const changed = parsed !== undefined && parsed !== row.quota_bytes;
  const save = async () => {
    const api = controller.api;
    if (!api || parsed === undefined) return;
    setBusy(true);
    try {
      onSaved(await api.setDriveQuota(row.id, parsed));
      controller.setNotice(t("admin.drive.quotaSaved", { name: locationLabel(row) }));
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Input
        value={text}
        inputMode="decimal"
        onChange={(event) => setText(event.target.value)}
        placeholder={row.effective_quota_bytes !== null && row.quota_bytes === null ? t("admin.drive.defaultQuota", { size: formatBytes(row.effective_quota_bytes) }) : t("admin.drive.noQuota")}
        aria-label={t("admin.drive.quotaFor", { name: locationLabel(row) })}
        aria-invalid={parsed === undefined}
        className={cn("h-8 w-28 py-1 text-right text-[13px] tabular-nums", parsed === undefined && "border-danger")}
      />
      <span className="text-xs text-muted">GB</span>
      {changed && <Button size="sm" type="submit" disabled={busy}>{t("common.save")}</Button>}
    </form>
  );
}

/**
 * CF2 (docs/CHANNEL_FILES.md §9, §12.7): the workspace's switch 「チャンネルに投稿したファイルをチャンネルのドライブに
 * 保存する」 (on by default; a channel's owners may decide otherwise). Not shown by a server before CF1 (no such field).
 */
function ChannelFilesSwitch({ controller }: { controller: AppController }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    let current = true;
    void Promise.resolve().then(() => api.adminWorkspaceSettings()).then(
      (settings) => { if (current && typeof settings.channel_files_to_drive === "boolean") setOn(settings.channel_files_to_drive); },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [controller.api]);
  if (on === null) return null;
  const save = async (value: boolean) => {
    const api = controller.api;
    if (!api) return;
    setBusy(true);
    try {
      const settings = await api.adminUpdateWorkspaceSettings({ channel_files_to_drive: value });
      setOn(settings.channel_files_to_drive ?? value);
      controller.store.setWorkspaceSettings({ ...controller.store.workspaceSettings, channel_files_to_drive: settings.channel_files_to_drive ?? value });
      controller.setNotice(t("channelFiles.admin.saved"));
    } catch (failure) {
      controller.setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label data-admin-channel-files="" className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2">
      <FolderInput size={15} className="shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 text-sm">
        {t("channelFiles.admin.title")}
        <span className="block text-xs text-muted">{t("channelFiles.admin.note")}</span>
      </span>
      <input type="checkbox" role="switch" aria-label={t("channelFiles.admin.title")} className="h-4 w-4 accent-[var(--accent)]" disabled={busy} checked={on} onChange={(event) => void save(event.target.checked)} />
    </label>
  );
}

export function AdminDriveTab({ controller }: { controller: AppController }) {
  const [usage, setUsage] = useState<DriveUsageOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const api = controller.api;
    if (!api) return;
    try {
      setUsage(await api.adminDriveUsage());
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [controller.api]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p role="alert" className="py-6 text-center text-sm text-danger">{error}</p>;
  if (!usage) return <div className="flex justify-center py-8 text-muted"><Loader2 size={18} className="animate-spin" /></div>;
  const total = usage.total;
  const users = controller.store.users;
  const replace = (row: DriveLocationUsageOut) => setUsage((current) => current && { ...current, locations: current.locations.map((entry) => (entry.id === row.id ? row : entry)) });

  return (
    <div className="space-y-5 py-3" data-admin-drive="">
      <p className="text-sm text-muted">{t("admin.drive.description")}</p>
      <section aria-label={t("admin.drive.total")} className="rounded-xl border border-line p-4">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <strong className="text-2xl tabular-nums">{formatBytes(total.used_bytes) || "0 B"}</strong>
          <span className="text-sm text-muted">
            {total.total_quota_bytes !== null ? t("admin.drive.ofTotal", { quota: formatBytes(total.total_quota_bytes) }) : t("admin.drive.noTotal")}
          </span>
        </div>
        <UsageBar used={total.used_bytes} quota={total.total_quota_bytes} />
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
          <div><dt className="text-muted">{t("admin.drive.current")}</dt><dd className="tabular-nums">{formatBytes(total.current_bytes) || "0 B"}</dd></div>
          <div><dt className="text-muted">{t("admin.drive.oldVersions")}</dt><dd className="tabular-nums">{formatBytes(total.old_versions_bytes) || "0 B"}</dd></div>
          <div><dt className="text-muted">{t("admin.drive.trash")}</dt><dd className="tabular-nums">{formatBytes(total.trash_bytes) || "0 B"}</dd></div>
          <div><dt className="text-muted">{t("admin.drive.items")}</dt><dd className="tabular-nums">{group3(total.item_count)}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-muted">
          {t("admin.drive.chat", { size: formatBytes(total.chat_attachments_bytes) || "0 B", count: group3(total.chat_attachment_count) })}
          {total.user_default_quota_bytes !== null && ` ${t("admin.drive.userDefault", { size: formatBytes(total.user_default_quota_bytes) })}`}
        </p>
        <p className="mt-1 text-xs text-muted">{t("channelFiles.admin.chatNote")}</p>
        <p className="mt-1 text-xs text-muted">{t("admin.drive.disk")}</p>
      </section>

      <ChannelFilesSwitch controller={controller} />

      <AdminDriveLinks controller={controller} />

      <section aria-label={t("admin.drive.locations")}>
        <h3 className="mb-2 text-sm font-semibold">{t("admin.drive.locations")}</h3>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[560px] border-collapse text-[13px]">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">{t("admin.drive.location")}</th>
                <th className="w-40 px-3 py-2 font-medium">{t("admin.drive.used")}</th>
                <th className="w-20 px-3 py-2 text-right font-medium">{t("admin.drive.items")}</th>
                <th className="w-48 px-3 py-2 font-medium">{t("admin.drive.quota")}</th>
              </tr>
            </thead>
            <tbody>
              {usage.locations.map((row) => (
                <tr key={row.id} data-admin-drive-location={row.kind} className="border-b border-line/60 last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {row.kind === "workspace" ? <HardDrive size={14} className="shrink-0 text-muted" /> : row.kind === "channel" ? <Hash size={14} className="shrink-0 text-muted" /> : <UserIcon size={14} className="shrink-0 text-muted" />}
                      <span className="truncate font-medium">{locationLabel(row)}</span>
                      {row.archived && <Badge>{row.kind === "channel" ? t("admin.drive.archived") : t("admin.drive.deactivated")}</Badge>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      {t("admin.drive.split", { current: formatBytes(row.current_bytes) || "0 B", old: formatBytes(row.old_versions_bytes) || "0 B", trash: formatBytes(row.trash_bytes) || "0 B" })} · {sinceLabel(row.updated_at)}
                    </div>
                    {/* CF2 (docs/CHANNEL_FILES.md §8): how much of it is posted files (posts are never refused for the quota). */}
                    {(row.posted_bytes ?? 0) > 0 && (
                      <div data-admin-drive-posted="" className="mt-0.5 text-[11px] text-muted">
                        {t("channelFiles.admin.posted", { size: formatBytes(row.posted_bytes) })}
                        {row.effective_quota_bytes !== null && row.used_bytes > row.effective_quota_bytes && <span className="ml-1.5 font-medium text-danger">{t("channelFiles.admin.over")}</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatBytes(row.used_bytes) || "0 B"}
                    <UsageBar used={row.used_bytes} quota={row.effective_quota_bytes} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{group3(row.item_count)}</td>
                  <td className="px-3 py-2"><QuotaField controller={controller} row={row} onSaved={replace} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">{t("admin.drive.quotaHint")}</p>
      </section>

      {usage.people.length > 0 && (
        <section aria-label={t("admin.drive.people")}>
          <h3 className="mb-2 text-sm font-semibold">{t("admin.drive.people")}</h3>
          <ul className="divide-y divide-line rounded-xl border border-line text-[13px]">
            {usage.people.map((person) => (
              <li key={person.user_id} className="flex items-center gap-3 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate">{users.get(person.user_id)?.display_name ?? t("drive.someone")}</span>
                <span className="text-xs text-muted">{t("admin.drive.versions", { count: group3(person.versions) })}</span>
                <span className="w-20 text-right tabular-nums">{formatBytes(person.bytes) || "0 B"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{t("admin.drive.peopleHint")}</p>
        </section>
      )}
    </div>
  );
}
