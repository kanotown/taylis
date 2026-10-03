"""Workflows: forms that post a message (M94, docs/WORKFLOWS.md).

A workflow belongs to its target channel. Whoever may post there fills its form; the server
checks the values, renders the template and posts the result **as the submitter** through the
ordinary message path (create_message), so seq, outbox, mentions, unread, pushes, the posting
policy, search and idempotency (client_msg_id) need nothing special. The message remembers the
workflow (`workflow_id`, `workflow_name`) for its 「⚡ name」 label.

The target channel's owners and the administrators who can read it manage its workflows. Guests
never manage. Lists are read when the menu opens (no events), like recurring posts.
"""

import uuid
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.messages import repository as message_repo
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.messages.schemas import MAX_BODY_LENGTH, MessageCreate
from app.modules.templates.service import RESERVED as TEMPLATE_RESERVED
from app.modules.users import service as users
from app.modules.users.models import User
from app.modules.workflows import repository as repo
from app.modules.workflows.models import Workflow
from app.modules.workflows.render import ValuesError, clean_values, render, unknown_placeholders
from app.modules.workflows.schemas import (
    RunBlocked,
    WorkflowCreate,
    WorkflowOut,
    WorkflowSubmit,
    WorkflowUpdate,
    fields_json,
    to_workflow_out,
)

# Workflows in the workspace at most (SECURITY.md §5).
MAX_WORKFLOWS = 200
# `/name` opens a workflow: the clients' built-in commands keep theirs, and `/wf name` is ours.
RESERVED = TEMPLATE_RESERVED | {"wf"}


def _not_found() -> AppError:
    return not_found("workflow_not_found", "Workflow not found")


# --- access -----------------------------------------------------------------------------------


