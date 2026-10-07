"""The 「運営」 (manager) role and the capability table (M142, docs/ROLES.md).

The key test is the matrix: every administration endpoint by {admin, manager, member, guest},
allowed or denied as docs/ROLES.md §2 decides. "Allowed" means the capability check passed (the
probe may still end in 404 / 409 / 422 on its made-up ids and bodies); "denied" means 403 with the
capability's code.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.roles import (
    ALL_CAPABILITIES,
    MANAGER_CAPABILITIES,
    PERSON_ROLES,
    ROLE_CAPABILITIES,
    capabilities_of,
    roles_with,
)
from app.modules.audit.models import AuditLog
from app.modules.users.models import User
from tests.helpers import make_user

Level = Literal["manager", "admin"]
ROLES = ("admin", "manager", "member", "guest")
X = "00000000-0000-4000-8000-000000000001"  # an id that does not exist


@dataclass(frozen=True)
class Probe:
    method: str
    path: str
    level: Level  # who may: "manager" = admins and managers, "admin" = administrators only
    body: dict[str, Any] | None = None
    # The router's gate when the service decides the rest (PATCH /admin/users with a role, say):
    # a member is stopped there with manager_required.
    gate: Level | None = None
    # Codes that differ from the capability's for a role (a service-level check that comes first).
    codes: dict[str, str] = field(default_factory=dict)
    params: dict[str, str] | None = None

    def code_for(self, role: str) -> str:
        if role in self.codes:
            return self.codes[role]
        if role == "manager":
            return "admin_required"
        gate = self.gate or self.level
        return "manager_required" if gate == "manager" else "admin_required"

    @property
    def id(self) -> str:
        extra = "" if self.body is None else "-" + ",".join(sorted(self.body))
        return f"{self.method} {self.path}{extra}"


M: Level = "manager"
A: Level = "admin"
PROBES: list[Probe] = [
    # --- users (admin module) ---
    Probe("GET", "/admin/users", M),
    Probe("PATCH", f"/admin/users/{X}", M, {"display_name": "New name"}),
    Probe("PATCH", f"/admin/users/{X}", M, {"title": "D1"}),
    Probe("PATCH", f"/admin/users/{X}", A, {"role": "member"}, gate=M),
    Probe("PATCH", f"/admin/users/{X}", A, {"role": "manager"}, gate=M),
    Probe("PATCH", f"/admin/users/{X}", A, {"deactivated": True}, gate=M),
    Probe("PATCH", f"/admin/users/{X}", A, {"username": "renamed"}, gate=M),
    Probe("POST", "/admin/users", A, {"username": "newbie", "display_name": "Newbie"}),
    Probe("POST", f"/admin/users/{X}/reset-password", A),
    Probe("DELETE", f"/admin/users/{X}/sessions", A),
    Probe("POST", f"/admin/users/{X}/anonymize", A),
    Probe("DELETE", f"/admin/users/{X}/totp", A),
    # --- invites ---
    Probe("GET", "/admin/invites", M),
    Probe("POST", "/admin/invites", M, {"role": "member"}),
    Probe("POST", "/admin/invites", M, {"role": "guest"}),
    Probe("POST", "/admin/invites", A, {"role": "manager"}, gate=M),
    Probe("POST", "/admin/invites", A, {"role": "admin"}, gate=M),
    Probe("DELETE", f"/admin/invites/{X}", M),
    # --- roster and the yearly rollover ---
    Probe("PUT", f"/lab/roster/{X}", M, {"affiliation": "student", "grade": "M1"}),
    Probe("DELETE", f"/lab/roster/{X}", M),
    Probe("POST", "/lab/rollover/preview", A, {"academic_year": 2027}),
    Probe("GET", "/lab/rollovers", A),
    Probe("POST", "/lab/rollovers", A, {}),
    Probe("POST", "/lab/rollovers/2027/undo", A),
    # --- workspace settings and default channels ---
    Probe("GET", "/admin/workspace-settings", M),
    Probe("PATCH", "/admin/workspace-settings", M, {"default_channel_ids": []}),
    Probe("POST", "/admin/workspace-settings/apply-default-channels", M, {"dry_run": True}),
    Probe("PATCH", "/admin/workspace-settings", A, {"preview_before_join": True}, gate=M),
    Probe("PATCH", "/admin/workspace-settings", A, {"show_membership_messages": False}, gate=M),
    Probe("PATCH", "/admin/workspace-settings", A, {"in_app_calls_enabled": True}, gate=M),
    Probe("POST", "/admin/workspace-settings/icon", A),
    Probe("DELETE", "/admin/workspace-settings/icon", A),
    # --- emoji ---
    Probe("POST", "/emoji/packs", M, {"name": "Lab pack"}),
    Probe("POST", "/emoji/packs/import", M),
    Probe("PATCH", f"/emoji/packs/{X}", M, {"name": "Renamed"}),
    Probe("DELETE", f"/emoji/packs/{X}", M),
    # --- templates ---
    Probe(
        "POST",
        "/templates",
        M,
        {"scope": "workspace", "name": "日報", "body": "今日やったこと"},
        codes={"guest": "manager_required"},
    ),
    Probe("GET", "/admin/canvas-templates", M),
    Probe("POST", "/admin/canvas-templates", M, {"name": "議事録", "title": "議事録", "body": "x"}),
    Probe("PATCH", f"/admin/canvas-templates/{X}", M, {"name": "Renamed"}),
    Probe("DELETE", f"/admin/canvas-templates/{X}", M),
    # --- attendance ---
    Probe("GET", "/admin/attendance/settings", M),
    Probe("POST", "/admin/attendance/states", M, {}),
    Probe("PUT", "/admin/attendance/states/order", M, {}),
    Probe("PATCH", f"/admin/attendance/states/{X}", M, {}),
    Probe("DELETE", f"/admin/attendance/states/{X}", M),
    Probe("PUT", f"/admin/attendance/users/{X}", M, {}),
    Probe("PATCH", "/admin/attendance/settings", A, {"enabled": True}),
    Probe("GET", "/admin/attendance/integrations", A),
    Probe("POST", "/admin/attendance/integrations", A, {}),
    Probe("PATCH", f"/admin/attendance/integrations/{X}", A, {}),
    Probe("DELETE", f"/admin/attendance/integrations/{X}", A),
    Probe("POST", f"/admin/attendance/integrations/{X}/token", A),
    Probe("DELETE", f"/admin/attendance/integrations/{X}/token", A),
    Probe("POST", f"/admin/attendance/integrations/{X}/test", A),
    Probe("GET", f"/admin/attendance/integrations/{X}/deliveries", A),
    # --- reservation pools (a member is told by the pool's own rule) ---
    Probe(
        "POST",
        "/reservation-pools",
        M,
        {"name": "GPU", "capacity": 1},
        codes={"member": "reservation_manage_restricted", "guest": "reservation_manage_restricted"},
    ),
    # --- reports ---
    Probe("GET", "/admin/reports", M),
    Probe("POST", f"/admin/reports/{X}/resolve", M),
    Probe("POST", f"/admin/reports/{X}/reopen", M),
    # --- administrators only ---
    Probe("POST", "/admin/groups", A, {}),
    Probe("PATCH", f"/admin/groups/{X}", A, {}),
    Probe("DELETE", f"/admin/groups/{X}", A),
    Probe("GET", "/admin/ai/agents", A),
    Probe("POST", "/admin/ai/agents", A, {}),
    Probe("PATCH", f"/admin/ai/agents/{X}", A, {}),
    Probe("DELETE", f"/admin/ai/agents/{X}", A),
    Probe("GET", "/admin/ai/usage", A),
    Probe("GET", "/admin/ai/providers", A),
    Probe("GET", "/admin/webhooks", A),
    Probe("POST", "/admin/webhooks", A, {}),
    Probe("PATCH", f"/admin/webhooks/{X}", A, {}),
    Probe("DELETE", f"/admin/webhooks/{X}", A),
    Probe("GET", "/admin/analytics/overview", A),
    Probe("GET", "/admin/analytics/members", A),
    Probe("GET", "/admin/analytics/members.csv", A),
    Probe("GET", "/admin/wiki/pages", A),
    Probe("POST", f"/admin/wiki/pages/{X}/takeover", A),
    Probe("DELETE", f"/admin/wiki/pages/{X}", A),
]


async def _people(db: AsyncSession) -> dict[str, User]:
    return {role: await make_user(db, f"{role}-person", role=role) for role in ROLES}


async def _call(client: AsyncClient, probe: Probe) -> Any:
    kwargs: dict[str, Any] = {}
    if probe.body is not None:
        kwargs["json"] = probe.body
    if probe.params is not None:
        kwargs["params"] = probe.params
    return await client.request(probe.method, f"/api/v1{probe.path}", **kwargs)


@pytest.mark.parametrize("probe", PROBES, ids=[p.id for p in PROBES])
async def test_matrix(
    probe: Probe, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    for role in ROLES:
        as_user(people[role])
        response = await _call(client, probe)
        allowed = role == "admin" or (role == "manager" and probe.level == "manager")
        if allowed:
            assert response.status_code != 403, (role, response.text)
            assert response.status_code < 500, (role, response.text)
        else:
            assert response.status_code == 403, (role, response.text)
            assert response.json()["error"]["code"] == probe.code_for(role), (role, response.text)


def test_the_table() -> None:
    """admin = everything; the manager's list is the one docs/ROLES.md §2 decides; the others
    nothing; the admin-only rights never leak to managers."""
    assert ROLE_CAPABILITIES["admin"] == ALL_CAPABILITIES
    assert MANAGER_CAPABILITIES < ALL_CAPABILITIES
    assert sorted(MANAGER_CAPABILITIES) == [
        "attendance.manage",
        "channels.manage",
        "emoji.manage",
        "invites.manage",
        "reports.manage",
        "reservations.manage",
        "roster.manage",
        "templates.manage",
        "users.edit_profile",
        "users.view",
    ]
    for role in ("member", "guest", "bot", "", "someday"):
        assert capabilities_of(role) == frozenset()
    assert PERSON_ROLES == ("admin", "manager", "member")
    assert roles_with("channels.moderate") == ("admin",)
    assert roles_with("reservations.manage") == ("admin", "manager")


async def test_me_exposes_capabilities(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    for role in ROLES:
        as_user(people[role])
        me = (await client.get("/api/v1/users/me")).json()
        assert me["role"] == role
        assert me["capabilities"] == sorted(capabilities_of(role))
        boot = (await client.get("/api/v1/sync/bootstrap")).json()
        assert boot["me"]["capabilities"] == me["capabilities"]
    # Everyone else sees a manager's role like any other value.
    as_user(people["member"])
    listed = {u["id"]: u for u in (await client.get("/api/v1/users")).json()}
    assert listed[str(people["manager"].id)]["role"] == "manager"
    assert "capabilities" not in listed[str(people["manager"].id)]


async def _audit_rows(db: AsyncSession, action: str) -> list[AuditLog]:
    stmt = select(AuditLog).where(AuditLog.action == action).order_by(AuditLog.id)
    return list((await db.execute(stmt.execution_options(populate_existing=True))).scalars())


async def test_only_admins_change_roles(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    student = await make_user(db, "student")
    as_user(people["manager"])
    for body in ({"role": "manager"}, {"role": "admin"}, {"role": "member"}):
        for target in (student, people["manager"], people["admin"]):
            response = await client.patch(f"/api/v1/admin/users/{target.id}", json=body)
            assert response.status_code in (403, 409), response.text
    # The administrator makes the student a manager: audited with the actor's role.
    as_user(people["admin"])
    response = await client.patch(f"/api/v1/admin/users/{student.id}", json={"role": "manager"})
    assert response.status_code == 200 and response.json()["role"] == "manager"
    rows = await _audit_rows(db, "admin.user_updated")
    assert rows[-1].details == {"role": "manager"} and rows[-1].actor_role == "admin"
    # And the new manager has the manager's rights at once.
    await db.refresh(student)
    as_user(student)
    assert (await client.get("/api/v1/admin/users")).status_code == 200
    assert (await client.get("/api/v1/admin/webhooks")).status_code == 403
    # Back to member: the rights go.
    as_user(people["admin"])
    response = await client.patch(f"/api/v1/admin/users/{student.id}", json={"role": "member"})
    assert response.status_code == 200
    await db.refresh(student)
    as_user(student)
    assert (await client.get("/api/v1/admin/users")).status_code == 403


async def test_manager_edits_member_profiles_only(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    other_manager = await make_user(db, "other-manager", role="manager")
    bot = await make_user(db, "a-bot", role="bot")
    as_user(people["manager"])
    for target in (people["member"], people["guest"]):
        response = await client.patch(
            f"/api/v1/admin/users/{target.id}", json={"display_name": " 山田 太郎 ", "title": "M2"}
        )
        assert response.status_code == 200, response.text
        out = response.json()
        assert out["display_name"] == "山田 太郎" and out["title"] == "M2"
        assert out["email"] is None and out["last_active_at"] is None
    cleared = await client.patch(f"/api/v1/admin/users/{people['member'].id}", json={"title": None})
    assert cleared.json()["title"] is None
    for target in (people["admin"], other_manager, bot):
        response = await client.patch(f"/api/v1/admin/users/{target.id}", json={"title": "x"})
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "admin_required"
    me = await client.patch(f"/api/v1/admin/users/{people['manager'].id}", json={"title": "x"})
    assert me.status_code == 409 and me.json()["error"]["code"] == "cannot_modify_self"

    rows = await _audit_rows(db, "admin.user_updated")
    assert [r.actor_role for r in rows] == ["manager"] * 3
    assert rows[0].details == {"display_name": " 山田 太郎 ", "title": "M2"}
    assert rows[2].details == {"title": None}
    # The member sees the new name in the user list (user.updated went out too).
    as_user(people["member"])
    await db.refresh(people["member"])
    me_out = (await client.get("/api/v1/users/me")).json()
    assert me_out["display_name"] == "山田 太郎"


async def test_manager_user_list_hides_private_fields(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    people["member"].email = "member@example.com"
    await db.commit()
    as_user(people["admin"])
    full = {u["username"]: u for u in (await client.get("/api/v1/admin/users")).json()}
    assert full["member-person"]["email"] == "member@example.com"
    as_user(people["manager"])
    seen = {u["username"]: u for u in (await client.get("/api/v1/admin/users")).json()}
    assert set(seen) == set(full)
    for row in seen.values():
        assert row["email"] is None
        assert row["last_login_at"] is None and row["last_active_at"] is None
        assert row["totp_enabled"] is False


async def test_manager_invites_members_and_guests(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    as_user(people["manager"])
    response = await client.post("/api/v1/admin/invites", json={"role": "member"})
    assert response.status_code == 201
    invite_id = response.json()["invite"]["id"]
    rows = await _audit_rows(db, "admin.invite_created")
    assert rows[-1].actor_role == "manager"
    revoked = await client.delete(f"/api/v1/admin/invites/{invite_id}")
    assert revoked.status_code == 204
    # An administrator's invite makes a manager.
    as_user(people["admin"])
    made = await client.post("/api/v1/admin/invites", json={"role": "manager"})
    assert made.status_code == 201
    token = made.json()["token"]
    preview = await client.get(f"/api/v1/invites/{token}")
    assert preview.json()["role"] == "manager"
    accepted = await client.post(
        f"/api/v1/invites/{token}/accept",
        json={
            "username": "newmanager",
            "display_name": "New",
            "password": "a-long-password-1",
            "device": {"platform": "desktop"},
        },
    )
    assert accepted.status_code == 201, accepted.text
    new = (await db.execute(select(User).where(User.username == "newmanager"))).scalar_one()
    assert new.role == "manager"


async def test_roster_not_own_line_nor_an_admins(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    as_user(people["manager"])
    line = {"affiliation": "faculty"}
    own = await client.put(f"/api/v1/lab/roster/{people['manager'].id}", json=line)
    assert own.status_code == 409 and own.json()["error"]["code"] == "cannot_modify_self"
    admins = await client.put(f"/api/v1/lab/roster/{people['admin'].id}", json=line)
    assert admins.status_code == 403 and admins.json()["error"]["code"] == "admin_required"
    ok = await client.put(
        f"/api/v1/lab/roster/{people['member'].id}", json={"affiliation": "student", "grade": "M1"}
    )
    assert ok.status_code == 200, ok.text
    assert (await _audit_rows(db, "admin.roster_updated"))[-1].actor_role == "manager"
    removed = await client.delete(f"/api/v1/lab/roster/{people['member'].id}")
    assert removed.status_code == 204
    assert (await _audit_rows(db, "admin.roster_removed"))[-1].actor_role == "manager"


async def _channel(client: AsyncClient, name: str, kind: str = "public") -> dict[str, Any]:
    response = await client.post("/api/v1/channels", json={"name": name, "type": kind})
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


async def test_manager_manages_channels_but_not_unjoined_private_ones(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    owner = await make_user(db, "owner")
    as_user(owner)
    public = await _channel(client, "general-lab")
    secret = await _channel(client, "students-only", "private")
    joined = await _channel(client, "joined-private", "private")
    added = await client.post(
        f"/api/v1/channels/{joined['id']}/members", json={"user_id": str(people["manager"].id)}
    )
    assert added.status_code == 200, added.text
    await client.post(
        f"/api/v1/channels/{public['id']}/members", json={"user_id": str(people["member"].id)}
    )
    message = await _post(client, public["id"], "the owner's message")
    dm = await client.post("/api/v1/dms", json={"user_ids": [str(people["member"].id)]})
    assert dm.status_code in (200, 201), dm.text

    as_user(people["manager"])
    renamed = await client.patch(f"/api/v1/channels/{public['id']}", json={"topic": "新しい話題"})
    assert renamed.status_code == 200, renamed.text
    row = (await _audit_rows(db, "channel.updated"))[-1]
    assert row.actor_role == "manager" and row.details == {"topic": "新しい話題"}
    removed = await client.delete(f"/api/v1/channels/{public['id']}/members/{people['member'].id}")
    assert removed.status_code == 204
    assert (await _audit_rows(db, "channel.member_removed"))[-1].actor_role == "manager"
    archived = await client.post(f"/api/v1/channels/{public['id']}/archive")
    assert archived.status_code == 200
    assert (await _audit_rows(db, "channel.archived"))[-1].actor_role == "manager"
    assert (await client.post(f"/api/v1/channels/{public['id']}/unarchive")).status_code == 200
    # A private channel the manager belongs to: yes (as an owner would).
    mine = await client.patch(f"/api/v1/channels/{joined['id']}", json={"topic": "x"})
    assert mine.status_code == 200
    # Not one they are not in, nor a DM, whatever the operation.
    for path, method, body in (
        (f"/channels/{secret['id']}", "PATCH", {"topic": "peek"}),
        (f"/channels/{secret['id']}/archive", "POST", None),
        (f"/channels/{secret['id']}/members/{owner.id}", "DELETE", None),
        (f"/channels/{dm.json()['id']}/archive", "POST", None),
    ):
        response = await client.request(method, f"/api/v1{path}", json=body)
        assert response.status_code == 403, (path, response.text)
        assert response.json()["error"]["code"] == "not_a_member"
    # Making a private channel public stays with administrators (a member one, L4).
    made_public = await client.patch(f"/api/v1/channels/{joined['id']}", json={"type": "public"})
    assert made_public.status_code == 403
    assert made_public.json()["error"]["code"] == "admin_required"
    # Inside a conversation a manager is a member: no deleting someone else's message.
    assert (await client.post(f"/api/v1/channels/{public['id']}/join")).status_code == 200
    deleted = await client.delete(f"/api/v1/messages/{message['id']}")
    assert deleted.status_code == 403 and deleted.json()["error"]["code"] == "not_message_owner"
    # Nor reading the private channel.
    read = await client.get(f"/api/v1/channels/{secret['id']}/messages")
    assert read.status_code == 403

    # The administrator still manages the private channel they are not in.
    as_user(people["admin"])
    admin_edit = await client.patch(f"/api/v1/channels/{secret['id']}", json={"topic": "ok"})
    assert admin_edit.status_code == 200
    assert (await _audit_rows(db, "channel.updated"))[-1].actor_role == "admin"


async def test_manager_does_not_see_report_snapshots_of_unreadable_conversations(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    secret = await _channel(client, "secret-room", "private")
    public = await _channel(client, "open-room")
    await client.post(f"/api/v1/channels/{secret['id']}/members", json={"user_id": str(bob.id)})
    await client.post(f"/api/v1/channels/{public['id']}/members", json={"user_id": str(bob.id)})
    hidden_msg = await _post(client, secret["id"], "秘密の本文")
    open_msg = await _post(client, public["id"], "公開の本文")
    as_user(bob)
    for message in (hidden_msg, open_msg):
        response = await client.post(
            f"/api/v1/messages/{message['id']}/report", json={"reason": "spam"}
        )
        assert response.status_code == 201, response.text
    general = await client.post("/api/v1/reports", json={"category": "feedback", "note": "要望"})
    assert general.status_code == 201

    as_user(people["manager"])
    reports = {r["message_id"]: r for r in (await client.get("/api/v1/admin/reports")).json()}
    hidden = reports[hidden_msg["id"]]
    assert hidden["snapshot_hidden"] is True
    assert hidden["body_snapshot"] == "" and hidden["channel_name"] is None
    shown = reports[open_msg["id"]]
    assert shown["snapshot_hidden"] is False and shown["body_snapshot"] == "公開の本文"
    assert reports[None]["note"] == "要望"
    resolved = await client.post(f"/api/v1/admin/reports/{hidden['id']}/resolve")
    assert resolved.status_code == 200
    assert resolved.json()["body_snapshot"] == "" and resolved.json()["status"] == "resolved"
    assert (await _audit_rows(db, "moderation.report_resolved"))[-1].actor_role == "manager"

    as_user(people["admin"])
    reports = {
        r["message_id"]: r for r in (await client.get("/api/v1/admin/reports?status=all")).json()
    }
    assert reports[hidden_msg["id"]]["body_snapshot"] == "秘密の本文"
    assert reports[hidden_msg["id"]]["snapshot_hidden"] is False


async def test_manager_actions_on_others_content_are_audited(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    people = await _people(db)
    as_user(people["manager"])
    created = await client.post(
        "/api/v1/templates", json={"scope": "workspace", "name": "週報", "body": "今週"}
    )
    assert created.status_code == 201, created.text
    tid = created.json()["id"]
    assert (
        await client.patch(f"/api/v1/templates/{tid}", json={"body": "来週"})
    ).status_code == 200
    assert (await client.delete(f"/api/v1/templates/{tid}")).status_code == 204
    actions = [r.action for r in (await db.execute(select(AuditLog))).scalars()]
    assert {"template.created", "template.updated", "template.deleted"} <= set(actions)
    canvas = await client.post(
        "/api/v1/admin/canvas-templates", json={"name": "議事録", "title": "議事録", "body": "x"}
    )
    assert canvas.status_code == 201, canvas.text
    assert (await _audit_rows(db, "canvas_template.created"))[-1].actor_role == "manager"
    # A personal template is nobody else's business: not audited.
    as_user(people["member"])
    own = await client.post("/api/v1/templates", json={"name": "mine", "body": "x"})
    assert own.status_code == 201
    assert len(await _audit_rows(db, "template.created")) == 1


async def test_manager_never_gets_docs_administration(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """The Docs administration lists every page's title (private ones too): administrators only
    (docs/ROLES.md §4.4); test_matrix covers the takeover and purge."""
    people = await _people(db)
    as_user(people["member"])
    page = await client.post(
        "/api/v1/wiki/pages",
        json={"title": "非公開のメモ", "access": "private", "client_save_id": str(uuid.uuid4())},
    )
    assert page.status_code == 201, page.text
    as_user(people["manager"])
    listed = await client.get("/api/v1/admin/wiki/pages")
    assert listed.status_code == 403
    read = await client.get(f"/api/v1/wiki/pages/{page.json()['id']}")
    assert read.status_code == 404
