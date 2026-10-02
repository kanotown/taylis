"""AI runs of kind "ask": questions about past conversations (M70)

Revision ID: 0064
Revises: 0062
Create Date: 2026-10-02

docs/AI.md §13 「AI に聞く」:

- `ai_runs.kind` may be `ask`.
- `ai_runs.channel_id` may be NULL: a question not narrowed to one conversation has none.
- `ai_runs.question`: the question as typed; `ai_runs.sources` (jsonb): the numbered messages
  sent with it, so the answer's [n] can be linked to them.

Written in parallel with the calendar's 0063: when both are on main, this revision follows 0063
(`down_revision` is set to it at the merge).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0064"
down_revision: str | None = "0062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("ai_runs", sa.Column("question", sa.Text(), nullable=True))
    op.add_column(
        "ai_runs", sa.Column("sources", postgresql.JSONB(astext_type=sa.Text()), nullable=True)
    )
    op.alter_column("ai_runs", "channel_id", existing_type=postgresql.UUID(), nullable=True)
    op.drop_constraint("kind_values", "ai_runs", type_="check")
    op.create_check_constraint("kind_values", "ai_runs", "kind IN ('mention', 'summary', 'ask')")


def downgrade() -> None:
    # The questions go: the older schema has no place for them.
    op.execute("DELETE FROM ai_runs WHERE kind = 'ask'")
    op.drop_constraint("kind_values", "ai_runs", type_="check")
    op.create_check_constraint("kind_values", "ai_runs", "kind IN ('mention', 'summary')")
    op.alter_column("ai_runs", "channel_id", existing_type=postgresql.UUID(), nullable=False)
    op.drop_column("ai_runs", "sources")
    op.drop_column("ai_runs", "question")
