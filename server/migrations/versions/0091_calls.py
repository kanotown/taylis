"""Calls by meeting link: the workspace's meeting service and a call message's link (M117)

Revision ID: 0091
Revises: 0090
Create Date: 2026-10-06

docs/CALLS.md. `workspace_settings.meeting_base_url`: where a call's room is made (the room name is
appended); the default is the public Jitsi server, NULL = calls are off. `messages.call_url`: the
room of a message that started a call (POST /channels/{id}/calls); NULL on every other message.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0091"
down_revision: str | None = "0090"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "workspace_settings",
        sa.Column(
            "meeting_base_url", sa.Text(), nullable=True, server_default="https://meet.jit.si/"
        ),
    )
    op.add_column("messages", sa.Column("call_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "call_url")
    op.drop_column("workspace_settings", "meeting_base_url")
