"""Removed link cards keep their keys under the clients' new link rule (messages.hidden_previews)

Revision ID: 0132
Revises: 0131
Create Date: 2026-11-05

The clients read a body's links as their tokenizer does since 2026-11-05 (apps/shared/
inline-format.json): a URL no longer takes the closing mark or the Japanese after it
(「https://example.com/a」を見て is the link https://example.com/a, not https://example.com/a」を見て),
and keeps a parenthesis it opens itself (Wikipedia's Foo_(bar)). A card removed before that was
stored under the key of the old reading of its link, which the clients no longer compute, so the
card would come back. Each stored key that is not a key of the body's links now, but is the old key
of one of them, becomes that link's key now; the message takes a new updated_seq (as an edit does)
so every client syncs the row again. Keys that are already right, or that match no link, stay.

Self-contained on purpose (the rules as of this revision, not the app's code that may change).
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0132"
down_revision: str | None = "0131"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LINK_KEY = re.compile(r"(https?)://([^/?#\s]+)([^#\s]*)(?:#\S*)?", re.IGNORECASE)
_START = re.compile(r"https?://", re.IGNORECASE)
_BARE = re.compile(r"https?://[^\s<>　-〿＀-￯]+", re.IGNORECASE)
_OWN_LINK = re.compile(
    r"(https?://\S*?/(?:m|c|p|e|d|eq)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"(?![/?#])",
    re.IGNORECASE,
)
_CLOSING = ".,:;!?'\"…"
_LEGACY_LINK = re.compile(r"https?://[^\s<>)\]]+", re.IGNORECASE)
_LEGACY_TRAILING = ".,!?;:。、」』）"


def _key(url: str) -> str | None:
    match = _LINK_KEY.fullmatch(url.strip())
    if match is None:
        return None
    scheme, host, rest = match.groups()
    if not rest.startswith("/"):
        rest = "/" + rest
    return f"{scheme.lower()}://{host.lower()}{rest}"


def _bare_url(match: str) -> str:
    own = _OWN_LINK.match(match)
    if own is not None:
        return own.group(1)
    url = match
    while url:
        last = url[-1]
        if last in _CLOSING or (
            (last == ")" and url.count(")") > url.count("("))
            or (last == "]" and url.count("]") > url.count("["))
        ):
            url = url[:-1]
        else:
            break
    return url


def migrated_keys(body: str, stored: list[str]) -> list[str]:
    """The stored keys under the new rule: each old key of a link becomes that link's key now."""
    now: set[str] = set()
    old_to_new: dict[str, str] = {}
    for start in _START.finditer(body):
        bare = _BARE.match(body, start.start())
        new = _key(_bare_url(bare.group(0))) if bare is not None else None
        if new is None:
            continue
        now.add(new)
        legacy = _LEGACY_LINK.match(body, start.start())
        if legacy is None:
            continue
        for old_url in (legacy.group(0).rstrip(_LEGACY_TRAILING), legacy.group(0)):
            old = _key(old_url)
            if old is not None and old != new:
                old_to_new.setdefault(old, new)
    out: list[str] = []
    for key in stored:
        moved = key if key in now else old_to_new.get(key, key)
        if moved not in out:
            out.append(moved)
    return out


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, channel_id, body, hidden_previews FROM messages "
            "WHERE cardinality(hidden_previews) > 0 AND deleted_at IS NULL ORDER BY seq"
        )
    ).all()
    bump = sa.text("UPDATE channels SET last_seq = last_seq + 1 WHERE id = :c RETURNING last_seq")
    update = sa.text(
        "UPDATE messages SET hidden_previews = :keys, updated_seq = :seq WHERE id = :id"
    ).bindparams(sa.bindparam("keys", type_=postgresql.ARRAY(sa.Text())))
    for message_id, channel_id, body, stored in rows:
        keys = migrated_keys(body or "", list(stored))
        if keys == list(stored):
            continue
        seq = bind.execute(bump, {"c": channel_id}).scalar_one()
        bind.execute(update, {"keys": keys, "seq": seq, "id": message_id})


def downgrade() -> None:
    # The keys stay as they are now: the server before this accepts them while their link is in
    # the body (its own reading finds the same URL for an ordinary link); a card whose old key
    # differs comes back there, as it would have for a client of the new rule.
    pass
