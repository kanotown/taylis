"""users.bot_kind = 'ai' for the AI bots' users

Revision ID: 0093
Revises: 0092
Create Date: 2026-10-06

docs/AI.md §2.1: clients tell a conversational AI bot (one of `ai_agents`, it answers mentions)
from the other bots by `UserPublic.bot_kind` — the @-mention suggestions keep people and AI bots
only. Every AI bot's user, deleted ones too, gets 'ai'; `updated_at` moves so that clients' caches
see the change.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0093"
down_revision: str | None = "0092"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BACKFILL = """
    UPDATE users SET bot_kind = 'ai', updated_at = now()
    WHERE role = 'bot' AND bot_kind IS DISTINCT FROM 'ai'
      AND id IN (SELECT bot_user_id FROM ai_agents)
"""


def upgrade() -> None:
    op.execute(BACKFILL)


def downgrade() -> None:
    op.execute("UPDATE users SET bot_kind = NULL, updated_at = now() WHERE bot_kind = 'ai'")
