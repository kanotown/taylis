/**
 * CF5 (docs/CHANNEL_FILES.md §12.4, §23): the composer's offer for files over the attachment limit 「ドライブに
 * アップロードしてリンクを投稿」, and a chip per such file with its progress, where it goes and a cancel button. The
 * upload is the drive's (its panel shows it too, with pause / resume / try again); the link goes into the draft when it
 * is done, and sending waits until then.
 */
import { AlertCircle, CloudUpload, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { formatBytes } from "../drive/listing";
import { addBigUploads, type BigUpload, bigUploadsOf, bigUploadsVersion, chipJob, heldJob, holdsSend, removeBigUpload, resolveBigFilePlace, subscribeBigUploads } from "../drive/bigFiles";
import { uploadQueueFor, useUploadQueue } from "../drive/session";
import type { UploadJob } from "../drive/uploads";
import { fileSource } from "../platform/driveFiles";
import { ATTACHMENT_MAX_BYTES, formatMegabytes } from "../platform/pickedFiles";
import { stateLine } from "./DriveUploadPanel";
import { FileName } from "./FileName";
import { Button, IconButton } from "./primitives";
import { t } from "../i18n";

/** Big files waiting for the person's answer; `releases` clear the picker's input once they are no longer read. */
export interface BigFileOfferState {
  files: File[];
  releases: (() => void)[];
}

/** The offer that takes the place of 「大きすぎます」 (§12.4). */
export function BigFileOffer({ offer, where, onUpload, onDismiss }: { offer: BigFileOfferState; where: "channel" | "me"; onUpload: () => void; onDismiss: () => void }) {
  const max = formatMegabytes(ATTACHMENT_MAX_BYTES);
  const first = offer.files[0];
  const title = offer.files.length === 1 && first ? t("composer.bigFile.tooLargeOne", { name: first.name, max }) : t("composer.bigFile.tooLargeMany", { count: offer.files.length, max });
  return (
    <div data-big-file-offer="" role="group" aria-label={t("composer.bigFile.offer")} className="mx-2 mt-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
      <p className="flex items-start gap-1.5">
        <CloudUpload size={13} className="mt-px shrink-0 text-muted" aria-hidden />
        <span>{title} {where === "channel" ? t("composer.bigFile.toChannel") : t("composer.bigFile.toMine")}</span>
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <Button size="sm" className="h-7 text-xs" onClick={onUpload}>{t("composer.bigFile.upload")}</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onDismiss}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}

export interface BigUploadItem {
  upload: BigUpload;
  job: UploadJob | null;
}

/**
 * The big files of the composer `key` with their jobs; `onDone` puts a finished file's link in the draft (true: taken,
 * the chip goes). A chip whose upload was cancelled or skipped (in the drive's panel) goes too.
 */
export function useBigUploads(controller: AppController, key: string, onDone: (itemId: string) => boolean): { items: BigUploadItem[]; holding: boolean } {
  const account = controller.accountKey;
  const queue = useUploadQueue(account, controller.api);
  const subscribe = useCallback((listener: () => void) => (account ? subscribeBigUploads(account, listener) : () => undefined), [account]);
  useSyncExternalStore(subscribe, () => (account ? bigUploadsVersion(account) : 0));
  const uploads = account ? bigUploadsOf(account, key) : [];
  const items = uploads.map((upload) => ({ upload, job: chipJob(upload, queue?.jobs ?? [], account ? heldJob(account, upload.clientUploadId) : null) }));
  const latest = useRef(onDone);
  latest.current = onDone;
  const states = items.map((item) => `${item.upload.clientUploadId}:${item.job?.state ?? ""}`).join(",");
  useEffect(() => {
    if (!account) return;
    for (const { upload, job } of items) {
      if (!job) continue;
      if (job.state === "done" && job.itemId) {
        if (latest.current(job.itemId)) removeBigUpload(account, upload.clientUploadId);
      } else if (job.state === "cancelled" || job.state === "skipped" || (job.state === "done" && !job.itemId)) {
        removeBigUpload(account, upload.clientUploadId);
      }
    }
  }, [account, states]); // eslint-disable-line react-hooks/exhaustive-deps
  return { items, holding: items.some((item) => holdsSend(item.job)) };
}

/**
 * Starts the drive uploads of `files` for the composer `key` of `channel`: false (nothing started, `release` called)
 * when there is no folder I can write — the composer then says the files are too large, as before.
 */
export async function startBigUploads(controller: AppController, channel: ChannelState, key: string, files: readonly File[], release: () => void): Promise<boolean> {
  const api = controller.api;
  const account = controller.accountKey;
  if (!api || !account || files.length === 0) {
    release();
    return false;
  }
  let place;
  try {
    place = await resolveBigFilePlace(api, channel, controller.store.workspaceSettings);
  } catch {
    release();
    return false;
  }
  const queue = uploadQueueFor(account, api);
  // A taken name keeps both (「動画 (1).mp4」) without a question: the file is posted, not filed by hand.
  const jobs = queue.add(files.map((file) => fileSource(file, place.relativeDir)), place.target, { onConflict: "rename" });
  addBigUploads(account, key, jobs, place.target.label, release);
  return true;
}

function percentOf(job: UploadJob | null): number {
  if (!job) return 0;
  if (job.state === "done") return 100;
  return job.size > 0 ? Math.min(100, Math.floor((job.sent / job.size) * 100)) : 0;
}

/** The chips under the composer's attachments. */
export function BigUploadChips({ controller, items }: { controller: AppController; items: readonly BigUploadItem[] }) {
  const account = controller.accountKey;
  if (items.length === 0 || !account) return null;
  const cancel = (item: BigUploadItem) => {
    const queue = controller.api ? uploadQueueFor(account, controller.api) : null;
    if (queue && item.job && queue.jobs.includes(item.job)) void queue.cancel(item.job.id);
    removeBigUpload(account, item.upload.clientUploadId);
  };
  return (
    <div data-big-uploads="" className="flex flex-col gap-1.5 px-1 pb-2 pt-1.5">
      {items.map((item) => {
        const { upload, job } = item;
        const percent = percentOf(job);
        const failed = job?.state === "failed";
        const line = job ? stateLine(job) : t("composer.bigFile.lost");
        return (
          <div key={upload.clientUploadId} data-big-upload={job?.state ?? "lost"} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs">
            {failed || !job ? <AlertCircle size={14} className="shrink-0 text-danger" aria-hidden /> : <Loader2 size={14} className="shrink-0 animate-spin text-muted" aria-hidden />}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <FileName name={upload.name} className="min-w-0 font-medium" />
                <span className="shrink-0 tabular-nums text-muted">{formatBytes(upload.size)}</span>
              </div>
              <div className={failed || !job ? "truncate text-danger" : "truncate text-muted"} role="status">
                {t("composer.bigFile.where", { where: upload.label })} · {line}
              </div>
              {!failed && job && (
                <div role="progressbar" aria-label={t("composer.bigFile.progress", { name: upload.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-1 h-1 overflow-hidden rounded-full bg-ink/10">
                  <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
                </div>
              )}
            </div>
            <IconButton label={t("composer.bigFile.cancel", { name: upload.name })} className="h-6 w-6 shrink-0 text-muted" onClick={() => cancel(item)}>
              <X size={13} />
            </IconButton>
          </div>
        );
      })}
      <p className="px-1 text-[11.5px] text-muted">{t("composer.bigFile.waitHint")}</p>
    </div>
  );
}
