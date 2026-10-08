/**
 * M121: the 「ドキュメント」 calls the screens make (WIKI.md §14.2), each showing its error and answering null when refused,
 * and putting what the server answered into the tree at once (the change feed says the same a moment later).
 */
import type { ApiClient } from "../api/client";
import type { PageCreate, PageDuplicate, PageDuplicateOut, PageItem, PageMove, PageOut, PageRef, WikiAccessOut, WikiAccessUpdate, WikiMoveOut } from "../api/types";
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

/** The client's IANA zone, for a template's {{date}} / {{time}} and a row template's 「今日」. */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Where a new page starts from (M145, WIKI.md §22.3): empty, a built-in template, or a page template. */
export type TemplateChoice = { kind: "blank" } | { kind: "builtin"; key: string } | { kind: "page"; id: string };

/** A new page: at the top level (`access` for 「共有」 / 「プライベート」, §4.2) or below `parentId` (it inherits). M145: from a
 * template (`template`), or a page template itself (`isTemplate`, top level only). */
export async function createPage(controller: AppController, options: { parentId?: string | null; access?: "workspace" | "private"; title?: string | null; afterId?: string | null; kind?: "page" | "database"; template?: TemplateChoice; isTemplate?: boolean }): Promise<PageOut | null> {
  const template = options.template ?? { kind: "blank" };
  const body: PageCreate = {
    kind: options.kind ?? "page",
    parent_id: options.parentId ?? null,
    access: options.access ?? "workspace",
    title: options.title ?? null,
    after_id: options.afterId ?? null,
    tz: localZone(),
    is_template: options.isTemplate ?? false,
    template_key: template.kind === "builtin" ? template.key : null,
    template_page_id: template.kind === "page" ? template.id : null,
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

export async function updatePage(controller: AppController, pageId: string, patch: { title?: string; icon?: string; is_template?: boolean }): Promise<PageOut | null> {
  const page = await wikiCall(controller, (api) => api.updateWikiPage(pageId, patch));
  if (page) {
    hub(controller)?.upsert(page);
    hub(controller)?.current(pageId)?.applyMeta(page);
  }
  return page;
}

/** M145: 「複製」 (beside the original unless `parent_id`) and 「テンプレートとして保存」 (`as_template`). */
export async function duplicatePage(controller: AppController, pageId: string, options: Omit<PageDuplicate, "client_save_id"> = {}): Promise<PageDuplicateOut | null> {
  const out = await wikiCall(controller, (api) => api.duplicateWikiPage(pageId, { ...options, client_save_id: crypto.randomUUID() }));
  if (out) hub(controller)?.upsert(out.page);
  return out;
}

/** M145: 「テンプレートから始める」 on an empty page. */
export async function applyTemplate(controller: AppController, pageId: string, template: Exclude<TemplateChoice, { kind: "blank" }>): Promise<PageOut | null> {
  const page = await wikiCall(controller, (api) => api.applyWikiTemplate(pageId, {
    template_key: template.kind === "builtin" ? template.key : null,
    template_page_id: template.kind === "page" ? template.id : null,
    tz: localZone(),
    client_save_id: crypto.randomUUID(),
  }));
  if (page) {
    hub(controller)?.upsert(page);
    hub(controller)?.current(pageId)?.remoteVersion(page.version);
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

/** M149: `![[` in the editor — the databases of the tree (those I can read) whose title contains `q`. */
export function lookupDatabases(controller: AppController, q: string): Promise<PageRef[]> {
  const needle = q.trim().toLowerCase();
  const found = [...(hub(controller)?.pages.values() ?? [])]
    .filter((page) => page.kind === "database" && (page.title ?? "").toLowerCase().includes(needle))
    .slice(0, 8)
    .map((page) => ({ id: page.id, title: page.title, icon: page.icon, kind: page.kind }));
  return Promise.resolve(found);
}

/** M149: the first view of a database (what a new embed names), null when it cannot be read. */
export async function firstViewId(controller: AppController, databaseId: string): Promise<string | null> {
  const api = controller.api;
  if (!api) return null;
  try {
    return (await api.wikiDatabase(databaseId)).views[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** The display name of an item of the tree. */
export function pageTitle(page: Pick<PageItem, "title"> | null | undefined, untitled: string): string {
  return page?.title?.trim() ? page.title : untitled;
}
