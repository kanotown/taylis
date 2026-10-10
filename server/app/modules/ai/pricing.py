"""What a run cost (docs/AI.md §3, §12), per million tokens.

Token counts are disjoint here (LlmResult): `input_tokens` is the uncached input only, cache reads
and cache writes are counted apart, and `output_tokens` includes any reasoning tokens.
"""

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Price:
    """USD per million tokens."""

    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write: Decimal


def _anthropic(inp: str, out: str, cache_read: str) -> Price:
    # Anthropic, 2026-09: a cache write is 1.25 x the input price.
    return Price(Decimal(inp), Decimal(out), Decimal(cache_read), Decimal(inp) * Decimal("1.25"))


PRICES: dict[str, Price] = {
    # Anthropic, checked 2026-10-10 on https://platform.claude.com/docs/en/about-claude/pricing
    # (input, output, cache hits; 5-minute cache writes are 1.25 x the input).
    "claude-fable-5-1": _anthropic("10", "50", "0.25"),
    "claude-opus-5-5": _anthropic("4", "20", "0.20"),
    "claude-sonnet-5-5": _anthropic("2", "10", "0.10"),
    "claude-haiku-4-5": _anthropic("1", "5", "0.10"),
    # OpenAI, checked 2026-10-10 on https://developers.openai.com/api/docs/pricing and the model
    # pages …/api/docs/models/<id> (input, output, cached input, cache writes; short context).
    "gpt-6-astra": Price(Decimal("10"), Decimal("50"), Decimal("1"), Decimal("12.50")),
    "gpt-6.1-sol": Price(Decimal("2"), Decimal("10"), Decimal("0.10"), Decimal("2.50")),
    "gpt-6-luna": Price(Decimal("0.10"), Decimal("0.50"), Decimal("0.01"), Decimal("0.125")),
}
# docs/AI.md §14: one web search, on top of the tokens (the results come back as input tokens).
# Anthropic: $10 per 1,000 searches (pricing page above, "Web search tool"); OpenAI: $10 per 1k
# web_search calls ("Web search (all models)", search content tokens at the model's rates).
WEB_SEARCH_USD = Decimal("0.01")
# The input one search may add, for the reservation only (results are filtered on the provider's
# side, but a page of results is easily several thousand tokens).
WEB_SEARCH_INPUT_TOKENS = 10_000
_MILLION = Decimal(1_000_000)
_PLACES = Decimal("0.000001")


def price_model(model: str, requested: str) -> str:
    """The model whose prices apply: the one that answered when we know it (a server-side
    fallback may answer with another), else the one asked for. Dated ids
    (claude-…-20260901, gpt-…-2026-10-01) count as their family."""
    for candidate in (model, requested):
        for known in PRICES:
            if candidate == known or candidate.startswith(known + "-"):
                return known
    return requested if requested in PRICES else "claude-opus-5-5"


def cost_usd(
    model: str,
    *,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
    web_search_requests: int = 0,
) -> Decimal:
    price = PRICES[model]
    total = (
        Decimal(input_tokens) * price.input
        + Decimal(output_tokens) * price.output
        + Decimal(cache_read_tokens) * price.cache_read
        + Decimal(cache_write_tokens) * price.cache_write
    ) / _MILLION + Decimal(web_search_requests) * WEB_SEARCH_USD
    return total.quantize(_PLACES)


# A conservative token count for text not yet sent (docs/AI.md §3, the budget reservation): two
# tokens per character (Japanese is about one, English a quarter; rare kanji may take more), plus
# room for the message framing.
TOKENS_PER_CHAR = 2
FRAMING_TOKENS = 500


def estimate_usd(
    model: str, *, input_chars: int, max_output_tokens: int, web_searches: int = 0
) -> Decimal:
    """The most one attempt is expected to cost: every input token at the dearer of the input and
    the cache-write price, and the whole output allowance (reasoning included) used. With web
    search (docs/AI.md §14), every allowed search made and its results read as input."""
    price = PRICES[price_model("", model)]
    input_tokens = Decimal(
        input_chars * TOKENS_PER_CHAR + FRAMING_TOKENS + web_searches * WEB_SEARCH_INPUT_TOKENS
    )
    total = (
        input_tokens * max(price.input, price.cache_write)
        + Decimal(max_output_tokens) * price.output
    ) / _MILLION + Decimal(web_searches) * WEB_SEARCH_USD
    return total.quantize(_PLACES)
