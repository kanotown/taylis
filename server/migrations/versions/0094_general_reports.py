"""Reports of a person and general reports / feedback in message_reports (M119)

Revision ID: 0094
Revises: 0093
Create Date: 2026-10-06

docs/MODERATION.md §3.1: Google Play's Child Safety Standards ask for an in-app way to report
without leaving the app, so a report no longer needs a message. `kind` says what was reported
(`message` as before, `user` a person, `general` anything else or feedback); for the last two
`message_id` and `channel_id` are NULL (and `reported_user_id` for `general`). `reason` gains
`child_safety` (all kinds) and `feedback` (not for a message). `client_report_id` makes a retried
POST /reports return the first report. Existing rows are message reports.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0094"
down_revision: str | None = "0093"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REASONS_NEW = (
    "reason IN ('spam', 'harassment', 'inappropriate', 'child_safety', 'feedback', 'other')"
)
REASONS_OLD = "reason IN ('spam', 'harassment', 'inappropriate', 'other')"
KIND_CHECK = (
    "(kind = 'message' AND message_id IS NOT NULL AND channel_id IS NOT NULL"
    " AND reported_user_id IS NOT NULL AND reason <> 'feedback')"
    " OR (kind = 'user' AND message_id IS NULL AND channel_id IS NULL"
    " AND reported_user_id IS NOT NULL)"
    " OR (kind = 'general' AND message_id IS NULL AND channel_id IS NULL"
    " AND reported_user_id IS NULL)"
)


def upgrade() -> None:
    op.add_column(
        "message_reports",
        sa.Column("kind", sa.String(16), nullable=False, server_default="message"),
    )
    op.add_column("message_reports", sa.Column("client_report_id", sa.Uuid(), nullable=True))
    for column in ("message_id", "channel_id", "reported_user_id"):
        op.alter_column("message_reports", column, nullable=True)
    op.drop_constraint("message_reports_reason_check", "message_reports", type_="check")
    op.create_check_constraint("message_reports_reason_check", "message_reports", REASONS_NEW)
    op.create_check_constraint("message_reports_kind_check", "message_reports", KIND_CHECK)
    op.create_unique_constraint(
        "message_reports_client_id", "message_reports", ["reporter_id", "client_report_id"]
    )


def downgrade() -> None:
    # The reports without a message cannot be kept in the old shape.
    op.execute("DELETE FROM message_reports WHERE kind <> 'message'")
    op.execute("UPDATE message_reports SET reason = 'other' WHERE reason = 'child_safety'")
    op.drop_constraint("message_reports_client_id", "message_reports", type_="unique")
    op.drop_constraint("message_reports_kind_check", "message_reports", type_="check")
    op.drop_constraint("message_reports_reason_check", "message_reports", type_="check")
    op.create_check_constraint("message_reports_reason_check", "message_reports", REASONS_OLD)
    for column in ("message_id", "channel_id", "reported_user_id"):
        op.alter_column("message_reports", column, nullable=False)
    op.drop_column("message_reports", "client_report_id")
    op.drop_column("message_reports", "kind")
