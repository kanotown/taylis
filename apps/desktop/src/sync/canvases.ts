/**
 * M43: canvases on this device (CANVAS.md §4.4 / §4.6). The conversation's list lives in the store (loaded when it opens
 * and after reconnecting, kept current by canvas.* events: the larger version wins); each canvas on screen, or with
 * edits not saved yet, has a CanvasSaver. Unsaved edits are kept in the store (SQLite in Tauri), so a restart sends them
 * with the same idempotency key.
 */
import type { CanvasDeleted, CanvasMeta, CanvasSaveIn, CanvasUpdated } from "../api/types";
import { CanvasSaver, type CanvasSaveApi, type CanvasSaverOptions } from "./canvasSave";
import type { Store } from "./store";

export interface CanvasSyncApi extends CanvasSaveApi {
  listCanvases(channelId: string, trashed?: boolean): Promise<CanvasMeta[]>;
}

export class CanvasHub {
  private readonly savers = new Map<string, CanvasSaver>();
  /** How many screens show each canvas: one nobody shows is dropped once it holds nothing unsaved. */
  private readonly holds = new Map<string, number>();

  constructor(
    private readonly deps: { api: CanvasSyncApi | null; store: Store; options?: CanvasSaverOptions },
  ) {}

  get available(): boolean {
    return this.deps.api !== null;
  }

  /** The conversation's canvases (when it opens, after reconnecting). */
  async loadList(channelId: string): Promise<void> {
    const api = this.deps.api;
    if (!api) return;
    try {
      this.deps.store.setCanvases(channelId, await api.listCanvases(channelId));
    } catch (err) {
      console.warn("could not load the canvases", err);
    }
  }

  /** The saver of a canvas (made, and its unsaved edits restored, on first use). */
  saver(canvasId: string, channelId: string): CanvasSaver | null {
    const api = this.deps.api;
    if (!api) return null;
    let saver = this.savers.get(canvasId);
    if (!saver) {
      const store = this.deps.store;
      saver = new CanvasSaver(canvasId, channelId, api, { ...this.deps.options, persist: (state) => store.setPendingCanvas(canvasId, state) }, store.pendingCanvas(canvasId));
      this.savers.set(canvasId, saver);
      void saver.load();
    }
    return saver;
  }

  /** A screen shows the canvas; the returned function lets go (saving what is typed, §4.4 「画面を閉じるとき」). */
  hold(canvasId: string, channelId: string): { saver: CanvasSaver | null; release: () => void } {
    const saver = this.saver(canvasId, channelId);
    this.holds.set(canvasId, (this.holds.get(canvasId) ?? 0) + 1);
    let released = false;
    return {
      saver,
      release: () => {
        if (released) return;
        released = true;
        const left = (this.holds.get(canvasId) ?? 1) - 1;
        if (left > 0) this.holds.set(canvasId, left);
        else this.holds.delete(canvasId);
        if (!saver) return;
        void saver.flush().then(() => this.dropIfIdle(canvasId));
      },
    };
  }

  current(canvasId: string): CanvasSaver | undefined {
    return this.savers.get(canvasId);
  }

  private dropIfIdle(canvasId: string): void {
    const saver = this.savers.get(canvasId);
    if (!saver || this.holds.has(canvasId) || saver.unsaved) return;
    saver.dispose();
    this.savers.delete(canvasId);
  }

  /** canvas.created / canvas.updated / canvas.deleted (§4.6). */
  applyEvent(event: string, data: unknown): void {
    const store = this.deps.store;
    if (event === "canvas.created") {
      store.applyCanvasMeta((data as { canvas: CanvasMeta }).canvas);
    } else if (event === "canvas.updated") {
      const { canvas } = data as CanvasUpdated;
      store.applyCanvasMeta(canvas);
      this.savers.get(canvas.id)?.remoteVersion(canvas.version);
    } else if (event === "canvas.deleted") {
      const { canvas_id: canvasId, channel_id: channelId } = data as CanvasDeleted;
      store.removeCanvas(channelId, canvasId);
      const saver = this.savers.get(canvasId);
      if (saver) {
        saver.gone();
        store.setPendingCanvas(canvasId, null);
      }
    }
  }

  /** After (re)connecting: failed saves go out, open canvases are read again, edits kept from before a restart resume. */
  online(): void {
    if (!this.deps.api) return;
    for (const saver of this.savers.values()) saver.online();
    for (const [canvasId, pending] of this.deps.store.pendingCanvases()) {
      if (!this.savers.has(canvasId)) {
        const saver = this.saver(canvasId, pending.channelId);
        void saver?.settled().then(() => this.dropIfIdle(canvasId));
      }
    }
  }

  /** Save everything typed now (the window goes to the background, sign-out). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.savers.values()].map((saver) => saver.flush()));
  }

  /**
   * M44, the web page going away (pagehide): each canvas with something typed hands over its save for a keepalive
   * request (the browser keeps no store of it, CANVAS.md §5).
   */
  unload(send: (canvasId: string, body: CanvasSaveIn) => void): void {
    for (const saver of this.savers.values()) {
      const body = saver.unloadSave();
      if (body) send(saver.id, body);
    }
  }

  /** M44, beforeunload: something typed that a keepalive request cannot carry (a choice open, refused, too long). */
  get mustStay(): boolean {
    return [...this.savers.values()].some((saver) => saver.mustStay);
  }

  /** I left the conversation (or it was removed): its canvases and their savers go (§4.6). */
  removeChannel(channelId: string): void {
    for (const [canvasId, saver] of [...this.savers]) {
      if (saver.channelId !== channelId) continue;
      saver.dispose();
      this.savers.delete(canvasId);
    }
  }

  stop(): void {
    for (const saver of this.savers.values()) saver.dispose();
    this.savers.clear();
    this.holds.clear();
  }
}
