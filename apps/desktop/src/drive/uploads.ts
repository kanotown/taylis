/**
 * The drive's upload queue (M161, docs/DRIVE.md §6 and §17.3): files and folders go up in 16 MiB parts that survive a
 * lost connection, a paused upload and (in the desktop app) a restart.
 *
 * Each file is a job:
 *
 *   queued → (asking) → uploading → completing → done
 *                 ↘ skipped     ↘ paused / waiting (network) ↗   ↘ failed
 *   needs-file: a session the server keeps (24 h after its last part) whose bytes this tab cannot read any more (a
 *   browser closed, a file that can no longer be opened); picking the same file again (name, size and time) resumes it.
 *
 * - A session is made with `fail`: a name already in the folder answers 409 drive_name_taken before any byte is sent,
 *   and the question 「上書きして版にする / 名前を変える / スキップ」 is asked (one at a time, 「残りすべてに同じ操作」
 *   answers the rest of the batch). The answer sets `on_conflict` (version / rename) and the session is made again with
 *   the same client_upload_id (the 409 made none, so the retry is still idempotent).
 * - The parts the server has (`received_parts`) are never sent again; up to `partsPerFile` go at once, `filesAtOnce`
 *   files at once. A part is its bytes and their SHA-256 (the server checks both).
 * - A network failure or a 5xx / 429 waits (2 s, doubling to 30 s, or at once when the browser says it is back online)
 *   and asks the server which parts it has before going on. An expired session starts again from the first part.
 * - The completion answers 200 (done) or 202 (still joining the parts: asked again every 2 s). A name taken meanwhile
 *   (`fail`) leaves the session active with error drive_name_taken: the question is asked and the session patched.
 *   A folder moved to another drive meanwhile ends the session (409 drive_upload_target_moved, REVIEW-v0.1.70 #1):
 *   the job fails with that error and is not started again by itself (the person picks where it goes).
 * - What a restart needs is kept in `storage` (per account): the session's ids, the file's name, size, time and folder,
 *   and in the desktop app its path (read again from disk). A browser cannot reopen a file after the tab is gone.
 */
import type { DriveConflictMode, DriveUploadCompleteOut, DriveUploadCreate, DriveUploadOut, DriveUploadPartOut, DriveUploadPatch, DriveUploadListOut } from "../api/types";
import { ApiError, NetworkError } from "../api/errors";

/** A file to send: its bytes are read part by part, never whole. */
export interface UploadSource {
  name: string;
  size: number;
  /** The file's own time (ms since the epoch), when known. */
  lastModified: number | null;
  /** The folder below the target it goes into ("a/b"; "" for none): a folder upload keeps its shape. */
  relativeDir: string;
  /** Bytes [start, end). */
  read(start: number, end: number): Promise<Uint8Array>;
  /** The desktop app's path on disk (kept for a restart); null for a browser's File. */
  path: string | null;
}

/** Where a batch goes. */
export interface UploadTarget {
  parentId: string;
  locationId: string;
  /** Shown in the panel (「研究室ドライブ › ゼミ資料」). */
  label: string;
}

export type UploadState = "queued" | "asking" | "uploading" | "paused" | "waiting" | "completing" | "done" | "skipped" | "failed" | "cancelled" | "needs-file";

export type ConflictChoice = "version" | "rename" | "skip";

export interface UploadJob {
  /** This queue's own id. */
  id: string;
  batchId: string;
  clientUploadId: string;
  uploadId: string | null;
  name: string;
  size: number;
  lastModified: number | null;
  relativeDir: string;
  target: UploadTarget;
  state: UploadState;
  onConflict: DriveConflictMode;
  partSize: number;
  partsTotal: number;
  /** Part numbers the server has. */
  received: number[];
  /** Bytes of the parts the server has. */
  sent: number;
  /** Bytes per second lately (0 until measured). */
  speed: number;
  /** An error code (the server's, or "network", "read_failed") while failed, waiting or needing the file. */
  error: string | null;
  /** The made item, once done. */
  itemId: string | null;
  path: string | null;
}

