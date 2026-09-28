"""UUIDv7 generation (RFC 9562), monotonic within a process."""

import os
import threading
import time
import uuid

_lock = threading.Lock()
_last_ms = 0
_last_rand_a = 0


def uuid7() -> uuid.UUID:
    global _last_ms, _last_rand_a
    with _lock:
        ms = time.time_ns() // 1_000_000
        if ms <= _last_ms:
            # Same millisecond (or clock went backwards): keep ordering by bumping the 12-bit
            # counter, spilling into the next millisecond on overflow.
            ms = _last_ms
            rand_a = _last_rand_a + 1
            if rand_a > 0xFFF:
                ms += 1
                rand_a = int.from_bytes(os.urandom(2), "big") & 0xFFF
        else:
            rand_a = int.from_bytes(os.urandom(2), "big") & 0xFFF
        _last_ms, _last_rand_a = ms, rand_a

    rand_b = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    value = (ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= rand_a << 64
    value |= 0b10 << 62
    value |= rand_b
    return uuid.UUID(int=value)


def uuid7_at(ms: int) -> uuid.UUID:
    """A UUIDv7 for a past moment (epoch milliseconds): imported rows sort by their own time."""
    rand_a = int.from_bytes(os.urandom(2), "big") & 0xFFF
    rand_b = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    value = (ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= rand_a << 64
    value |= 0b10 << 62
    value |= rand_b
    return uuid.UUID(int=value)
