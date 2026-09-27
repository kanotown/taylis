"""private keyword hits: messages.keyword_user_ids, out of mentioned_user_ids

Revision ID: 0035
Revises: 0034
Create Date: 2026-09-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUIDS = postgresql.ARRAY(sa.Uuid())


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "keyword_user_ids", UUIDS, nullable=False, server_default=sa.text("'{}'::uuid[]")
        ),
    )
    # Keyword hits (M12g) used to sit in mentioned_user_ids, which every member receives: move the
    # ids that are not a mention by name (<@id> in the body) and match that user's keywords.
    bind = op.get_bind()
    keywords: dict[object, list[str]] = {}
    for user_id, words in bind.execute(
        sa.text("SELECT id, notify_keywords FROM users WHERE cardinality(notify_keywords) > 0")
    ):
        keywords[user_id] = [w.lower() for w in words or [] if w]
    if not keywords:
        return
    rows = bind.execute(
        sa.text(
            "SELECT id, body, mentioned_user_ids FROM messages WHERE mentioned_user_ids && :ids"
        ).bindparams(sa.bindparam("ids", type_=UUIDS)),
        {"ids": list(keywords)},
    ).all()
    update = sa.text(
        "UPDATE messages SET mentioned_user_ids = :mentioned, keyword_user_ids = :hits "
        "WHERE id = :id"
    ).bindparams(sa.bindparam("mentioned", type_=UUIDS), sa.bindparam("hits", type_=UUIDS))
    for message_id, body, mentioned in rows:
        text = (body or "").lower()
        hits = [
            uid
            for uid in mentioned
            if uid in keywords
            and f"<@{uid}>" not in (body or "")
            and any(word in text for word in keywords[uid])
        ]
        if hits:
            kept = [uid for uid in mentioned if uid not in hits]
            bind.execute(update, {"id": message_id, "mentioned": kept, "hits": hits})


def downgrade() -> None:
    op.execute(
        "UPDATE messages SET mentioned_user_ids = mentioned_user_ids || keyword_user_ids "
        "WHERE cardinality(keyword_user_ids) > 0"
    )
    op.drop_column("messages", "keyword_user_ids")
