"""The boundary to the model provider (docs/AI.md §2.4).

`LlmProvider` is all the rest of the module sees: one request in, the text and the token counts
out, or an `LlmError` that says whether trying again later may help. `AnthropicProvider` and
`OpenAIProvider` (docs/AI.md §12) wrap the official SDKs; `FakeProvider` answers tests without the
network. Each bot's model decides its provider (`provider_of`); each provider has its own key file.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Protocol

import anthropic
import openai

log = logging.getLogger("app.ai")

ANTHROPIC = "anthropic"
OPENAI = "openai"
PROVIDERS = (ANTHROPIC, OPENAI)
# docs/AI.md §12: the model decides the provider (no column of its own).
# The order is the admin form's (docs/AI.md §14: Fable 5.1 and GPT-6 Astra added 2026-10-10).
MODEL_PROVIDERS: dict[str, str] = {
    "claude-fable-5-1": ANTHROPIC,
    "claude-opus-5-5": ANTHROPIC,
    "claude-sonnet-5-5": ANTHROPIC,
    "claude-haiku-4-5": ANTHROPIC,
    "gpt-6-astra": OPENAI,
    "gpt-6.1-sol": OPENAI,
    "gpt-6-luna": OPENAI,
}

HAIKU = "claude-haiku-4-5"
# Server-side fallback on a safety refusal (Fable 5.1 / Opus 5.5 / Sonnet 5.5).
FALLBACK_BETA = "server-side-fallback-2026-07-01"

# docs/AI.md §14: the provider's own web search tool, at most this many searches per reply.
WEB_SEARCH_MAX_USES = 5
# Anthropic: the newest web search tool (dynamic filtering: the model filters the results in code
# before they reach its context; response_inclusion drops those filtered result blocks from the
# response) on Claude 4.6 and later; Haiku 4.5 keeps the basic version.
# https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
ANTHROPIC_WEB_SEARCH = "web_search_20260318"
ANTHROPIC_WEB_SEARCH_BASIC = "web_search_20250305"
# Room for the model's work around the searches (queries, filtering code, reading), added to the
# reply's output allowance when a request may search (the visible length stays set by the prompt).
WEB_SEARCH_ROOM = 8000
# A long search turn may pause (stop_reason pause_turn); it is sent back this many times at most.
MAX_CONTINUATIONS = 3
# Sources listed under a reply at most.
MAX_SOURCES = 10


@dataclass(frozen=True)
class LlmRequest:
    model: str
    effort: str
    system: str
    user: str
    max_tokens: int
    # docs/AI.md §14: the provider's web search tool is attached (mention replies of a bot with
    # web_search on).
    web_search: bool = False


@dataclass(frozen=True)
class WebSource:
    """A web page an answer cites (docs/AI.md §14)."""

    url: str
    title: str


@dataclass(frozen=True)
class LlmResult:
    text: str
    # end_turn | max_tokens | refusal | …, Anthropic's words (OpenAIProvider maps to them).
    stop_reason: str | None
    model: str
    # Disjoint counts (pricing.py): uncached input, output (with reasoning), cache read / write.
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    # docs/AI.md §14: the searches the provider ran (priced apart) and the pages the answer cites.
    web_search_requests: int = 0
    sources: tuple[WebSource, ...] = ()

    @property
    def has_tokens(self) -> bool:
        """Whether there is anything to record (tokens, or searches: both cost)."""
        return any(
            (
                self.input_tokens,
                self.output_tokens,
                self.cache_read_tokens,
                self.cache_write_tokens,
                self.web_search_requests,
            )
        )


class LlmError(Exception):
    """A call that did not produce a result. `retryable`: a rate limit, an overload or a network
    problem (the worker tries again later); otherwise trying again would fail the same way.
    `usage`: the tokens the provider still reports for the failed attempt (an OpenAI response
    that ended failed / cancelled is billed), recorded on the run like a result's (review v0.1.18
    #7)."""

    def __init__(self, reason: str, *, retryable: bool, usage: "LlmResult | None" = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.retryable = retryable
        self.usage = usage


class LlmProvider(Protocol):
    async def complete(self, request: LlmRequest) -> LlmResult: ...


def _tokens(value: int | None) -> int:
    return int(value or 0)


class AnthropicProvider:
    """The Claude API through the official SDK (AsyncAnthropic, built on first use)."""

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key
        self._client: anthropic.AsyncAnthropic | None = None

    def _get_client(self) -> anthropic.AsyncAnthropic:
        if self._client is None:
            self._client = anthropic.AsyncAnthropic(
                api_key=self._api_key, max_retries=2, timeout=120.0
            )
        return self._client

    async def complete(self, request: LlmRequest) -> LlmResult:
        # The system prompt is the same for every run of a bot: cache it.
        system: Any = [
            {"type": "text", "text": request.system, "cache_control": {"type": "ephemeral"}}
        ]
        messages: list[Any] = [{"role": "user", "content": request.user}]
        responses: list[Any] = []
        response = await self._create(request, system, messages)
        responses.append(response)
        # docs/AI.md §14: a long search turn may pause; it goes on when the paused assistant
        # message is sent back unchanged (no extra user message).
        while response.stop_reason == "pause_turn" and len(responses) <= MAX_CONTINUATIONS:
            messages = [
                messages[0],
                {"role": "assistant", "content": [_block_param(b) for b in response.content]},
            ]
            response = await self._create(request, system, messages)
            responses.append(response)
        return _anthropic_result(responses, request.model)

    async def _create(self, request: LlmRequest, system: Any, messages: list[Any]) -> Any:
        client = self._get_client()
        output_config: Any = {"effort": request.effort}
        max_tokens = request.max_tokens + (WEB_SEARCH_ROOM if request.web_search else 0)
        extra: dict[str, Any] = {}
        if request.web_search:
            extra["tools"] = [anthropic_web_search_tool(request.model)]
        try:
            if request.model == HAIKU:
                return await client.messages.create(
                    model=request.model,
                    max_tokens=max_tokens,
                    system=system,
                    messages=messages,
                    **extra,
                )
            # Fable 5.1 / Opus 5.5 / Sonnet 5.5 always think (no `thinking` parameter); effort
            # sets how much.
            return await client.beta.messages.create(
                model=request.model,
                max_tokens=max_tokens,
                system=system,
                messages=messages,
                output_config=output_config,
                betas=[FALLBACK_BETA],
                fallbacks="default",
                **extra,
            )
        except (
            anthropic.AuthenticationError,
            anthropic.PermissionDeniedError,
        ) as exc:
            raise LlmError("API キーが使えません", retryable=False) from exc
        except anthropic.BadRequestError as exc:
            reason = f"リクエストが受け付けられませんでした ({exc.message[:120]})"
            raise LlmError(reason, retryable=False) from exc
        except anthropic.NotFoundError as exc:
            raise LlmError("モデルが見つかりません", retryable=False) from exc
        except anthropic.RateLimitError as exc:
            raise LlmError("API の利用が混み合っています", retryable=True) from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code >= 500:
                raise LlmError(f"API のサーバーエラー ({exc.status_code})", retryable=True) from exc
            raise LlmError(f"API のエラー ({exc.status_code})", retryable=False) from exc
        except anthropic.APIConnectionError as exc:  # includes timeouts
            raise LlmError("API に接続できませんでした", retryable=True) from exc


def anthropic_web_search_tool(model: str) -> dict[str, Any]:
    """docs/AI.md §14: Anthropic's server-side web search, at most WEB_SEARCH_MAX_USES searches."""
    if model == HAIKU:
        return {
            "type": ANTHROPIC_WEB_SEARCH_BASIC,
            "name": "web_search",
            "max_uses": WEB_SEARCH_MAX_USES,
        }
    return {
        "type": ANTHROPIC_WEB_SEARCH,
        "name": "web_search",
        "max_uses": WEB_SEARCH_MAX_USES,
        "response_inclusion": "excluded",
    }


def _block_param(block: Any) -> Any:
    """A response content block as it is sent back (pause_turn): unchanged."""
    to_dict = getattr(block, "to_dict", None)
    return to_dict() if callable(to_dict) else block


def _add_source(found: dict[str, WebSource], url: Any, title: Any) -> None:
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        return
    if url not in found and len(found) < MAX_SOURCES:
        found[url] = WebSource(url=url, title=title if isinstance(title, str) else "")


def _anthropic_result(responses: list[Any], requested_model: str) -> LlmResult:
    """The responses of one turn (more than one after pause_turn) as an LlmResult: the text of
    every text block, the cited pages (web_search_result_location citations), the tokens and the
    searches added up."""
    text: list[str] = []
    sources: dict[str, WebSource] = {}
    inp = out = cache_read = cache_write = searches = 0
    for response in responses:
        for block in response.content:
            if block.type != "text":
                continue
            text.append(block.text)
            for citation in getattr(block, "citations", None) or []:
                if getattr(citation, "type", None) == "web_search_result_location":
                    _add_source(sources, citation.url, getattr(citation, "title", None))
        usage = response.usage
        inp += _tokens(usage.input_tokens)
        out += _tokens(usage.output_tokens)
        cache_read += _tokens(getattr(usage, "cache_read_input_tokens", None))
        cache_write += _tokens(getattr(usage, "cache_creation_input_tokens", None))
        server_tools = getattr(usage, "server_tool_use", None)
        searches += _tokens(getattr(server_tools, "web_search_requests", None))
    last = responses[-1]
    return LlmResult(
        text="".join(text),
        stop_reason=last.stop_reason,
        model=str(last.model or requested_model),
        input_tokens=inp,
        output_tokens=out,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
        web_search_requests=searches,
        sources=tuple(sources.values()),
    )


# Reasoning tokens count against max_output_tokens on OpenAI; the guide advises reserving at least
# 25,000 for reasoning and output (developers.openai.com/api/docs/guides/reasoning). The visible
# length is kept short by the prompt, so this is room to think, not a longer answer.
OPENAI_REASONING_ROOM = 23_000


class OpenAIProvider:
    """The OpenAI Responses API through the official SDK (AsyncOpenAI, built on first use).
    docs/AI.md §12: system prompt as `instructions`, the conversation as `input`, our effort as
    `reasoning.effort` (low / medium / high are valid as they are), `store=False`. Caching is
    automatic on these models; usage is mapped to the disjoint counts LlmResult keeps."""

    def __init__(self, api_key: str, client: Any = None) -> None:
        self._api_key = api_key
        self._client: Any = client  # tests pass a stub with `responses.create`

    def _get_client(self) -> Any:
        if self._client is None:
            self._client = openai.AsyncOpenAI(api_key=self._api_key, max_retries=2, timeout=120.0)
        return self._client

    def build_request(self, request: LlmRequest) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": request.model,
            "instructions": request.system,
            "input": [{"role": "user", "content": request.user}],
            "reasoning": {"effort": request.effort},
            "max_output_tokens": request.max_tokens + OPENAI_REASONING_ROOM,
            "store": False,
        }
        if request.web_search:
            # docs/AI.md §14: the Responses API's web search tool; max_tool_calls caps the calls
            # of built-in tools in the response (further ones are ignored).
            body["tools"] = [{"type": "web_search"}]
            body["max_tool_calls"] = WEB_SEARCH_MAX_USES
            body["max_output_tokens"] += WEB_SEARCH_ROOM
        return body

    async def complete(self, request: LlmRequest) -> LlmResult:
        client = self._get_client()
        try:
            response = await client.responses.create(**self.build_request(request))
        except (openai.AuthenticationError, openai.PermissionDeniedError) as exc:
            raise LlmError("API キーが使えません", retryable=False) from exc
        except (openai.BadRequestError, openai.UnprocessableEntityError) as exc:
            reason = f"リクエストが受け付けられませんでした ({exc.message[:120]})"
            raise LlmError(reason, retryable=False) from exc
        except openai.NotFoundError as exc:
            raise LlmError("モデルが見つかりません", retryable=False) from exc
        except openai.RateLimitError as exc:
            if exc.code == "insufficient_quota":  # billing: waiting does not help
                raise LlmError("API の利用枠が足りません", retryable=False) from exc
            raise LlmError("API の利用が混み合っています", retryable=True) from exc
        except openai.APIStatusError as exc:
            if exc.status_code >= 500:
                raise LlmError(f"API のサーバーエラー ({exc.status_code})", retryable=True) from exc
            raise LlmError(f"API のエラー ({exc.status_code})", retryable=False) from exc
        except openai.APIConnectionError as exc:  # includes timeouts
            raise LlmError("API に接続できませんでした", retryable=True) from exc
        return parse_openai_response(response, request.model)


