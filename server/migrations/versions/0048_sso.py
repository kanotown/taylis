"""M48: Google sign-in (docs/SSO.md §5)

Revision ID: 0048
Revises: 0047
Create Date: 2026-09-30

- user_identities: which external account (provider, subject) signs in as which user.
- sso_requests: a started sign-in (state, nonce, PKCE verifier for Google, the app's challenge),
  10 minutes, single use.
- sso_tickets: the one-time ticket the app exchanges for tokens (SHA-256 only), 2 minutes.
- users.password_hash becomes nullable: an account made by Google sign-in has no password.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0048"
down_revision: str | None = "0047"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("users", "password_hash", existing_type=sa.Text(), nullable=True)
    op.create_table(
        "user_identities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("subject", sa.String(255), nullable=False),
        sa.Column("email", postgresql.CITEXT(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "user_identities_provider_subject_uniq",
        "user_identities",
        ["provider", "subject"],
        unique=True,
    )
    op.create_index("user_identities_user_idx", "user_identities", ["user_id"])
    op.create_table(
        "sso_requests",
        sa.Column("state", sa.Text(), primary_key=True),
        sa.Column("nonce", sa.Text(), nullable=False),
        sa.Column("code_verifier", sa.Text(), nullable=False),
        sa.Column("challenge", sa.Text(), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("sso_requests_expires_idx", "sso_requests", ["expires_at"])
    op.create_table(
        "sso_tickets",
        sa.Column("ticket_hash", sa.LargeBinary(), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("challenge", sa.Text(), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("sso_tickets_expires_idx", "sso_tickets", ["expires_at"])


def downgrade() -> None:
    op.drop_table("sso_tickets")
    op.drop_table("sso_requests")
    op.drop_table("user_identities")
    # "!" is no argon2 hash: such accounts still cannot log in with a password.
    op.execute("UPDATE users SET password_hash = '!' WHERE password_hash IS NULL")
    op.alter_column("users", "password_hash", existing_type=sa.Text(), nullable=False)
