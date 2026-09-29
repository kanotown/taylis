"""Post templates (M30, LAB.md C).

The workspace's templates (admins edit them) and each person's own. A client inserts one into its
input with `/name` or the input's template button, after putting in the date (the rules and their
test vectors are in DATA_MODEL.md message_templates and apps/shared/templates.json); nothing is
posted by the server. Clients learn the list from bootstrap and template.updated (a workspace
template's to everyone, a personal one's to its owner).
"""

import unicodedata
import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.templates import repository as repo
from app.modules.templates.events import TEMPLATE_UPDATED, TemplateUpdatedData
from app.modules.templates.models import MessageTemplate
from app.modules.templates.schemas import (
    TemplateCreate,
    TemplateOut,
    TemplateUpdate,
    to_template_out,
)
from app.modules.users.models import User

# The clients' built-in slash commands (desktop ui/commands.ts, iOS UI/Commands.swift,
# Android ui/Commands.kt): a template may not take their names, or `/name` would mean two things.
RESERVED = frozenset(
    {
        "status",
        "dnd",
        "topic",
        "invite",
        "leave",
        "join",
        "dm",
        "mute",
        "unmute",
        "me",
        "shrug",
        "poll",
        "help",
        "日程",
    }
)
MAX_WORKSPACE = 100
MAX_PER_USER = 50


def clean_name(name: str) -> str:
    """1-20 letters (any script), digits, `_` or `-`: what follows the `/` of a command."""
    cleaned = unicodedata.normalize("NFC", name.strip())
    if (
        not cleaned
        or len(cleaned) > 20
        or any(not (unicodedata.category(ch)[0] in "LN" or ch in "_-") for ch in cleaned)
    ):
        raise bad_request("template_name_invalid", "Names are 1-20 letters, digits, _ or -")
    if cleaned.lower() in RESERVED:
        raise bad_request("template_name_reserved", "This name is a built-in command")
    return cleaned


def _clean_body(body: str) -> str:
    if not body.strip():
        raise bad_request("template_body_empty", "The template is empty")
    return body


async def list_for(db: AsyncSession, user: User) -> list[TemplateOut]:
    return [to_template_out(row) for row in await repo.list_for(db, user.id)]


def _check_can_edit(actor: User, row: MessageTemplate) -> None:
    if row.scope == "user" and row.owner_id != actor.id:
        # Someone else's own templates are not visible at all.
        raise not_found("template_not_found", "Template not found")
    if row.scope == "workspace" and not actor.is_admin:
        raise forbidden("admin_required", "Only an administrator edits the workspace's templates")


async def require_editable(
    db: AsyncSession, actor: User, template_id: uuid.UUID
) -> MessageTemplate:
    row = await repo.get(db, template_id)
    if row is None:
        raise not_found("template_not_found", "Template not found")
    _check_can_edit(actor, row)
    return row


async def create(db: AsyncSession, actor: User, data: TemplateCreate) -> TemplateOut:
    if data.scope == "workspace" and not actor.is_admin:
        raise forbidden("admin_required", "Only an administrator adds workspace templates")
    owner = None if data.scope == "workspace" else actor.id
    name = clean_name(data.name)
    body = _clean_body(data.body)
    limit = MAX_WORKSPACE if data.scope == "workspace" else MAX_PER_USER
    if await repo.count_in(db, data.scope, owner) >= limit:
        raise conflict("template_limit", f"At most {limit} templates")
    if await repo.name_taken(db, data.scope, owner, name):
        raise conflict("template_name_taken", "A template with this name already exists")
    position = (
        data.position
        if data.position is not None
        else await repo.next_position(db, data.scope, owner)
    )
    row = MessageTemplate(
        scope=data.scope,
        owner_id=owner,
        name=name,
        body=body,
        suggest_in=data.suggest_in,
        position=position,
    )
    db.add(row)
    await _flush(db)
    await _emit(db, row, deleted=False)
    await db.commit()
    return to_template_out(row)


async def update(
    db: AsyncSession, actor: User, template_id: uuid.UUID, data: TemplateUpdate
) -> TemplateOut:
    row = await require_editable(db, actor, template_id)
    if data.name is not None:
        name = clean_name(data.name)
        if await repo.name_taken(db, row.scope, row.owner_id, name, except_id=row.id):
            raise conflict("template_name_taken", "A template with this name already exists")
        row.name = name
    if data.body is not None:
        row.body = _clean_body(data.body)
    if data.suggest_in is not None:
        row.suggest_in = data.suggest_in
    if data.position is not None:
        row.position = data.position
    row.updated_at = utcnow()
    await _flush(db)
    await _emit(db, row, deleted=False)
    await db.commit()
    return to_template_out(row)


async def delete(db: AsyncSession, actor: User, template_id: uuid.UUID) -> None:
    row = await require_editable(db, actor, template_id)
    out = to_template_out(row)
    await db.delete(row)
    await db.flush()
    await _emit_out(db, out, deleted=True)
    await db.commit()


async def _flush(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError as exc:  # the unique name index, against a concurrent request
        await db.rollback()
        raise conflict("template_name_taken", "A template with this name already exists") from exc


async def _emit(db: AsyncSession, row: MessageTemplate, *, deleted: bool) -> None:
    await _emit_out(db, to_template_out(row), deleted=deleted)


async def _emit_out(db: AsyncSession, out: TemplateOut, *, deleted: bool) -> None:
    payload = TemplateUpdatedData(template=out, deleted=deleted).model_dump(mode="json")
    if out.scope == "workspace":
        await write_outbox(db, event_type=TEMPLATE_UPDATED, audience_type="all", payload=payload)
    else:
        await write_outbox(
            db,
            event_type=TEMPLATE_UPDATED,
            audience_type="user",
            audience_id=out.owner_id,
            payload=payload,
        )