def parse_openai_response(response: Any, requested_model: str) -> LlmResult:
    """A Responses API `Response` as an LlmResult. A refusal content item or an incomplete
    response stopped by the content filter → stop_reason "refusal"; out of output tokens →
    "max_tokens" (with whatever text came); a failed / cancelled response → LlmError."""
    status = getattr(response, "status", None)
    usage = _openai_usage(response, requested_model)
    if status in ("failed", "cancelled"):
        # The usage first: a failed or cancelled response may still have been billed.
        error = getattr(response, "error", None)
        detail = getattr(error, "code", None) or status
        raise LlmError(
            f"API の応答が失敗しました ({detail})",
            retryable=status == "failed",
            usage=usage if usage.has_tokens else None,
        )
    refused = any(
        getattr(item, "type", None) == "refusal"
        for output in (response.output or [])
        if getattr(output, "type", None) == "message"
        for item in (output.content or [])
    )
    stop_reason = "end_turn"
    if status == "incomplete":
        details = getattr(response, "incomplete_details", None)
        reason = getattr(details, "reason", None)
        if reason == "max_output_tokens":
            stop_reason = "max_tokens"
        elif reason == "content_filter":
            stop_reason = "refusal"
        else:
            stop_reason = str(reason or "incomplete")
    if refused:
        stop_reason = "refusal"
    sources: dict[str, WebSource] = {}
    for output in response.output or []:
        if getattr(output, "type", None) != "message":
            continue
        for item in output.content or []:
            for note in getattr(item, "annotations", None) or []:
                if getattr(note, "type", None) == "url_citation":
                    _add_source(sources, note.url, getattr(note, "title", None))
    return replace(
        usage,
        text=response.output_text or "",
        stop_reason=stop_reason,
        sources=tuple(sources.values()),
    )


