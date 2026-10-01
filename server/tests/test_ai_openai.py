"""docs/AI.md §12: OpenAI as a second provider, chosen per bot by its model. No network: the API
paths use FakeProviders per vendor, and OpenAIProvider runs against a stubbed SDK client."""

import uuid
from collections.abc import Callable
from decimal import Decimal
from typing import Any

import httpx2
import openai
import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from openai.types.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.ai.llm import (
    OPENAI_REASONING_ROOM,
    AiRuntime,
    AnthropicProvider,
    FakeProvider,
    LlmError,
    LlmRequest,
    OpenAIProvider,
    provider_of,
)
from app.modules.ai.pricing import cost_usd, price_model
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_ai import _agent, _bot_posts, _channel, _drain, _post, _runs, _work

API = "/api/v1"


def _only(app: FastAPI, tmp_path: Any, **providers: FakeProvider) -> AiRuntime:
    """The runtime with exactly these vendors configured (no key files at all)."""
    runtime: AiRuntime = app.state.ai
    runtime.provider = None
    runtime.key_files = {"anthropic": str(tmp_path / "none-a"), "openai": str(tmp_path / "none-o")}
    runtime.providers = dict(providers)
    return runtime


# --- pure parts ---------------------------------------------------------------------------------


def test_cost_for_the_openai_rows() -> None:
    # GPT-6.1 Sol: $2 in, $10 out, $0.10 cached input, $2.50 cache write per million tokens.
    sol = cost_usd(
        "gpt-6.1-sol",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read_tokens=1_000_000,
        cache_write_tokens=1_000_000,
    )
    assert sol == Decimal("2") + Decimal("10") + Decimal("0.10") + Decimal("2.50")
    # GPT-6 Luna: $0.10, $0.50, $0.01, $0.125.
    luna = cost_usd(
        "gpt-6-luna",
        input_tokens=200,
        output_tokens=1000,
        cache_read_tokens=1000,
        cache_write_tokens=300,
    )
    assert luna == Decimal("0.000568")  # (20 + 500 + 10 + 37.5) / 1e6, rounded half-even
    assert price_model("gpt-6.1-sol-2026-09-30", "gpt-6.1-sol") == "gpt-6.1-sol"
    assert price_model("", "gpt-6-luna") == "gpt-6-luna"
    # The Anthropic rows are unchanged (cache write = 1.25 x input).
    assert cost_usd(
        "claude-opus-5-5",
        input_tokens=0,
        output_tokens=0,
        cache_read_tokens=0,
        cache_write_tokens=1_000_000,
    ) == Decimal("5")


def test_provider_routing_by_model(tmp_path: Any) -> None:
    assert provider_of("claude-opus-5-5") == "anthropic" and provider_of("gpt-6-luna") == "openai"
    key = tmp_path / "openai_key"
    key.write_text("sk-test\n")
    runtime = AiRuntime(str(tmp_path / "missing"), openai_key_file=str(key))
    assert runtime.available
    assert runtime.configured("openai") and not runtime.configured("anthropic")
    sol = runtime.get_provider("gpt-6.1-sol")
    assert isinstance(sol, OpenAIProvider) and runtime.get_provider("gpt-6-luna") is sol
    assert runtime.get_provider("claude-opus-5-5") is None
    both = AiRuntime(str(key), openai_key_file=str(key))
    assert isinstance(both.get_provider("claude-haiku-4-5"), AnthropicProvider)
    # A directory (compose's stand-in for a missing file) is "not configured".
    assert not AiRuntime(str(tmp_path), openai_key_file=str(tmp_path)).available


# --- OpenAIProvider against a stubbed SDK client ------------------------------------------------


class _Responses:
    def __init__(self, outcome: Any) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class _Client:
    def __init__(self, outcome: Any) -> None:
        self.responses = _Responses(outcome)


def _response(
    *,
    status: str = "completed",
    content: list[dict[str, Any]] | None = None,
    incomplete: str | None = None,
    usage: dict[str, Any] | None = None,
) -> Response:
    if content is None:
        content = [{"type": "output_text", "text": "こんにちは", "annotations": []}]
    return Response.construct(
        id="resp_1",
        object="response",
        model="gpt-6.1-sol-2026-09-30",
        status=status,
        incomplete_details={"reason": incomplete} if incomplete else None,
        output=[
            {"type": "reasoning", "id": "rs_1", "summary": []},
            {
                "type": "message",
                "id": "msg_1",
                "role": "assistant",
                "status": "completed",
                "content": content,
            },
        ],
        usage=usage
        or {
            "input_tokens": 1500,
            "input_tokens_details": {"cached_tokens": 1000, "cache_write_tokens": 300},
            "output_tokens": 700,
            "output_tokens_details": {"reasoning_tokens": 500},
            "total_tokens": 2200,
        },
    )


