"""Who may read and change a wiki page (docs/WIKI.md §4): the one place that decides.

Principals are `workspace` (every admin and member: never a guest or a bot), `group` (its members,
not guests) and `user` (one person, guests too: a guest reads only what is shared with them by
name, §4.4). Levels are view < edit < full; several entries → the strongest.

effective(p) = p.inherit_access ? merge(effective(parent), own(p)) : own(p) (§4.2). The result
is kept in wiki_effective_grants and rewritten for a page's subtree in the same transaction as
any change of the tree's shape or of access, serialised by one advisory lock (lock_tree). A page's
level for someone is then one indexed lookup (level_of), and the pages someone can read one query
(readable_ids). `verify` recomputes everything from the roots and compares (`cli wiki-acl`).

Pages someone cannot read do not exist for them: 404 page_not_found on every path, the same as a
page that was never there. Administrators are no exception (§4.3: they list titles and take a
page over, audited).
"""

import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, Select, and_, delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, forbidden, not_found
from app.modules.groups.models import UserGroupMember
from app.modules.users.models import User
from app.modules.wiki.models import WikiEffectiveGrant, WikiGrant, WikiPage

LEVELS: dict[str, int] = {"view": 1, "edit": 2, "full": 3}
LEVEL_NAMES: dict[int, str] = {rank: name for name, rank in LEVELS.items()}
PRINCIPAL_TYPES = ("workspace", "group", "user")
# pg_advisory_xact_lock key for changes of the tree's shape and of access (WIKI.md §4.6).
TREE_LOCK_KEY = 0x77696B69_74726565  # "wikitree"

Key = tuple[str, uuid.UUID | None]


@dataclass(frozen=True)
class Entry:
    """One effective entry: who, how strong, and whose own entry gave it."""

    principal_type: str
    principal_id: uuid.UUID | None
    rank: int
    source: uuid.UUID

    @property
    def key(self) -> Key:
        return (self.principal_type, self.principal_id)


Effective = dict[Key, Entry]


def page_not_found() -> AppError:
    return not_found("page_not_found", "Page not found")


async def lock_tree(db: AsyncSession) -> None:
    """Serialise changes of the tree's shape and of access (released at commit / rollback)."""
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": TREE_LOCK_KEY})


def only_named(actor: User) -> bool:
    """Guests and bots read only pages shared with them by name (WIKI.md §4.1 / §4.4)."""
    return actor.role in ("guest", "bot")


def principal_clause(actor: User, row: Any = WikiEffectiveGrant) -> ColumnElement[bool]:
    """The effective entries that apply to `actor` (the SQL of WIKI.md §4.6)."""
    named = and_(row.principal_type == "user", row.principal_id == actor.id)
    if only_named(actor):
        return named
    my_groups = select(UserGroupMember.group_id).where(UserGroupMember.user_id == actor.id)
    return or_(
        row.principal_type == "workspace",
        and_(row.principal_type == "group", row.principal_id.in_(my_groups)),
        named,
    )


async def level_of(db: AsyncSession, actor: User, page_id: uuid.UUID) -> int:
    """0 (none), 1 view, 2 edit, 3 full. Trash is not looked at here."""
    stmt = select(func.max(WikiEffectiveGrant.level_rank)).where(
        WikiEffectiveGrant.page_id == page_id, principal_clause(actor)
    )
    return int((await db.execute(stmt)).scalar_one() or 0)


async def levels_of(
    db: AsyncSession, actor: User, page_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, int]:
    ids = list(dict.fromkeys(page_ids))
    if not ids:
        return {}
    stmt = (
        select(WikiEffectiveGrant.page_id, func.max(WikiEffectiveGrant.level_rank))
        .where(WikiEffectiveGrant.page_id.in_(ids), principal_clause(actor))
        .group_by(WikiEffectiveGrant.page_id)
    )
    return {row[0]: int(row[1]) for row in (await db.execute(stmt)).all()}


def readable_ids(actor: User, min_rank: int = 1) -> Select[Any]:
    """The ids of the pages `actor` reaches at `min_rank` or more (trash not looked at): one
    query on wiki_effective_principal_idx, whatever the depth (WIKI.md §4.6)."""
    E = WikiEffectiveGrant
    stmt = select(E.page_id).where(principal_clause(actor))
    if min_rank > 1:
        return stmt.group_by(E.page_id).having(func.max(E.level_rank) >= min_rank)
    return stmt.distinct()


def readable_clause(actor: User, page_id_column: Any) -> ColumnElement[bool]:
    """`page_id_column` is a page `actor` can read (an EXISTS on the effective entries)."""
    E = WikiEffectiveGrant
    return select(E.page_id).where(E.page_id == page_id_column, principal_clause(actor)).exists()


