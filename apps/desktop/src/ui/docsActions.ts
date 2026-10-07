/**
 * M121: the 「ドキュメント」 calls the screens make (WIKI.md §14.2), each showing its error and answering null when refused,
 * and putting what the server answered into the tree at once (the change feed says the same a moment later).
 */
import type { ApiClient } from "../api/client";
import type { PageCreate, PageItem, PageMove, PageOut, PageRef, WikiAccessOut, WikiAccessUpdate, WikiMoveOut } from "../api/types";
import type { AppController } from "../state/app";
import type { MoveTarget } from "../sync/wikiTree";

export async function wikiCall<T>(controller: AppController, run: (api: ApiClient) => Promise<T>): Promise<T | null> {
  const api = controller.api;
  if (!api) return null;
  try {
    return await run(api);
  } catch (error) {
    controller.setError(error);
    return null;
  }
}

const hub = (controller: AppController) => controller.engine?.wiki ?? null;

/** A new page: at the top level (`access` for 「共有」 / 「プライベート」, §4.2) or below `parentId` (it inherits). */
export async function createPage(controller: AppController, options: { parentId?: string | null; access?: "workspace" | "private"; title?: string | null; afterId?: string | null; kind?: "page" | "database" }): Promise<PageOut | null> {
  const body: PageCreate = {
    kind: options.kind ?? "page",
    parent_id: options.parentId ?? null,
    access: options.access ?? "workspace",
    title: options.title ?? null,
    after_id: options.afterId ?? null,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    client_save_id: crypto.randomUUID(),
  };
  const page = await wikiCall(controller, (api) => api.createWikiPage(body));
  if (page) hub(controller)?.upsert(page);
  return page;
}

/** The `/` menu's 「子ページ」: a page below `parentId`, as a link target. */
export async function createChildRef(controller: AppController, parentId: string, kind: "page" | "database" = "page"): Promise<PageRef | null> {
  const siblings = hub(controller)?.tree().children.get(parentId) ?? [];
  const page = await createPage(controller, { parentId, afterId: siblings[siblings.length - 1]?.id ?? null, kind });
  if (!page) return null;
  return { id: page.id, title: page.title, icon: page.icon, kind: page.kind };
}

export async function updatePage(controller: AppController, pageId: string, patch: { title?: string; icon?: string }): Promise<PageOut | null> {
  const page = await wikiCall(controller, (api) => api.updateWikiPage(pageId, patch));
  if (page) {
    hub(controller)?.upsert(page);
    hub(controller)?.current(pageId)?.applyMeta(page);
  }
  return page;
}

/** Who would gain or lose access (nothing moves). */
export function moveDryRun(controller: AppController, pageId: string, target: MoveTarget): Promise<WikiMoveOut | null> {
  return wikiCall(controller, (api) => api.moveWikiPage(pageId, { ...toMove(target), dry_run: true, keep_access: false }));
}

export async function movePage(controller: AppController, pageId: string, target: MoveTarget, keepAccess: boolean): Promise<WikiMoveOut | null> {
  const moved = await wikiCall(controller, (api) => api.moveWikiPage(pageId, { ...toMove(target), dry_run: false, keep_access: keepAccess }));
  if (moved?.page) hub(controller)?.upsert(moved.page);
  if (moved) void hub(controller)?.catchUp(); // the siblings' places and the subtree's access
  return moved;
}

function toMove(target: MoveTarget): PageMove {
  return { parent_id: target.parent_id, before_id: target.before_id ?? null, after_id: target.after_id ?? null, dry_run: false, keep_access: false };
}

export async function trashPage(controller: AppController, pageId: string): Promise<boolean> {
  const done = await wikiCall(controller, (api) => api.trashWikiPage(pageId).then(() => true));
  if (done) hub(controller)?.remove(pageId);
  return !!done;
}

export async function restorePage(controller: AppController, pageId: string): Promise<PageOut | null> {
  const page = await wikiCall(controller, (api) => api.restoreWikiPage(pageId));
  if (page) void hub(controller)?.catchUp();
  return page;
}

export async function setAccess(controller: AppController, pageId: string, update: WikiAccessUpdate): Promise<WikiAccessOut | null> {
  const access = await wikiCall(controller, (api) => api.setWikiAccess(pageId, update));
  if (access) void hub(controller)?.catchUp(); // `private` and the subtree's levels may have changed
  return access;
}

export function lookupPages(controller: AppController, q: string): Promise<PageRef[]> {
  const api = controller.api;
  if (!api) return Promise.resolve([]);
  return api.lookupWikiPages(q, 8).catch(() => []);
}

/** The display name of an item of the tree. */
export function pageTitle(page: Pick<PageItem, "title"> | null | undefined, untitled: string): string {
  return page?.title?.trim() ? page.title : untitled;
}