_REQUEST = LlmRequest(
    model="gpt-6.1-sol", effort="high", system="決まりと性格", user="会話", max_tokens=2000
)


async def test_openai_request_building_and_parsing() -> None:
    client = _Client(_response())
    result = await OpenAIProvider("sk-test", client=client).complete(_REQUEST)
    (call,) = client.responses.calls
    assert call == {
        "model": "gpt-6.1-sol",
        "instructions": "決まりと性格",
        "input": [{"role": "user", "content": "会話"}],
        "reasoning": {"effort": "high"},
        "max_output_tokens": 2000 + OPENAI_REASONING_ROOM,
        "store": False,
    }
    assert result.text == "こんにちは" and result.stop_reason == "end_turn"
    assert result.model == "gpt-6.1-sol-2026-09-30"
    # input_tokens on OpenAI includes the cached and the written tokens: kept apart here.
    assert (result.input_tokens, result.cache_read_tokens, result.cache_write_tokens) == (
        200,
        1000,
        300,
    )
    assert result.output_tokens == 700  # reasoning tokens are part of the output


async def test_openai_refusal_and_incomplete() -> None:
    refused = _response(content=[{"type": "refusal", "refusal": "お手伝いできません"}])
    result = await OpenAIProvider("k", client=_Client(refused)).complete(_REQUEST)
    assert result.stop_reason == "refusal" and result.text == ""

    filtered = _response(status="incomplete", incomplete="content_filter", content=[])
    result = await OpenAIProvider("k", client=_Client(filtered)).complete(_REQUEST)
    assert result.stop_reason == "refusal"

    cut = _response(
        status="incomplete",
        incomplete="max_output_tokens",
        content=[{"type": "output_text", "text": "途中まで", "annotations": []}],
    )
    result = await OpenAIProvider("k", client=_Client(cut)).complete(_REQUEST)
    assert result.stop_reason == "max_tokens" and result.text == "途中まで"

    failed = Response.construct(
        id="r", model="gpt-6.1-sol", status="failed", output=[], error={"code": "server_error"}
    )
    with pytest.raises(LlmError) as info:
        await OpenAIProvider("k", client=_Client(failed)).complete(_REQUEST)
    assert info.value.retryable and "server_error" in info.value.reason


def _status_error(cls: Any, status: int, code: str | None = None) -> Any:
    request = httpx2.Request("POST", "https://api.openai.com/v1/responses")
    response = httpx2.Response(status, request=request)
    return cls("boom", response=response, body={"code": code} if code else None)


@pytest.mark.parametrize(
    ("error", "retryable", "reason"),
    [
        (_status_error(openai.AuthenticationError, 401), False, "API キーが使えません"),
        (_status_error(openai.PermissionDeniedError, 403), False, "API キーが使えません"),
        (_status_error(openai.BadRequestError, 400), False, "リクエストが受け付けられません"),
        (_status_error(openai.NotFoundError, 404), False, "モデルが見つかりません"),
        (_status_error(openai.RateLimitError, 429), True, "混み合っています"),
        (_status_error(openai.RateLimitError, 429, "insufficient_quota"), False, "利用枠"),
        (_status_error(openai.InternalServerError, 503), True, "サーバーエラー (503)"),
        (
            openai.APIConnectionError(request=httpx2.Request("POST", "https://api.openai.com")),
            True,
            "接続できませんでした",
        ),
        (
            openai.APITimeoutError(request=httpx2.Request("POST", "https://api.openai.com")),
            True,
            "接続できませんでした",
        ),
    ],
)
async def test_openai_error_mapping(error: Exception, retryable: bool, reason: str) -> None:
    with pytest.raises(LlmError) as info:
        await OpenAIProvider("k", client=_Client(error)).complete(_REQUEST)
    assert info.value.retryable is retryable and reason in info.value.reason


# --- through the API ----------------------------------------------------------------------------


async def test_admin_models_and_providers(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Any,
) -> None:
    _only(app, tmp_path, openai=FakeProvider())
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await client.get(f"{API}/admin/ai/providers")).status_code == 403
    as_user(root)
    listed = (await client.get(f"{API}/admin/ai/providers")).json()
    assert listed == [
        {
            "name": "anthropic",
            "configured": False,
            "models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
        },
        {"name": "openai", "configured": True, "models": ["gpt-6.1-sol", "gpt-6-luna"]},
    ]
    sol = await _agent(client, "ai-sol", model="gpt-6.1-sol")
    assert sol["model"] == "gpt-6.1-sol"
    patched = await client.patch(f"{API}/admin/ai/agents/{sol['id']}", json={"model": "gpt-6-luna"})
    assert patched.status_code == 200 and patched.json()["model"] == "gpt-6-luna"
    bad = await client.patch(f"{API}/admin/ai/agents/{sol['id']}", json={"model": "gpt-6"})
    assert bad.status_code in (400, 422)


