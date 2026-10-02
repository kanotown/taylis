"""M70 (docs/AI.md §13): 「AI に聞く」, questions about past conversations answered from the
messages the search finds, with numbered sources. FakeProviders only: no network."""

import re
import uuid
from collections.abc import Callable
from decimal import Decimal
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.ai.ask import groonga_query, question_terms
from app.modules.ai.llm import FakeProvider, LlmRequest
from app.modules.ai.schemas import cited_numbers
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_ai import _agent, _channel, _fake, _post, _runs, _runtime, _spend, _work
from tests.test_ai_openai import _only

API = "/api/v1"


def _cite(*needles: str) -> Callable[[LlmRequest], str]:
    """An answer citing the sources whose line contains each needle."""

    def reply(request: LlmRequest) -> str:
        numbers = []
        for needle in needles:
            line = next(x for x in request.user.splitlines() if needle in x)
            match = re.match(r"\[(\d+)\]", line)
            assert match is not None, line
            numbers.append(match.group(1))
        return "答えです " + "".join(f"[{n}]" for n in numbers) + " [99]"

    return reply


def _lines(request: LlmRequest) -> list[str]:
    return [x for x in request.user.splitlines() if re.match(r"\[\d+\] ", x)]


async def _ask(client: AsyncClient, q: str, **extra: Any) -> Any:
    return await client.post(f"{API}/ai/ask", json={"q": q, "tz_offset_minutes": 540, **extra})


# --- pure parts ---------------------------------------------------------------------------------


def test_question_terms() -> None:
    assert question_terms("先週の研究室会議で決めた発表の順番は\uff1f") == [
        "先週",
        "研究室会議",
        "発表",
        "順番",
    ]
    assert question_terms("What did we decide about the GPU server?") == ["decide", "gpu", "server"]
    assert question_terms("v0.1.18 のリリースはいつ?") == ["v0.1.18", "リリース"]
    assert question_terms("ＡＰＩキーの場所") == ["api", "キー", "場所"]  # full width folded
    assert question_terms("最近どう?") == ["最近"]  # only question words: used anyway
    assert question_terms("何?") == ["何"]
    assert question_terms("それはどうなった\uff1f") == []
    assert len(question_terms(" ".join(f"語{i}{i}" for i in range(20)))) == 8
    assert groonga_query(["ゼミ", 'a"b', "OR"]) == '"ゼミ" OR "a\\"b" OR "OR"'


def test_cited_numbers() -> None:
    assert cited_numbers("A [1] と [3][4]、[2, 5] と [6、7] [x] [] 2") == {1, 2, 3, 4, 5, 6, 7}


# --- the flow -----------------------------------------------------------------------------------


