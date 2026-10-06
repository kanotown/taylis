"""`app.cli seed-demo` (app/demo): the fictional demo lab, its idempotence and the reset guard."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.cli import build_parser
from app.core.settings import Settings
from app.core.time import utcnow
from app.demo import content
from app.demo.seed import DemoSeedError, anchor_day, render, seed_demo, wipe
from app.modules.users.models import User
from tests.helpers import make_user

REVIEW_PASSWORD = "review-demo-pass-1"


async def _scalar(db: AsyncSession, sql: str, **params: Any) -> Any:
    return (await db.execute(text(sql), params)).scalar()


async def _counts(db: AsyncSession) -> tuple[int, int, int]:
    return (
        await _scalar(db, "SELECT count(*) FROM users"),
        await _scalar(db, "SELECT count(*) FROM channels"),
        await _scalar(db, "SELECT count(*) FROM messages"),
    )


def test_render_dates_and_mentions() -> None:
    from datetime import date
    from uuid import UUID

    uid = UUID("00000000-0000-0000-0000-000000000001")
    text_ = render("{d+3} / {iso-1} <@ito> <!channel>", date(2026, 10, 5), {"ito": uid})
    assert text_ == f"10/8（木） / 2026-10-04 <@{uid}> <!channel>"


def test_anchor_is_yesterday_before_noon() -> None:
    from datetime import UTC, datetime

    assert str(anchor_day(datetime(2026, 10, 6, 1, 0, tzinfo=UTC))) == "2026-10-05"  # 10:00 JST
    assert str(anchor_day(datetime(2026, 10, 6, 4, 0, tzinfo=UTC))) == "2026-10-06"  # 13:00 JST


def test_cli_parses_seed_demo() -> None:
    args = build_parser().parse_args(
        ["seed-demo", "--reset", "--review-password-file", "/run/secrets/review"]
    )
    assert args.reset and not args.i_know and args.review_user == "review"
    assert args.review_password_file == "/run/secrets/review"


async def test_seed_demo_end_to_end(
    app: FastAPI, client: AsyncClient, db: AsyncSession, test_settings: Settings
) -> None:
    demo = test_settings.model_copy(update={"workspace_name": content.WORKSPACE_NAME})
    try:
        outcome = await seed_demo(demo, review_password=REVIEW_PASSWORD)
        assert outcome.status == "seeded"
        assert set(outcome.credentials) == {p.username for p in content.CAST}  # not review
        assert outcome.messages >= len(content.POSTS)

        # The review account: a member (not admin, not guest) in every demo channel.
        role = await _scalar(db, "SELECT role FROM users WHERE username = 'review'")
        assert role == "member"
        joined = await _scalar(
            db,
            "SELECT count(*) FROM channel_members cm JOIN users u ON u.id = cm.user_id "
            "JOIN channels c ON c.id = cm.channel_id "
            "WHERE u.username = 'review' AND c.type IN ('public', 'private')",
        )
        assert joined == len(content.CHANNELS) + 1  # + its times
        grade = await _scalar(
            db,
            "SELECT p.grade FROM lab_profiles p JOIN users u ON u.id = p.user_id "
            "WHERE u.username = 'review'",
        )
        assert grade == "M1"

        # Lived-in: posts spread over about two weeks, none in the future.
        oldest, newest = (
            await db.execute(text("SELECT min(created_at), max(created_at) FROM messages"))
        ).one()
        assert utcnow() - oldest > timedelta(days=12)
        assert newest <= utcnow()

        # The features that make the demo: a text emoji, the collection, the pool, tasks.
        assert await _scalar(db, "SELECT count(*) FROM custom_emoji") == len(content.TEXT_EMOJI)
        assert await _scalar(db, "SELECT count(*) FROM collections") == 1
        holding = await _scalar(db, "SELECT count(*) FROM reservations WHERE status = 'holding'")
        waiting = await _scalar(db, "SELECT count(*) FROM reservations WHERE status = 'waiting'")
        assert (holding, waiting) == (2, 1)
        assert await _scalar(db, "SELECT count(*) FROM tasks") >= 5
        assert await _scalar(db, "SELECT count(*) FROM attachments") == len(content.FILES)
        # The seed's own sessions are gone.
        assert await _scalar(db, "SELECT count(*) FROM sessions WHERE revoked_at IS NULL") == 0

        # The review account logs in and has unread posts.
        login = await client.post(
            "/api/v1/auth/login",
            json={"username": "review", "password": REVIEW_PASSWORD, "device": {"platform": "ios"}},
        )
        assert login.status_code == 200, login.text
        token = login.json()["access_token"]
        summary = await client.get(
            "/api/v1/sync/summary", headers={"Authorization": f"Bearer {token}"}
        )
        assert summary.status_code == 200
        assert summary.json()["has_unread"] and summary.json()["badge"] > 0
        unread_channels = await _scalar(
            db,
            "SELECT count(*) FROM read_states r JOIN users u ON u.id = r.user_id "
            "WHERE u.username = 'review' AND EXISTS (SELECT 1 FROM messages m "
            "WHERE m.channel_id = r.channel_id AND m.parent_id IS NULL "
            "AND m.sender_id <> u.id AND m.seq > r.last_read_seq)",
        )
        assert unread_channels >= 3

        # Idempotent: a second run changes nothing (and may set the review password again).
        before = await _counts(db)
        again = await seed_demo(demo, review_password=REVIEW_PASSWORD + "x")
        assert again.status == "already_seeded"
        assert await _counts(db) == before

        # --reset is refused unless the workspace is the demo (or --i-know).
        with pytest.raises(DemoSeedError, match="refusing to reset"):
            await seed_demo(test_settings, reset=True)
        assert await _counts(db) == before

        identity = await _scalar(db, "SELECT id FROM workspace_identity")
        await db.commit()
        reset = await seed_demo(demo, reset=True)
        assert reset.status == "seeded" and reset.reset
        assert "review" in reset.credentials  # no password given: generated
        assert await _scalar(db, "SELECT id FROM workspace_identity") == identity
        assert await _counts(db) == before
        assert await _scalar(db, "SELECT count(*) FROM message_templates") >= 2
    finally:
        await db.rollback()
        await wipe(db, test_settings)


async def test_seed_demo_with_another_review_name(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    demo = test_settings.model_copy(update={"workspace_name": content.WORKSPACE_NAME_EN})
    try:
        outcome = await seed_demo(demo, review_username="visitor")
        assert outcome.status == "seeded" and "visitor" in outcome.credentials
        private = await _scalar(
            db,
            "SELECT count(*) FROM channel_members cm JOIN users u ON u.id = cm.user_id "
            "JOIN channels c ON c.id = cm.channel_id WHERE u.username = 'visitor' "
            "AND c.type = 'private'",
        )
        assert private == 1
        assert await _scalar(db, "SELECT count(*) FROM users WHERE username = 'review'") == 0
    finally:
        await db.rollback()
        await wipe(db, test_settings)


async def test_seed_refuses_a_workspace_with_messages(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    test_settings: Settings,
    as_user: Callable[[User], None],
) -> None:
    owner = await make_user(db, "someone")
    as_user(owner)
    channel = await client.post("/api/v1/channels", json={"name": "general", "type": "public"})
    assert channel.status_code in (200, 201), channel.text
    posted = await client.post(
        f"/api/v1/channels/{channel.json()['id']}/messages",
        json={"body": "real data", "client_msg_id": str(uuid.uuid4())},
    )
    assert posted.status_code in (200, 201), posted.text
    with pytest.raises(DemoSeedError, match="has messages"):
        await seed_demo(test_settings)
    assert await _scalar(db, "SELECT count(*) FROM users") == 1
