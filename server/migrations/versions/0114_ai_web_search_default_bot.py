"""AI bots: web search, the default bot, newer models (docs/AI.md §14)

Revision ID: 0114
Revises: 0113
Create Date: 2026-10-10

- ai_agents.web_search (default false): the bot's mention replies may use the provider's web
  search tool (Anthropic web_search, OpenAI Responses web_search).
- ai_agents.is_default (default false, at most one bot): the bot summaries and 「AI に聞く」 use
  when the conversation has no bot of its own (before: the oldest usable bot).
- ai_runs.web_search (fixed when the run is made) and ai_runs.web_search_requests (searches the
  provider ran, priced apart in cost_usd).
- ai_agents.model also accepts claude-fable-5-1 and gpt-6-astra. Downgrade moves those bots back
  to claude-opus-5-5 / gpt-6.1-sol before the old check returns.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0114"
down_revision: str | None = "0113"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD = (
    "model IN ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', "
    "'gpt-6.1-sol', 'gpt-6-luna')"
)
NEW = (
    "model IN ('claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', "
    "'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna')"
)


def upgrade() -> None:
    op.drop_constraint("model_values", "ai_agents", type_="check")
    op.create_check_constraint("model_values", "ai_agents", NEW)
    op.add_column(
        "ai_agents",
        sa.Column("web_search", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "ai_agents",
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_index(
        "ai_agents_default_uniq",
        "ai_agents",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )
    op.add_column(
        "ai_runs",
        sa.Column("web_search", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "ai_runs",
        sa.Column("web_search_requests", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("ai_runs", "web_search_requests")
    op.drop_column("ai_runs", "web_search")
    op.drop_index("ai_agents_default_uniq", table_name="ai_agents")
    op.drop_column("ai_agents", "is_default")
    op.drop_column("ai_agents", "web_search")
    op.drop_constraint("model_values", "ai_agents", type_="check")
    op.execute("UPDATE ai_agents SET model = 'claude-opus-5-5' WHERE model = 'claude-fable-5-1'")
    op.execute("UPDATE ai_agents SET model = 'gpt-6.1-sol' WHERE model = 'gpt-6-astra'")
    op.create_check_constraint("model_values", "ai_agents", OLD)