async def test_ask_answers_from_the_search_with_sources(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app)
    provider.reply = _cite("発表順は山田")
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    cid = await _channel(client, "general", [alice.id])
    as_user(alice)
    await _post(client, cid, "おはようございます")
    before = await _post(client, cid, "昨日の実験は順調でした")
    parent = await _post(client, cid, "来週のゼミの準備をしましょう")
    after = await _post(client, cid, "お昼に行きます")
    await _post(client, cid, "了解です", parent=parent["id"])
    hit = await _post(client, cid, "ゼミの発表順は山田、佐藤の順です", parent=parent["id"])
    await _post(client, cid, "ありがとう", parent=parent["id"])

    # Shown before asking: the default bot.
    target = (await client.get(f"{API}/ai/ask/target", params={"q": "ゼミの発表順は?"})).json()
    assert target == {
        "available": True,
        "provider": "anthropic",
        "model": "claude-opus-5-5",
        "agent_name": agent["name"],
        "reason": None,
    }
    created = await _ask(client, "ゼミの発表順は?")
    assert created.status_code == 202, created.text
    run = created.json()
    assert run["kind"] == "ask" and run["status"] == "pending"
    assert run["question"] == "ゼミの発表順は?" and run["channel_id"] is None
    assert run["sources"] == [] and run["omitted_count"] == 0
    assert run["provider"] == "anthropic"
    await _work(app)
    sent = provider.requests[-1]
    assert sent.effort == "low" and sent.max_tokens == 3000
    assert "[3] のように" in sent.system and "語尾" not in sent.system  # no character
    assert "<question>\nゼミの発表順は?\n</question>" in sent.user
    lines = _lines(sent)
    bodies = "\n".join(lines)
    # The hits with their context: the reply's parent, and its neighbours in the thread; the
    # parent's neighbours in the timeline come with the parent (a hit itself).
    assert "↳ Alice (" in bodies and "#general / " in bodies
    assert "来週のゼミの準備" in bodies and "了解です" in bodies and "ありがとう" in bodies
    assert before["body"] in bodies and after["body"] in bodies
    assert "おはようございます" not in bodies  # neither a hit nor next to one
    numbers = [int(re.match(r"\[(\d+)\]", x).group(1)) for x in lines]  # type: ignore[union-attr]
    assert numbers == list(range(1, len(lines) + 1))  # each message once, numbered in order
    assert len({x.split(" ", 1)[1] for x in lines}) == len(lines)

    done = (await client.get(f"{API}/ai/runs/{run['id']}")).json()
    assert done["status"] == "done" and done["output"].startswith("答えです [")
    # Only what the answer cites, by its number ([99] is not a source).
    (source,) = done["sources"]
    assert source["message_id"] == hit["id"] and source["parent_id"] == parent["id"]
    assert source["channel_id"] == cid and source["sender_id"] == str(alice.id)
    assert "発表順" in source["excerpt"] and source["n"] in numbers
    assert source["created_at"]
    # History; the events went to the asker alone, as for summaries.
    listed = (await client.get(f"{API}/ai/runs", params={"kind": "ask"})).json()
    assert [r["id"] for r in listed] == [run["id"]]
    assert (await client.get(f"{API}/ai/runs", params={"kind": "summary"})).json() == []
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "ai.run_updated")))
        .scalars()
        .all()
    )
    assert [e.payload["run"]["status"] for e in events] == ["running", "done"]
    assert all(e.audience_type == "user" and e.audience_id == alice.id for e in events)
    assert events[-1].payload["run"]["sources"][0]["message_id"] == hit["id"]
    # Someone else cannot read it.
    as_user(root)
    assert (await client.get(f"{API}/ai/runs/{run['id']}")).status_code == 404


