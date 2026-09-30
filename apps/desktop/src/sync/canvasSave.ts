/**
 * The save loop of one open canvas (CANVAS.md §4.4 「クライアント側の規則」). The client holds no merge code: it sends the
 * whole body with the version it was written on (`base_rev_id`) and an idempotency key (`client_save_id`), and takes the
 * server's (possibly merged) body when nothing was typed meanwhile.
 *
 * State: `synced` is the body of the version `baseRevId` names (the base of the next save), `text` what the editor
 * holds (dirty when they differ), `inFlight` the save on the wire. A save that failed on the network or with 429 / 5xx
 * is sent again as it was — same key, same body, same base — so a retry never makes a second version.
 *
 * `text` is the stored form (`<@uuid>` mentions); the editor shows and edits `@name` and converts (ui/CanvasEditor.tsx).
 */
import { ApiError, isRetryable, NetworkError } from "../api/errors";
import type { CanvasConflictDetails, CanvasOnConflict, CanvasOut, CanvasSaveIn, CanvasSaveOut } from "../api/types";

export interface CanvasSaveApi {
  /** null: `knownVersion` is still current (304). */
  getCanvas(canvasId: string, knownVersion: number | null): Promise<CanvasOut | null>;
  saveCanvas(canvasId: string, body: CanvasSaveIn): Promise<CanvasSaveOut>;
}

/**
 * - loading: the first GET has not answered yet
 * - saved: the server holds what is on screen
 * - editing: typed, the save goes out when typing pauses
 * - saving: a save is on the wire
 * - offline / retrying: the save failed on the network / with 429 or 5xx and goes out again (same key)
 * - conflict: someone changed the same words; waiting for 自分の版 / 相手の版 / 両方残す
 * - expired: the version this was written on is gone (long offline); waiting for a choice
 * - blocked: refused for good (403, 422, an archived conversation …); the text stays here
 * - gone: the canvas was moved to the trash (or cannot be seen any more)
 */
export type CanvasSaveStatus = "loading" | "saved" | "editing" | "saving" | "offline" | "retrying" | "conflict" | "expired" | "blocked" | "gone";

export interface InFlight {
  clientSaveId: string;
  sent: string;
  baseRevId: string;
  onConflict: CanvasOnConflict;
}

/** What survives a restart of the app (Tauri keeps it in SQLite; the browser only in memory). */
export interface CanvasPendingState {
  channelId: string;
  baseRevId: string;
  synced: string;
  text: string;
  version: number;
  inFlight: InFlight | null;
}

export interface CanvasSaverOptions {
  /** §4.4: a save goes out when typing pauses this long. */
  debounceMs?: number;
  /** §4.4: a canvas.updated while not editing is read again after this pause (bursts collapse). */
  refreshDebounceMs?: number;
  /** Waits before sending a failed save again; the last one repeats. */
  retryDelaysMs?: readonly number[];
  newId?: () => string;
  /** The unsaved state changed (null: nothing to keep). */
  persist?: (state: CanvasPendingState | null) => void;
}

export interface CanvasConflictState {
  details: CanvasConflictDetails;
  /** The version the refused save was written on: the choice is sent on it again. */
  baseRevId: string;
}

export class CanvasSaver {
  status: CanvasSaveStatus = "loading";
  /** The server's canvas as last received (its body is the one of that moment). */
  canvas: CanvasOut | null = null;
  /** What the editor holds, in the stored form. */
  text = "";
  conflict: CanvasConflictState | null = null;
  /** canvas_base_expired: the current canvas to compare with. */
  expired: CanvasOut | null = null;
  /** Why saving stopped (blocked / gone). */
  error: unknown = null;
  /** Bumped on every change (useSyncExternalStore). */
  revision = 0;
  /** Bumped when the saver itself changed `text` (a merge or someone else's version): the editor takes it. */
  textRevision = 0;
  /**
   * Whether the editor can take a new text now (not while an IME composition is open). When it cannot, the merged
   * body waits: the next save carries this text on the version that holds it, and the server merges again.
   */
  canReplace: () => boolean = () => true;

