"""In-memory token-bucket rate limiter (process-local; see ARCHITECTURE.md §7)."""

import math
import time


class RateLimiter:
    def __init__(self, per_minute: float, *, burst: int | None = None) -> None:
        self.rate = per_minute / 60.0
        self.capacity = float(burst if burst is not None else per_minute)
        self._buckets: dict[str, tuple[float, float]] = {}

    def try_acquire(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        tokens, last = self._buckets.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last) * self.rate)
        allowed = tokens >= 1.0
        if allowed:
            tokens -= 1.0
        self._buckets[key] = (tokens, now)
        if len(self._buckets) > 10_000:
            self._prune(now)
        return allowed

    def retry_after_seconds(self, key: str, now: float | None = None) -> int:
        now = time.monotonic() if now is None else now
        tokens, last = self._buckets.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last) * self.rate)
        if tokens >= 1.0:
            return 1
        return max(1, math.ceil((1.0 - tokens) / self.rate))

    def _prune(self, now: float) -> None:
        full_after = self.capacity / self.rate if self.rate else 0
        self._buckets = {k: v for k, v in self._buckets.items() if now - v[1] < full_after}