async def load_page(db: AsyncSession, page_id: uuid.UUID, *, lock: bool = False) -> WikiPage | None:
    stmt = select(WikiPage).where(WikiPage.id == page_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


def _refuse(rank: int, needed: int) -> None:
    if rank >= needed:
        return
    if needed >= LEVELS["full"]:
        raise forbidden("page_manage_restricted", "Only people with full access can do this")
    raise forbidden("page_edit_restricted", "You can read this page but not change it")


async def require_level(
    db: AsyncSession,
    actor: User,
    page_id: uuid.UUID,
    level: str,
    *,
    lock: bool = False,
    trashed: bool = False,
) -> tuple[WikiPage, int]:
    """The page and the actor's rank, or 404 page_not_found when they cannot read it (or it is
    in the trash, or not, as `trashed` asks), 403 when they read it but `level` is more."""
    page = await load_page(db, page_id, lock=lock)
    if page is None or page.is_deleted != trashed:
        raise page_not_found()
    rank = await level_of(db, actor, page.id)
    if rank < 1:
        raise page_not_found()
    _refuse(rank, LEVELS[level])
    return page, rank


# --- computing the effective entries -------------------------------------------------------------


@dataclass(frozen=True)
class Node:
    id: uuid.UUID
    parent_id: uuid.UUID | None
    inherit_access: bool


Own = Mapping[uuid.UUID, list[tuple[str, uuid.UUID | None, int]]]


def merge_own(
    inherited: Effective, own: list[tuple[str, uuid.UUID | None, int]], page_id: uuid.UUID
) -> Effective:
    """The inherited entries with the page's own on top; for each principal the stronger, and on
    a tie the page's own (so the sharing screen shows it as the page's)."""
    out = dict(inherited)
    for principal_type, principal_id, rank in own:
        current = out.get((principal_type, principal_id))
        if current is None or rank >= current.rank:
            out[(principal_type, principal_id)] = Entry(principal_type, principal_id, rank, page_id)
    return out


def compute(
    root: uuid.UUID,
    parent_effective: Effective,
    nodes: Mapping[uuid.UUID, Node],
    own: Own,
) -> dict[uuid.UUID, Effective]:
    """The effective entries of `root` and everything below it in `nodes` (WIKI.md §4.2)."""
    children: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for node in nodes.values():
        if node.parent_id is not None:
            children[node.parent_id].append(node.id)
    out: dict[uuid.UUID, Effective] = {}
    stack: list[tuple[uuid.UUID, Effective]] = [(root, parent_effective)]
    while stack:
        page_id, inherited = stack.pop()
        node = nodes[page_id]
        base = inherited if node.inherit_access else {}
        mine = merge_own(base, own.get(page_id, []), page_id)
        out[page_id] = mine
        for child in children.get(page_id, ()):
            stack.append((child, mine))
    return out


async def load_effective(
    db: AsyncSession, page_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, Effective]:
    ids = list(dict.fromkeys(page_ids))
    out: dict[uuid.UUID, Effective] = {pid: {} for pid in ids}
    if not ids:
        return out
    E = WikiEffectiveGrant
    rows = await db.execute(
        select(E.page_id, E.principal_type, E.principal_id, E.level_rank, E.source_page_id).where(
            E.page_id.in_(ids)
        )
    )
    for page_id, ptype, pid, rank, source in rows.all():
        out[page_id][(ptype, pid)] = Entry(ptype, pid, int(rank), source)
    return out


async def load_own(
    db: AsyncSession, page_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[str, uuid.UUID | None, int]]]:
    ids = list(dict.fromkeys(page_ids))
    out: dict[uuid.UUID, list[tuple[str, uuid.UUID | None, int]]] = defaultdict(list)
    if not ids:
        return out
    rows = await db.execute(
        select(WikiGrant.page_id, WikiGrant.principal_type, WikiGrant.principal_id, WikiGrant.level)
        .where(WikiGrant.page_id.in_(ids))
        .order_by(WikiGrant.page_id, WikiGrant.principal_type, WikiGrant.principal_id)
    )
    for page_id, ptype, pid, level in rows.all():
        out[page_id].append((ptype, pid, LEVELS[level]))
    return out


async def subtree_nodes(db: AsyncSession, root: uuid.UUID) -> dict[uuid.UUID, Node]:
    """The page and every page below it (in the trash too), by `path`."""
    rows = await db.execute(
        select(WikiPage.id, WikiPage.parent_id, WikiPage.inherit_access).where(
            or_(WikiPage.id == root, WikiPage.path.contains([root]))
        )
    )
    return {row[0]: Node(row[0], row[1], row[2]) for row in rows.all()}


async def compute_subtree(
    db: AsyncSession,
    root: uuid.UUID,
    *,
    parent_id: uuid.UUID | None,
    nodes: dict[uuid.UUID, Node] | None = None,
    own: Own | None = None,
) -> dict[uuid.UUID, Effective]:
    """What the subtree's entries would be under `parent_id` (without writing): a move's dry run
    and the rewrite share it."""
    if nodes is None:
        nodes = await subtree_nodes(db, root)
    if own is None:
        own = await load_own(db, nodes)
    parent_effective: Effective = {}
    if parent_id is not None:
        parent_effective = (await load_effective(db, [parent_id]))[parent_id]
    return compute(root, parent_effective, nodes, own)