def _openai_usage(response: Any, requested_model: str) -> LlmResult:
    """The token counts of a Response (whatever its status), as an LlmResult without text."""
    usage = getattr(response, "usage", None)
    total_in = cached = written = out = 0
    if usage is not None:
        total_in = _tokens(usage.input_tokens)
        out = _tokens(usage.output_tokens)  # reasoning tokens are part of it (billed as output)
        details_in = getattr(usage, "input_tokens_details", None)
        cached = _tokens(getattr(details_in, "cached_tokens", None))
        written = _tokens(getattr(details_in, "cache_write_tokens", None))
    # docs/AI.md §14: every web_search_call item is one billed tool call.
    searches = sum(
        1
        for output in (getattr(response, "output", None) or [])
        if getattr(output, "type", None) == "web_search_call"
    )
    return LlmResult(
        text="",
        stop_reason=None,
        web_search_requests=searches,
        model=str(getattr(response, "model", None) or requested_model),
        # OpenAI's input_tokens includes the cached and the cache-write tokens.
        input_tokens=max(total_in - cached - written, 0),
        output_tokens=out,
        cache_read_tokens=cached,
        cache_write_tokens=written,
    )


@dataclass
class FakeProvider:
    """A provider for tests: answers with `reply(request)` (or `text`), or raises the queued
    errors first. Records every request."""

    text: str = "了解です。"
    stop_reason: str = "end_turn"
    errors: list[LlmError] = field(default_factory=list)
    reply: Callable[[LlmRequest], str] | None = None
    usage: tuple[int, int, int, int] = (1000, 200, 0, 0)
    requests: list[LlmRequest] = field(default_factory=list)
    # docs/AI.md §14: what a request with web search gets back (ignored without it).
    web_search_requests: int = 0
    sources: tuple[WebSource, ...] = ()

    async def complete(self, request: LlmRequest) -> LlmResult:
        self.requests.append(request)
        if self.errors:
            raise self.errors.pop(0)
        inp, out, cache_read, cache_write = self.usage
        return LlmResult(
            text=self.reply(request) if self.reply else self.text,
            stop_reason=self.stop_reason,
            model=request.model,
            input_tokens=inp,
            output_tokens=out,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            web_search_requests=self.web_search_requests if request.web_search else 0,
            sources=self.sources if request.web_search else (),
        )