/** A conflict waiting for an answer (the panel's question). */
export interface ConflictQuestion {
  job: UploadJob;
  /** "file" or "folder": a folder of that name cannot take a new version. */
  existingKind: string | null;
  /** How many more of the batch are still to go (「残りすべてに同じ操作」 shows when > 0). */
  remaining: number;
}

export interface UploadApi {
  createDriveUpload(body: DriveUploadCreate): Promise<DriveUploadOut>;
  driveUpload(uploadId: string): Promise<DriveUploadOut>;
  driveUploads(status: DriveUploadOut["status"] | null): Promise<DriveUploadListOut>;
  patchDriveUpload(uploadId: string, patch: DriveUploadPatch): Promise<DriveUploadOut>;
  putDrivePart(uploadId: string, number: number, bytes: Uint8Array, sha256Hex: string, signal?: AbortSignal): Promise<DriveUploadPartOut>;
  completeDriveUpload(uploadId: string): Promise<DriveUploadCompleteOut>;
  abortDriveUpload(uploadId: string): Promise<void>;
}

/** What a restart needs (never the bytes). */
export interface PersistedUpload {
  clientUploadId: string;
  uploadId: string | null;
  name: string;
  size: number;
  lastModified: number | null;
  relativeDir: string;
  target: UploadTarget;
  onConflict: DriveConflictMode;
  path: string | null;
  paused: boolean;
}

export interface UploadStorage {
  load(): PersistedUpload[];
  save(entries: PersistedUpload[]): void;
}

export interface UploadDeps {
  api: UploadApi;
  sha256(bytes: Uint8Array): Promise<string>;
  storage: UploadStorage;
  /** A file of the desktop app read again from its path after a restart (null: not readable now). */
  reopen?: (entry: PersistedUpload) => Promise<UploadSource | null>;
  newId?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The answer to a name conflict; `all`: the same for the rest of the batch. */
  ask?: (question: ConflictQuestion) => Promise<{ choice: ConflictChoice; all: boolean }>;
  filesAtOnce?: number;
  partsPerFile?: number;
  /** Called after every change (the panel re-renders). */
  onChange?: () => void;
  /** A file finished (the open folder reads itself again; the server's drive.changed says so too). */
  onDone?: (job: UploadJob) => void;
}

const FINISHED: readonly UploadState[] = ["done", "skipped", "cancelled"];
const ACTIVE: readonly UploadState[] = ["uploading", "completing", "asking"];
export const RETRY_MIN_MS = 2_000;
export const RETRY_MAX_MS = 30_000;
export const COMPLETE_POLL_MS = 2_000;

export function isFinished(state: UploadState): boolean {
  return FINISHED.includes(state);
}

/** The parts of a file of `size` bytes cut at `partSize` (none for an empty file). */
export function partCount(size: number, partSize: number): number {
  return size <= 0 ? 0 : Math.ceil(size / partSize);
}

/** Byte range [start, end) of part `number` (from 1). */
export function partRange(number: number, size: number, partSize: number): [number, number] {
  const start = (number - 1) * partSize;
  return [start, Math.min(size, start + partSize)];
}

/** The part numbers still to send, lowest first. */
export function missingParts(total: number, received: readonly number[]): number[] {
  const have = new Set(received);
  const out: number[] = [];
  for (let n = 1; n <= total; n++) if (!have.has(n)) out.push(n);
  return out;
}

/** Bytes of the parts the server has. */
export function sentBytes(received: readonly number[], size: number, partSize: number): number {
  let total = 0;
  for (const n of new Set(received)) {
    const [start, end] = partRange(n, size, partSize);
    if (end > start) total += end - start;
  }
  return total;
}

/** A file picked again matches a session by name, size and (when both know it) its time. */
export function sameFile(job: Pick<UploadJob, "name" | "size" | "lastModified">, file: Pick<UploadSource, "name" | "size" | "lastModified">): boolean {
  if (job.name.normalize("NFC") !== file.name.normalize("NFC") || job.size !== file.size) return false;
  return job.lastModified === null || file.lastModified === null || Math.abs(job.lastModified - file.lastModified) < 2000;
}