async def test_nothing_found_is_done_without_a_call(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _agent(client)
    cid = await _channel(client, "general", [alice.id])
    as_user(alice)
    await _post(client, cid, "ゼミは 15 時から")

    nothing = (await _ask(client, "合宿の宿はどこ?")).json()
    assert nothing["status"] == "done" and "見つかりませんでした" in nothing["output"]
    assert nothing["sources"] == [] and nothing["finished_at"] is not None
    no_words = (await _ask(client, "それはどうなった?")).json()
    assert no_words["status"] == "done" and "キーワード" in no_words["output"]
    unknown = (await _ask(client, "ゼミ in:#nowhere")).json()
    assert unknown["status"] == "done" and "in:#nowhere" in unknown["output"]
    assert provider.requests == []
    (await _work(app))
    assert provider.requests == []
    runs = await _runs(db)
    assert len(runs) == 3 and all(r.cost_usd == 0 and r.reserved_usd == 0 for r in runs)
    # Blank questions are refused.
    blank = await _ask(client, "   ")
    assert blank.status_code == 400 and blank.json()["error"]["code"] == "validation_error"
    assert (await _ask(client, "")).status_code in (400, 422)
    assert (await _ask(client, "長" * 201)).status_code in (400, 422)


async def test_retrieval_reads_only_what_the_asker_may_search(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    guest = await make_user(db, "guest", role="guest")
    as_user(root)
    await _agent(client, allow_private=True)
    general = await _channel(client, "general", [alice.id, bob.id, guest.id])
    lounge = await _channel(client, "lounge", [bob.id])  # public, alice not a member
    secret = await _channel(client, "secret", [bob.id], type="private")
    as_user(alice)
    await _post(client, general, "校正の手順 general")
    as_user(bob)
    await _post(client, lounge, "校正の手順 lounge")
    await _post(client, secret, "校正の手順 secret")
    bobs_times = str((await client.post(f"{API}/times")).json()["id"])
    await _post(client, bobs_times, "校正の手順 times")

    as_user(alice)
    await _ask(client, "校正の手順")
    await _work(app)
    sent = provider.requests[-1].user
    assert "general" in sent
    for hidden in ("手順 lounge", "手順 secret", "手順 times"):
        assert hidden not in sent  # not a member: never sent (as the search)
    # is:times widens to the public times I have not joined, as the search does.
    await _ask(client, "校正の手順 is:times")
    await _work(app)
    sent = provider.requests[-1].user
    assert "手順 times" in sent and "手順 general" not in sent
    # Narrowed to a channel I cannot read: 404, before anything else.
    hidden = await _ask(client, "校正", channel_id=secret)
    assert hidden.status_code == 404 and hidden.json()["error"]["code"] == "channel_not_found"
    target = await client.get(f"{API}/ai/ask/target", params={"q": "校正", "channel_id": secret})
    assert target.status_code == 404

    # A guest: only their own conversations, and is:times does not widen.
    as_user(guest)
    calls = len(provider.requests)
    await _ask(client, "校正の手順")
    await _work(app)
    assert "手順 general" in provider.requests[-1].user
    found = (await _ask(client, "校正の手順 is:times")).json()
    assert found["status"] == "done" and "見つかりませんでした" in found["output"]
    assert len(provider.requests) == calls + 1


async def test_private_conversations_need_allow_private(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)  # no allow_private
    general = await _channel(client, "general", [alice.id])
    secret = await _channel(client, "secret", [alice.id], type="private")
    as_user(alice)
    await _post(client, general, "予算の申請は来月")
    await _post(client, secret, "予算の申請は内緒の話")
    await _post(client, secret, "予算の申請の期限は金曜")
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(root.id)]})).json()["id"]
    await _post(client, dm, "予算の申請について DM")

    created = (await _ask(client, "予算の申請")).json()
    assert created["omitted_count"] == 3  # the private channel's two and the DM's one
    await _work(app)
    sent = provider.requests[-1].user
    assert "来月" in sent and "内緒" not in sent and "金曜" not in sent and "DM" not in sent
    assert "非公開の会話の 3 件" in sent
    # Narrowed to the private channel: refused, and said so up front.
    target = (await client.get(f"{API}/ai/ask/target", params={"q": "予算 in:#secret"})).json()
    assert target["available"] is False and target["reason"] == "ai_private_not_allowed"
    assert target["agent_name"] == agent["name"]
    refused = await _ask(client, "予算", channel_id=secret)
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "ai_private_not_allowed"
    # Only private matches: nothing sent, no call.
    calls = len(provider.requests)
    only_private = (await _ask(client, "期限")).json()
    assert only_private["status"] == "done" and only_private["omitted_count"] == 1
    assert len(provider.requests) == calls

    # With allow_private the private ones are sent; taking it away cancels a waiting run.
    as_user(root)
    await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"allow_private": True})
    as_user(alice)
    waiting = (await _ask(client, "予算の申請")).json()
    assert waiting["omitted_count"] == 0
    public_only = (await _ask(client, "来月")).json()
    as_user(root)
    await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"allow_private": False})
    as_user(alice)
    cancelled = (await client.get(f"{API}/ai/runs/{waiting['id']}")).json()
    assert cancelled["status"] == "failed" and "非公開" in cancelled["error"]
    still = (await client.get(f"{API}/ai/runs/{public_only['id']}")).json()
    assert still["status"] == "pending"  # only public sources: kept
    await _work(app)
    assert "内緒" not in provider.requests[-1].user


