"""The boundary to the model provider (docs/AI.md §2.4).

`LlmProvider` is all the rest of the module sees: one request in, the text and the token counts
out, or an `LlmError` that says whether trying again later may help. `AnthropicProvider` wraps
the official SDK; `FakeProvider` answers tests without the network. Another provider would be a
third implementation here.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import anthropic

log = logging.getLogger("app.ai")

HAIKU = "claude-haiku-4-5"
# Server-side fallback on a safety refusal (Opus 5.5 / Sonnet 5.5 only).
FALLBACK_BETA = "server-side-fallback-2026-07-01"


@dataclass(frozen=True)
class LlmRequest:
    model: str
    effort: str
    system: str
    user: str
    max_tokens: int


@dataclass(frozen=True)
class LlmResult:
    text: str
    # end_turn | max_tokens | refusal | …, as the API says.
    stop_reason: str | None
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


class LlmError(Exception):
    """A call that did not produce a result. `retryable`: a rate limit, an overload or a network
    problem (the worker tries again later); otherwise trying again would fail the same way."""

    def __init__(self, reason: str, *, retryable: bool) -> None:
        super().__init__(reason)
        self.reason = reason
        self.retryable = retryable


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
        client = self._get_client()
        # The system prompt is the same for every run of a bot: cache it.
        system: Any = [
            {"type": "text", "text": request.system, "cache_control": {"type": "ephemeral"}}
        ]
        messages: Any = [{"role": "user", "content": request.user}]
        output_config: Any = {"effort": request.effort}
        try:
            response: Any
            if request.model == HAIKU:
                response = await client.messages.create(
                    model=request.model,
                    max_tokens=request.max_tokens,
                    system=system,
                    messages=messages,
                )
            else:
                # Opus 5.5 always thinks (no `thinking` parameter); effort sets how much.
                response = await client.beta.messages.create(
                    model=request.model,
                    max_tokens=request.max_tokens,
                    system=system,
                    messages=messages,
                    output_config=output_config,
                    betas=[FALLBACK_BETA],
                    fallbacks="default",
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
        text = "".join(block.text for block in response.content if block.type == "text")
        usage = response.usage
        return LlmResult(
            text=text,
            stop_reason=response.stop_reason,
            model=str(response.model or request.model),
            input_tokens=_tokens(usage.input_tokens),
            output_tokens=_tokens(usage.output_tokens),
            cache_read_tokens=_tokens(getattr(usage, "cache_read_input_tokens", None)),
            cache_write_tokens=_tokens(getattr(usage, "cache_creation_input_tokens", None)),
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


class AiRuntime:
    """What the API and the worker need from the outside world: the provider, built lazily from
    the key file. A missing key leaves the AI unavailable (checked again on the next use, so a
    key added later is picked up without a restart). Tests set `provider` directly."""

    def __init__(
        self, key_file: str, *, monthly_budget_usd: float = 30.0, user_daily_runs: int = 50
    ) -> None:
        self.key_file = key_file
        self.provider: LlmProvider | None = None
        # docs/AI.md §3 (AI_MONTHLY_BUDGET_USD, AI_USER_DAILY_RUNS).
        self.monthly_budget_usd = monthly_budget_usd
        self.user_daily_runs = user_daily_runs

    def get_provider(self) -> LlmProvider | None:
        if self.provider is None:
            key = read_api_key(self.key_file)
            if key is not None:
                log.info("AI enabled (API key read from the secret file)")
                self.provider = AnthropicProvider(key)
        return self.provider

    @property
    def available(self) -> bool:
        return self.get_provider() is not None
