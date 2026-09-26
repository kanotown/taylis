"""Imports every module's models so that ``Base.metadata`` is complete (used by Alembic)."""

from app.core.base import Base
from app.events import models as _event_models
from app.modules.auth import models as _auth_models
from app.modules.channels import models as _channel_models
from app.modules.messages import models as _message_models
from app.modules.notifications import models as _notification_models
from app.modules.users import models as _user_models

__all__ = [
    "Base",
    "_auth_models",
    "_channel_models",
    "_event_models",
    "_message_models",
    "_notification_models",
    "_user_models",
]
