/**
 * 「版の履歴」 (M162, docs/DRIVE.md §10.2): a file's versions, newest first, with who put each one there, its size and
 * how it came to be. Every version downloads; an older one can be brought back as the new current version (those who
 * may write; the versions in between stay) or deleted for good (those who may delete for good, §3.2). Older versions
 * are kept for a while only (the server says how many and how long), which the dialog says.
 */
import { Download, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { describeError } from "../api/errors";
import type { DriveItemOut, DriveLocationOut, DriveVersionListOut, DriveVersionOut } from "../api/types";
import { versionActions, versionSourceLabel } from "../drive/actions";
import { formatBytes } from "../drive/listing";
import type { AppController } from "../state/app";
import { sinceLabel } from "./format";
import { Badge, Button, Modal } from "./primitives";
import { t } from "../i18n";

export function VersionsDialog({ controller, item, location, onClose, onChanged }: {
  controller: AppController;
  item: DriveItemOut;
  location: Pick<DriveLocationOut, "can_write" | "can_manage">;
  onClose: () => void;
  /** A version was brought back or deleted: the listing reads the file again. */
  onChanged: (item: DriveItemOut | null) => void;
}) {
  const [list, setList] = useState<DriveVersionListOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DriveVersionOut | null>(null);

  const load = useCallback(async () => {
    const api = controller.api;
    if (!api) return;
    try {
      setList(await api.driveVersions(item.id));
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    }
  }, [controller.api, item.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (version: DriveVersionOut) => {
    const api = controller.api;
    if (!api) return;
    setBusy(version.id);
    try {
      const restored = await api.restoreDriveVersion(item.id, version.id);
      controller.setNotice(t("drive.versions.restored", { number: version.number }));
      onChanged(restored);
      await load();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (version: DriveVersionOut) => {
    const api = controller.api;
    if (!api) return;
    setBusy(version.id);
    try {
      await api.deleteDriveVersion(item.id, version.id);
      setConfirm(null);
      onChanged(null);
      await load();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(null);
    }
  };

  const users = controller.store.users;
  const who = (id: string | null | undefined) => (id ? users.get(id)?.display_name ?? t("drive.someone") : t("drive.someone"));
  return (
    <Modal onClose={onClose} title={t("drive.versions.title", { name: item.name })} growsDown className="w-[560px]">
      {list && <p className="mt-1 text-xs text-muted">{t("drive.versions.keep", { count: list.keep_versions, days: list.keep_days })}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {list === null && !error ? (
        <div className="flex justify-center py-8 text-muted"><Loader2 size={18} className="animate-spin" /></div>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line" aria-label={t("drive.versions.list")}>
          {(list?.versions ?? []).map((version) => {
            const can = versionActions(version, { canWrite: location.can_write, canManage: location.can_manage });
            return (
              <li key={version.id} data-drive-version={version.number} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <strong className="font-semibold">{t("drive.versions.number", { number: version.number })}</strong>
                    {version.current && <Badge tone="accent">{t("drive.versions.current")}</Badge>}
                    <span className="truncate text-muted">{versionSourceLabel(version)}</span>
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {sinceLabel(version.created_at)} · {who(version.uploaded_by)} · {formatBytes(version.size_bytes)}
                  </div>
                </div>
                <Button size="sm" variant="ghost" aria-label={t("drive.versions.download", { number: version.number })} onClick={() => void controller.downloadDriveFile({ id: item.id, name: item.name, size_bytes: version.size_bytes }, { versionId: version.current ? null : version.id })}>
                  <Download size={13} />
                </Button>
                {can.restore && (
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void restore(version)}>
                    {busy === version.id ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} {t("drive.versions.restore")}
                  </Button>
                )}
                {can.remove && (
                  <Button size="sm" variant="ghost" className="text-danger" aria-label={t("drive.versions.delete", { number: version.number })} disabled={busy !== null} onClick={() => setConfirm(version)}>
                    <Trash2 size={13} />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">{t("drive.versions.hint")}</p>
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
      </div>
      {confirm && (
        <Modal onClose={() => setConfirm(null)} title={t("drive.versions.deleteTitle")} description={t("drive.versions.deleteText", { number: confirm.number, name: item.name })}>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy !== null} onClick={() => void remove(confirm)}>{t("drive.versions.deleteConfirm")}</Button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
