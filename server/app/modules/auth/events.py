"""Events emitted by the auth module."""

from pydantic import BaseModel

SESSION_REVOKED = "session.revoked"


class SessionRevokedData(BaseModel):
    reason: str
