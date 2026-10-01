"""M65: ai_agents and ai_runs (docs/AI.md §2-§3)

Revision ID: 0057
Revises: 0056
Create Date: 2026-10-02

- ai_agents: an AI bot. Its `bot` user (role bot) answers mentions with the character, model and
  effort set here; `allow_private` lets it into private channels and DMs. Deleted logically.
- ai_runs: one call to the model, a mention's reply or a summary: what was sent (`input`, dropped
  after 90 days), what came back, the tokens and the cost. One run per (kind, source message), so
  an outbox event processed twice makes one run. The worker picks open runs (pending, or running
  with an expired lease) by created_at.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0057"
down_revision: str | None = "0056"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    uid = postgresql.UUID(as_uuid=True)
    now = sa.func.now()
    op.create_table(
        "ai_agents",
        sa.Column("id", uid, primary_key=True),
        sa.Column("bot_user_id", uid, sa.ForeignKey("users.id"), nullable=False, unique=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("character", sa.Text(), nullable=False, server_default=""),
        sa.Column("model", sa.String(32), nullable=False),
        sa.Column("effort", sa.String(8), nullable=False, server_default="medium"),
        sa.Column("allow_private", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_by", uid, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(character) <= 4000", name="character_len"),
        sa.CheckConstraint(
            "model IN ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5')",
            name="model_values",
        ),
        sa.CheckConstraint("effort IN ('low', 'medium', 'high')", name="effort_values"),
    )
    op.create_table(
        "ai_runs",
        sa.Column("id", uid, primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("agent_id", uid, sa.ForeignKey("ai_agents.id"), nullable=True),
        sa.Column("requester_id", uid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("channel_id", uid, sa.ForeignKey("channels.id"), nullable=False),
        sa.Column("thread_id", uid, sa.ForeignKey("messages.id"), nullable=True),
        sa.Column("source_message_id", uid, sa.ForeignKey("messages.id"), nullable=True),
        sa.Column("scope", sa.String(16), nullable=True),
        sa.Column("days", sa.SmallInteger(), nullable=True),
        sa.Column("input", sa.Text(), nullable=True),
        sa.Column("output", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("omitted_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempts", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cache_read_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cache_write_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("model", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=now),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('mention', 'summary')", name="kind_values"),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'done', 'failed')", name="status_values"
        ),
    )
    op.execute(
        "CREATE UNIQUE INDEX ai_runs_source_uniq ON ai_runs (kind, source_message_id) "
        "WHERE source_message_id IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX ai_runs_open_idx ON ai_runs (created_at) "
        "WHERE status IN ('pending', 'running')"
    )
    op.create_index("ai_runs_created_idx", "ai_runs", ["created_at"])
    op.execute("CREATE INDEX ai_runs_requester_idx ON ai_runs (requester_id, created_at DESC)")
    op.execute("CREATE INDEX ai_runs_input_idx ON ai_runs (created_at) WHERE input IS NOT NULL")


def downgrade() -> None:
    op.drop_table("ai_runs")
    op.drop_table("ai_agents")