async def write_effective(db: AsyncSession, computed: Mapping[uuid.UUID, Effective]) -> None:
    """Replace the effective entries of these pages (the caller holds lock_tree)."""
    ids = list(computed)
    if not ids:
        return
    await db.execute(delete(WikiEffectiveGrant).where(WikiEffectiveGrant.page_id.in_(ids)))
    pages: list[uuid.UUID] = []
    types: list[str] = []
    principals: list[uuid.UUID | None] = []
    ranks: list[int] = []
    sources: list[uuid.UUID] = []
    for page_id, entries in computed.items():
        for entry in entries.values():
            pages.append(page_id)
            types.append(entry.principal_type)
            principals.append(entry.principal_id)
            ranks.append(entry.rank)
            sources.append(entry.source)
    if not pages:
        return
    await db.execute(
        text(
            "INSERT INTO wiki_effective_grants "
            "(page_id, principal_type, principal_id, level_rank, source_page_id) "
            "SELECT * FROM unnest(CAST(:pages AS uuid[]), CAST(:types AS varchar[]), "
            "CAST(:principals AS uuid[]), CAST(:ranks AS smallint[]), CAST(:sources AS uuid[]))"
        ),
        {
            "pages": pages,
            "types": types,
            "principals": principals,
            "ranks": ranks,
            "sources": sources,
        },
    )


async def recompute_subtree(db: AsyncSession, root: uuid.UUID) -> dict[uuid.UUID, Effective]:
    """Rewrite the effective entries of `root` and everything below it from its parent's (the
    caller holds lock_tree). Returns the new entries."""
    page = await load_page(db, root)
    if page is None:
        return {}
    computed = await compute_subtree(db, root, parent_id=page.parent_id)
    await write_effective(db, computed)
    return computed


# --- the whole table (cli wiki-acl, the tests) ---------------------------------------------------


async def compute_all(db: AsyncSession) -> dict[uuid.UUID, Effective]:
    rows = await db.execute(select(WikiPage.id, WikiPage.parent_id, WikiPage.inherit_access))
    nodes = {row[0]: Node(row[0], row[1], row[2]) for row in rows.all()}
    own = await load_own(db, nodes)
    out: dict[uuid.UUID, Effective] = {}
    for node in nodes.values():
        if node.parent_id is None or node.parent_id not in nodes:
            out.update(compute(node.id, {}, nodes, own))
    return out


async def stored_all(db: AsyncSession) -> dict[uuid.UUID, Effective]:
    E = WikiEffectiveGrant
    rows = await db.execute(
        select(E.page_id, E.principal_type, E.principal_id, E.level_rank, E.source_page_id)
    )
    out: dict[uuid.UUID, Effective] = defaultdict(dict)
    for page_id, ptype, pid, rank, source in rows.all():
        out[page_id][(ptype, pid)] = Entry(ptype, pid, int(rank), source)
    return out


async def path_problems(db: AsyncSession) -> list[str]:
    """Pages whose `path` is not the chain of their parents (the tree's other derived column)."""
    rows = await db.execute(select(WikiPage.id, WikiPage.parent_id, WikiPage.path))
    parents: dict[uuid.UUID, uuid.UUID | None] = {}
    paths: dict[uuid.UUID, list[uuid.UUID]] = {}
    for page_id, parent_id, path in rows.all():
        parents[page_id] = parent_id
        paths[page_id] = list(path or [])
    problems: list[str] = []
    for page_id, parent_id in parents.items():
        chain: list[uuid.UUID] = []
        current = parent_id
        while current is not None and len(chain) <= len(parents):
            chain.append(current)
            current = parents.get(current)
        chain.reverse()
        if chain != paths[page_id]:
            problems.append(f"page {page_id}: path {paths[page_id]} != {chain}")
    return problems


async def verify(db: AsyncSession) -> list[str]:
    """Differences between wiki_effective_grants and a recomputation from the roots, and paths
    that do not match the parents (empty: all is well)."""
    expected = await compute_all(db)
    stored = await stored_all(db)
    problems: list[str] = []
    for page_id in sorted(set(expected) | set(stored)):
        want = {k: (e.rank, e.source) for k, e in expected.get(page_id, {}).items()}
        have = {k: (e.rank, e.source) for k, e in stored.get(page_id, {}).items()}
        if want != have:
            problems.append(f"page {page_id}: stored {have} != expected {want}")
    problems.extend(await path_problems(db))
    return problems


async def rebuild(db: AsyncSession) -> int:
    """Rewrite the whole table from the roots (cli wiki-acl --rebuild). Returns the pages."""
    await lock_tree(db)
    computed = await compute_all(db)
    await db.execute(delete(WikiEffectiveGrant))
    await write_effective(db, computed)
    return len(computed)