  private synced = "";
  private baseRevId: string | null = null;
  private version = 0;
  private inFlight: InFlight | null = null;
  private again = false;
  private attempt = 0;
  private loaded = false;
  private disposed = false;
  /** A merged body could not be put on screen: read the canvas again once the editor is idle. */
  private stale = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly opts: Required<Omit<CanvasSaverOptions, "persist">> & Pick<CanvasSaverOptions, "persist">;

  constructor(
    readonly id: string,
    readonly channelId: string,
    private readonly api: CanvasSaveApi,
    options: CanvasSaverOptions = {},
    restored: CanvasPendingState | null = null,
  ) {
    this.opts = {
      debounceMs: options.debounceMs ?? 2_000,
      refreshDebounceMs: options.refreshDebounceMs ?? 500,
      retryDelaysMs: options.retryDelaysMs ?? [1_000, 2_000, 5_000, 10_000, 30_000],
      newId: options.newId ?? (() => crypto.randomUUID()),
      persist: options.persist,
    };
    if (restored) {
      this.baseRevId = restored.baseRevId;
      this.synced = restored.synced;
      this.text = restored.text;
      this.version = restored.version;
      this.inFlight = restored.inFlight;
    }
  }

  get dirty(): boolean {
    return this.text !== this.synced;
  }

