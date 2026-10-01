"""AI bots may use OpenAI models (docs/AI.md §12)

Revision ID: 0059
Revises: 0058
Create Date: 2026-10-02

ai_agents.model also accepts gpt-6.1-sol and gpt-6-luna. The provider (Anthropic or OpenAI) is
derived from the model in code, so no new column. Downgrade moves OpenAI bots back to the default
model (claude-opus-5-5) before the old check returns.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0059"
down_revision: str | None = "0058"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD = "model IN ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5')"
NEW = (
    "model IN ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', "
    "'gpt-6.1-sol', 'gpt-6-luna')"
)


def upgrade() -> None:
    op.drop_constraint("model_values", "ai_agents", type_="check")
    op.create_check_constraint("model_values", "ai_agents", NEW)


def downgrade() -> None:
    op.drop_constraint("model_values", "ai_agents", type_="check")
    op.execute(
        "UPDATE ai_agents SET model = 'claude-opus-5-5' "
        "WHERE model NOT IN ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5')"
    )
    op.create_check_constraint("model_values", "ai_agents", OLD)
