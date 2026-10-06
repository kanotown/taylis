/**
 * M121 「ドキュメント」 on this device (WIKI.md §9.1, §10, §14). The hub keeps:
 *
 * - the tree: every page I can read, as `GET /wiki/tree` answered (with its ETag) and then kept current by the change
 *   feed (`GET /wiki/changes?since=<cursor>` after `wiki.changed`, 300 ms collapsing a burst; `removed` drops, `reset`
 *   reads the whole tree again). Bootstrap's `wiki.change_seq` says the server has Docs and how far the feed is.
 * - the pages on screen: one save loop each (sync/canvasSave.ts, the canvas's, on the wiki endpoints), `wiki.page.updated`
 *   reading an idle one again (an edited one merges on its next save, as canvases do).
 * - what is kept for later: the tree, the pages opened lately (20, to read offline) and unsaved edits (the store:
 *   SQLite in Tauri, memory in the browser).
 * - page titles for `page:` links: from the tree, else `POST /wiki/pages/resolve` (batched); a page that does not come
 *   back is one I cannot read (「アクセスできないページ」).
 */
import { ApiError, isRetryable } from "../api/errors";
import type { PageContent, PageItem, PageMeta, PageOut, PageRef, PageSaveIn, PageSaveOut, WikiChangesOut, WikiChanged, WikiMentioned, WikiPageUpdated, WikiShared, WikiTreeOut } from "../api/types";
import { CanvasSaver, type CanvasSaverOptions } from "./canvasSave";
import type { Store } from "./store";
import { applyChanges, buildTree, type WikiTree } from "./wikiTree";

export interface WikiApi {
  wikiTree(etag: string | null): Promise<{ tree: WikiTreeOut; etag: string | null } | null>;
  wikiChanges(since: number): Promise<WikiChangesOut>;
  wikiPage(pageId: string, etag: string | null): Promise<PageOut | null>;
  saveWikiPage(pageId: string, body: PageSaveIn): Promise<PageSaveOut>;
  resolveWikiPages(ids: string[]): Promise<PageRef[]>;
}

/** idle: nothing asked yet; unsupported: a server before M120 (no `wiki` in bootstrap). */
export type WikiTreeState = "idle" | "loading" | "ready" | "failed" | "unsupported";

export type PageSaver = CanvasSaver<PageContent>;

export type WikiNotice = { kind: "mentioned"; data: WikiMentioned } | { kind: "shared"; data: WikiShared };

/** How many opened pages this device keeps to read offline (as the phones' 20 recent canvases, M74). */
export const RECENT_PAGES = 20;

export class WikiHub {
  state: WikiTreeState = "idle";
  version = 0;
  private pagesById = new Map<string, PageItem>();
  private treeCache: WikiTree | null = null;
  private cursor: number | null = null;
  private etag: string | null = null;
  /** The tree was read from the server since this hub started (a stored one may miss group changes). */
  private freshThisSession = false;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private catchingUp: Promise<void> | null = null;
  private catchUpAgain = false;
  private treeRead: Promise<void> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly savers = new Map<string, PageSaver>();
  private readonly holds = new Map<string, number>();
  /** `page:` link titles beyond the tree: null = not readable by me (or gone). */
  private readonly refs = new Map<string, PageRef | null>();
  private resolveQueue = new Set<string>();
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private stopped = false;

  constructor(
    private readonly deps: {
      api: WikiApi | null;
      store: Store;
      options?: CanvasSaverOptions & { feedDelayMs?: number; resolveDelayMs?: number };
      onNotice?: (notice: WikiNotice) => void;
    },
  ) {
    const kept = deps.store.wikiTreeSnapshot();
    if (kept) {
      this.pagesById = new Map(kept.pages.map((page) => [page.id, page]));
      this.cursor = kept.cursor;
      this.etag = kept.etag;
    }
  }

  get available(): boolean {
    return this.deps.api !== null && this.state !== "unsupported";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version += 1;
    this.treeCache = null;
    for (const listener of this.listeners) listener();
  }

  // --- the tree ---------------------------------------------------------------------------------

  get pages(): ReadonlyMap<string, PageItem> {
    return this.pagesById;
  }

  page(pageId: string): PageItem | undefined {
    return this.pagesById.get(pageId);
  }

  tree(): WikiTree {
    this.treeCache ??= buildTree(this.pagesById.values());
    return this.treeCache;
  }

  /** Whether there is a tree to show (read now, or kept from before: offline it shows read only). */
  get hasTree(): boolean {
    return this.cursor !== null;
  }

