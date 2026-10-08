/**
 * M121: a small in-memory stand-in for the wiki endpoints the hub uses (WIKI.md §14.2) — enough for the tree, the
 * change feed and one page's save loop. Access is fixed per page (`my_level`); the server's own rules are pytest's.
 */
import { ApiError } from "../src/api/errors";
import type { PageContent, PageItem, PageOut, PageRef, PageSaveIn, PageSaveOut, WikiChangesOut, WikiTreeOut } from "../src/api/types";
import type { WikiApi } from "../src/sync/wiki";

let counter = 0;
export const uid = (n?: number) => `00000000-0000-7000-8000-${String(n ?? ++counter).padStart(12, "0")}`;

export function item(id: string, patch: Partial<PageItem> = {}): PageItem {
  return {
    id,
    parent_id: null,
    position: "a",
    kind: "page",
    title: `page ${id.slice(-3)}`,
    icon: null,
    version: 1,
    head_rev_id: `rev-${id}-1`,
    meta_seq: 1,
    inherit_access: true,
    task_total: 0,
    task_done: 0,
    created_by: "u-me",
    updated_by: "u-me",
    created_at: "2026-10-07T00:00:00Z",
    updated_at: "2026-10-07T00:00:00Z",
    deleted_at: null,
    my_level: "full",
    private: false,
    is_template: false,
    ...patch,
  };
}

export class FakeWiki implements WikiApi {
  pages = new Map<string, PageItem>();
  bodies = new Map<string, string>();
  cursor = 1;
  etag = '"e1"';
  /** What the next GET /wiki/changes answers (else nothing changed). */
  nextChanges: WikiChangesOut | null = null;
  calls: string[] = [];
  /** The next save answers 409 page_conflict. */
  conflictNext = false;

  add(page: PageItem, body = ""): PageItem {
    this.pages.set(page.id, page);
    this.bodies.set(page.id, body);
    return page;
  }

  async wikiTree(etag: string | null): Promise<{ tree: WikiTreeOut; etag: string | null } | null> {
    this.calls.push(`tree ${etag ?? "-"}`);
    if (etag && etag === this.etag) return null;
    return { tree: { pages: [...this.pages.values()], cursor: this.cursor }, etag: this.etag };
  }

  async wikiChanges(since: number): Promise<WikiChangesOut> {
    this.calls.push(`changes ${since}`);
    const next = this.nextChanges ?? { pages: [], removed: [], cursor: this.cursor, reset: false };
    this.nextChanges = null;
    return next;
  }

  private out(id: string): PageOut {
    const page = this.pages.get(id);
    if (!page) throw new ApiError(404, "page_not_found", "Page not found");
    return { ...page, body: this.bodies.get(id) ?? "", breadcrumbs: [], children: [] };
  }

  async wikiPage(pageId: string, etag: string | null): Promise<PageOut | null> {
    this.calls.push(`get ${pageId.slice(-3)} ${etag ?? "-"}`);
    const page = this.out(pageId);
    if (etag === `"v${page.version}-${page.my_level}"`) return null;
    return page;
  }

  async saveWikiPage(pageId: string, body: PageSaveIn): Promise<PageSaveOut> {
    this.calls.push(`save ${pageId.slice(-3)} ${JSON.stringify(body.body)}`);
    const page = this.pages.get(pageId)!;
    if (this.conflictNext) {
      this.conflictNext = false;
      const head: PageContent = { ...page, body: this.bodies.get(pageId) ?? "" };
      throw new ApiError(409, "page_conflict", "Conflict", { head, conflicts: [{ base: "a", ours: "b", theirs: "c", ours_line: 0, theirs_line: 0 }], timed_out: false });
    }
    const version = page.version + 1;
    const next = { ...page, version, head_rev_id: `rev-${pageId}-${version}` };
    this.pages.set(pageId, next);
    this.bodies.set(pageId, body.body);
    return { page: { ...next, body: body.body }, submitted_rev_id: next.head_rev_id, merged: false };
  }

  async resolveWikiPages(ids: string[]): Promise<PageRef[]> {
    this.calls.push(`resolve ${ids.length}`);
    return ids.filter((id) => this.pages.has(id)).map((id) => {
      const page = this.pages.get(id)!;
      return { id, title: page.title, icon: page.icon, kind: page.kind };
    });
  }
}
