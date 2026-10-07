"""Links pinned to the top of a conversation (M15f; Slack's bookmarks bar).

Members read the bar; members who may post (not guests, and in an announcement channel only
owners and administrators) change it. Every change reaches the members as
`channel.links_updated` with the whole bar; clients load the bar when they open a conversation.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, forbidden, not_found
from app.core.roles import has_capability
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.channel_links import repository as repo
from app.modules.channel_links.events import CHANNEL_LINKS_UPDATED, ChannelLinksUpdatedData
from app.modules.channel_links.models import ChannelLink
from app.modules.channel_links.schemas import MAX_LINKS, ChannelLinkOut, LinkCreate, LinkUpdate
from app.modules.channels import service as channels
from app.modules.users.models import User


def _out(rows: list[ChannelLink]) -> list[ChannelLinkOut]:
    return [
        ChannelLinkOut(
            id=r.id,
            title=r.title,
            url=r.url,
            position=r.position,
            created_by=r.created_by,
            created_at=r.created_at,
        )
        for r in rows
    ]


async def list_for(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> list[ChannelLinkOut]:
    await channels.require_member(db, actor.id, channel_id)
    return _out(await repo.links_for(db, channel_id))


async def _require_editor(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> None:
    channels.require_not_guest(actor)
    channel, membership = await channels.require_member(db, actor.id, channel_id)
    channels.require_writable(channel)
    if (
        channel.posting_policy == "owners"
        and not has_capability(actor, "channels.moderate")
        and membership.role != "owner"
    ):
        raise forbidden(
            "posting_restricted", "Only owners and administrators can change links here"
        )


async def _commit(db: AsyncSession, channel_id: uuid.UUID) -> list[ChannelLinkOut]:
    await db.flush()
    rows = await repo.links_for(db, channel_id)
    for index, row in enumerate(rows):
        row.position = index
    await db.flush()
    out = _out(rows)
    await write_outbox(
        db,
        event_type=CHANNEL_LINKS_UPDATED,
        audience_type="channel",
        channel_id=channel_id,
        payload=ChannelLinksUpdatedData(channel_id=channel_id, links=out).model_dump(mode="json"),
    )
    await db.commit()
    return out


async def create(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, data: LinkCreate
) -> list[ChannelLinkOut]:
    await _require_editor(db, actor, channel_id)
    rows = await repo.links_for(db, channel_id)
    if len(rows) >= MAX_LINKS:
        raise conflict("too_many_links", f"At most {MAX_LINKS} links")
    db.add(
        ChannelLink(
            channel_id=channel_id,
            title=data.title,
            url=data.url,
            position=len(rows),
            created_by=actor.id,
        )
    )
    return await _commit(db, channel_id)


async def _require_link(db: AsyncSession, channel_id: uuid.UUID, link_id: uuid.UUID) -> ChannelLink:
    link = await repo.get(db, channel_id, link_id)
    if link is None:
        raise not_found("link_not_found", "Link not found")
    return link


async def update(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, link_id: uuid.UUID, data: LinkUpdate
) -> list[ChannelLinkOut]:
    await _require_editor(db, actor, channel_id)
    link = await _require_link(db, channel_id, link_id)
    if data.title is not None:
        link.title = data.title
    if data.url is not None:
        link.url = data.url
    link.updated_at = utcnow()
    if data.position is not None:
        ordered = [r for r in await repo.links_for(db, channel_id) if r.id != link.id]
        ordered.insert(min(data.position, len(ordered)), link)
        for index, row in enumerate(ordered):
            row.position = index
    return await _commit(db, channel_id)


async def delete(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, link_id: uuid.UUID
) -> list[ChannelLinkOut]:
    await _require_editor(db, actor, channel_id)
    await repo.remove(db, await _require_link(db, channel_id, link_id))
    return await _commit(db, channel_id)