  /** Bootstrap (every connect): `wiki` absent = a server without Docs. */
  applyBootstrap(wiki: { change_seq: number } | null | undefined): void {
    if (!this.deps.api) return;
    if (!wiki) {
      this.state = "unsupported";
      this.changed();
      return;
    }
    if (this.state === "unsupported" || this.state === "idle") this.state = this.cursor === null ? "idle" : "ready";
    if (this.cursor === null || !this.freshThisSession) void this.loadTree();
    else if (wiki.change_seq > this.cursor) this.scheduleCatchUp(0);
  }

  /** The whole tree (If-None-Match: a 304 keeps it). `force`: without the ETag (a `reset`). */
  loadTree(force = false): Promise<void> {
    const api = this.deps.api;
    if (!api) return Promise.resolve();
    if (this.treeRead) return this.treeRead;
    if (this.cursor === null) {
      this.state = "loading";
      this.changed();
    }
    const read = (async () => {
      try {
        const answer = await api.wikiTree(force ? null : this.etag);
        if (this.stopped) return;
        this.freshThisSession = true;
        if (answer) {
          this.pagesById = new Map(answer.tree.pages.filter((page) => page.kind !== "row").map((page) => [page.id, page]));
          this.cursor = answer.tree.cursor;
          this.etag = answer.etag;
          this.dropGoneSavers();
          this.persistTree();
        }
        this.state = "ready";
        this.changed();
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof ApiError && err.status === 404 && err.code !== "page_not_found") this.state = "unsupported";
        else this.state = this.cursor === null ? "failed" : "ready"; // the kept tree stays (read only offline)
        if (!isRetryable(err)) console.warn("could not read the Docs tree", err);
        this.changed();
      } finally {
        this.treeRead = null;
      }
    })();
    this.treeRead = read;
    return read;
  }

  /** wiki.changed: read the feed after a pause (a burst of changes is one read). */
  private scheduleCatchUp(delay = this.deps.options?.feedDelayMs ?? 300): void {
    if (this.catchUpTimer) return;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      void this.catchUp();
    }, delay);
  }

  /** The change feed since the cursor (one read at a time; one more if asked meanwhile). */
  catchUp(): Promise<void> {
    if (this.catchingUp) {
      this.catchUpAgain = true;
      return this.catchingUp;
    }
    const api = this.deps.api;
    if (!api || this.state === "unsupported") return Promise.resolve();
    if (this.cursor === null) return this.loadTree();
    const run = (async () => {
      try {
        const changes = await api.wikiChanges(this.cursor!);
        if (this.stopped) return;
        if (changes.reset) {
          await this.loadTree(true);
          return;
        }
        this.applyFeed(changes);
      } catch (err) {
        if (!isRetryable(err)) console.warn("could not read the Docs change feed", err);
      } finally {
        this.catchingUp = null;
        if (this.catchUpAgain && !this.stopped) {
          this.catchUpAgain = false;
          void this.catchUp();
        }
      }
    })();
    this.catchingUp = run;
    return run;
  }

  /** One answer of the feed (also tests). */
  applyFeed(changes: Pick<WikiChangesOut, "pages" | "removed" | "cursor">): void {
    this.pagesById = applyChanges(this.pagesById, changes);
    this.cursor = Math.max(this.cursor ?? 0, changes.cursor);
    for (const page of changes.pages) {
      this.refs.delete(page.id);
      this.savers.get(page.id)?.remoteVersion(page.version);
    }
    for (const id of changes.removed) {
      if (this.pagesById.has(id)) continue;
      this.refs.set(id, null);
    }
    this.dropGoneSavers(changes.removed);
    this.persistTree();
    this.changed();
  }

  /** A page I can no longer read (or that went to the trash) stops saving; its text stays on screen. */
  private dropGoneSavers(removed: readonly string[] = []): void {
    for (const id of removed) {
      if (this.pagesById.has(id)) continue;
      const saver = this.savers.get(id);
      if (saver && saver.status !== "gone") {
        saver.gone();
        this.deps.store.setPendingPage(id, null);
      }
    }
  }

  /** An answer of mine (create, rename, move, restore, takeover): into the tree now, before the feed says so. */
  upsert(page: PageItem | PageOut): void {
    if (page.kind === "row") return;
    const current = this.pagesById.get(page.id);
    if (current && current.version > page.version) return;
    const { body: _body, breadcrumbs: _crumbs, children: _children, ...item } = page as PageOut;
    this.pagesById.set(page.id, item);
    this.refs.delete(page.id);
    this.persistTree();
    this.changed();
  }

  /** A page I moved to the trash: gone from the tree with what was below it. */
  remove(pageId: string): void {
    this.pagesById = applyChanges(this.pagesById, { pages: [], removed: [pageId] });
    this.persistTree();
    this.changed();
  }

  private persistTree(): void {
    if (this.persistTimer || this.cursor === null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.cursor === null || this.stopped) return;
      this.deps.store.setWikiTreeSnapshot({ pages: [...this.pagesById.values()], cursor: this.cursor, etag: this.etag });
    }, 500);
  }

  // --- events -----------------------------------------------------------------------------------

  applyEvent(event: string, data: unknown): void {
    if (!this.deps.api) return;
    if (event === "wiki.changed") {
      const seq = (data as WikiChanged).seq;
      if (this.cursor === null) {
        if (this.state !== "unsupported") void this.loadTree();
      } else if (seq > this.cursor) this.scheduleCatchUp();
    } else if (event === "wiki.page.updated") {
      const { page } = data as WikiPageUpdated;
      this.applyMeta(page);
      this.savers.get(page.id)?.remoteVersion(page.version);
    } else if (event === "wiki.mentioned") {
      this.deps.onNotice?.({ kind: "mentioned", data: data as WikiMentioned });
    } else if (event === "wiki.shared") {
      this.deps.onNotice?.({ kind: "shared", data: data as WikiShared });
    }
  }

  /** wiki.page.updated: title, icon, version and counts (its place comes from the feed: `parent_id` there is null). */
  private applyMeta(meta: PageMeta): void {
    const current = this.pagesById.get(meta.id);
    const ref = this.refs.get(meta.id);
    if (ref) this.refs.set(meta.id, { ...ref, title: meta.title, icon: meta.icon });
    if (!current || current.version >= meta.version) {
      if (ref) this.changed();
      return;
    }
    this.pagesById.set(meta.id, {
      ...current,
      title: meta.title,
      icon: meta.icon,
      version: meta.version,
      head_rev_id: meta.head_rev_id,
      task_total: meta.task_total,
      task_done: meta.task_done,
      updated_at: meta.updated_at,
      updated_by: meta.updated_by,
      inherit_access: meta.inherit_access,
    });
    this.persistTree();
    this.changed();
  }

  /** `group.updated` or my role changed: who I am to the pages may differ (§10); the tree is read again (ETag). */
  accessMayHaveChanged(): void {
    if (this.state === "unsupported" || !this.deps.api) return;
    void this.loadTree();
  }

  // --- links ------------------------------------------------------------------------------------

  /**
   * A `page:` link's page: from the tree, else asked for (batched). undefined: not known yet (asked); null: one I cannot
   * read (or gone).
   */
  resolve(pageId: string): PageRef | null | undefined {
    const id = pageId.toLowerCase();
    const page = this.pagesById.get(id);
    if (page) return { id: page.id, title: page.title, icon: page.icon, kind: page.kind };
    if (this.refs.has(id)) return this.refs.get(id)!;
    if (!this.deps.api || this.state === "unsupported") return null;
    this.resolveQueue.add(id);
    if (!this.resolveTimer) {
      this.resolveTimer = setTimeout(() => {
        this.resolveTimer = null;
        void this.flushResolve();
      }, this.deps.options?.resolveDelayMs ?? 30);
    }
    return undefined;
  }

  private async flushResolve(): Promise<void> {
    const api = this.deps.api;
    const ids = [...this.resolveQueue].slice(0, 200);
    for (const id of ids) this.resolveQueue.delete(id);
    if (!api || ids.length === 0) return;
    try {
      const found = await api.resolveWikiPages(ids);
      const byId = new Map(found.map((ref) => [ref.id.toLowerCase(), ref]));
      for (const id of ids) this.refs.set(id, byId.get(id) ?? null);
      this.changed();
    } catch (err) {
      // Asked again on the next draw (offline: the link shows its own text meanwhile).
      if (!isRetryable(err)) {
        for (const id of ids) this.refs.set(id, null);
        this.changed();
      }
    }
    if (this.resolveQueue.size > 0) void this.flushResolve();
  }

  // --- the pages on screen -------------------------------------------------------------------------

  /** The page as last read here (breadcrumbs, children, the body to show offline). */
  cachedPage(pageId: string): PageOut | null {
    return this.deps.store.cachedPage(pageId);
  }

  private remember(page: PageOut): void {
    const store = this.deps.store;
    store.setCachedPage(page.id, page);
    // Kept: the newest RECENT_PAGES (by when they were read here).
    const all = store.cachedPages();
    if (all.length > RECENT_PAGES) {
      const order = this.readOrder.filter((id) => all.some(([key]) => key === id));
      const keep = new Set(order.slice(-RECENT_PAGES));
      for (const [id] of all) if (!keep.has(id) && id !== page.id) store.setCachedPage(id, null);
    }
  }
  private readonly readOrder: string[] = [];

  /** The page's save loop (made, and its unsaved edits restored, on first use). */
  saver(pageId: string): PageSaver | null {
    const api = this.deps.api;
    if (!api) return null;
    let saver = this.savers.get(pageId);
    if (!saver) {
      const store = this.deps.store;
      saver = new CanvasSaver<PageContent>(
        pageId,
        "",
        {
          getCanvas: async (id, knownVersion) => {
            const level = this.pagesById.get(id)?.my_level ?? store.cachedPage(id)?.my_level;
            const page = await api.wikiPage(id, knownVersion !== null && level ? `"v${knownVersion}-${level}"` : null);
            if (page) this.noteRead(page);
            return page;
          },
          saveCanvas: async (id, body) => {
            const answer = await api.saveWikiPage(id, body);
            this.noteSaved(answer.page);
            return { canvas: answer.page, submitted_rev_id: answer.submitted_rev_id };
          },
        },
        { ...this.deps.options, persist: (state) => store.setPendingPage(pageId, state) },
        store.pendingPage(pageId),
      );
      this.savers.set(pageId, saver);
      void saver.load();
    }
    return saver;
  }

  private noteRead(page: PageOut): void {
    const index = this.readOrder.indexOf(page.id);
    if (index >= 0) this.readOrder.splice(index, 1);
    this.readOrder.push(page.id);
    this.remember(page);
    const current = this.pagesById.get(page.id);
    if (current && current.version <= page.version) {
      const { body: _body, breadcrumbs: _crumbs, children: _children, ...item } = page;
      // The tree keeps its own place for it (the feed's); the rest is this newer answer.
      this.pagesById.set(page.id, { ...item, parent_id: current.parent_id, position: current.position });
      this.persistTree();
    }
    this.changed();
  }

  private noteSaved(page: PageContent): void {
    const cached = this.deps.store.cachedPage(page.id);
    if (cached) this.deps.store.setCachedPage(page.id, { ...cached, ...page });
    const current = this.pagesById.get(page.id);
    if (current && current.version <= page.version) {
      const { body: _body, ...item } = page;
      this.pagesById.set(page.id, { ...current, ...item, parent_id: current.parent_id, position: current.position });
      this.persistTree();
      this.changed();
    }
  }

  /** A screen shows the page; the returned function lets go (saving what is typed). */
  hold(pageId: string): { saver: PageSaver | null; release: () => void } {
    const saver = this.saver(pageId);
    this.holds.set(pageId, (this.holds.get(pageId) ?? 0) + 1);
    let released = false;
    return {
      saver,
      release: () => {
        if (released) return;
        released = true;
        const left = (this.holds.get(pageId) ?? 1) - 1;
        if (left > 0) this.holds.set(pageId, left);
        else this.holds.delete(pageId);
        if (!saver) return;
        void saver.flush().then(() => this.dropIfIdle(pageId));
      },
    };
  }

  current(pageId: string): PageSaver | undefined {
    return this.savers.get(pageId);
  }

  private dropIfIdle(pageId: string): void {
    const saver = this.savers.get(pageId);
    if (!saver || this.holds.has(pageId) || saver.unsaved) return;
    saver.dispose();
    this.savers.delete(pageId);
  }

  /** After (re)connecting: failed saves go out, open pages are read again, edits kept from before a restart resume. */
  online(): void {
    if (!this.deps.api) return;
    for (const saver of this.savers.values()) saver.online();
    for (const [pageId] of this.deps.store.pendingPages()) {
      if (!this.savers.has(pageId)) {
        const saver = this.saver(pageId);
        void saver?.settled().then(() => this.dropIfIdle(pageId));
      }
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.savers.values()].map((saver) => saver.flush()));
  }

  /** The web page going away: each page with something typed hands over its save for a keepalive request. */
  unload(send: (pageId: string, body: PageSaveIn) => void): void {
    for (const saver of this.savers.values()) {
      const body = saver.unloadSave();
      if (body) send(saver.id, body);
    }
  }

  get mustStay(): boolean {
    return [...this.savers.values()].some((saver) => saver.mustStay);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [this.catchUpTimer, this.resolveTimer, this.persistTimer]) if (timer) clearTimeout(timer);
    this.catchUpTimer = this.resolveTimer = this.persistTimer = null;
    for (const saver of this.savers.values()) saver.dispose();
    this.savers.clear();
    this.holds.clear();
  }
}
