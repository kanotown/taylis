"""devices.base_url: the server address a phone reaches this server by (push avatars)

Revision ID: 0088
Revises: 0087
Create Date: 2026-10-06

PUSH_NOTIFICATIONS.md §16: an iOS message push carries an absolute, signed URL of the sender's
picture for the Notification Service Extension, which has no session and does not know which
server it belongs to. The address is the one the device itself used for PUT /devices/current
(PUBLIC_BASE_URL when set, else the request's, through the reverse proxy's forwarded headers).
NULL (every existing row, until the app next registers) = the push carries no picture URL.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0088"
down_revision: str | None = "0087"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("base_url", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "base_url")
