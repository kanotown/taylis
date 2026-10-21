"""A snapshot of an item and what is under it outside the trash (phase D3): what a copy writes and
what a ZIP holds, read once, with each file's current version and its attachment."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment
from app.modules.drive import repository as repo
from app.modules.drive.access import item_not_found
from app.modules.drive.models import DriveFileVersion, DriveItem


class TooLarge(Exception):
    """More items than the caller's cap."""


@dataclass
class Node:
    item: DriveItem
    version: DriveFileVersion | None = None
    attachment: Attachment | None = None
    children: list["Node"] = field(default_factory=list)

    def walk(self) -> list["Node"]:
        """This node and everything under it, parents before children."""
        out = [self]
        for child in self.children:
            out += child.walk()
        return out

    @property
    def height(self) -> int:
        """Levels below this node (a file or an empty folder: 0)."""
        return 1 + max(child.height for child in self.children) if self.children else 0

    @property
    def size(self) -> int:
        return sum(node.version.size_bytes for node in self.walk() if node.version is not None)


def _order(node: Node) -> tuple[int, bytes, uuid.UUID]:
    # Folders first, then by the sidebar's name order (the listing's order).
    return (0 if node.item.kind == "folder" else 1, node.item.name_sort, node.item.id)


async def snapshot(db: AsyncSession, root: DriveItem, *, cap: int) -> Node:
    """The live tree under `root` (included). TooLarge past `cap` nodes. A file whose bytes are
    gone (its attachment deleted) has no attachment: the caller decides."""
    ids = await repo.live_subtree(db, root.id, cap=cap + 1)
    if len(ids) > cap:
        raise TooLarge
    rows = await repo.items(db, [i for i, _ in ids])
    files = await repo.current_files(
        db, [r.current_version_id for r in rows.values() if r.current_version_id is not None]
    )
    nodes: dict[uuid.UUID, Node] = {}
    for item_id, _ in ids:
        row = rows.get(item_id)
        if row is None:
            continue
        found = files.get(row.current_version_id) if row.current_version_id else None
        node = Node(item=row)
        if found is not None:
            node.version, attachment = found
            node.attachment = attachment if attachment.status != "deleted" else None
        nodes[item_id] = node
    for item_id, node in nodes.items():
        parent = node.item.parent_id
        if item_id != root.id and parent in nodes:
            nodes[parent].children.append(node)
    for node in nodes.values():
        node.children.sort(key=_order)
    if root.id not in nodes:
        raise item_not_found()  # put in the trash meanwhile
    return nodes[root.id]
