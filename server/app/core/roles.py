"""Workspace roles and what each may do (docs/ROLES.md §2): the one table.

Every check of an administrative right goes through ``has_capability`` / ``ensure_capability`` (or
the ``require_capability`` dependency in app.modules.auth.deps) with a capability name, never a
``role == "admin"`` comparison, so that a new role is one line here. ``admin`` always has every
capability. Unknown roles have none.
"""

from typing import Final, Literal, Protocol

from app.core.errors import forbidden

Capability = Literal[
    "users.view",
    "users.view_private",
    "users.edit_profile",
    "users.manage",
    "invites.manage",
    "roster.manage",
    "lab.rollover",
    "channels.manage",
    "channels.manage_any",
    "channels.make_public",
    "channels.moderate",
    "emoji.manage",
    "templates.manage",
    "attendance.manage",
    "attendance.configure",
    "reservations.manage",
    "reports.manage",
    "reports.read_private",
    "workspace.settings",
    "groups.manage",
    "integrations.manage",
    "ai.manage",
    "analytics.view",
    "docs.admin",
]

ALL_CAPABILITIES: Final[frozenset[str]] = frozenset(Capability.__args__)  # type: ignore[attr-defined]

# The manager (「運営」): daily operations, nothing security-, privacy-, money- or
# configuration-sensitive (docs/ROLES.md §3).
MANAGER_CAPABILITIES: Final[frozenset[str]] = frozenset(
    {
        "users.view",
        "users.edit_profile",
        "invites.manage",
        "roster.manage",
        "channels.manage",
        "emoji.manage",
        "templates.manage",
        "attendance.manage",
        "reservations.manage",
        "reports.manage",
    }
)

ROLE_CAPABILITIES: Final[dict[str, frozenset[str]]] = {
    "admin": ALL_CAPABILITIES,
    "manager": MANAGER_CAPABILITIES,
    "member": frozenset(),
    "guest": frozenset(),
    "bot": frozenset(),
}

# Roles a person (not a guest, not a bot) has: the attendance board, default channels, workspace
# grants of Docs, the roster's order (docs/ROLES.md §1).
PERSON_ROLES: Final[tuple[str, ...]] = ("admin", "manager", "member")

# Roles an administrator may give (AdminUserCreate / AdminUserUpdate / InviteCreate).
ASSIGNABLE_ROLES: Final[tuple[str, ...]] = ("admin", "manager", "member", "guest")


class HasRole(Protocol):
    @property
    def role(self) -> str: ...


def capabilities_of(role: str | None) -> frozenset[str]:
    return ROLE_CAPABILITIES.get(role or "", frozenset())


def has_capability(user: HasRole, capability: Capability) -> bool:
    return capability in capabilities_of(user.role)


def roles_with(capability: Capability) -> tuple[str, ...]:
    """The roles that have a capability (for SQL filters such as notice audiences)."""
    return tuple(role for role, caps in ROLE_CAPABILITIES.items() if capability in caps)


def ensure_capability(user: HasRole, capability: Capability) -> None:
    """403 when the user lacks it: ``manager_required`` for a capability managers have (so a
    member learns who can), ``admin_required`` for an administrators-only one."""
    if has_capability(user, capability):
        return
    if capability in MANAGER_CAPABILITIES:
        raise forbidden("manager_required", "Administrator or manager role required")
    raise forbidden("admin_required", "Administrator role required")
