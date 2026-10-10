"""docs/AI.md §14: web search for a bot's mention replies, the default bot, the bot's picture,
the newer models. No network: FakeProvider for the API paths, stubbed SDK clients for the
providers' request building and parsing."""

import io
import uuid
from collections.abc import Callable
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from openai.types.responses import Response
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.ai import prompts
from app.modules.ai import service as ai
from app.modules.ai.llm import (
    ANTHROPIC_WEB_SEARCH,
    ANTHROPIC_WEB_SEARCH_BASIC,
    OPENAI_REASONING_ROOM,
    WEB_SEARCH_MAX_USES,
    WEB_SEARCH_ROOM,
    AnthropicProvider,
    FakeProvider,
    LlmRequest,
    OpenAIProvider,
    WebSource,
    provider_of,
)
from app.modules.ai.pricing import WEB_SEARCH_USD, cost_usd, estimate_usd
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_ai import _agent, _bot_posts, _channel, _drain, _fake, _post, _runs, _work

API = "/api/v1"


# --- pure parts ---------------------------------------------------------------------------------


def test_new_models_and_their_prices() -> None:
    assert provider_of("claude-fable-5-1") == "anthropic"
    assert provider_of("gpt-6-astra") == "openai"
    one_million = {
        "input_tokens": 1_000_000,
        "output_tokens": 1_000_000,
        "cache_read_tokens": 1_000_000,
        "cache_write_tokens": 1_000_000,
    }
    # Fable 5.1: $10 in, $50 out, $0.25 cache hits, cache write 1.25 x $10.
    assert cost_usd("claude-fable-5-1", **one_million) == Decimal("72.75")
    # GPT-6 Astra: $10, $50, $1 cached, $12.50 cache write.
    assert cost_usd("gpt-6-astra", **one_million) == Decimal("73.50")
    # Sonnet 5.5 cache hits are $0.10 (0.05 x input), checked 2026-10-10.
    assert cost_usd("claude-sonnet-5-5", **{**one_million, "input_tokens": 0}) == Decimal(
        "10"
    ) + Decimal("0.10") + Decimal("2.50")


def test_searches_are_priced_apart() -> None:
    plain = dict(input_tokens=1000, output_tokens=200, cache_read_tokens=0, cache_write_tokens=0)
    base = cost_usd("claude-opus-5-5", **plain)
    assert cost_usd("claude-opus-5-5", **plain, web_search_requests=3) == base + 3 * WEB_SEARCH_USD
    assert WEB_SEARCH_USD == Decimal("0.01")  # $10 per 1,000 searches, both providers
    # The reservation counts every allowed search, its results as input, and the room.
    without = estimate_usd("gpt-6.1-sol", input_chars=1000, max_output_tokens=2000)
    with_search = estimate_usd(
        "gpt-6.1-sol", input_chars=1000, max_output_tokens=2000, web_searches=5
    )
    assert with_search > without + 5 * WEB_SEARCH_USD
    assert ai.estimate_run("mention", "claude-opus-5-5", "x", "s", web_search=True) > (
        ai.estimate_run("mention", "claude-opus-5-5", "x", "s")
    )


def test_sources_section_in_the_link_form() -> None:
    assert prompts.sources_section([]) == ""
    text = prompts.sources_section(
        [
            ("https://example.com/a", "Example [A]"),
            ("https://example.com/b_(x)", ""),
            ("javascript:alert(1)", "bad"),
            ("https://example.com/c d", "blank in url"),
            ("http://example.org/", "  改行\nあり  "),
        ]
    )
    assert text == (
        "\n\n出典：\n"
        "- [Example (A)](https://example.com/a)\n"
        "- [example.com](https://example.com/b_(x%29)\n"
        "- [改行 あり](http://example.org/)"
    )
    long = prompts.sources_section([("https://e.com/", "あ" * 200)])
    assert "あ" * 79 + "…](https://e.com/)" in long


