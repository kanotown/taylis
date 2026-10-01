"""M59: recurring_posts and collections (RECURRING.md §2, L6)

Revision ID: 0054
Revises: 0053
Create Date: 2026-10-01

- recurring_posts: a channel's recurring post. Its own bot user (role bot, a member of the
  channel) posts `body` after the template placeholders are replaced, on `schedule` (weekly on
  some weekdays, or monthly on a day clamped to the month's end) at a local time in `tz`.
  `next_run_at` is computed from them; the worker posts rows whose time has come (enabled, not
  deleted) and moves it on in the same transaction. `collect` (optional) says whom to collect
  replies from and by when.
- collections: one row per collecting post (the message is the key): the targets fixed when it was
  posted, the due time, and when the nudges went out (once). Submissions are counted from the
  thread's live replies, not stored.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0054"
down_revision: str | None = "0053"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    op.create_table(
        "recurring_posts",
        sa.Column("id", uid, primary_key=True),
        sa.Column("channel_id", uid, sa.ForeignKey("channels.id"), nullable=False),
        sa.Column("created_by", uid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("bot_user_id", uid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("schedule", postgresql.JSONB(), nullable=False),
        sa.Column("tz", sa.String(64), nullable=False),
        sa.Column("collect", postgresql.JSONB(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 40", name="name_length"),
        sa.CheckConstraint("char_length(body) BETWEEN 1 AND 4000", name="body_length"),
    )
    op.execute(
        "CREATE INDEX recurring_posts_due_idx ON recurring_posts (next_run_at) "
        "WHERE enabled AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE INDEX recurring_posts_channel_idx ON recurring_posts (channel_id) "
        "WHERE deleted_at IS NULL"
    )

    op.create_table(
        "collections",
        sa.Column("message_id", uid, sa.ForeignKey("messages.id"), primary_key=True),
        sa.Column("recurring_post_id", uid, sa.ForeignKey("recurring_posts.id"), nullable=False),
        sa.Column("channel_id", uid, sa.ForeignKey("channels.id"), nullable=False),
        sa.Column(
            "target_user_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'::uuid[]"),
        ),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reminded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.execute("CREATE INDEX collections_due_idx ON collections (due_at) WHERE reminded_at IS NULL")


def downgrade() -> None:
    op.drop_table("collections")
    op.drop_table("recurring_posts")
