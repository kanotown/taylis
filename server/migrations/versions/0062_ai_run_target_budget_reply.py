"""AI runs keep their target, a budget reservation and the reply's own state (review v0.1.18)

Revision ID: 0062
Revises: 0061
Create Date: 2026-10-02

docs/AI.md §8 「レビュー v0.1.18 の修正」:

- `ai_runs.provider` (with `model`): the target is fixed when the run is created; the worker never
  switches it. Open runs from before get their bot's current model; finished ones the provider of
  the model they recorded.
- `ai_runs.reserved_usd`: the budget reserved while a run is open (settled to 0 when it ends).
- `ai_runs.reply_state` / `reply_attempts` / `reply_next_at`: a mention's reply is posted apart
  from getting it from the model, so a failed post is tried again without calling the model.
  NULL for summaries and for the mention runs that ended before this revision.
- `ai_mention_inbox`: a mention whose handling failed in the outbox relay, tried again by the AI
  worker (instead of being dropped after a log line).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0062"
down_revision: str | None = "0061"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("ai_runs", sa.Column("provider", sa.String(16), nullable=True))
    op.add_column(
        "ai_runs",
        sa.Column("reserved_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
    )
    op.add_column("ai_runs", sa.Column("reply_state", sa.String(8), nullable=True))
    op.add_column(
        "ai_runs",
        sa.Column("reply_attempts", sa.SmallInteger(), nullable=False, server_default="0"),
    )
    op.add_column("ai_runs", sa.Column("reply_next_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        "reply_state_values", "ai_runs", "reply_state IN ('pending', 'posted', 'failed')"
    )
    op.create_index(
        "ai_runs_reply_due_idx",
        "ai_runs",
        ["reply_next_at"],
        postgresql_where=sa.text("reply_state = 'pending'"),
    )
    op.execute(
        "UPDATE ai_runs r SET model = a.model FROM ai_agents a "
        "WHERE r.agent_id = a.id AND r.model IS NULL AND r.status IN ('pending', 'running')"
    )
    op.execute(
        "UPDATE ai_runs SET provider = CASE WHEN model LIKE 'gpt-%' THEN 'openai' "
        "ELSE 'anthropic' END WHERE model IS NOT NULL"
    )
    op.create_table(
        "ai_mention_inbox",
        sa.Column(
            "message_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("attempts", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ai_mention_inbox_due_idx", "ai_mention_inbox", ["next_attempt_at"])


def downgrade() -> None:
    op.drop_index("ai_mention_inbox_due_idx", table_name="ai_mention_inbox")
    op.drop_table("ai_mention_inbox")
    op.drop_index("ai_runs_reply_due_idx", table_name="ai_runs")
    op.drop_constraint("reply_state_values", "ai_runs", type_="check")
    op.drop_column("ai_runs", "reply_next_at")
    op.drop_column("ai_runs", "reply_attempts")
    op.drop_column("ai_runs", "reply_state")
    op.drop_column("ai_runs", "reserved_usd")
    op.drop_column("ai_runs", "provider")