def test_the_web_search_rules_replace_the_no_tools_line() -> None:
    assert prompts.NO_TOOLS in prompts.RULES
    plain = prompts.mention_system("ちくわ", "")
    searching = prompts.mention_system("ちくわ", "", web_search=True)
    assert prompts.NO_TOOLS in plain and "ネット検索" not in plain
    assert prompts.NO_TOOLS not in searching and "ネット検索だけ" in searching
    assert "人の名前・連絡先・非公開の内容を入れないでください" in searching


# --- AnthropicProvider against a stubbed SDK client ---------------------------------------------


class _Messages:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.responses.pop(0)


class _AnthropicClient:
    def __init__(self, responses: list[Any]) -> None:
        self.messages = _Messages(responses)
        self.beta = SimpleNamespace(messages=self.messages)


class _Block(SimpleNamespace):
    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in vars(self).items() if k != "citations" or v}


def _message(content: list[Any], stop: str = "end_turn", searches: int = 0) -> Any:
    return SimpleNamespace(
        content=content,
        stop_reason=stop,
        model="claude-opus-5-5",
        usage=SimpleNamespace(
            input_tokens=1000,
            output_tokens=100,
            cache_read_input_tokens=0,
            cache_creation_input_tokens=0,
            server_tool_use=SimpleNamespace(web_search_requests=searches) if searches else None,
        ),
    )


def _cite(url: str, title: str) -> Any:
    return SimpleNamespace(type="web_search_result_location", url=url, title=title, cited_text="…")


def _request(model: str = "claude-opus-5-5", *, web_search: bool) -> LlmRequest:
    return LlmRequest(
        model=model,
        effort="medium",
        system="決まり",
        user="会話",
        max_tokens=2000,
        web_search=web_search,
    )


async def test_anthropic_tool_only_when_on() -> None:
    provider = AnthropicProvider("k")
    client = _AnthropicClient([_message([_Block(type="text", text="答え", citations=None)])])
    provider._client = client  # type: ignore[assignment]
    result = await provider.complete(_request(web_search=False))
    (call,) = client.messages.calls
    assert "tools" not in call and call["max_tokens"] == 2000
    assert result.web_search_requests == 0 and result.sources == ()

    client = _AnthropicClient([_message([_Block(type="text", text="答え", citations=None)])])
    provider._client = client  # type: ignore[assignment]
    await provider.complete(_request(web_search=True))
    (call,) = client.messages.calls
    assert call["tools"] == [
        {
            "type": ANTHROPIC_WEB_SEARCH,
            "name": "web_search",
            "max_uses": WEB_SEARCH_MAX_USES,
            "response_inclusion": "excluded",
        }
    ]
    assert ANTHROPIC_WEB_SEARCH == "web_search_20260318" and WEB_SEARCH_MAX_USES == 5
    assert call["max_tokens"] == 2000 + WEB_SEARCH_ROOM
    assert call["fallbacks"] == "default"

    # Haiku 4.5 (no dynamic filtering): the basic tool.
    client = _AnthropicClient([_message([_Block(type="text", text="答え", citations=None)])])
    provider._client = client  # type: ignore[assignment]
    await provider.complete(_request("claude-haiku-4-5", web_search=True))
    (call,) = client.messages.calls
    assert call["tools"] == [
        {"type": ANTHROPIC_WEB_SEARCH_BASIC, "name": "web_search", "max_uses": 5}
    ]


async def test_anthropic_citations_searches_and_pause_turn() -> None:
    paused = _message(
        [
            _Block(type="text", text="調べます。", citations=None),
            _Block(type="server_tool_use", id="srv_1", name="web_search", input={"query": "q"}),
        ],
        stop="pause_turn",
        searches=1,
    )
    final = _message(
        [
            _Block(
                type="text",
                text="明日は晴れです。",
                citations=[
                    _cite("https://weather.example/tokyo", "東京の天気"),
                    _cite("https://weather.example/tokyo", "東京の天気"),  # the same page twice
                ],
            ),
            _Block(
                type="text", text="気温は 20 度。", citations=[_cite("https://b.example/", "B")]
            ),
        ],
        searches=2,
    )
    provider = AnthropicProvider("k")
    client = _AnthropicClient([paused, final])
    provider._client = client  # type: ignore[assignment]
    result = await provider.complete(_request(web_search=True))
    first, second = client.messages.calls
    assert first["tools"][0]["type"] == ANTHROPIC_WEB_SEARCH
    # The paused turn goes back unchanged as the assistant's message, no extra user message.
    assert second["messages"][0] == {"role": "user", "content": "会話"}
    assert second["messages"][1]["role"] == "assistant"
    assert second["messages"][1]["content"][1]["type"] == "server_tool_use"
    assert len(second["messages"]) == 2
    assert result.text == "調べます。明日は晴れです。気温は 20 度。"
    assert result.web_search_requests == 3
    assert (result.input_tokens, result.output_tokens) == (2000, 200)
    assert result.sources == (
        WebSource("https://weather.example/tokyo", "東京の天気"),
        WebSource("https://b.example/", "B"),
    )
    assert result.stop_reason == "end_turn"


