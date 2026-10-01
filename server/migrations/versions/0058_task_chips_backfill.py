"""M64 follow-up: devices learn the task chips of messages they already hold (review v0.1.15 #12)

Revision ID: 0058
Revises: 0057
Create Date: 2026-10-02

MessageOut.tasks (M63) also lists shared tasks made before it existed, but a device that had synced
those messages never hears of them: the rows did not change. As in 0049, each channel with such a
message takes one new seq and those messages move their updated_seq to it, so the delta brings
them again with their chips. Personal tasks show no chip and are left out.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0058"
down_revision: str | None = "0057"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHIPPED = """
    SELECT DISTINCT t.source_message_id AS id
    FROM tasks AS t JOIN messages AS m ON m.id = t.source_message_id
    WHERE t.deleted_at IS NULL AND t.channel_id = t.source_channel_id AND m.deleted_at IS NULL
"""


def upgrade() -> None:
    op.execute(
        f"""
        WITH chipped AS ({CHIPPED}),
        bumped AS (
            UPDATE channels AS c SET last_seq = c.last_seq + 1
            WHERE c.id IN (
                SELECT m.channel_id FROM messages AS m WHERE m.id IN (SELECT id FROM chipped)
            )
            RETURNING c.id, c.last_seq
        )
        UPDATE messages AS m SET updated_seq = b.last_seq
        FROM bumped AS b
        WHERE m.channel_id = b.id AND m.id IN (SELECT id FROM chipped)
        """
    )


def downgrade() -> None:
    pass  # a seq once handed out stays; the rows are only re-sent
