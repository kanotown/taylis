/**
 * The drive's upload panel (M161, docs/DRIVE.md §17.3), bottom right as in Google Drive: every file with its progress,
 * speed and time left, the total, pause / resume / cancel / try again, and the files a restart left waiting
 * (「続きがあります」: picked again, they go on from the parts the server has). The name-conflict question shows here.
 * It stays while I move around the app and closes once everything is finished.
 */
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, FileUp, Pause, Play, RotateCcw, X } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";

import type { AppController } from "../state/app";
import { formatBytes, formatRemaining } from "../drive/listing";
import { answerConflict, useQueueSignals, useUploadQueue } from "../drive/session";
import { isFinished, type UploadJob, uploadTotals } from "../drive/uploads";
import { describeError } from "../api/errors";
import { ApiError } from "../api/errors";
import { fileSource, pickFilesNative } from "../platform/driveFiles";
import { isTauri } from "../platform/env";
import { ConflictDialog } from "./DriveDialogs";
import { FileName } from "./FileName";
import { cn, IconButton } from "./primitives";
import { t } from "../i18n";

export function stateLine(job: UploadJob): string {
  const percent = job.size > 0 ? Math.floor((job.sent / job.size) * 100) : 0;
  switch (job.state) {
    case "queued":
      return t("drive.upload.queued");
    case "asking":
      return t("drive.upload.asking");
    case "uploading": {
      const speed = job.speed > 0 ? ` · ${formatBytes(job.speed)}/s` : "";
      const left = job.speed > 0 ? ` · ${formatRemaining((job.size - job.sent) / job.speed)}` : "";
      return `${percent}%${speed}${left}`;
    }
    case "completing":
      return t("drive.upload.completing");
    case "paused":
      return t("drive.upload.paused", { percent });
    case "waiting":
      return t("drive.upload.waiting", { percent });
    case "done":
      return t("drive.upload.done");
    case "skipped":
      return t("drive.upload.skipped");
    case "cancelled":
      return t("drive.upload.cancelled");
    case "needs-file":
      return job.error === "read_failed" ? t("drive.upload.readFailed") : t("drive.upload.needsFile", { percent });
    case "failed":
      return describeError(new ApiError(409, job.error ?? "unknown", ""));
  }
}