# --- OpenAIProvider against a stubbed SDK client ------------------------------------------------


class _Responses:
    def __init__(self, outcome: Any) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.outcome


def _openai_response() -> Response:
    return Response.construct(
        id="resp_1",
        object="response",
        model="gpt-6.1-sol",
        status="completed",
        incomplete_details=None,
        output=[
            {"type": "web_search_call", "id": "ws_1", "status": "completed"},
            {"type": "web_search_call", "id": "ws_2", "status": "completed"},
            {
                "type": "message",
                "id": "msg_1",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {
                        "type": "output_text",
                        "text": "答え",
                        "annotations": [
                            {
                                "type": "url_citation",
                                "url": "https://news.example/1",
                                "title": "ニュース",
                                "start_index": 0,
                                "end_index": 2,
                            },
                            {"type": "file_citation", "file_id": "f", "index": 0},
                        ],
                    }
                ],
            },
        ],
        usage={
            "input_tokens": 1500,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 700,
            "output_tokens_details": {"reasoning_tokens": 500},
            "total_tokens": 2200,
        },
    )


async def test_openai_web_search_request_and_parsing() -> None:
    plain = OpenAIProvider("k").build_request(_request("gpt-6.1-sol", web_search=False))
    assert "tools" not in plain and "max_tool_calls" not in plain
    responses = _Responses(_openai_response())
    provider = OpenAIProvider("k", client=SimpleNamespace(responses=responses))
    result = await provider.complete(_request("gpt-6.1-sol", web_search=True))
    (call,) = responses.calls
    assert call["tools"] == [{"type": "web_search"}]
    assert call["max_tool_calls"] == 5
    assert call["max_output_tokens"] == 2000 + OPENAI_REASONING_ROOM + WEB_SEARCH_ROOM
    assert result.text == "答え"
    assert result.web_search_requests == 2
    assert result.sources == (WebSource("https://news.example/1", "ニュース"),)


# --- through the API ----------------------------------------------------------------------------


