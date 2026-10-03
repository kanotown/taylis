"""Slack import, people for the lab (M91): the address domain map, active accounts for the lab's
domain that Google sign-in lands on, guests, the mapping order and the people table."""

from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.cli import _width, main, parse_domain_map, print_import_report, print_people_table
from app.modules.audit.models import AuditLog
from app.modules.channels.models import Channel, ChannelMember
from app.modules.importer.core import Report
from app.modules.importer.models import ImportRef
from app.modules.importer.slack_import import FileSource, Options, import_slack
from app.modules.messages.models import Message
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_slack_import import DAY1, _user, ts, write_zip
from tests.test_sso import FakeOIDC, configure, exchange, sign_in
from tests.test_sso import google as google

VC = "vc.example.ac.jp"
G = "g.example.ac.jp"


def lab_export() -> dict[str, Any]:
    users = [
        _user("U10", "alice", email=f"s001@{VC}", real_name="Alice A"),
        # the domain match ignores case
        _user("U11", "bob", email="S002@VC.Example.ac.jp", real_name="ボブ"),
        _user("U12", "carol", email=f"s003@{VC}"),  # never posted, but a member
        _user("U13", "dave", email=f"s004@{VC}", deleted=True),
        _user("U14", "erin", email="erin@partner.example.com"),
        _user("U15", "frank", email=f"s005@{VC}"),  # --user by address beats the address match
        _user("U16", "gina", email="gina@gmail.com"),  # outside the lab's domain
        _user("U17", "hank", email=f"s006@{VC}"),  # in no channel, never posted
        _user("U18", "ivan", email=f"s007@{VC}"),  # s007 is taken here by someone else
        _user("U19", "judy", email="judy@partner.example.com"),
        _user("UB", "deploybot", is_bot=True, bot_id="B1"),
    ]
    users[4]["is_restricted"] = True  # erin: a multi-channel guest
    users[9]["is_ultra_restricted"] = True  # judy: a single-channel guest, mapped with --user
    general = {
        "id": "C1",
        "name": "general",
        "created": DAY1 - 1000,
        "creator": "U19",
        "is_archived": False,
        "members": ["U10", "U11", "U12", "U13", "U14", "U15", "U16", "U18", "U19"],
    }
    posters = ["U10", "U11", "U13", "U14", "U15", "U16", "U18", "U19"]
    day = [
        {"type": "message", "user": uid, "text": f"hi from {uid}", "ts": ts(DAY1 + n)}
        for n, uid in enumerate(posters, 1)
    ]
    day.append({"type": "message", "subtype": "bot_message", "bot_id": "B1", "text": "ok",
                "ts": ts(DAY1 + 50)})  # fmt: skip
    return {"users.json": users, "channels.json": [general], "general/2024-05-01.json": day}


async def _setup(db: AsyncSession) -> dict[str, User]:
    await make_user(db, "admin", role="admin")
    existing = await make_user(db, "alice-g")
    existing.email = f"s001@{G}"  # signed in with Google before the import
    other = await make_user(db, "someone")
    other.email = f"s005@{G}"
    await make_user(db, "boss")
    await make_user(db, "visitor", role="guest")
    await make_user(db, "s007")  # a username the import would want
    await db.commit()
    return {u.username: u for u in (await db.execute(select(User))).scalars().all()}


async def _run(
    app: FastAPI,
    db: AsyncSession,
    path: Path,
    *,
    dry_run: bool = False,
    people_only: bool = False,
    domain_map: dict[str, str] | None = None,
    activate: tuple[str, ...] = (G,),
) -> Report:
    return await import_slack(
        db,
        path,
        files=FileSource(),
        options=Options(),
        user_map={f"s005@{VC}": "boss", "judy": "visitor"},
        actor_username="admin",
        blobs=app.state.blobs,
        settings=app.state.settings,
        dry_run=dry_run,
        email_domain_map=domain_map if domain_map is not None else {VC: G},
        activate_domains=activate,
        people_only=people_only,
    )


def _actions(report: Report) -> dict[str, tuple[str, str, str]]:
    return {r.source_id: (r.action, r.username, r.email) for r in report.people_rows}


async def _users(db: AsyncSession) -> dict[str, User]:
    db.expire_all()
    return {u.username: u for u in (await db.execute(select(User))).scalars().all()}


