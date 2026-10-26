"""Events emitted by the 備品 module (docs/LENDING.md §9, SYNC_PROTOCOL.md §6): no seq."""

from app.modules.lending.schemas import LendingNoticeData, LendingUpdatedData

LENDING_UPDATED = "lending.updated"  # audience all
LENDING_NOTICE = "lending.notice"  # audience user (M169)

__all__ = ["LENDING_NOTICE", "LENDING_UPDATED", "LendingNoticeData", "LendingUpdatedData"]
