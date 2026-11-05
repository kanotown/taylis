"""Messages remember the link previews their sender removed (messages.hidden_previews)

Revision ID: 0131
Revises: 0130
Create Date: 2026-11-05

M185 (docs/LINK_PREVIEWS.md §4): the sender (or an administrator) removes a link's card from a
message for everyone, Slack style: an external link's Open Graph card (M11g) or a message link's
card. The keys are the links' normalized URLs (docs/LINK_PREVIEWS.md §4.1).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0131"
down_revision: str | None = "0130"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "hidden_previews",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
    )


def downgrade() -> None:
    # An older server shows every card again (the behaviour before this).
    op.drop_column("messages", "hidden_previews")
