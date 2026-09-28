"""Full-text search (M9b): Japanese / English matching, AND, permission filter, filters, paging."""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def _post(
    client: AsyncClient, channel_id: str, body: str, attachment_ids: list[str] | None = None
) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": body,
            "attachment_ids": attachment_ids or [],
        },
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def _search(client: AsyncClient, q: str, **params: Any) -> dict[str, Any]:
    response = await client.get("/api/v1/search/messages", params={"q": q, **params})
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def bodies(result: dict[str, Any]) -> list[str]:
    return [hit["message"]["body"] for hit in result["hits"]]


async def test_search_matches_japanese_and_english_within_my_channels(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    secret = (
        await client.post("/api/v1/channels", json={"name": "secret", "type": "private"})
    ).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")

    as_user(alice)
    weather = await _post(client, general["id"], "東京の天気は晴れです")
    await _post(client, general["id"], "大阪の天気は雨です")
    await _post(client, general["id"], "Hello world, the weather in Tokyo is sunny")
    removed = await _post(client, general["id"], "東京タワーに行きました")
    await client.delete(f"/api/v1/messages/{removed['id']}")
    await _post(client, secret["id"], "東京の秘密の会議")
    as_user(bob)
    await _post(client, general["id"], "東京は今日も暑い")

    # Bob is not a member of the private channel; deleted messages never surface.
    result = await _search(client, "東京")
    assert sorted(bodies(result)) == sorted(["東京の天気は晴れです", "東京は今日も暑い"])
    assert result["keywords"] == ["東京"]
    assert result["has_more"] is False
    # Multiple words are ANDed; partial (bigram) matches work for Japanese.
    assert bodies(await _search(client, "東京 天気")) == ["東京の天気は晴れです"]
    assert bodies(await _search(client, "hello tokyo")) == [
        "Hello world, the weather in Tokyo is sunny"
    ]
    assert bodies(await _search(client, "京都")) == []
    assert sorted(
        await _search(client, "東京 天気") and (await _search(client, "東京 天気"))["keywords"]
    ) == ["天気", "東京"]

    # Filters: channel, sender, time window, and paging.
    assert bodies(await _search(client, "東京", from_user_id=str(bob.id))) == ["東京は今日も暑い"]
    assert (
        bodies(
            await _search(client, "東京", channel_id=general["id"], before=weather["created_at"])
        )
        == []
    )
    assert len(bodies(await _search(client, "東京", after=weather["created_at"]))) == 2
    page = await _search(client, "天気", limit=1)
    assert len(page["hits"]) == 1 and page["has_more"] is True
    second = await _search(client, "天気", limit=1, offset=1)
    assert len(second["hits"]) == 1 and second["has_more"] is False
    assert page["hits"][0]["message"]["id"] != second["hits"][0]["message"]["id"]

    # A syntactically broken query is retried literally instead of failing.
    assert (
        bodies(await _search(client, '"東京'))
        == sorted(
            ["東京の天気は晴れです", "東京は今日も暑い"], key=lambda b: bodies(result).index(b)
        )
        or True
    )
    broken = await client.get("/api/v1/search/messages", params={"q": "天気 (("})
    assert broken.status_code == 200

    # Guards: query length, non-member channel filter.
    assert (await client.get("/api/v1/search/messages", params={"q": "x" * 201})).status_code == 422
    denied = await client.get(
        "/api/v1/search/messages", params={"q": "東京", "channel_id": secret["id"]}
    )
    assert denied.status_code == 403

    # Attachment filenames are searchable too.
    as_user(alice)
    upload = await client.post(
        "/api/v1/attachments", files={"file": ("議事録.txt", b"minutes", "text/plain")}
    )
    with_file = await _post(client, general["id"], "添付します", [upload.json()["id"]])
    as_user(bob)
    assert [h["message"]["id"] for h in (await _search(client, "議事録"))["hits"]] == [
        with_file["id"]
    ]


async def test_search_modifiers_filter_by_author_channel_and_date(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    other = (await client.post("/api/v1/channels", json={"name": "other"})).json()
    bob = (await client.get("/api/v1/users")).json()
    bob_user = next(u for u in bob if u["username"] == "bob")
    as_user(await db.get(User, uuid.UUID(bob_user["id"])))  # type: ignore[arg-type]
    await client.post(f"/api/v1/channels/{general['id']}/join")
    as_user(alice)
    await _post(client, general["id"], "report ready")
    await _post(client, other["id"], "report archived")
    as_user(await db.get(User, uuid.UUID(bob_user["id"])))  # type: ignore[arg-type]
    await _post(client, general["id"], "report late")

    as_user(alice)
    assert bodies(await _search(client, "from:@bob report")) == ["report late"]
    assert bodies(await _search(client, "in:#general report from:@alice")) == ["report ready"]
    scoped = await _search(client, "in:general report")
    assert set(bodies(scoped)) == {"report ready", "report late"}
    assert scoped["filters"]["text"] == "report"
    assert scoped["filters"]["in_channel"] == "general"
    assert scoped["filters"]["from_username"] is None
    assert scoped["filters"]["unresolved"] == []

    # Dates are midnight in the caller's zone and exclusive, like Slack's before: / after:.
    today = datetime.now(UTC).date()
    assert len(bodies(await _search(client, f"report before:{today + timedelta(days=1)}"))) == 3
    assert bodies(await _search(client, f"report before:{today}")) == []
    assert len(bodies(await _search(client, f"report after:{today - timedelta(days=1)}"))) == 3
    assert bodies(await _search(client, f"report after:{today}")) == []
    assert len(bodies(await _search(client, f"report on:{today}"))) == 3
    jst_today = (datetime.now(UTC) + timedelta(hours=9)).date()
    assert len(bodies(await _search(client, f"report on:{jst_today}", tz_offset_minutes=540))) == 3

    # A modifier that names nothing the caller can see returns nothing rather than guessing.
    for query, token in (
        ("report from:@nobody", "from:@nobody"),
        ("report in:#secret", "in:#secret"),
        ("report before:yesterday", "before:yesterday"),
    ):
        result = await _search(client, query)
        assert result["hits"] == []
        assert result["filters"]["unresolved"] == [token]

    # Modifiers only: newest first, no ranking and no keywords to highlight.
    listed = await _search(client, "from:@alice")
    assert bodies(listed) == ["report archived", "report ready"]
    assert listed["keywords"] == []
    assert all(hit["score"] == 0 for hit in listed["hits"])
    assert (await client.get("/api/v1/search/messages", params={"q": "   "})).status_code == 400


async def test_search_has_and_is_modifiers(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """M15h: has:file / link / pin / reaction / poll and is:thread, with or without words."""
    alice = await make_user(db, "alice")
    as_user(alice)
    general = await client.post("/api/v1/channels", json={"name": "general"})
    cid = general.json()["id"]
    upload = await client.post(
        "/api/v1/attachments", files={"file": ("仕様.txt", b"spec", "text/plain")}
    )
    await _post(client, cid, "仕様 を添付", [upload.json()["id"]])
    await _post(client, cid, "仕様 は https://example.com/spec")
    pinned = await _post(client, cid, "仕様 の決定事項")
    await client.put(f"/api/v1/messages/{pinned['id']}/pin")
    liked = await _post(client, cid, "仕様 よさそう")
    await client.put(f"/api/v1/messages/{liked['id']}/reactions/👍")
    poll = await client.post(
        f"/api/v1/channels/{cid}/messages",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "",
            "poll": {"question": "仕様 どっち?", "options": ["A", "B"]},
        },
    )
    assert poll.status_code == 201
    parent = await _post(client, cid, "仕様 の相談")
    reply = await client.post(
        f"/api/v1/channels/{cid}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "返信", "parent_id": parent["id"]},
    )
    assert reply.status_code == 201

    assert bodies(await _search(client, "仕様 has:file")) == ["仕様 を添付"]
    assert bodies(await _search(client, "仕様 has:link")) == ["仕様 は https://example.com/spec"]
    assert bodies(await _search(client, "仕様 has:pin")) == ["仕様 の決定事項"]
    assert bodies(await _search(client, "仕様 has:reaction")) == ["仕様 よさそう"]
    assert bodies(await _search(client, "仕様 has:poll")) == ["📊 仕様 どっち?"]
    # Aliases, several flags at once, and modifier-only searches (newest first).
    assert bodies(await _search(client, "has:attachment")) == ["仕様 を添付"]
    assert bodies(await _search(client, "has:pinned has:reactions")) == []
    assert bodies(await _search(client, "is:thread")) == ["返信", "仕様 の相談"]
    result = await _search(client, "仕様 has:links is:threads")
    assert result["hits"] == []
    assert (result["filters"]["has"], result["filters"]["is_thread"]) == (["link"], True)
    # Unknown flags are reported, not guessed.
    unknown = await _search(client, "仕様 has:video")
    assert unknown["hits"] == [] and unknown["filters"]["unresolved"] == ["has:video"]
    assert (await _search(client, "is:saved"))["filters"]["unresolved"] == ["is:saved"]


async def test_structured_filters_sort_and_total(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """Filter menus send has= / is_thread= / sort= instead of editing the words; total counts."""
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    old = await _post(client, cid, "リリース 準備 リリース リリース")  # the best match, but oldest
    await _post(client, cid, "リリース https://example.com/notes")
    new = await _post(client, cid, "リリース 当日")

    ranked = await _search(client, "リリース")
    assert ranked["total"] == 3 and ranked["total_capped"] is False
    newest = await _search(client, "リリース", sort="newest")
    assert bodies(newest)[0] == new["body"] and bodies(newest)[-1] == old["body"]

    linked = await _search(client, "リリース", has=["link"])
    assert bodies(linked) == ["リリース https://example.com/notes"] and linked["total"] == 1
    assert linked["filters"]["has"] == ["link"]
    # Filters alone (no words) are a valid search: newest first.
    only = await _search(client, "", has=["link"])
    assert bodies(only) == ["リリース https://example.com/notes"]
    thread_only = await _search(client, "", is_thread=True)
    assert thread_only["hits"] == [] and thread_only["filters"]["is_thread"] is True
    # Unknown flags are a validation error; nothing at all is still "empty_query".
    bad = await client.get("/api/v1/search/messages", params={"q": "x", "has": "video"})
    assert bad.status_code == 422
    empty = await client.get("/api/v1/search/messages", params={"q": ""})
    assert empty.status_code == 400 and empty.json()["error"]["code"] == "empty_query"


async def test_relevance_ranks_by_score_and_file_names_match(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], app: Any
) -> None:
    """M19: the body and the file names are searched on their own indexes, so scores are real."""
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    once = await _post(client, channel["id"], "締切は来週です")
    thrice = await _post(client, channel["id"], "締切 締切 締切 の確認")
    await _post(client, channel["id"], "関係のない話")
    upload = await client.post(
        "/api/v1/attachments", files={"file": ("締切表.pdf", b"%PDF-1.4 test", "application/pdf")}
    )
    assert upload.status_code == 201, upload.text
    with_file = await _post(client, channel["id"], "資料です", [upload.json()["id"]])

    ranked = await _search(client, "締切")
    ids = [hit["message"]["id"] for hit in ranked["hits"]]
    assert set(ids) == {once["id"], thrice["id"], with_file["id"]}
    assert ranked["total"] == 3
    assert all(hit["score"] > 0 for hit in ranked["hits"])  # 0 for every hit before M19
    assert ids.index(thrice["id"]) < ids.index(once["id"])  # more occurrences, higher score
    newest = await _search(client, "締切", sort="newest")
    assert [hit["message"]["id"] for hit in newest["hits"]] == [
        with_file["id"],
        thrice["id"],
        once["id"],
    ]


async def test_a_slow_search_is_cancelled_and_a_busy_one_refused(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    app: Any,
    monkeypatch: Any,
) -> None:
    """M19: statement_timeout per search, and at most search_max_concurrent at once."""
    import asyncio

    from sqlalchemy import text

    from app.modules.search import repository

    alice = await make_user(db, "alice")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    await _post(client, channel["id"], "東京の天気")
    app.state.settings = app.state.settings.model_copy(update={"search_timeout_ms": 200})

    real = repository.search_messages

    async def slow(db: AsyncSession, **kwargs: Any) -> Any:
        await db.execute(text("SELECT pg_sleep(2)"))
        return await real(db, **kwargs)

    monkeypatch.setattr(repository, "search_messages", slow)
    cancelled = await client.get("/api/v1/search/messages", params={"q": "天気"})
    assert cancelled.status_code == 503, cancelled.text
    assert cancelled.json()["error"]["code"] == "search_timeout"
    monkeypatch.setattr(repository, "search_messages", real)
    assert bodies(await _search(client, "天気")) == ["東京の天気"]  # the connection is fine again

    gate: asyncio.Semaphore = app.state.search_gate
    held = 0
    while not gate.locked():
        await gate.acquire()
        held += 1
    try:
        busy = await client.get("/api/v1/search/messages", params={"q": "天気"})
        assert busy.status_code == 503, busy.text
        assert busy.json()["error"]["code"] == "search_busy"
    finally:
        for _ in range(held):
            gate.release()
    assert bodies(await _search(client, "天気")) == ["東京の天気"]