async def _readable(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> Channel | None:
    try:
        return await channels.require_readable(db, actor, channel_id)
    except AppError:
        return None


async def _can_manage(db: AsyncSession, actor: User, channel: Channel) -> bool:
    """The channel's owners, and the administrators who can read it (WORKFLOWS.md §5)."""
    if actor.is_guest or channel.is_dm:
        return False
    membership = await channels.membership_of(db, actor.id, channel.id)
    if membership is not None and membership.role == "owner":
        return True
    return actor.is_admin and await _readable(db, actor, channel.id) is not None


async def _run_blocked(db: AsyncSession, actor: User, row: Workflow) -> RunBlocked | None:
    """Why the actor cannot submit it now (None: they can). The same checks as posting."""
    if not row.enabled:
        return "disabled"
    channel = await channels.find_channel(db, row.channel_id)
    if channel is None or channel.is_archived:
        return "archived"
    membership = await channels.membership_of(db, actor.id, channel.id)
    if membership is None:
        return "not_a_member"
    if channel.posting_policy == "owners" and not actor.is_admin and membership.role != "owner":
        return "posting_restricted"
    return None


async def _out(db: AsyncSession, actor: User, row: Workflow, channel: Channel) -> WorkflowOut:
    return to_workflow_out(
        row,
        can_manage=await _can_manage(db, actor, channel),
        run_blocked=await _run_blocked(db, actor, row),
    )


async def _target(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> Channel:
    """A target the actor may manage workflows in."""
    channels.require_not_guest(actor)
    channel = await _readable(db, actor, channel_id)
    if channel is None:
        raise not_found("channel_not_found", "Channel not found")
    if channel.is_dm:
        raise bad_request("workflow_channel_unsupported", "Workflows post to channels, not DMs")
    if not await _can_manage(db, actor, channel):
        raise forbidden(
            "workflow_manage_restricted",
            "Only the channel's owners and administrators manage its workflows",
        )
    channels.require_writable(channel)
    return channel


async def _offered(
    db: AsyncSession, actor: User, target: Channel, channel_ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    """The target first, then the other channels the menu offers it in: channels (not DMs) the
    actor belongs to (an administrator: can read)."""
    result = [target.id]
    for channel_id in channel_ids:
        if channel_id in result:
            continue
        channel = await channels.find_channel(db, channel_id)
        member = await channels.membership_of(db, actor.id, channel_id)
        readable = member is not None or (
            actor.is_admin and await _readable(db, actor, channel_id) is not None
        )
        if channel is None or not readable:
            raise not_found("channel_not_found", "Channel not found")
        if channel.is_dm:
            raise bad_request(
                "workflow_channel_unsupported", "Workflows are offered in channels, not DMs"
            )
        result.append(channel_id)
    return result


async def _managed_row(db: AsyncSession, actor: User, workflow_id: uuid.UUID) -> Workflow:
    row = await repo.get(db, workflow_id, for_update=True)
    if row is None:
        raise _not_found()
    channel = await _readable(db, actor, row.channel_id)
    if channel is None:  # someone who cannot read the target does not learn it exists
        raise _not_found()
    if not await _can_manage(db, actor, channel):
        raise forbidden(
            "workflow_manage_restricted",
            "Only the channel's owners and administrators manage its workflows",
        )
    return row


def _check_name(name: str) -> None:
    if name.lower() in RESERVED:
        raise bad_request("workflow_name_reserved", "This name is a built-in command")


async def _check_name_free(db: AsyncSession, name: str, except_id: uuid.UUID | None = None) -> None:
    _check_name(name)
    if await repo.name_taken(db, name, except_id=except_id):
        raise conflict("workflow_name_taken", "A workflow with this name already exists")


def _check_template(template: str, fields: list[dict[str, Any]]) -> None:
    unknown = unknown_placeholders(template, [field["key"] for field in fields])
    if unknown:
        raise bad_request(
            "workflow_template_invalid",
            "The template names fields that do not exist",
            details={"unknown": unknown},
        )


async def _flush(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError as exc:  # the unique name index, against a concurrent request
        await db.rollback()
        raise conflict("workflow_name_taken", "A workflow with this name already exists") from exc


# --- reading ----------------------------------------------------------------------------------


async def list_manageable(db: AsyncSession, actor: User) -> list[WorkflowOut]:
    """The admin screen's list: every workflow the actor may change, by name."""
    if actor.is_guest:
        return []
    out: list[WorkflowOut] = []
    for row in await repo.list_all(db):
        channel = await channels.find_channel(db, row.channel_id)
        if channel is not None and await _can_manage(db, actor, channel):
            out.append(await _out(db, actor, row, channel))
    return out


async def list_offered(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> list[WorkflowOut]:
    """The channel's menu and `/` candidates: the workflows offered there whose target the
    actor can read (paused ones too, marked)."""
    await channels.require_readable(db, actor, channel_id)
    out: list[WorkflowOut] = []
    for row in await repo.list_offered_in(db, channel_id):
        channel = await _readable(db, actor, row.channel_id)
        if channel is not None:
            out.append(await _out(db, actor, row, channel))
    return out


async def get(db: AsyncSession, actor: User, workflow_id: uuid.UUID) -> WorkflowOut:
    row = await repo.get(db, workflow_id)
    if row is None:
        raise _not_found()
    channel = await _readable(db, actor, row.channel_id)
    if channel is None:
        raise _not_found()
    return await _out(db, actor, row, channel)


# --- managing ---------------------------------------------------------------------------------


async def create(db: AsyncSession, actor: User, data: WorkflowCreate) -> WorkflowOut:
    channel = await _target(db, actor, data.channel_id)
    if await repo.count(db) >= MAX_WORKFLOWS:
        raise conflict("too_many_workflows", f"At most {MAX_WORKFLOWS} workflows")
    await _check_name_free(db, data.name)
    fields = fields_json(data.fields)
    _check_template(data.template, fields)
    now = utcnow()
    row = Workflow(
        name=data.name,
        emoji=data.emoji,
        description=data.description,
        channel_id=channel.id,
        offered_channel_ids=await _offered(db, actor, channel, data.offered_channel_ids),
        fields=fields,
        template=data.template,
        enabled=data.enabled,
        created_by=actor.id,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await _flush(db)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="workflow.created",
        target_type="workflow",
        target_id=row.id,
        details={"name": row.name, "channel_id": str(channel.id)},
    )
    await db.commit()
    return await _out(db, actor, row, channel)


async def update(
    db: AsyncSession, actor: User, workflow_id: uuid.UUID, data: WorkflowUpdate
) -> WorkflowOut:
    row = await _managed_row(db, actor, workflow_id)
    fields_set = data.model_fields_set
    # A new target must be one the actor manages too; either way it must not be archived.
    channel = await _target(db, actor, data.channel_id or row.channel_id)
    if data.name is not None and data.name != row.name:
        await _check_name_free(db, data.name, except_id=row.id)
        row.name = data.name
    if "emoji" in fields_set:
        row.emoji = data.emoji
    if data.description is not None:
        row.description = data.description
    fields = fields_json(data.fields) if data.fields is not None else list(row.fields)
    template = data.template if data.template is not None else row.template
    if data.fields is not None or data.template is not None:
        _check_template(template, fields)
        row.fields = fields
        row.template = template
    if data.channel_id is not None or data.offered_channel_ids is not None:
        wanted = (
            data.offered_channel_ids
            if data.offered_channel_ids is not None
            else [cid for cid in row.offered_channel_ids if cid != row.channel_id]
        )
        row.channel_id = channel.id
        row.offered_channel_ids = await _offered(db, actor, channel, wanted)
    if data.enabled is not None:
        row.enabled = data.enabled
    row.updated_at = utcnow()
    await _flush(db)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="workflow.updated",
        target_type="workflow",
        target_id=row.id,
        details={"fields": sorted(fields_set)},
    )
    await db.commit()
    return await _out(db, actor, row, channel)


async def delete(db: AsyncSession, actor: User, workflow_id: uuid.UUID) -> None:
    """Gone for good; the messages it posted keep their label (its name then)."""
    row = await _managed_row(db, actor, workflow_id)
    now = utcnow()
    row.deleted_at = now
    row.enabled = False
    row.updated_at = now
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="workflow.deleted",
        target_type="workflow",
        target_id=row.id,
        details={"name": row.name},
    )
    await db.commit()


# --- submitting -------------------------------------------------------------------------------


async def _check_people(
    db: AsyncSession, fields: list[dict[str, Any]], cleaned: dict[str, Any]
) -> None:
    """People chosen in user fields must be active people (not bots)."""
    wanted = {
        uuid.UUID(user_id)
        for field in fields
        if field["type"] == "user"
        for user_id in cleaned.get(field["key"], [])
    }
    if not wanted:
        return
    found = await users.get_users(db, list(wanted))
    ok = {uid for uid, user in found.items() if user.is_active and user.role != "bot"}
    errors = {
        field["key"]: "user_not_found"
        for field in fields
        if field["type"] == "user"
        and any(uuid.UUID(uid) not in ok for uid in cleaned.get(field["key"], []))
    }
    if errors:
        raise ValuesError(errors)


def _values_invalid(fields: dict[str, str], message: str = "Some values are invalid") -> AppError:
    return bad_request("workflow_values_invalid", message, details={"fields": fields})


async def submit(
    db: AsyncSession, actor: User, workflow_id: uuid.UUID, data: WorkflowSubmit
) -> tuple[Message, bool]:
    """Posts the rendered form as the actor. A retry with the same client_msg_id returns the
    message already posted (also if the workflow changed or was paused since)."""
    existing = await message_repo.get_by_client_msg_id(db, actor.id, data.client_msg_id)
    if existing is not None:
        if existing.workflow_id != workflow_id:
            raise conflict(
                "idempotency_conflict", "client_msg_id was already used for another message"
            )
        return existing, False
    row = await repo.get(db, workflow_id)
    if row is None or await _readable(db, actor, row.channel_id) is None:
        raise _not_found()
    if not row.enabled:
        raise conflict("workflow_disabled", "This workflow is paused")
    fields = list(row.fields)
    try:
        cleaned = clean_values(fields, data.values)
        await _check_people(db, fields, cleaned)
    except ValuesError as exc:
        raise _values_invalid(exc.fields) from exc
    body = render(row.template, fields, cleaned)
    if not body.strip():
        raise _values_invalid({}, "The message would be empty")
    if len(body) > MAX_BODY_LENGTH:
        raise _values_invalid({}, f"The message would be longer than {MAX_BODY_LENGTH}")
    return await messages.create_message(
        db,
        actor,
        row.channel_id,
        MessageCreate(client_msg_id=data.client_msg_id, body=body),
        workflow=(row.id, row.name),
    )
