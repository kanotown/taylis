"""Read one Mattermost team out of Mattermost's own PostgreSQL database into a JSONL file (M18).

Only SELECTs in a read-only transaction: nothing in Mattermost changes. The file holds the team's
public and private channels (archived ones too), their members, every live user post with its files
and reactions, the people involved and the custom emoji the posts use. Direct and group messages are
not part of a team and are not read. The import (``mattermost_import``) runs later inside the
ChikuwaChat stack; files stay where Mattermost keeps them and are read from there.

Record kinds, one JSON object per line: ``meta``, ``user``, ``emoji``, ``channel``, ``post`` (posts
sorted by create time). Times are Mattermost's epoch milliseconds.
"""

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg

FORMAT_VERSION = 1
# @name as Mattermost writes it (letters, digits, . _ -); the import strips trailing punctuation.
MENTION = re.compile(r"(?<![\w@])@([a-z0-9][a-z0-9._-]*)", re.IGNORECASE)
CUSTOM_EMOJI = re.compile(r":([a-z0-9_+-]{1,64}):")


def asyncpg_dsn(dsn: str) -> str:
    """Mattermost's DataSource as asyncpg takes it: postgres:// and only the sslmode parameter."""
    parts = urlsplit(dsn)
    scheme = "postgresql" if parts.scheme in ("postgres", "postgresql") else parts.scheme
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if k == "sslmode"])
    return urlunsplit((scheme, parts.netloc, parts.path, query, ""))


async def extract_team(dsn: str, team_name: str, out: Path) -> dict[str, int]:
    conn = await asyncpg.connect(asyncpg_dsn(dsn))
    try:
        async with conn.transaction(readonly=True):
            return await _extract(conn, team_name, out)
    finally:
        await conn.close()


