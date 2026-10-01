"""Imports every module's models so that ``Base.metadata`` is complete (used by Alembic)."""

from app.core.base import Base
from app.events import models as _event_models
from app.modules.auth import models as _auth_models
from app.modules.calendar import models as _calendar_models
from app.modules.canvases import models as _canvas_models
from app.modules.channel_links import models as _channel_link_models
from app.modules.channels import models as _channel_models
from app.modules.drafts import models as _draft_models
from app.modules.groups import models as _group_models
from app.modules.importer import models as _import_models
from app.modules.invites import models as _invite_models
from app.modules.messages import models as _message_models
from app.modules.notifications import models as _notification_models
from app.modules.recurring import models as _recurring_models
from app.modules.sidebar import models as _sidebar_models
from app.modules.sso import models as _sso_models
from app.modules.tasks import models as _task_models
from app.modules.totp import models as _totp_models
from app.modules.users import models as _user_models
from app.modules.webhooks import models as _webhook_models
from app.modules.workspace import models as _workspace_models

__all__ = [
    "Base",
    "_auth_models",
    "_calendar_models",
    "_canvas_models",
    "_channel_link_models",
    "_channel_models",
    "_draft_models",
    "_event_models",
    "_group_models",
    "_import_models",
    "_invite_models",
    "_message_models",
    "_notification_models",
    "_recurring_models",
    "_sidebar_models",
    "_sso_models",
    "_task_models",
    "_totp_models",
    "_user_models",
    "_webhook_models",
    "_workspace_models",
]
