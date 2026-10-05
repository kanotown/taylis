"""M115: users.locale and devices.locale, the UI language (docs/I18N.md)

Revision ID: 0085
Revises: 0084
Create Date: 2026-10-05

- users.locale: the UI language the person chose, "ja" / "en" / "zh-Hans"; NULL (every
  existing row) = follow each device's language. Set through PATCH /users/me {locale}.
- devices.locale: the language the app on this device last asked for (its Accept-Language,
  normalised), kept at login, token refresh and device update; a push to the device uses it
  when users.locale is NULL. NULL = not known yet (ja).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0085"
down_revision: str | None = "0084"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("locale", sa.String(16), nullable=True))
    op.add_column("devices", sa.Column("locale", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "locale")
    op.drop_column("users", "locale")
