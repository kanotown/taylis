"""sidebar: a starred conversation is not also in one of my sections

Revision ID: 0096
Revises: 0095
Create Date: 2026-10-07

DATA_MODEL.md sidebar_sections 「1 つの会話は 1 か所」: a conversation sits in お気に入り or in one
of my sections, never both. Until now both rows could exist and the clients showed the favorite
(so putting a starred conversation in a section seemed to do nothing). The section rows of starred
conversations go: the sidebar looks as it did, and the server keeps the rule from now on.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0096"
down_revision: str | None = "0095"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        DELETE FROM sidebar_section_channels AS s
        USING channel_favorites AS f
        WHERE f.user_id = s.user_id AND f.channel_id = s.channel_id
        """
    )


def downgrade() -> None:
    pass  # the removed rows were hidden behind the favorite; nothing to put back