async def test_lab_people_are_mapped_created_active_or_kept_out(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    before = await _setup(db)
    path = write_zip(tmp_path / "lab.zip", lab_export())

    report = await _run(app, db, path)

    assert _actions(report) == {
        "U10": ("existing email", "alice-g", f"s001@{G}"),  # matched through the map
        "U11": ("create active", "s002", f"s002@{G}"),
        "U12": ("create active", "s003", f"s003@{G}"),  # for the membership alone
        "U13": ("create deactivated", "s004", f"s004@{G}"),  # deleted in Slack
        "U14": ("create guest", "erin", "erin@partner.example.com"),
        "U15": ("--user", "boss", ""),  # not "someone", who has s005@g
        "U16": ("create deactivated", "gina", "gina@gmail.com"),
        "U17": ("skip (nothing to import)", "", f"s006@{G}"),
        "U18": ("create active", "s007-slack", f"s007@{G}"),  # a clash, deterministically
        "U19": ("--user", "visitor", ""),
        "UB": ("bot", "deploybot", ""),
    }
    rows = {r.source_id: r for r in report.people_rows}
    assert rows["U11"].source_email == "S002@VC.Example.ac.jp"  # kept in the report only
    assert rows["U11"].name == "bob (ボブ)"

    users = await _users(db)
    assert not any(u.email and u.email.endswith(VC) for u in users.values())
    bob, carol, ivan = users["s002"], users["s003"], users["s007-slack"]
    for person in (bob, carol, ivan):
        assert person.is_active and person.role == "member"
        assert person.password_hash is None and not person.must_change_password
    assert users["s007"].id == before["s007"].id and users["s007"].email is None
    dave = users["s004"]
    assert not dave.is_active and dave.role == "member" and dave.must_change_password
    erin = users["erin"]
    assert erin.role == "guest" and not erin.is_active
    assert not users["gina"].is_active
    assert "s006" not in users
    assert users["deploybot"].role == "bot"

    general = (await db.execute(select(Channel).where(Channel.name == "general"))).scalar_one()
    members = {
        m.user_id: m.role
        for m in (
            await db.execute(select(ChannelMember).where(ChannelMember.channel_id == general.id))
        ).scalars()
    }
    # Active people only; the guest who made the channel in Slack is no owner here; no default
    # channels (M90) joined.
    assert members == {
        users["alice-g"].id: "member",
        bob.id: "member",
        carol.id: "member",
        ivan.id: "member",
        users["boss"].id: "member",
        users["visitor"].id: "member",
    }
    joined = (
        await db.execute(select(ChannelMember.channel_id).where(ChannelMember.user_id == bob.id))
    ).scalars()
    assert list(joined) == [general.id]
    created = [
        row.details
        for row in (await db.execute(select(AuditLog))).scalars()
        if row.action == "admin.user_created" and row.target_id == str(bob.id)
    ]
    assert created == [
        {"username": "s002", "role": "member", "source": "slack", "source_id": "U11"}
    ]
    assert report.counts["users_created"] == 7 and report.counts["users_mapped"] == 3


async def test_an_active_lab_account_is_where_google_sign_in_lands(
    app: FastAPI,
    db: AsyncSession,
    client: AsyncClient,
    google: FakeOIDC,
    tmp_path: Path,
) -> None:
    await _setup(db)
    await _run(app, db, write_zip(tmp_path / "lab.zip", lab_export()))
    bob = (await db.execute(select(User).where(User.username == "s002"))).scalar_one()
    configure(app, sso_google_allowed_domains=G)

    back = await sign_in(
        client, google, email=f"S002@{G}", hosted_domain=G, subject="google-sub-s002"
    )
    tokens = await exchange(client, back["sso_ticket"])

    assert tokens.status_code == 200, tokens.text
    body = tokens.json()["user"]
    assert body["id"] == str(bob.id) and body["has_password"] is False
    assert (await db.execute(select(User).where(User.email == f"s002@{G}"))).scalar_one().id == (
        bob.id
    )
    # A deleted Slack person in the same domain stays out.
    refused = await sign_in(
        client, google, email=f"s004@{G}", hosted_domain=G, subject="google-sub-s004"
    )
    assert refused == {"sso_error": "account_disabled"}


async def test_a_rerun_maps_everyone_to_the_same_accounts(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _setup(db)
    path = write_zip(tmp_path / "lab.zip", lab_export())
    first = await _run(app, db, path)
    users_before = {u.username: u.id for u in (await _users(db)).values()}
    refs_before = len((await db.execute(select(ImportRef))).scalars().all())

    again = await _run(app, db, path)

    assert again.counts["users_created"] == 0 and again.counts["posts"] == 0
    assert {u.username: u.id for u in (await _users(db)).values()} == users_before
    assert len((await db.execute(select(ImportRef))).scalars().all()) == refs_before
    first_rows, rows = _actions(first), _actions(again)
    for source_id, (action, username, _) in rows.items():
        if first_rows[source_id][0] == "skip (nothing to import)":
            assert action == "skip (nothing to import)"
        elif first_rows[source_id][0] == "--user":
            assert action == "--user"
        else:
            assert action == "previous run" and username == first_rows[source_id][1]


async def test_without_the_options_nothing_is_activated(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _setup(db)
    report = await _run(
        app, db, write_zip(tmp_path / "lab.zip", lab_export()), domain_map={}, activate=()
    )
    actions = _actions(report)
    # The vc address matches nobody; the vc address is stored as it was (no map was asked for).
    assert actions["U10"] == ("create deactivated", "s001", f"s001@{VC}")
    assert actions["U12"][0] == "skip (nothing to import)"
    assert actions["U14"][0] == "create guest"
    users = await _users(db)
    assert not users["s001"].is_active and not users["s002"].is_active


async def test_people_only_and_dry_run_print_the_table_and_write_nothing(
    app: FastAPI, db: AsyncSession, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    await _setup(db)
    path = write_zip(tmp_path / "lab.zip", lab_export())
    users_before = len(await _users(db))

    people = await _run(app, db, path, people_only=True)
    assert people.dry_run and people.counts["posts"] == 0
    assert len(await _users(db)) == users_before
    assert (await db.execute(select(Channel))).first() is None
    print_people_table(people)
    table = capsys.readouterr().out

    report = await _run(app, db, path, dry_run=True)
    assert len(await _users(db)) == users_before
    assert (await db.execute(select(Message))).first() is None
    print_import_report(report)
    out = capsys.readouterr().out

    lines = table.splitlines()
    assert lines[0] == "people (11):"
    assert lines[1].split() == ["Slack", "id", "name", "Slack", "email", "→", "username",
                                "email", "action"]  # fmt: skip
    assert set(lines[2]) <= {" ", "-"}
    bob = next(line for line in lines if line.startswith("  U11 "))
    assert bob.split() == [
        "U11", "bob", "(ボブ)", "S002@VC.Example.ac.jp", "s002", f"s002@{G}", "create", "active"
    ]  # fmt: skip
    # grouped by what happens, in the order of the mapping
    order = [line.split()[0] for line in lines[3:] if line.startswith("  U")]
    assert order == ["U15", "U19", "U10", "U11", "U12", "U18", "U13", "U16", "U14", "UB", "U17"]
    # the columns line up, the Japanese name counted as two columns a character
    header = lines[1]
    assert _width(bob[: bob.index("S002@")]) == header.index("Slack email")
    assert "people by action:" in table and "  create active: 3" in table
    assert "  skip (nothing to import): 1" in table
    assert out.startswith("dry run: nothing was written\npeople (11):")
    assert "people: " not in out.split("counts:")[1]  # the table has its own counts


def test_cli_checks_the_domain_options(tmp_path: Path) -> None:
    assert parse_domain_map([f"VC.Example.ac.jp={G}", f"@old.example={G}"]) == {
        VC: G,
        "old.example": G,
    }
    for bad in ([f"{VC}"], [f"{VC}=not a domain"], [f"{VC}={G}", f"{VC}=other.example"]):
        with pytest.raises(ValueError):
            parse_domain_map(bad)
    base = ["import-slack", str(tmp_path / "x.zip"), "--actor", "admin"]
    assert main([*base, "--email-domain-map", "nonsense"]) == 1
    assert main([*base, "--activate-domain", "bad domain"]) == 1