def read_api_key(path: str) -> str | None:
    """The key from the secret file, or None (missing, unreadable, a directory, or empty)."""
    if not path:
        return None
    try:
        key = Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return key or None


def provider_of(model: str) -> str:
    """The provider of a model id (unknown ids are Anthropic's, the original default)."""
    return MODEL_PROVIDERS.get(model, ANTHROPIC)


class AiRuntime:
    """What the API and the worker need from the outside world: one provider per vendor, each
    built lazily from its own key file (docs/AI.md §12). A missing key leaves that vendor's bots
    unavailable (checked again on the next use, so a key added later is picked up without a
    restart). Tests set `provider` (answers every model) or `providers[name]` directly."""

    def __init__(
        self,
        key_file: str,
        *,
        openai_key_file: str = "",
        monthly_budget_usd: float = 30.0,
        user_daily_runs: int = 50,
    ) -> None:
        self.key_files = {ANTHROPIC: key_file, OPENAI: openai_key_file}
        self.providers: dict[str, LlmProvider] = {}
        self.provider: LlmProvider | None = None
        # docs/AI.md §3 (AI_MONTHLY_BUDGET_USD, AI_USER_DAILY_RUNS).
        self.monthly_budget_usd = monthly_budget_usd
        self.user_daily_runs = user_daily_runs

    def _named(self, name: str) -> LlmProvider | None:
        if self.provider is not None:
            return self.provider
        if name not in self.providers:
            key = read_api_key(self.key_files.get(name, ""))
            if key is None:
                return None
            log.info("AI: %s enabled (API key read from the secret file)", name)
            self.providers[name] = (
                AnthropicProvider(key) if name == ANTHROPIC else OpenAIProvider(key)
            )
        return self.providers[name]

    def get_provider(self, model: str) -> LlmProvider | None:
        """The provider that serves `model`, or None when its key is not configured."""
        return self._named(provider_of(model))

    def configured(self, name: str) -> bool:
        return self._named(name) is not None

    def serves(self, model: str) -> bool:
        return self.get_provider(model) is not None

    @property
    def available(self) -> bool:
        """At least one provider has a key."""
        return any(self.configured(name) for name in PROVIDERS)