async def test_web_search_flag_and_a_mention_reply_with_sources(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(
        app,
        text="明日は晴れです。",
        web_search_requests=2,
        sources=(
            WebSource("https://weather.example/tokyo", "東京の天気"),
            WebSource("https://b.example/x", ""),
        ),
    )
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    plain = await _agent(client, "ai-plain", name="ふつう")
    assert plain["web_search"] is False and plain["is_default"] is False
    searcher = await _agent(client, "ai-search", name="しらべ", web_search=True)
    assert searcher["web_search"] is True
    status = (await client.get(f"{API}/ai/status")).json()
    assert {a["name"]: a["web_search"] for a in status["agents"]} == {
        "ふつう": False,
        "しらべ": True,
    }
    bots = [uuid.UUID(plain["bot_user_id"]), uuid.UUID(searcher["bot_user_id"])]
    cid = await _channel(client, "general", [alice.id, *bots])

    as_user(alice)
    await _post(client, cid, f"<@{plain['bot_user_id']}> こんにちは")
    await _drain(app)
    await _work(app)
    (request,) = provider.requests
    assert request.web_search is False and "ネット検索" not in request.system
    (reply,) = await _bot_posts(db, plain["bot_user_id"])
    assert reply.body == "明日は晴れです。"  # no search, no sources (the fake gives none)
    (first_run,) = await _runs(db)
    assert first_run.web_search is False and first_run.web_search_requests == 0

    await _post(client, cid, f"<@{searcher['bot_user_id']}> 明日の東京の天気は?")
    await _drain(app)
    runs = await _runs(db)
    assert runs[1].web_search is True
    assert runs[1].reserved_usd > first_run.cost_usd  # the searches are reserved too
    await _work(app)
    request = provider.requests[1]
    assert request.web_search is True and "ネット検索だけ" in request.system
    assert request.max_tokens == prompts.REPLY_MAX_TOKENS  # the room is the provider's
    (reply,) = await _bot_posts(db, searcher["bot_user_id"])
    assert reply.body == (
        "明日は晴れです。\n\n出典：\n"
        "- [東京の天気](https://weather.example/tokyo)\n"
        "- [b.example](https://b.example/x)"
    )
    run = (await _runs(db))[1]
    assert run.status == "done" and run.web_search_requests == 2
    tokens = cost_usd(
        "claude-opus-5-5",
        input_tokens=1000,
        output_tokens=200,
        cache_read_tokens=0,
        cache_write_tokens=0,
    )
    assert run.cost_usd == tokens + 2 * WEB_SEARCH_USD and run.reserved_usd == 0

    # The usage lists the searches per bot.
    as_user(root)
    usage = (await client.get(f"{API}/admin/ai/usage")).json()
    by_name = {row["name"]: row for row in usage["by_agent"]}
    assert by_name["しらべ"]["web_search_requests"] == 2
    assert by_name["ふつう"]["web_search_requests"] == 0
    assert usage["total_cost_usd"] == float(first_run.cost_usd + run.cost_usd)

    # Turned off by the administrator while a mention waits: no search for it.
    as_user(alice)
    await _post(client, cid, f"<@{searcher['bot_user_id']}> もう一度")
    await _drain(app)
    as_user(root)
    patched = await client.patch(
        f"{API}/admin/ai/agents/{searcher['id']}", json={"web_search": False}
    )
    assert patched.status_code == 200 and patched.json()["web_search"] is False
    await _work(app)
    assert provider.requests[2].web_search is False

    # Summaries and questions never search.
    as_user(alice)
    created = await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "recent"})
    assert created.status_code == 202
    await _work(app)
    assert provider.requests[-1].web_search is False


async def test_the_default_bot(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _fake(app)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    first = await _agent(client, "ai-first", name="いちばん")
    second = await _agent(client, "ai-second", name="にばん", model="gpt-6.1-sol")
    as_user(alice)
    cid = await _channel(client, "nobots", [])

    async def target() -> Any:
        got = await client.get(f"{API}/ai/summaries/target", params={"channel_id": cid})
        assert got.status_code == 200, got.text
        return got.json()

    async def ask_target() -> Any:
        return (await client.get(f"{API}/ai/ask/target", params={"q": "予定"})).json()

    # No setting: the oldest usable bot, as before.
    assert (await target())["agent_name"] == "いちばん"
    assert (await ask_target())["agent_name"] == "いちばん"

    as_user(root)
    chosen = await client.patch(f"{API}/admin/ai/agents/{second['id']}", json={"is_default": True})
    assert chosen.status_code == 200 and chosen.json()["is_default"] is True
    as_user(alice)
    assert (await target())["agent_name"] == "にばん"
    assert (await target())["provider"] == "openai"
    assert (await ask_target())["agent_name"] == "にばん"

    # Only one default: choosing another moves it (on create too).
    as_user(root)
    third = await _agent(client, "ai-third", name="さんばん", is_default=True)
    listed = {
        a["name"]: a["is_default"] for a in (await client.get(f"{API}/admin/ai/agents")).json()
    }
    assert listed == {"いちばん": False, "にばん": False, "さんばん": True}
    moved = await client.patch(f"{API}/admin/ai/agents/{second['id']}", json={"is_default": True})
    assert moved.status_code == 200
    listed = {
        a["name"]: a["is_default"] for a in (await client.get(f"{API}/admin/ai/agents")).json()
    }
    assert listed == {"いちばん": False, "にばん": True, "さんばん": False}

    # A conversation's own bot still comes first.
    as_user(alice)
    own = await _channel(client, "withbot", [uuid.UUID(third["bot_user_id"])])
    got = await client.get(f"{API}/ai/summaries/target", params={"channel_id": own})
    assert got.json()["agent_name"] == "さんばん"

    # A default bot that cannot be used (stopped) falls back to the oldest usable one.
    as_user(root)
    await client.patch(f"{API}/admin/ai/agents/{second['id']}", json={"enabled": False})
    as_user(alice)
    assert (await target())["agent_name"] == "いちばん"
    # Cleared: the oldest again; deleted: no default left.
    as_user(root)
    await client.patch(f"{API}/admin/ai/agents/{second['id']}", json={"enabled": True})
    as_user(alice)
    assert (await target())["agent_name"] == "にばん"
    as_user(root)
    assert (await client.delete(f"{API}/admin/ai/agents/{second['id']}")).status_code == 204
    listed = {
        a["name"]: a["is_default"] for a in (await client.get(f"{API}/admin/ai/agents")).json()
    }
    assert listed == {"いちばん": False, "さんばん": False}
    unset = await client.patch(f"{API}/admin/ai/agents/{first['id']}", json={"is_default": True})
    assert unset.json()["is_default"] is True
    unset = await client.patch(f"{API}/admin/ai/agents/{first['id']}", json={"is_default": False})
    assert unset.json()["is_default"] is False


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (300, 200), (200, 100, 30)).save(out, format="PNG")
    return out.getvalue()


