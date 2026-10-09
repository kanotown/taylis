"""Events emitted by the threads module (THREADS.md §4)."""

from app.modules.threads.schemas import ThreadsReadAllData, ThreadUpdatedData

THREAD_UPDATED = "thread.updated"
THREADS_READ_ALL = "threads.read_all"

__all__ = ["THREADS_READ_ALL", "THREAD_UPDATED", "ThreadUpdatedData", "ThreadsReadAllData"]