  /** Anything not on the server yet (typed, on the wire, or waiting for a choice). */
  get unsaved(): boolean {
    return this.dirty || this.inFlight !== null || this.conflict !== null || this.expired !== null;
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when the work started so far (a save, its retries' current attempt, a read) has answered (tests). */
  async settled(): Promise<void> {
    let seen: Promise<void> | null = null;
    while (seen !== this.running) {
      seen = this.running;
      await seen;
    }
  }

  // --- loading and reading again ---------------------------------------------------------

  /** The first read. A restored unsaved state keeps its text and goes on saving. */
  load(): Promise<void> {
    return this.track(this.read(null, true));
  }

  /** A canvas.updated (or a reconnect): read again unless something here is not saved yet (§4.4). */
  remoteVersion(version: number): void {
    if (this.disposed || version <= this.version) return;
    this.scheduleRefresh();
  }

  /** After reconnecting: saves that failed go out now; an idle canvas is read again (If-None-Match). */
  online(): void {
    if (this.disposed) return;
    if (!this.loaded) {
      void this.load();
      return;
    }
    if (this.inFlight && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.track(this.send());
      return;
    }
    if (this.dirty) {
      void this.save();
      return;
    }
    this.scheduleRefresh(0);
  }

  private scheduleRefresh(delay = this.opts.refreshDebounceMs): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.idleHere()) this.track(this.read(this.version || null, false));
    }, delay);
  }

  /** Nothing typed, nothing on the wire, no choice open: a newer version may replace the text. */
  private idleHere(): boolean {
    return this.loaded && !this.disposed && !this.dirty && !this.inFlight && !this.conflict && !this.expired;
  }

  private async read(knownVersion: number | null, first: boolean): Promise<void> {
    const before = this.text;
    let canvas: CanvasOut | null;
    try {
      canvas = await this.api.getCanvas(this.id, knownVersion);
    } catch (err) {
      if (this.disposed) return;
      if (isRetryable(err)) {
        if (first) this.setStatus("offline"); // online() loads again
        return;
      }
      this.stop(err);
      return;
    }
    if (this.disposed || !canvas) return;
    this.canvas = canvas;
    if (first && !this.loaded) {
      this.loaded = true;
      this.version = Math.max(this.version, canvas.version);
      if (this.baseRevId === null) {
        this.adopt(canvas);
        this.setStatus("saved");
        return;
      }
      // A restored state (§4.4 「落ちても、オフラインでも同じ key で再送」): send what was on the wire, then the rest.
      if (this.inFlight) {
        this.track(this.send());
        return;
      }
      if (this.dirty) {
        void this.save();
        return;
      }
      if (this.baseRevId !== canvas.head_rev_id) this.adopt(canvas);
      this.setStatus("saved");
      return;
    }
    // Typed (or saved) since the request went out: the next save merges instead.
    if (this.text !== before || !this.idleHere() || !this.canReplace()) {
      if (this.idleHere() && canvas.body !== this.text) this.stale = true; // an IME composition: read again after it
      this.emit();
      return;
    }
    this.version = Math.max(this.version, canvas.version);
    this.stale = false;
    this.adopt(canvas);
    this.setStatus("saved");
  }

  /** The server's version becomes the text (nothing unsaved here). */
  private adopt(canvas: CanvasOut): void {
    this.baseRevId = canvas.head_rev_id;
    this.synced = canvas.body;
    if (this.text !== canvas.body) {
      this.text = canvas.body;
      this.textRevision += 1;
    }
    this.persist();
  }

  // --- editing and saving ---------------------------------------------------------------------

  /**
   * The editor's text changed: saved once typing pauses. `external`: the change came from elsewhere on the screen (a
   * box ticked in the preview), so the editor takes it like a merge.
   */
  edit(text: string, external = false): void {
    if (this.disposed || text === this.text) return;
    this.text = text;
    if (external) this.textRevision += 1;
    if (this.status === "blocked") this.error = null; // an edit may fix it (a body that was too long)
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, this.opts.debounceMs);
    if (!this.inFlight && !this.conflict && !this.expired && this.status !== "gone") this.setStatus(this.dirty ? "editing" : "saved");
    else this.emit();
  }

  /** Save now instead of after the pause (closing the canvas, the window going to the background, a tick). */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.save();
  }

  private save(onConflict: CanvasOnConflict = "fail"): Promise<void> {
    if (this.disposed || !this.loaded || this.baseRevId === null) return this.running;
    if (this.inFlight) {
      this.again = true; // once this one answers
      return this.running;
    }
    if (this.conflict || this.expired || this.status === "gone" || (this.status === "blocked" && this.error !== null)) return this.running;
    if (!this.dirty) {
      if (this.stale && this.idleHere()) this.track(this.read(null, false));
      else if (this.status === "editing") this.setStatus("saved");
      return this.running;
    }
    this.inFlight = { clientSaveId: this.opts.newId(), sent: this.text, baseRevId: this.baseRevId, onConflict };
    this.persist();
    return this.track(this.send());
  }

  private async send(): Promise<void> {
    const flight = this.inFlight;
    if (!flight || this.disposed) return;
    this.setStatus("saving");
    let answer: CanvasSaveOut;
    try {
      answer = await this.api.saveCanvas(this.id, { base_rev_id: flight.baseRevId, body: flight.sent, client_save_id: flight.clientSaveId, on_conflict: flight.onConflict });
    } catch (err) {
      if (this.inFlight === flight) this.failed(flight, err);
      return;
    }
    if (this.inFlight !== flight) return;
    this.landed(flight, answer);
  }

  private landed(flight: InFlight, answer: CanvasSaveOut): void {
    this.inFlight = null;
    this.attempt = 0;
    this.canvas = answer.canvas;
    this.version = Math.max(this.version, answer.canvas.version);
    if (this.text === flight.sent && this.canReplace()) {
      // Nothing typed meanwhile: the head is the base, and a merge's result goes on screen.
      this.baseRevId = answer.canvas.head_rev_id;
      this.synced = answer.canvas.body;
      if (this.text !== answer.canvas.body) {
        this.text = answer.canvas.body;
        this.textRevision += 1;
      }
      this.stale = false;
    } else {
      // Typed on: the next save is written on the version holding exactly what was sent (§4.4).
      this.baseRevId = answer.submitted_rev_id;
      this.synced = flight.sent;
      if (answer.canvas.body !== flight.sent) this.stale = true;
    }
    this.persist();
    this.setStatus(this.dirty ? "editing" : "saved");
    if (this.again) {
      this.again = false;
      void this.save();
    } else if (this.dirty && !this.saveTimer) {
      void this.save();
    }
  }

  private failed(flight: InFlight, err: unknown): void {
    if (err instanceof ApiError && err.status === 409 && (err.code === "canvas_conflict" || err.code === "canvas_base_expired")) {
      this.inFlight = null;
      this.again = false;
      this.attempt = 0;
      const details = err.details as CanvasConflictDetails | undefined;
      if (details?.head) {
        this.canvas = details.head;
      }
      if (err.code === "canvas_conflict" && details) {
        this.conflict = { details, baseRevId: flight.baseRevId };
        this.setStatus("conflict");
      } else if (details?.head) {
        this.expired = details.head;
        this.setStatus("expired");
      } else {
        this.stop(err);
      }
      this.persist();
      return;
    }
    if (isRetryable(err)) {
      // Kept as it is (same key, body and base) and sent again: never a second version (§4.4).
      this.setStatus(err instanceof NetworkError ? "offline" : "retrying");
      const delays = this.opts.retryDelaysMs;
      const retryAfter = err instanceof ApiError && err.status === 429 ? retryAfterMs(err) : null;
      const delay = retryAfter ?? delays[Math.min(this.attempt, delays.length - 1)] ?? 30_000;
      this.attempt += 1;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.track(this.send());
      }, delay);
      return;
    }
    this.inFlight = null;
    this.again = false;
    this.persist();
    this.stop(err);
  }

  /** Refused for good: nothing more is sent until the text changes (403, 422) or at all (404: in the trash). */
  private stop(err: unknown): void {
    this.error = err;
    this.setStatus(err instanceof ApiError && err.status === 404 ? "gone" : "blocked");
  }

  // --- choices --------------------------------------------------------------------------------

  /**
   * §4.4 409 canvas_conflict: send the text again on the same version with the choice for the overlapping words —
   * "ours" (mine), "theirs" (the other version) or "both" (theirs, then mine quoted). A member who may only tick can
   * only take theirs (the server refuses the others from them).
   */
  resolveConflict(choice: Exclude<CanvasOnConflict, "fail">): Promise<void> {
    const conflict = this.conflict;
    if (!conflict || this.disposed) return this.running;
    this.conflict = null;
    this.inFlight = { clientSaveId: this.opts.newId(), sent: this.text, baseRevId: conflict.baseRevId, onConflict: choice };
    this.persist();
    return this.track(this.send());
  }

  /**
   * §4.4 409 canvas_base_expired: "mine" saves this text over the current version (what others wrote since is replaced;
   * it stays in the history), "theirs" drops this text for the current version.
   */
  resolveExpired(choice: "mine" | "theirs"): Promise<void> {
    const head = this.expired;
    if (!head || this.disposed) return this.running;
    this.expired = null;
    this.canvas = head;
    this.version = Math.max(this.version, head.version);
    this.baseRevId = head.head_rev_id;
    this.synced = head.body;
    if (choice === "theirs") {
      this.adopt(head);
      this.setStatus("saved");
      return this.running;
    }
    this.persist();
    return this.save();
  }

  // --- the web page going away (M44) -------------------------------------------------------------

  /**
   * The browser tab is closing (pagehide): the save that keeps what is typed, to be sent on a `keepalive` request the
   * browser finishes after the page is gone; null when nothing needs one, or when it cannot be sent that way (a choice
   * open, refused, or larger than a keepalive request may carry — `mustStay` says so for beforeunload). The save is kept
   * as this loop's own (same key), so if the page lives on (the back-forward cache) the loop sends it again and the
   * server answers the repeat once. Typed while a save was on the wire: the text on that save's base, a new key; the
   * server merges it with whichever of the two lands first.
   */
  unloadSave(): CanvasSaveIn | null {
    if (this.disposed || !this.loaded || this.baseRevId === null || this.mustStay) return null;
    const flight = this.inFlight;
    if (flight) {
      if (this.text === flight.sent) return { base_rev_id: flight.baseRevId, body: flight.sent, client_save_id: flight.clientSaveId, on_conflict: flight.onConflict };
      return fitsKeepalive(this.text) ? { base_rev_id: flight.baseRevId, body: this.text, client_save_id: this.opts.newId(), on_conflict: "fail" } : null;
    }
    if (!this.dirty || !fitsKeepalive(this.text)) return null;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const next: InFlight = { clientSaveId: this.opts.newId(), sent: this.text, baseRevId: this.baseRevId, onConflict: "fail" };
    this.inFlight = next;
    this.persist();
    // Runs only if the page lives on (timers stop with it): the same save, the same key.
    setTimeout(() => {
      if (this.inFlight === next) this.track(this.send());
    }, 0);
    return { base_rev_id: next.baseRevId, body: next.sent, client_save_id: next.clientSaveId, on_conflict: "fail" };
  }

  /** Something typed here that closing the page would lose (beforeunload asks to stay). */
  get mustStay(): boolean {
    if (this.disposed || !this.unsaved) return false;
    if (this.conflict || this.expired || (this.status === "blocked" && this.error !== null)) return true;
    return !fitsKeepalive(this.text);
  }

  // --- the rest ----------------------------------------------------------------------------------

  /** canvas.deleted: nothing more is saved; the text stays on screen to be copied. */
  gone(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.inFlight = null;
    this.error = new ApiError(404, "canvas_not_found", "Canvas not found");
    this.setStatus("gone");
  }

  /** The metadata changed (the title, a setting) without a new body: the screen shows it. */
  applyMeta(canvas: CanvasOut): void {
    if (this.disposed) return;
    if (this.canvas && canvas.version < this.canvas.version) return;
    this.canvas = { ...canvas, body: this.canvas?.body ?? canvas.body };
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.listeners.clear();
  }

  private clearTimers(): void {
    for (const timer of [this.saveTimer, this.retryTimer, this.refreshTimer]) if (timer) clearTimeout(timer);
    this.saveTimer = this.retryTimer = this.refreshTimer = null;
  }

  private track(work: Promise<void>): Promise<void> {
    const next = this.running.then(() => work, () => work);
    this.running = next.catch((err: unknown) => console.warn("canvas save step failed", err));
    return next;
  }

  private persist(): void {
    if (!this.opts.persist) return;
    if (this.baseRevId === null || (!this.dirty && !this.inFlight && !this.conflict && !this.expired)) {
      this.opts.persist(null);
      return;
    }
    this.opts.persist({ channelId: this.channelId, baseRevId: this.baseRevId, synced: this.synced, text: this.text, version: this.version, inFlight: this.inFlight });
  }

  private setStatus(status: CanvasSaveStatus): void {
    this.status = status;
    this.emit();
  }

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Browsers carry at most 64 KiB of keepalive request bodies at a time: a canvas body (with the request's JSON around
 * it) past this goes out only on an ordinary request, so closing the tab must ask first.
 */
export const KEEPALIVE_BODY_BYTES = 60_000;

export function fitsKeepalive(body: string): boolean {
  // UTF-8 is at most 3 bytes per UTF-16 unit; count exactly only when that bound is over the limit.
  if (body.length * 3 + 512 <= KEEPALIVE_BODY_BYTES) return true;
  return new TextEncoder().encode(JSON.stringify(body)).length + 512 <= KEEPALIVE_BODY_BYTES;
}

/** 429's details carry `retry_after_seconds` (server/app/core/errors.py rate_limited). */
function retryAfterMs(err: ApiError): number | null {
  const details = err.details as { retry_after_seconds?: number } | undefined;
  return typeof details?.retry_after_seconds === "number" ? Math.max(1_000, details.retry_after_seconds * 1_000) : null;
}