export interface UploadTotals {
  files: number;
  done: number;
  failed: number;
  bytes: number;
  sent: number;
  /** Files being sent or about to be. */
  pending: number;
  /** Seconds left at the current speed (null: unknown). */
  remainingSeconds: number | null;
}

export function uploadTotals(jobs: readonly UploadJob[]): UploadTotals {
  const counted = jobs.filter((job) => job.state !== "cancelled" && job.state !== "skipped");
  const bytes = counted.reduce((sum, job) => sum + job.size, 0);
  const sent = counted.reduce((sum, job) => sum + (job.state === "done" ? job.size : job.sent), 0);
  const speed = counted.filter((job) => job.state === "uploading").reduce((sum, job) => sum + job.speed, 0);
  const pending = counted.filter((job) => !isFinished(job.state) && job.state !== "failed" && job.state !== "needs-file").length;
  return {
    files: counted.length,
    done: counted.filter((job) => job.state === "done").length,
    failed: counted.filter((job) => job.state === "failed").length,
    bytes,
    sent,
    pending,
    remainingSeconds: speed > 0 ? Math.round((bytes - sent) / speed) : null,
  };
}

function randomId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Network trouble or a server that is briefly unwell: wait and go on (the parts it has are kept). */
function isTransient(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ApiError && error.isRetryable) || (error instanceof DOMException && error.name === "AbortError");
}

class Paused extends Error {}

export class UploadQueue {
  jobs: UploadJob[] = [];
  /** The conflict the panel asks about now (one at a time). */
  question: ConflictQuestion | null = null;
  private readonly sources = new Map<string, UploadSource>();
  private readonly controllers = new Map<string, AbortController>();
  /** Answers given with 「残りすべてに同じ操作」, by batch. */
  private readonly batchAnswers = new Map<string, ConflictChoice>();
  private readonly retryAt = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private asking: Promise<unknown> = Promise.resolve();
  private running = 0;
  private stopped = false;
  private wake: (() => void) | null = null;
  private readonly opts: Required<Pick<UploadDeps, "filesAtOnce" | "partsPerFile">>;

  constructor(private readonly deps: UploadDeps) {
    this.opts = { filesAtOnce: deps.filesAtOnce ?? 3, partsPerFile: deps.partsPerFile ?? 3 };
  }

