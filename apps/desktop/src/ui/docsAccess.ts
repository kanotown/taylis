/**
 * M121 (WIKI.md §4): who may do what with a Docs page, and the sharing screen's edits as the PUT /wiki/pages/{id}/access
 * they send. The server decides everything (§4.7); this only hides what it would refuse and builds the requests.
 *
 * Sharing (§4.2): a page takes its parent's entries (`inherit_access`) plus its own. Adding someone, or raising someone,
 * adds an own entry and keeps the inheritance. Narrowing or removing an inherited entry stops the inheritance: the
 * effective entries become the page's own (minus / with the change), as Notion does. 「親から受け継ぐ」 on again keeps
 * the own entries (nobody loses access by turning it back on).
 */
import type { PageItem, WikiAccessOut, WikiAccessUpdate, WikiGrantIn, WikiLevel, WikiPrincipalType } from "../api/types";

export const LEVELS: readonly WikiLevel[] = ["view", "edit", "full"];

export function levelRank(level: WikiLevel | null | undefined): number {
  return level === "full" ? 3 : level === "edit" ? 2 : level === "view" ? 1 : 0;
}

export interface PageRights {
  /** Read it (always, once it is on screen). */
  view: boolean;
  /** Body, title, icon, child pages, version labels (§4.1 edit). */
  edit: boolean;
  /** Sharing, moving, the trash, erasing a version (§4.1 full). Sharing also needs a non-guest (§4.8). */
  manage: boolean;
  share: boolean;
}

export const NO_PAGE_RIGHTS: PageRights = { view: false, edit: false, manage: false, share: false };

export function pageRights(page: Pick<PageItem, "my_level"> | null | undefined, isGuest: boolean): PageRights {
  if (!page) return NO_PAGE_RIGHTS;
  const rank = levelRank(page.my_level);
  return { view: rank >= 1, edit: rank >= 2, manage: rank >= 3, share: rank >= 3 && !isGuest };
}

export interface Principal {
  principal_type: WikiPrincipalType;
  principal_id?: string | null;
}

export function principalKey(p: Principal): string {
  return `${p.principal_type}:${p.principal_id ?? ""}`;
}

const sameAs = (a: Principal) => (b: Principal) => principalKey(a) === principalKey(b);
const grant = (p: Principal, level: WikiLevel): WikiGrantIn => ({ principal_type: p.principal_type, principal_id: p.principal_type === "workspace" ? null : p.principal_id, level });

function own(access: WikiAccessOut): WikiGrantIn[] {
  return access.own.map((g) => grant(g, g.level));
}

/** Every effective entry as an own one (what stopping the inheritance keeps). */
function effectiveAsOwn(access: WikiAccessOut): WikiGrantIn[] {
  return access.effective.map((g) => grant(g, g.level));
}

/** Someone added at a level (or an own entry raised): the inheritance stays as it is. */
export function addGrant(access: WikiAccessOut, who: Principal, level: WikiLevel): WikiAccessUpdate {
  return { inherit_access: access.inherit_access, grants: [...own(access).filter((g) => !sameAs(who)(g)), grant(who, level)] };
}

/**
 * A level changed in the list. Raising, or changing an entry of this page's own, keeps the inheritance; narrowing an
 * inherited one stops it (its effective entries become the page's own, with the change).
 */
export function changeLevel(access: WikiAccessOut, who: Principal, level: WikiLevel): WikiAccessUpdate {
  const entry = access.effective.find(sameAs(who));
  if (!entry || !entry.inherited || levelRank(level) >= levelRank(entry.level)) return addGrant(access, who, level);
  return { inherit_access: false, grants: effectiveAsOwn(access).map((g) => (sameAs(who)(g) ? grant(who, level) : g)) };
}

/** Someone removed: an own entry goes; an inherited one stops the inheritance (everyone else keeps their access). */
export function removeGrant(access: WikiAccessOut, who: Principal): WikiAccessUpdate {
  const entry = access.effective.find(sameAs(who));
  if (entry?.inherited) return { inherit_access: false, grants: effectiveAsOwn(access).filter((g) => !sameAs(who)(g)) };
  return { inherit_access: access.inherit_access, grants: own(access).filter((g) => !sameAs(who)(g)) };
}

/** 「親から受け継ぐ」: off keeps everyone's access as the page's own entries; on again keeps the own entries. */
export function setInherit(access: WikiAccessOut, inherit: boolean): WikiAccessUpdate {
  if (inherit === access.inherit_access) return { inherit_access: inherit, grants: own(access) };
  return inherit ? { inherit_access: true, grants: own(access) } : { inherit_access: false, grants: effectiveAsOwn(access) };
}

/** The list's order: everyone first, then groups, then people; stronger levels first within each. */
export function sortedEntries<T extends Principal & { level: WikiLevel }>(entries: readonly T[], nameOf: (p: Principal) => string): T[] {
  const kind = (p: Principal) => (p.principal_type === "workspace" ? 0 : p.principal_type === "group" ? 1 : 2);
  return [...entries].sort((a, b) => kind(a) - kind(b) || levelRank(b.level) - levelRank(a.level) || nameOf(a).localeCompare(nameOf(b)));
}