async def test_the_bots_picture(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _fake(app)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    assert agent["avatar_updated_at"] is None
    url = f"{API}/admin/ai/agents/{agent['id']}/avatar"
    files = {"file": ("bot.png", _png(), "image/png")}

    as_user(alice)
    assert (await client.post(url, files=files)).status_code == 403
    as_user(root)
    uploaded = await client.post(url, files=files)
    assert uploaded.status_code == 200, uploaded.text
    version = uploaded.json()["avatar_updated_at"]
    assert version is not None
    listed = (await client.get(f"{API}/admin/ai/agents")).json()
    assert listed[0]["avatar_updated_at"] == version
    # The bot user carries it, like a person's picture (every client draws it from there).
    users = (await client.get(f"{API}/users")).json()
    bot = next(u for u in users if u["id"] == agent["bot_user_id"])
    assert bot["avatar_updated_at"] == version
    as_user(alice)
    picture = await client.get(f"{API}/users/{agent['bot_user_id']}/avatar")
    assert picture.status_code == 200 and picture.headers["content-type"] == "image/png"
    with Image.open(io.BytesIO(picture.content)) as image:
        assert image.size == (256, 256)

    as_user(root)
    bad = await client.post(url, files={"file": ("x.png", b"not an image", "image/png")})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "avatar_not_image"
    missing = await client.post(f"{API}/admin/ai/agents/{uuid.uuid4()}/avatar", files=files)
    assert missing.status_code == 404
    cleared = await client.delete(url)
    assert cleared.status_code == 200 and cleared.json()["avatar_updated_at"] is None
    as_user(alice)
    assert (await client.get(f"{API}/users/{agent['bot_user_id']}/avatar")).status_code == 404


async def test_new_models_through_the_api(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider: FakeProvider = _fake(app)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    fable = await _agent(client, "ai-fable", model="claude-fable-5-1")
    astra = await _agent(client, "ai-astra", model="gpt-6-astra", name="アストラ")
    assert (fable["model"], astra["model"]) == ("claude-fable-5-1", "gpt-6-astra")
    cid = await _channel(
        client,
        "general",
        [alice.id, uuid.UUID(fable["bot_user_id"]), uuid.UUID(astra["bot_user_id"])],
    )
    as_user(alice)
    await _post(client, cid, f"<@{astra['bot_user_id']}> やあ")
    await _drain(app)
    await _work(app)
    assert provider.requests[0].model == "gpt-6-astra"
    (run,) = await _runs(db)
    assert run.provider == "openai" and run.status == "done"
