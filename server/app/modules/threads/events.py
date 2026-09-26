"""Events emitted by the threads module (THREADS.md §4)."""

from app.modules.threads.schemas import ThreadUpdatedData

THREAD_UPDATED = "thread.updated"

__all__ = ["THREAD_UPDATED", "ThreadUpdatedData"]