async def _extract(conn: asyncpg.Connection, team_name: str, out: Path) -> dict[str, int]:
    team = await conn.fetchrow(
        "SELECT id, name, displayname FROM teams WHERE name = $1 AND deleteat = 0", team_name
    )
    if team is None:
        raise ValueError(f"no team named {team_name!r}")
    channels = await conn.fetch(
        "SELECT id, name, displayname, type::text AS type, header, purpose, creatorid, createat, "
        "deleteat FROM channels WHERE teamid = $1 AND type::text IN ('O', 'P') "
        "ORDER BY createat, id",
        team["id"],
    )
    channel_ids = [c["id"] for c in channels]
    members = await conn.fetch(
        "SELECT channelid, userid, schemeadmin FROM channelmembers "
        "WHERE channelid = ANY($1::varchar[])",
        channel_ids,
    )
    # Live user posts only: deleted ones, edit history rows (deleteat set) and system posts stay.
    posts = await conn.fetch(
        "SELECT id, channelid, userid, rootid, message, createat, editat, ispinned, props "
        "FROM posts WHERE channelid = ANY($1::varchar[]) AND deleteat = 0 AND type = '' "
        "ORDER BY createat, id",
        channel_ids,
    )
    post_ids = [p["id"] for p in posts]
    files = await conn.fetch(
        "SELECT id, postid, name, path, mimetype, size, width, height, createat FROM fileinfo "
        "WHERE postid = ANY($1::varchar[]) AND deleteat = 0 ORDER BY createat, id",
        post_ids,
    )
    reactions = await conn.fetch(
        "SELECT postid, userid, emojiname, createat FROM reactions "
        "WHERE postid = ANY($1::varchar[]) AND deleteat = 0 ORDER BY createat",
        post_ids,
    )

    mentioned = {m.lower() for p in posts for m in MENTION.findall(p["message"] or "")}
    user_ids = (
        {p["userid"] for p in posts}
        | {m["userid"] for m in members}
        | {r["userid"] for r in reactions}
        | {c["creatorid"] for c in channels if c["creatorid"]}
    )
    users = await conn.fetch(
        "SELECT u.id, u.username, u.email, u.firstname, u.lastname, u.nickname, u.position, "
        "u.deleteat, EXISTS (SELECT 1 FROM bots b WHERE b.userid = u.id) AS is_bot "
        "FROM users u WHERE u.id = ANY($1::varchar[]) OR lower(u.username) = ANY($2::varchar[]) "
        "ORDER BY u.username",
        sorted(user_ids),
        sorted(mentioned),
    )
    emoji_names = {r["emojiname"] for r in reactions} | {
        name for p in posts for name in CUSTOM_EMOJI.findall(p["message"] or "")
    }
    emoji = await conn.fetch(
        "SELECT id, name, creatorid FROM emoji WHERE deleteat = 0 AND name = ANY($1::varchar[]) "
        "ORDER BY name",
        sorted(emoji_names),
    )

    files_by_post: dict[str, list[dict[str, Any]]] = {}
    for f in files:
        files_by_post.setdefault(f["postid"], []).append(
            {
                "id": f["id"],
                "name": f["name"],
                "path": f["path"],
                "mime_type": f["mimetype"],
                "size": f["size"],
                "width": f["width"],
                "height": f["height"],
            }
        )
    reactions_by_post: dict[str, list[dict[str, Any]]] = {}
    for r in reactions:
        reactions_by_post.setdefault(r["postid"], []).append(
            {"user_id": r["userid"], "emoji_name": r["emojiname"], "create_at": r["createat"]}
        )
    members_by_channel: dict[str, list[dict[str, Any]]] = {}
    for m in members:
        members_by_channel.setdefault(m["channelid"], []).append(
            {"user_id": m["userid"], "admin": bool(m["schemeadmin"])}
        )

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:

        def write(record: dict[str, Any]) -> None:
            fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

        write(
            {
                "type": "meta",
                "version": FORMAT_VERSION,
                "source": "mattermost",
                "team": {
                    "id": team["id"],
                    "name": team["name"],
                    "display_name": team["displayname"],
                },
            }
        )
        for u in users:
            write(
                {
                    "type": "user",
                    "id": u["id"],
                    "username": u["username"],
                    "email": u["email"] or None,
                    "first_name": u["firstname"] or "",
                    "last_name": u["lastname"] or "",
                    "nickname": u["nickname"] or "",
                    "position": u["position"] or "",
                    "is_bot": bool(u["is_bot"]),
                    "deleted": bool(u["deleteat"]),
                }
            )
        for e in emoji:
            write({"type": "emoji", "id": e["id"], "name": e["name"], "creator_id": e["creatorid"]})
        for c in channels:
            write(
                {
                    "type": "channel",
                    "id": c["id"],
                    "name": c["name"],
                    "display_name": c["displayname"] or c["name"],
                    "private": c["type"] == "P",
                    "header": c["header"] or "",
                    "purpose": c["purpose"] or "",
                    "creator_id": c["creatorid"] or None,
                    "create_at": c["createat"],
                    "delete_at": c["deleteat"],
                    "members": members_by_channel.get(c["id"], []),
                }
            )
        for p in posts:
            props = json.loads(p["props"]) if isinstance(p["props"], str) else (p["props"] or {})
            write(
                {
                    "type": "post",
                    "id": p["id"],
                    "channel_id": p["channelid"],
                    "user_id": p["userid"],
                    "root_id": p["rootid"] or None,
                    "message": p["message"] or "",
                    "create_at": p["createat"],
                    "edit_at": p["editat"] or 0,
                    "pinned": bool(p["ispinned"]),
                    "override_username": props.get("override_username")
                    if props.get("from_webhook")
                    else None,
                    "files": files_by_post.get(p["id"], []),
                    "reactions": reactions_by_post.get(p["id"], []),
                }
            )
    return {
        "users": len(users),
        "emoji": len(emoji),
        "channels": len(channels),
        "posts": len(posts),
        "files": len(files),
        "reactions": len(reactions),
    }