async def test_only_the_openai_key(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Any,
) -> None:
    fake = FakeProvider(text="GPT です。", usage=(1000, 200, 0, 0))
    _only(app, tmp_path, openai=fake)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    claude = await _agent(client, "ai-claude")  # first, but its vendor has no key
    as_user(alice)
    status = (await client.get(f"{API}/ai/status")).json()
    assert status["available"] is False and status["summary_available"] is False
    as_user(root)
    gpt = await _agent(client, "ai-gpt", name="GPT 先生", model="gpt-6.1-sol")
    bots = [uuid.UUID(claude["bot_user_id"]), uuid.UUID(gpt["bot_user_id"])]
    cid = await _channel(client, "general", [alice.id, *bots])

    as_user(alice)
    status = (await client.get(f"{API}/ai/status")).json()
    assert status["available"] is True and status["summary_available"] is True
    assert {a["model"] for a in status["agents"]} == {"claude-opus-5-5", "gpt-6.1-sol"}

    # The summary uses the first enabled bot whose provider has a key: the OpenAI one.
    await _post(client, cid, "明日のゼミは 15 時から")
    summary = await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "recent"})
    assert summary.status_code == 202, summary.text
    await _work(app)
    assert fake.requests[-1].model == "gpt-6.1-sol" and fake.requests[-1].effort == "low"
    done = (await client.get(f"{API}/ai/runs/{summary.json()['id']}")).json()
    assert done["status"] == "done" and done["output"] == "GPT です。"
    (run,) = await _runs(db)
    assert run.agent_id == uuid.UUID(gpt["id"]) and run.model == "gpt-6.1-sol"
    assert run.cost_usd == Decimal("0.004")  # 1000 x $2 + 200 x $10 per million

    # A mention of the OpenAI bot is answered by the OpenAI provider.
    await _post(client, cid, f"<@{gpt['bot_user_id']}> こんにちは")
    await _drain(app)
    await _work(app)
    assert fake.requests[-1].model == "gpt-6.1-sol" and "GPT 先生" in fake.requests[-1].system
    assert (await _bot_posts(db, gpt["bot_user_id"]))[-1].body == "GPT です。"

    # The Claude bot has no key: a short notice, no run, no call.
    calls = len(fake.requests)
    await _post(client, cid, f"<@{claude['bot_user_id']}> いますか")
    await _drain(app)
    await _work(app)
    assert len(fake.requests) == calls and len(await _runs(db)) == 2
    (notice,) = await _bot_posts(db, claude["bot_user_id"])
    assert notice.body == "応答できませんでした: AI の API キーが設定されていません"


async def test_each_bot_uses_its_own_provider(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Any,
) -> None:
    anthropic_fake = FakeProvider(text="Claude です。")
    openai_fake = FakeProvider(text="GPT です。")
    _only(app, tmp_path, anthropic=anthropic_fake, openai=openai_fake)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    claude = await _agent(client, "ai-claude", model="claude-sonnet-5-5")
    luna = await _agent(client, "ai-luna", name="ルナ", model="gpt-6-luna", effort="high")
    bots = [uuid.UUID(claude["bot_user_id"]), uuid.UUID(luna["bot_user_id"])]
    cid = await _channel(client, "general", [alice.id, *bots])
    as_user(alice)
    await _post(client, cid, f"<@{claude['bot_user_id']}> どう?")
    await _post(client, cid, f"<@{luna['bot_user_id']}> どう?")
    await _drain(app)
    await _work(app)
    assert [r.model for r in anthropic_fake.requests] == ["claude-sonnet-5-5"]
    assert [(r.model, r.effort) for r in openai_fake.requests] == [("gpt-6-luna", "high")]
    assert (await _bot_posts(db, luna["bot_user_id"]))[-1].body == "GPT です。"
    assert (await _bot_posts(db, claude["bot_user_id"]))[-1].body == "Claude です。"

    # An LlmError from the OpenAI side is handled like the Anthropic one (here: at once).
    openai_fake.errors = [LlmError("API キーが使えません", retryable=False)]
    await _post(client, cid, f"<@{luna['bot_user_id']}> もう一度")
    await _drain(app)
    await _work(app)
    assert (await _runs(db))[-1].status == "failed"
    assert (await _bot_posts(db, luna["bot_user_id"]))[-1].body == (
        "応答できませんでした: API キーが使えません"
    )
