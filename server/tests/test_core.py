import uuid

from app.core.ids import uuid7
from app.core.ratelimit import RateLimiter


def test_uuid7_is_version_7_and_monotonic() -> None:
    ids = [uuid7() for _ in range(2000)]
    assert all(i.version == 7 for i in ids)
    assert all(isinstance(i, uuid.UUID) for i in ids)
    assert ids == sorted(ids)
    assert len(set(ids)) == len(ids)


def test_rate_limiter_refills_over_time() -> None:
    limiter = RateLimiter(per_minute=60)  # one token per second, burst 60
    now = 1000.0
    for _ in range(60):
        assert limiter.try_acquire("k", now)
    assert not limiter.try_acquire("k", now)
    assert limiter.retry_after_seconds("k", now) == 1
    assert limiter.try_acquire("k", now + 1.0)
    assert limiter.try_acquire("other", now)