export function DriveUploadPanel({ controller }: { controller: AppController }) {
  const queue = useUploadQueue(controller.accountKey, controller.api);
  useQueueSignals(queue, controller.engine?.drive);
  const [folded, setFolded] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!queue || queue.jobs.length === 0) return null;
  const jobs = queue.jobs;
  const totals = uploadTotals(jobs);
  const waitingForFiles = jobs.filter((job) => job.state === "needs-file");
  const allFinished = jobs.every((job) => isFinished(job.state) || job.state === "failed");
  const anyPausable = jobs.some((job) => ["queued", "uploading", "waiting"].includes(job.state));
  const anyPaused = jobs.some((job) => job.state === "paused");
  const percent = totals.bytes > 0 ? Math.min(100, Math.floor((totals.sent / totals.bytes) * 100)) : allFinished ? 100 : 0;

  const attach = (picked: ReturnType<typeof fileSource>[]) => {
    const rest = queue.attach(picked);
    setNotice(rest.length > 0 ? t("drive.upload.notMatched", { count: rest.length }) : null);
  };
  const pickAgain = async () => {
    if (isTauri()) {
      const tree = await pickFilesNative();
      if (tree) attach(tree.files);
      return;
    }
    picker.current?.click();
  };
  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    attach(files.map((file) => fileSource(file)));
    // The File objects stay readable after the input is cleared in a browser (the app's dialog is used in Tauri).
    event.target.value = "";
  };
  const key = controller.accountKey ?? "";
  const title = allFinished
    ? t("drive.upload.titleDone", { done: totals.done, files: totals.files })
    : t("drive.upload.title", { done: totals.done, files: totals.files });

  return (
    <section aria-label={t("drive.upload.panel")} data-drive-uploads="" className="flex w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-line bg-canvas text-ink shadow-2xl">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <FileUp size={16} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
          {!allFinished && (
            <div className="text-[11px] tabular-nums text-muted">
              {formatBytes(totals.sent)} / {formatBytes(totals.bytes)}
              {totals.remainingSeconds !== null ? ` · ${formatRemaining(totals.remainingSeconds)}` : ""}
            </div>
          )}
        </div>
        {anyPausable && <IconButton label={t("drive.upload.pauseAll")} onClick={() => queue.pauseAll()}><Pause size={15} /></IconButton>}
        {!anyPausable && anyPaused && <IconButton label={t("drive.upload.resumeAll")} onClick={() => queue.resumeAll()}><Play size={15} /></IconButton>}
        <IconButton label={folded ? t("drive.upload.unfold") : t("drive.upload.fold")} onClick={() => setFolded((value) => !value)}>
          {folded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </IconButton>
        {allFinished && <IconButton label={t("common.close")} onClick={() => queue.clearFinished()}><X size={15} /></IconButton>}
      </header>
      {!allFinished && (
        <div role="progressbar" aria-label={t("drive.upload.total")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 bg-ink/10">
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      )}
      {!folded && (
        <>
          {waitingForFiles.length > 0 && (
            <div className="border-b border-line px-3 py-2 text-xs">
              <p>{t("drive.upload.resumeNotice", { count: waitingForFiles.length })}</p>
              {!isTauri() && <p className="mt-1 text-muted">{t("drive.upload.browserNote")}</p>}
              <button type="button" className="mt-1.5 rounded-md border border-line px-2 py-1 font-medium hover:bg-ink/6" onClick={() => void pickAgain()}>
                {t("drive.upload.pickAgain")}
              </button>
              {notice && <p className="mt-1 text-muted">{notice}</p>}
              <input ref={picker} type="file" multiple hidden onChange={onPicked} />
            </div>
          )}
          <ul className="max-h-72 overflow-y-auto py-1">
            {jobs.map((job) => (
              <UploadRow key={job.id} job={job} onPause={() => queue.pause(job.id)} onResume={() => queue.resume(job.id)} onCancel={() => void queue.cancel(job.id)} onPick={() => void pickAgain()} />
            ))}
          </ul>
        </>
      )}
      {queue.question && <ConflictDialog question={queue.question} onAnswer={(choice, all) => answerConflict(key, choice, all)} />}
    </section>
  );
}

function UploadRow({ job, onPause, onResume, onCancel, onPick }: { job: UploadJob; onPause: () => void; onResume: () => void; onCancel: () => void; onPick: () => void }) {
  const percent = job.size > 0 ? Math.min(100, Math.floor((job.sent / job.size) * 100)) : job.state === "done" ? 100 : 0;
  const moving = job.state === "uploading" || job.state === "queued" || job.state === "waiting" || job.state === "completing";
  const failed = job.state === "failed";
  return (
    <li data-upload-state={job.state} className="group px-3 py-1.5">
      <div className="flex items-center gap-2">
        {job.state === "done" ? <CheckCircle2 size={15} className="shrink-0 text-success" /> : failed ? <AlertCircle size={15} className="shrink-0 text-danger" /> : <FileUp size={15} className="shrink-0 text-muted" />}
        <div className="min-w-0 flex-1">
          <FileName name={job.name} className="text-[13px]" />
          <div className={cn("truncate text-[11px] tabular-nums", failed ? "text-danger" : "text-muted")}>
            {job.relativeDir ? `${job.relativeDir} · ` : ""}
            {formatBytes(job.size)} · {stateLine(job)}
          </div>
        </div>
        <div className="flex shrink-0 items-center opacity-80 group-hover:opacity-100">
          {(job.state === "uploading" || job.state === "queued" || job.state === "waiting") && (
            <IconButton label={t("drive.upload.pause")} onClick={onPause} className="h-7 w-7"><Pause size={13} /></IconButton>
          )}
          {job.state === "paused" && <IconButton label={t("drive.upload.resume")} onClick={onResume} className="h-7 w-7"><Play size={13} /></IconButton>}
          {failed && <IconButton label={t("drive.upload.retry")} onClick={onResume} className="h-7 w-7"><RotateCcw size={13} /></IconButton>}
          {job.state === "needs-file" && <IconButton label={t("drive.upload.pickAgain")} onClick={onPick} className="h-7 w-7"><FileUp size={13} /></IconButton>}
          {!isFinished(job.state) && <IconButton label={t("drive.upload.cancel")} onClick={onCancel} className="h-7 w-7"><X size={13} /></IconButton>}
        </div>
      </div>
      {(moving || job.state === "paused" || job.state === "needs-file") && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink/10 pl-0">
          <div className={cn("h-full rounded-full transition-[width] duration-300", job.state === "paused" || job.state === "needs-file" ? "bg-muted" : "bg-accent")} style={{ width: `${percent}%` }} />
        </div>
      )}
    </li>
  );
}