async def test_the_conversations_bot_when_narrowed_to_one(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Any,
) -> None:
    claude, gpt = FakeProvider(text="Claude [1]"), FakeProvider(text="GPT [1]")
    _only(app, tmp_path, anthropic=claude, openai=gpt)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _agent(client, "ai-claude")
    sol = await _agent(client, "ai-gpt", name="GPT 先生", model="gpt-6.1-sol", allow_private=True)
    lab = await _channel(client, "lab", [alice.id, uuid.UUID(sol["bot_user_id"])], type="private")
    general = await _channel(client, "general", [alice.id])
    as_user(alice)
    await _post(client, lab, "装置の予約は水曜")
    await _post(client, general, "装置の予約は木曜")

    for params in ({"q": "装置 in:#lab"}, {"q": "装置", "channel_id": lab}):
        target = (await client.get(f"{API}/ai/ask/target", params=params)).json()
        assert (target["available"], target["provider"], target["agent_name"]) == (
            True,
            "openai",
            "GPT 先生",
        )
    narrowed = (await _ask(client, "装置の予約 in:#lab")).json()
    assert narrowed["provider"] == "openai" and narrowed["channel_id"] == lab
    await _work(app)
    assert "水曜" in gpt.requests[-1].user and "木曜" not in gpt.requests[-1].user
    assert gpt.requests[-1].max_tokens == 3000
    done = (await client.get(f"{API}/ai/runs/{narrowed['id']}")).json()
    assert done["output"] == "GPT [1]" and done["sources"][0]["channel_id"] == lab
    # Not narrowed: the default bot (the first), Anthropic, without the private channel.
    wide = (await _ask(client, "装置の予約")).json()
    assert wide["provider"] == "anthropic" and wide["omitted_count"] == 1
    await _work(app)
    assert "木曜" in claude.requests[-1].user and "水曜" not in claude.requests[-1].user
    assert len(gpt.requests) == 1


async def test_limits_and_availability(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    cid = await _channel(client, "general", [alice.id])
    as_user(alice)
    await _post(client, cid, "ゼミの資料")
    # No key: unavailable (target and POST).
    _runtime(app).provider = None
    _runtime(app).key_files = {"anthropic": "/nonexistent", "openai": "/nonexistent"}
    _runtime(app).providers = {}
    target = (await client.get(f"{API}/ai/ask/target", params={"q": "ゼミ"})).json()
    assert target["available"] is False and target["reason"] == "ai_unavailable"
    assert target["provider"] is None
    unavailable = await _ask(client, "ゼミ")
    assert unavailable.status_code == 409
    assert unavailable.json()["error"]["code"] == "ai_unavailable"

    provider = _fake(app)
    # The daily count is shared with summaries and mentions.
    await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "recent"})
    _runtime(app).user_daily_runs = 1
    daily = await _ask(client, "ゼミ")
    assert daily.status_code == 429 and daily.json()["error"]["code"] == "ai_daily_limit"
    _runtime(app).user_daily_runs = 50
    # The reservation counts against the month's budget.
    created = (await _ask(client, "ゼミの資料")).json()
    (run,) = [r for r in await _runs(db) if str(r.id) == created["id"]]
    assert run.reserved_usd > 0 and run.kind == "ask"
    await _work(app)
    assert sorted(r.max_tokens for r in provider.requests) == [3000, 4000]
    done = next(r for r in await _runs(db) if str(r.id) == created["id"])
    assert done.reserved_usd == 0 and done.cost_usd > 0
    await _spend(db, root, Decimal("30.5"))
    target = (await client.get(f"{API}/ai/ask/target", params={"q": "ゼミ"})).json()
    assert target["available"] is False and target["reason"] == "ai_budget_exceeded"
    assert target["agent_name"] == agent["name"]
    budget = await _ask(client, "ゼミ")
    assert budget.status_code == 429 and budget.json()["error"]["code"] == "ai_budget_exceeded"


async def test_a_disabled_bot_fails_the_waiting_question(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    cid = await _channel(client, "general", [alice.id])
    as_user(alice)
    await _post(client, cid, "ゼミの資料")
    created = (await _ask(client, "ゼミの資料")).json()
    as_user(root)
    await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"enabled": False})
    as_user(alice)
    await _work(app)
    failed = (await client.get(f"{API}/ai/runs/{created['id']}")).json()
    assert failed["status"] == "failed" and failed["error"]
    assert failed["sources"] == [] and provider.requests == []
