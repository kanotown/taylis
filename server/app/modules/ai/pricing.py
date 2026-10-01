"""What a run cost (docs/AI.md §3): Anthropic's prices of 2026-09, per million tokens."""

from decimal import Decimal

# model: (input, output, cache read) in USD per million tokens. A cache write is 1.25 x input.
PRICES: dict[str, tuple[Decimal, Decimal, Decimal]] = {
    "claude-opus-5-5": (Decimal("4"), Decimal("20"), Decimal("0.20")),
    "claude-sonnet-5-5": (Decimal("2"), Decimal("10"), Decimal("0.20")),
    "claude-haiku-4-5": (Decimal("1"), Decimal("5"), Decimal("0.10")),
}
CACHE_WRITE_FACTOR = Decimal("1.25")
_MILLION = Decimal(1_000_000)
_PLACES = Decimal("0.000001")


def price_model(model: str, requested: str) -> str:
    """The model whose prices apply: the one that answered when we know it (a server-side
    fallback may answer with another), else the one asked for. Dated ids
    (claude-…-20260901) count as their family."""
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
) -> Decimal:
    inp, out, cache_read = PRICES[model]
    total = (
        Decimal(input_tokens) * inp
        + Decimal(output_tokens) * out
        + Decimal(cache_read_tokens) * cache_read
        + Decimal(cache_write_tokens) * inp * CACHE_WRITE_FACTOR
    ) / _MILLION
    return total.quantize(_PLACES)