  private newId(): string {
    return (this.deps.newId ?? randomId)();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private changed(): void {
    this.persist();
    this.deps.onChange?.();
  }

  private persist(): void {
    try {
      this.deps.storage.save(
        this.jobs
          .filter((job) => !isFinished(job.state))
          .map((job) => ({
            clientUploadId: job.clientUploadId,
            uploadId: job.uploadId,
            name: job.name,
            size: job.size,
            lastModified: job.lastModified,
            relativeDir: job.relativeDir,
            target: job.target,
            onConflict: job.onConflict,
            path: job.path,
            paused: job.state === "paused",
          })),
      );
    } catch {
      /* a convenience for a restart only */
    }
  }

  private update(job: UploadJob, change: Partial<UploadJob>): void {
    Object.assign(job, change);
    this.changed();
  }

  /** Files into `target` (a batch: one 「残りすべてに同じ操作」 answers all of it). */
  add(sources: readonly UploadSource[], target: UploadTarget): UploadJob[] {
    const batchId = this.newId();
    const added = sources.map((source) => {
      const job: UploadJob = {
        id: this.newId(),
        batchId,
        clientUploadId: this.newId(),
        uploadId: null,
        name: source.name,
        size: source.size,
        lastModified: source.lastModified,
        relativeDir: source.relativeDir,
        target,
        state: "queued",
        onConflict: "fail",
        partSize: 0,
        partsTotal: 0,
        received: [],
        sent: 0,
        speed: 0,
        error: null,
        itemId: null,
        path: source.path,
      };
      this.sources.set(job.id, source);
      return job;
    });
    this.jobs = [...this.jobs, ...added];
    this.changed();
    this.pump();
    return added;
  }

  /**
   * After a restart: the sessions kept here that the server still has. A desktop file is read again from its path and
   * goes on by itself (unless it was paused); a browser's needs to be picked again (`attach`).
   */
  async restore(): Promise<void> {
    let entries: PersistedUpload[];
    try {
      entries = this.deps.storage.load();
    } catch {
      entries = [];
    }
    if (entries.length === 0) return;
    let active: DriveUploadOut[] = [];
    let listed = false;
    try {
      active = (await this.deps.api.driveUploads("active")).uploads;
      listed = true;
    } catch {
      // Offline at the start: keep them as they are and try their sessions when they run.
      active = [];
    }
    const byClient = new Map(active.map((upload) => [upload.client_upload_id, upload]));
    const known = new Set(this.jobs.map((job) => job.clientUploadId));
    for (const entry of entries) {
      if (known.has(entry.clientUploadId)) continue;
      const session = byClient.get(entry.clientUploadId);
      // Made but gone (completed elsewhere, expired, cancelled): nothing to resume. Never made: start it again.
      if (entry.uploadId && !session && listed) continue;
      const job: UploadJob = {
        id: this.newId(),
        batchId: `restored:${entry.target.parentId}`,
        clientUploadId: entry.clientUploadId,
        uploadId: session?.id ?? entry.uploadId,
        name: entry.name,
        size: entry.size,
        lastModified: entry.lastModified,
        relativeDir: entry.relativeDir,
        target: entry.target,
        state: "needs-file",
        onConflict: entry.onConflict,
        partSize: session?.part_size ?? 0,
        partsTotal: session?.parts_total ?? 0,
        received: session?.received_parts ?? [],
        sent: session ? sentBytes(session.received_parts, session.size_bytes, session.part_size) : 0,
        speed: 0,
        error: null,
        itemId: null,
        path: entry.path,
      };
      const source = entry.path && this.deps.reopen ? await this.deps.reopen(entry).catch(() => null) : null;
      if (source && source.size === entry.size) {
        this.sources.set(job.id, source);
        job.state = entry.paused ? "paused" : "queued";
      }
      this.jobs = [...this.jobs, job];
    }
    this.changed();
    this.pump();
  }

  /**
   * Files picked again for sessions that need them (matched by name, size and time). The ones that match nothing are
   * returned (the caller may upload them as new files).
   */
  attach(sources: readonly UploadSource[]): UploadSource[] {
    const rest: UploadSource[] = [];
    for (const source of sources) {
      const job = this.jobs.find((candidate) => candidate.state === "needs-file" && sameFile(candidate, source));
      if (!job) {
        rest.push(source);
        continue;
      }
      this.sources.set(job.id, source);
      if (source.path) job.path = source.path;
      job.state = "queued";
      job.error = null;
    }
    this.changed();
    this.pump();
    return rest;
  }

  pause(id: string): void {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || isFinished(job.state) || job.state === "failed" || job.state === "needs-file") return;
    this.update(job, { state: "paused", speed: 0 });
    this.controllers.get(id)?.abort();
  }

