"""Audit trail: a leaf module other services call inside their transactions."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog
from app.modules.users.models import User


async def record_in_tx(
    db: AsyncSession,
    *,
    actor_id: uuid.UUID | None,
    action: str,
    target_type: str,
    target_id: uuid.UUID | str | None,
    details: dict[str, Any] | None = None,
) -> AuditLog:
    """Never log secrets (passwords, tokens); details are identifiers and before/after values.
    The actor's role is written too (docs/ROLES.md §6): a manager's use of a right that used to be
    the administrators' is told apart from an administrator's."""
    actor = await db.get(User, actor_id) if actor_id is not None else None
    row = AuditLog(
        actor_id=actor_id,
        actor_role=actor.role if actor is not None else None,
        action=action,
        target_type=target_type,
        target_id=None if target_id is None else str(target_id),
        details=details or {},
    )
    db.add(row)
    await db.flush()
    return row


async def list_recent(db: AsyncSession, limit: int = 100) -> list[AuditLog]:
    stmt = select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)
    return list((await db.execute(stmt)).scalars().all())
