"""conversation_closes: DMs I closed (M141, 「会話を閉じる」)

Revision ID: 0102
Revises: 0101
Create Date: 2026-10-07

DATA_MODEL.md conversation_closes: personal like conversation_pins (no channel seq), only for DMs
and group DMs I belong to. `closed_seq` is the channel's last_seq at closing: the conversation is
closed while no timeline message has a higher seq (a new message reopens it without a write).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0102"
down_revision: str | None = "0101"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conversation_closes",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("channel_id", sa.Uuid(), sa.ForeignKey("channels.id"), primary_key=True),
        sa.Column("closed_seq", sa.BigInteger(), nullable=False),
        sa.Column(
            "closed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("conversation_closes")