  resume(id: string): void {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || !(job.state === "paused" || job.state === "failed" || job.state === "waiting")) return;
    if (!this.sources.has(job.id)) {
      this.update(job, { state: "needs-file" });
      return;
    }
    this.retryAt.delete(id);
    this.attempts.delete(id);
    this.update(job, { state: "queued", error: null });
    this.pump();
  }

  pauseAll(): void {
    for (const job of this.jobs) this.pause(job.id);
  }

  resumeAll(): void {
    for (const job of this.jobs) if (job.state === "paused" || job.state === "waiting") this.resume(job.id);
  }

  /** Stops it and drops the server's session (its parts are deleted there). */
  async cancel(id: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || isFinished(job.state)) return;
    this.controllers.get(id)?.abort();
    const uploadId = job.uploadId;
    this.update(job, { state: "cancelled", speed: 0 });
    this.sources.delete(id);
    if (uploadId) {
      try {
        await this.deps.api.abortDriveUpload(uploadId);
      } catch {
        /* expires on the server within a day anyway */
      }
    }
  }

  /** Takes the finished, skipped and cancelled rows out of the panel. */
  clearFinished(): void {
    this.jobs = this.jobs.filter((job) => !isFinished(job.state));
    this.changed();
  }

  /** The network is back (the browser's `online`, the engine reconnected): waiting jobs go on now. */
  online(): void {
    let any = false;
    for (const job of this.jobs) {
      if (job.state !== "waiting") continue;
      this.retryAt.delete(job.id);
      job.state = "queued";
      any = true;
    }
    if (any) {
      this.changed();
      this.pump();
    }
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
  }

  /** A session's news from drive.upload.updated (a completion finished in the background, an expiry). */
  applyEvent(upload: DriveUploadOut): void {
    const job = this.jobs.find((candidate) => candidate.uploadId === upload.id || candidate.clientUploadId === upload.client_upload_id);
    if (!job || isFinished(job.state)) return;
    if (upload.status === "completed" && job.state !== "done") {
      this.update(job, { state: "done", itemId: upload.item_id ?? null, sent: job.size, speed: 0 });
      this.deps.onDone?.(job);
    } else if (upload.status === "aborted" && upload.error === "drive_upload_target_moved") {
      // REVIEW-v0.1.70 #1: the completion ended the session because its folder moved to another drive.
      this.update(job, { state: "failed", error: upload.error, speed: 0 });
    } else if ((upload.status === "expired" || upload.status === "aborted") && job.state !== "uploading") {
      this.update(job, { uploadId: null, clientUploadId: this.newId(), received: [], sent: 0 });
    }
  }

  // --- running ------------------------------------------------------------------------------------------------

  private pump(): void {
    if (this.stopped) return;
    while (this.running < this.opts.filesAtOnce) {
      const next = this.jobs.find((job) => job.state === "queued");
      if (!next) break;
      this.running += 1;
      next.state = "uploading";
      void this.run(next).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
    this.scheduleRetries();
  }

  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleRetries(): void {
    if (this.retryTimer || this.stopped) return;
    const due = [...this.retryAt.values()];
    if (due.length === 0) return;
    const wait = Math.max(0, Math.min(...due) - this.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const now = this.now();
      for (const [id, at] of [...this.retryAt]) {
        if (at > now) continue;
        this.retryAt.delete(id);
        const job = this.jobs.find((candidate) => candidate.id === id);
        if (job?.state === "waiting") job.state = "queued";
      }
      this.changed();
      this.pump();
    }, wait);
  }

  /** Runs until the job is done, paused, waiting or failed. Public for the tests (they step it by hand). */
  async run(job: UploadJob): Promise<void> {
    const source = this.sources.get(job.id);
    if (!source) {
      this.update(job, { state: "needs-file" });
      return;
    }
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      job.state = "uploading";
      this.changed();
      let session = await this.ensureSession(job);
      if (!session) return; // skipped
      await this.sendParts(job, source, session, controller.signal);
      session = await this.complete(job);
      if (!session) return;
    } catch (error) {
      if ((job.state as UploadState) === "paused" || (job.state as UploadState) === "cancelled" || error instanceof Paused) return;
      if (isTransient(error)) {
        const attempt = (this.attempts.get(job.id) ?? 0) + 1;
        this.attempts.set(job.id, attempt);
        this.retryAt.set(job.id, this.now() + Math.min(RETRY_MIN_MS * 2 ** (attempt - 1), RETRY_MAX_MS));
        this.update(job, { state: "waiting", error: "network", speed: 0 });
        return;
      }
      if (error instanceof ApiError && (error.code === "drive_upload_expired" || error.code === "drive_upload_not_found")) {
        // The session is gone (a day without parts, cancelled elsewhere): start over with a new one.
        this.update(job, { state: "queued", uploadId: null, clientUploadId: this.newId(), received: [], sent: 0, error: null });
        return;
      }
      if (error instanceof ReadError) {
        this.update(job, { state: "needs-file", error: "read_failed", speed: 0 });
        this.sources.delete(job.id);
        return;
      }
      this.update(job, { state: "failed", error: error instanceof ApiError ? error.code : "unknown", speed: 0 });
    } finally {
      this.controllers.delete(job.id);
    }
  }

  /** The session (made with `fail` first; a conflict asks). null: skipped. */
  private async ensureSession(job: UploadJob): Promise<DriveUploadOut | null> {
    if (job.uploadId) {
      const session = await this.deps.api.driveUpload(job.uploadId);
      if (session.status === "completed") {
        this.finish(job, session.item_id ?? null);
        return null;
      }
      if (session.status === "expired" || session.status === "aborted") throw new ApiError(410, "drive_upload_expired", "expired");
      this.take(job, session);
      return session;
    }
    for (;;) {
      try {
        const session = await this.deps.api.createDriveUpload({
          client_upload_id: job.clientUploadId,
          parent_id: job.target.parentId,
          relative_dir: job.relativeDir || null,
          name: job.name,
          size_bytes: job.size,
          content_modified_ms: job.lastModified,
          on_conflict: job.onConflict,
        });
        this.take(job, session);
        return session;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "drive_name_taken" || job.onConflict !== "fail") throw error;
        const choice = await this.conflictChoice(job, error);
        if (choice === "skip") {
          this.update(job, { state: "skipped" });
          return null;
        }
        job.onConflict = choice;
      }
    }
  }

  private take(job: UploadJob, session: DriveUploadOut): void {
    this.update(job, {
      uploadId: session.id,
      partSize: session.part_size,
      partsTotal: session.parts_total,
      received: [...session.received_parts],
      sent: sentBytes(session.received_parts, session.size_bytes, session.part_size),
    });
  }

  private conflictChoice(job: UploadJob, error: ApiError): Promise<ConflictChoice> {
    const remembered = this.batchAnswers.get(job.batchId);
    if (remembered) return Promise.resolve(remembered);
    const details = (error.details ?? {}) as { existing_kind?: string };
    // One question at a time: the next waits for the one before (whose 「すべてに」 may answer it).
    const answer = this.asking.then(async () => {
      const again = this.batchAnswers.get(job.batchId);
      if (again) return again;
      const ask = this.deps.ask;
      if (!ask) return "rename" as ConflictChoice;
      const before = job.state;
      const remaining = this.jobs.filter((other) => other.batchId === job.batchId && other.id !== job.id && !isFinished(other.state) && other.state !== "failed").length;
      this.question = { job, existingKind: details.existing_kind ?? null, remaining };
      this.update(job, { state: "asking" });
      try {
        const { choice, all } = await ask(this.question);
        if (all) this.batchAnswers.set(job.batchId, choice);
        return choice;
      } finally {
        this.question = null;
        if (job.state === "asking") this.update(job, { state: before === "asking" ? "uploading" : before });
      }
    });
    this.asking = answer.catch(() => undefined);
    return answer;
  }

  private async sendParts(job: UploadJob, source: UploadSource, session: DriveUploadOut, signal: AbortSignal): Promise<void> {
    const todo = missingParts(session.parts_total, job.received);
    let at = 0;
    const started = this.now();
    let sentHere = 0;
    const worker = async () => {
      for (;;) {
        if (signal.aborted) throw new Paused();
        const number = todo[at++];
        if (number === undefined) return;
        const [start, end] = partRange(number, job.size, session.part_size);
        let bytes: Uint8Array;
        try {
          bytes = await source.read(start, end);
        } catch (error) {
          throw new ReadError(error);
        }
        if (bytes.byteLength !== end - start) throw new ReadError(new Error("short read"));
        const sha = await this.deps.sha256(bytes);
        if (signal.aborted) throw new Paused();
        await this.deps.api.putDrivePart(session.id, number, bytes, sha, signal);
        sentHere += bytes.byteLength;
        const seconds = Math.max(0.001, (this.now() - started) / 1000);
        this.attempts.delete(job.id);
        this.update(job, {
          received: [...job.received, number],
          sent: job.sent + bytes.byteLength,
          speed: sentHere / seconds,
          error: null,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.partsPerFile, Math.max(1, todo.length)) }, worker));
  }

  /** Completes (200 or 202 then asked again); a name taken meanwhile asks the question and completes again. */
  private async complete(job: UploadJob): Promise<DriveUploadOut | null> {
    const uploadId = job.uploadId!;
    this.update(job, { state: "completing", speed: 0 });
    for (;;) {
      let answer: DriveUploadCompleteOut;
      try {
        answer = await this.deps.api.completeDriveUpload(uploadId);
      } catch (error) {
        if (error instanceof ApiError && error.code === "drive_name_taken" && job.onConflict === "fail") {
          const choice = await this.conflictChoice(job, error);
          if (choice === "skip") {
            this.update(job, { state: "skipped" });
            void this.deps.api.abortDriveUpload(uploadId).catch(() => undefined);
            return null;
          }
          job.onConflict = choice;
          await this.deps.api.patchDriveUpload(uploadId, { on_conflict: choice });
          this.update(job, { state: "completing" });
          continue;
        }
        if (error instanceof ApiError && error.code === "drive_upload_not_active") {
          // Completing already (another device, a request that was faster): ask.
          answer = { status: "completing" };
        } else {
          throw error;
        }
      }
      if (answer.status === "completed") {
        this.finish(job, answer.item?.id ?? null);
        return null;
      }
      // 202: the parts are being joined; ask again until the session says how it ended.
      for (;;) {
        await (this.deps.sleep ?? defaultSleep)(COMPLETE_POLL_MS);
        if (job.state !== "completing") return null; // drive.upload.updated said so meanwhile
        const session = await this.deps.api.driveUpload(uploadId);
        if (session.status === "completed") {
          this.finish(job, session.item_id ?? null);
          return null;
        }
        if (session.status === "completing") continue;
        if (session.status === "active" && session.error) {
          if (session.error === "drive_name_taken" && job.onConflict === "fail") break; // complete again: it asks
          throw new ApiError(409, session.error, session.error);
        }
        if (session.status === "active") break;
        // Ended because its folder moved to another drive (REVIEW-v0.1.70 #1): not started again by itself.
        if (session.status === "aborted" && session.error === "drive_upload_target_moved") throw new ApiError(409, session.error, session.error);
        throw new ApiError(410, "drive_upload_expired", "expired");
      }
    }
  }

  private finish(job: UploadJob, itemId: string | null): void {
    this.sources.delete(job.id);
    this.update(job, { state: "done", itemId, sent: job.size, speed: 0, error: null });
    this.deps.onDone?.(job);
  }

  /** Whether any job is moving (the panel's 「すべて一時停止」). */
  get busy(): boolean {
    return this.jobs.some((job) => ACTIVE.includes(job.state) || job.state === "queued" || job.state === "waiting");
  }
}

/** A file that could not be read (gone, moved, no longer allowed): picked again, it resumes. */
export class ReadError extends Error {
  constructor(public readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "ReadError";
  }
}

/** The hex SHA-256 of `bytes` (Web Crypto: the app and secure-context pages). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The queue's restart notes in localStorage, per account. */
export function localUploadStorage(key: string): UploadStorage {
  const name = `taylis.drive.uploads.v1:${key}`;
  return {
    load() {
      try {
        const raw = localStorage.getItem(name);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(parsed) ? (parsed as PersistedUpload[]) : [];
      } catch {
        return [];
      }
    },
    save(entries) {
      try {
        if (entries.length === 0) localStorage.removeItem(name);
        else localStorage.setItem(name, JSON.stringify(entries));
      } catch {
        /* per-device convenience */
      }
    },
  };
}
