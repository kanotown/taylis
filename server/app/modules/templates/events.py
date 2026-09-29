"""Events emitted by the templates module (SYNC_PROTOCOL.md §6): no seq.

A workspace template's go to everyone, a personal one's to its owner only.
"""

from app.modules.templates.schemas import TemplateUpdatedData

TEMPLATE_UPDATED = "template.updated"

__all__ = ["TEMPLATE_UPDATED", "TemplateUpdatedData"]
