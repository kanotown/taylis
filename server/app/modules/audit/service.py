"""Audit trail: a leaf module other services call inside their transactions."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog


async def record_in_tx(
    db: AsyncSession,
    *,
    actor_id: uuid.UUID | None,
    action: str,
    target_type: str,
    target_id: uuid.UUID | str | None,
    details: dict[str, Any] | None = None,
) -> AuditLog:
    """Never log secrets (passwords, tokens); details are identifiers and before/after values."""
    row = AuditLog(
        actor_id=actor_id,
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
