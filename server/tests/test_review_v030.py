"""Review v0.1.30 (server): regression tests for the fixed items. #1 (default channels racing a
channel made private or archived) and #7 (two people taking the same free username) are here; #2
is in test_slack_import.py and #4 in test_workflows.py (with the shared vectors)."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog
from app.modules.channels import repository as channel_repo
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.channels.schemas import ChannelUpdate
from app.modules.groups import service as groups
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.users.models import User
from app.modules.workspace import service as workspace
from tests.helpers import make_user
from tests.test_default_channels import APPLY, _channels_of, setup  # noqa: F401 (fixture)

API = "/api/v1"


# --- #1: 「今いる人も全員入れる」 / a new account vs. a channel made private or archived ---


async def _change(app: FastAPI, root_id: uuid.UUID, cid: str, action: str) -> str | None:
    """Make the channel private and post in it, or archive it, in a session of its own (another
    request). Returns the id of the post made after the conversion."""
    async with app.state.db.session_factory() as session:
        root = await session.get(User, root_id)
        assert root is not None
        if action == "archive":
            await channels.archive_channel(session, root, uuid.UUID(cid))
            return None
        await channels.update_channel(session, root, uuid.UUID(cid), ChannelUpdate(type="private"))
        message, _ = await messages.create_message(
            session,
            root,
            uuid.UUID(cid),
            MessageCreate(client_msg_id=uuid.uuid4(), body="PRIVATE AFTER CONVERSION"),
        )
        return str(message.id)


async def _run_path(client: AsyncClient, path: str) -> str:
    """The joining operation; returns the id of the person it should have added."""
    if path == "apply":
        response = await client.post(APPLY, json={})
        assert response.status_code == 200, response.text
        return ""
    created = await client.post(
        f"{API}/admin/users", json={"username": "late", "display_name": "L"}
    )
    assert created.status_code == 201, created.text
    uid: str = created.json()["user"]["id"]
    return uid


@pytest.mark.parametrize("action", ["private", "archive"])
@pytest.mark.parametrize("path", ["apply", "new_account"])
async def test_a_channel_changed_after_the_list_was_read_is_not_joined(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    setup: dict[str, Any],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    action: str,
) -> None:
    """The review's order: the defaults are read, the change commits, then members are added. The
    channels are re-read under their row locks, so the changed one is skipped."""
    root, lounge = setup["root"], setup["lounge"]
    alice = await make_user(db, "alice")
    original = workspace.default_channel_ids
    post: dict[str, str | None] = {}

    async def read_then_change(session: AsyncSession) -> list[uuid.UUID] | None:
        ids = await original(session)
        if "id" not in post:
            post["id"] = await _change(app, root.id, lounge, action)
        return ids

    monkeypatch.setattr(workspace, "default_channel_ids", read_then_change)
    uid = await _run_path(client, path) or str(alice.id)
    assert "id" in post
    assert await _channels_of(db, uid) == {setup["notices"]}
    if action == "private":
        person = await db.get(User, uuid.UUID(uid))
        assert person is not None
        as_user(person)
        got = await client.get(f"{API}/messages/{post['id']}")
        assert got.status_code == 403, got.text
        assert "PRIVATE AFTER CONVERSION" not in got.text


@pytest.mark.parametrize("path", ["apply", "new_account"])
async def test_a_change_started_while_members_are_added_waits_for_them(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    setup: dict[str, Any],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    path: str,
) -> None:
    """The other order: the channel is locked before anyone is added, so making it private waits
    until the memberships (made while it was public) are committed."""
    root, lounge = setup["root"], setup["lounge"]
    alice = await make_user(db, "alice")
    tasks: list[asyncio.Task[str | None]] = []

    def hooked(original: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not tasks:
                tasks.append(asyncio.create_task(_change(app, root.id, lounge, "private")))
                done, _ = await asyncio.wait(tasks, timeout=0.5)
                assert not done, "making the channel private did not wait for the channel lock"
            return await original(*args, **kwargs)

        return wrapper

    name = "member_ids_of" if path == "apply" else "add_member_in_tx"
    monkeypatch.setattr(channels, name, hooked(getattr(channels, name)))
    uid = await _run_path(client, path) or str(alice.id)
    assert tasks
    await tasks[0]
    assert await _channels_of(db, uid) == {setup["notices"], lounge}
    kind = (
        await db.execute(select(Channel.type).where(Channel.id == uuid.UUID(lounge)))
    ).scalar_one()
    assert kind == "private"


# --- #7: two people taking the same free username at once ----------------------------------------

PASSWORD = "correct-horse-battery"


async def _token(client: AsyncClient, username: str) -> dict[str, str]:
    response = await client.post(
        f"{API}/auth/login",
        json={"username": username, "password": PASSWORD, "device": {"platform": "desktop"}},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.mark.parametrize(
    "who", [("self", "self"), ("self", "admin"), ("admin", "admin")], ids="-".join
)
async def test_two_renames_to_one_free_name_give_200_and_409(
    client: AsyncClient,
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    who: tuple[str, str],
) -> None:
    """Both pass the 'taken?' check (held at a barrier right after it); the later flush violates
    uq_users_username and is answered 409 username_taken with nothing of its transaction kept
    (audit row, times name, username)."""
    people = [await make_user(db, name, password=PASSWORD) for name in ("alice", "bob")]
    admins = [await make_user(db, name, role="admin", password=PASSWORD) for name in ("r1", "r2")]
    for person in people:
        await channels.create_times_in_tx(db, person, [])
    await db.commit()
    ids = [p.id for p in people]

    requests = []
    for n, (kind, person) in enumerate(zip(who, people, strict=True)):
        if kind == "self":
            headers = await _token(client, person.username)
            requests.append((f"{API}/users/me", headers))
        else:
            headers = await _token(client, admins[n].username)
            requests.append((f"{API}/admin/users/{person.id}", headers))

    barrier = asyncio.Barrier(2)
    original = groups.name_in_use

    async def held(session: AsyncSession, name: str) -> bool:
        result = await original(session, name)
        if name == "shared":
            await asyncio.wait_for(barrier.wait(), timeout=5)
        return result

    monkeypatch.setattr(groups, "name_in_use", held)
    answers = await asyncio.gather(
        *(client.patch(url, json={"username": "shared"}, headers=h) for url, h in requests)
    )
    codes = sorted(a.status_code for a in answers)
    assert codes == [200, 409], [a.text for a in answers]
    lost_at = next(n for n, a in enumerate(answers) if a.status_code == 409)
    assert answers[lost_at].json()["error"]["code"] == "username_taken"
    loser, winner = ids[lost_at], ids[1 - lost_at]

    db.expire_all()
    names = {u.id: u.username for u in (await db.scalars(select(User))).all()}
    assert names[winner] == "shared"
    assert names[loser] == ("alice", "bob")[lost_at]
    audits = (
        await db.scalars(select(AuditLog).where(AuditLog.action == "user.username_changed"))
    ).all()
    assert [a.target_id for a in audits] == [str(winner)]
    updated = (
        await db.scalars(select(AuditLog).where(AuditLog.action == "admin.user_updated"))
    ).all()
    assert str(loser) not in [a.target_id for a in updated]
    times = {
        c.times_owner_id: c.name
        for c in (await db.scalars(select(Channel).where(Channel.times_owner_id.in_(ids)))).all()
    }
    assert times[winner] == "times-shared"
    assert times[loser] == f"times-{names[loser]}"


async def test_a_times_name_taken_meanwhile_does_not_fail_the_rename(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The times' new name is taken by a channel created after the check: the rename still
    succeeds (no mislabelled username_taken / email_taken) and the times keeps its name."""
    alice = await make_user(db, "alice")
    # Not Alice: her row is locked by the rename (a foreign key to it would wait for it).
    bob_id = (await make_user(db, "bob")).id
    await channels.create_times_in_tx(db, alice, [])
    await db.commit()
    alice_id = alice.id
    as_user(alice)
    original = channel_repo.get_channel_by_name

    async def free_then_taken(session: AsyncSession, name: str) -> Any:
        found = await original(session, name)
        if name == "times-alicia" and found is None:
            db.add(Channel(type="public", name="times-alicia", created_by=bob_id))
            await db.commit()
        return found

    monkeypatch.setattr(channel_repo, "get_channel_by_name", free_then_taken)
    renamed = await client.patch(f"{API}/users/me", json={"username": "alicia"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["username"] == "alicia"
    db.expire_all()
    times = (await db.scalars(select(Channel).where(Channel.times_owner_id == alice_id))).one()
    assert times.name == "times-alice"
