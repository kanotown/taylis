/**
 * M121 (WIKI.md §3, §10, §14): the 「ドキュメント」 tree as this device holds it — pure rules, no I/O.
 *
 * The server sends every page I can read (`GET /wiki/tree`) and then what changed (`GET /wiki/changes?since=`). A page
 * whose parent I cannot read already arrives with `parent_id` null (§14.4), so it is a root here. Siblings are ordered
 * by `position` (byte order: the keys are ASCII, so code-unit order is byte order) and then by id, as the server orders
 * them. Roots are split into 「共有」 and 「プライベート」 by `private` (the effective access is me alone, §3.1).
 */
import type { PageItem, WikiChangesOut } from "../api/types";

/** The server's sibling order: `position` in byte order, then id. */
export function comparePages(a: Pick<PageItem, "position" | "id">, b: Pick<PageItem, "position" | "id">): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface WikiTree {
  /** Roots I share with others (or that others share with me). */
  shared: PageItem[];
  /** Roots only I can read. */
  private: PageItem[];
  /** parent id → its children I can read, in order. */
  children: ReadonlyMap<string, PageItem[]>;
}

/** The tree of `pages` (database rows never show in it). A page whose parent is not here is a root. */
export function buildTree(pages: Iterable<PageItem>): WikiTree {
  const all = [...pages].filter((page) => page.kind !== "row" && !page.deleted_at);
  const ids = new Set(all.map((page) => page.id));
  const children = new Map<string, PageItem[]>();
  const shared: PageItem[] = [];
  const mine: PageItem[] = [];
  for (const page of all) {
    const parent = page.parent_id && ids.has(page.parent_id) && page.parent_id !== page.id ? page.parent_id : null;
    if (parent) {
      const list = children.get(parent);
      if (list) list.push(page);
      else children.set(parent, [page]);
    } else if (page.private) mine.push(page);
    else shared.push(page);
  }
  for (const list of children.values()) list.sort(comparePages);
  shared.sort(comparePages);
  mine.sort(comparePages);
  return { shared, private: mine, children };
}

/** The visible parent of a page here (null: a root). */
export function parentOf(pages: ReadonlyMap<string, PageItem>, id: string): string | null {
  const parent = pages.get(id)?.parent_id ?? null;
  return parent && pages.has(parent) ? parent : null;
}

/** The ids above the page here, the root first (to open the branches down to it). */
export function ancestorIds(pages: ReadonlyMap<string, PageItem>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let current = parentOf(pages, id);
  while (current && !seen.has(current)) {
    out.unshift(current);
    seen.add(current);
    current = parentOf(pages, current);
  }
  return out;
}

/** The page and every page below it here. */
export function subtreeIds(pages: ReadonlyMap<string, PageItem>, id: string): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const page of pages.values()) {
    if (!page.parent_id) continue;
    const list = byParent.get(page.parent_id);
    if (list) list.push(page.id);
    else byParent.set(page.parent_id, [page.id]);
  }
  const out = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.pop()!) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * One answer of the change feed applied (§10): changed pages replace theirs (a larger version never loses to a smaller
 * one), `removed` ones go — with what was below them here unless the same answer brings it back (a page shared with me
 * on its own stays, as a root, when its parent leaves). `reset` is the caller's: read the whole tree again.
 */
export function applyChanges(pages: ReadonlyMap<string, PageItem>, changes: Pick<WikiChangesOut, "pages" | "removed">): Map<string, PageItem> {
  const next = new Map(pages);
  const brought = new Set(changes.pages.map((page) => page.id));
  for (const id of changes.removed) {
    if (brought.has(id)) continue;
    for (const gone of subtreeIds(next, id)) if (!brought.has(gone)) next.delete(gone);
  }
  for (const page of changes.pages) {
    if (page.kind === "row") continue;
    if (page.deleted_at) {
      next.delete(page.id);
      continue;
    }
    next.set(page.id, page);
  }
  return next;
}

export type DropZone = "before" | "after" | "inside";

export interface MoveTarget {
  parent_id: string | null;
  before_id?: string;
  after_id?: string;
}

/**
 * Where a page dropped on another goes (the server makes the position key from before / after, §3.2): above it, below
 * it, or as its last child. null: onto itself or below itself (409 wiki_move_cycle), or where it already is.
 */
export function dropTarget(pages: ReadonlyMap<string, PageItem>, dragId: string, targetId: string, zone: DropZone): MoveTarget | null {
  if (dragId === targetId || !pages.has(dragId) || !pages.has(targetId)) return null;
  if (subtreeIds(pages, dragId).has(targetId)) return null;
  const tree = buildTree(pages.values());
  const siblingsOf = (parent: string | null, page: PageItem) =>
    parent ? tree.children.get(parent) ?? [] : page.private ? tree.private : tree.shared;
  if (zone === "inside") {
    const all = tree.children.get(targetId) ?? [];
    if (all.length > 0 && all[all.length - 1]!.id === dragId) return null; // already its last child
    const kids = all.filter((page) => page.id !== dragId);
    const last = kids[kids.length - 1];
    return last ? { parent_id: targetId, after_id: last.id } : { parent_id: targetId };
  }
  const target = pages.get(targetId)!;
  const parent = parentOf(pages, targetId);
  const siblings = siblingsOf(parent, target);
  const index = siblings.findIndex((page) => page.id === targetId);
  // Already there: right above / below the target among the same siblings.
  if (parentOf(pages, dragId) === parent) {
    const neighbour = siblings[zone === "before" ? index - 1 : index + 1];
    if (neighbour?.id === dragId) return null;
  }
  return zone === "before" ? { parent_id: parent, before_id: targetId } : { parent_id: parent, after_id: targetId };
}

/**
 * A root dropped on the 「共有」 / 「プライベート」 heading: first among those roots. The section itself is not a place
 * (who can read decides it); the page simply goes to the top level.
 */
export function rootTarget(pages: ReadonlyMap<string, PageItem>, dragId: string, section: "shared" | "private"): MoveTarget | null {
  if (!pages.has(dragId)) return null;
  const tree = buildTree(pages.values());
  const first = (section === "private" ? tree.private : tree.shared).find((page) => page.id !== dragId);
  return first ? { parent_id: null, before_id: first.id } : { parent_id: null };
}

/** The ids of the branches open on this device, per account (WIKI.md §9.1: expand / collapse is remembered here). */
export function expandedKey(accountKey: string | null): string {
  return `chikuwa.docs.expanded:${accountKey ?? ""}`;
}

export function readExpanded(accountKey: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(expandedKey(accountKey));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeExpanded(accountKey: string | null, ids: ReadonlySet<string>): void {
  try {
    if (ids.size === 0) localStorage.removeItem(expandedKey(accountKey));
    else localStorage.setItem(expandedKey(accountKey), JSON.stringify([...ids].slice(-500)));
  } catch {
    /* storage refused: the branches just start closed next time */
  }
}
