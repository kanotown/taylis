"""M94 (docs/WORKFLOWS.md): workflows — forms whose values the server renders into a message
posted as the submitter."""

import json
import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.emoji.service import NAME as EMOJI_NAME
from app.modules.messages.models import Message
from app.modules.users.models import User
from app.modules.workflows.render import (
    ValuesError,
    clean_values,
    placeholders,
    render,
    valid_key,
)
from app.modules.workflows.templates import workflow_templates
from tests.helpers import make_user

ROOT = Path(__file__).resolve().parents[2]
VECTORS = json.loads((ROOT / "apps" / "shared" / "workflows.json").read_text())

ABSENCE_FIELDS: list[dict[str, Any]] = [
    {
        "key": "報告者",
        "label": "報告者",
        "type": "user",
        "required": True,
        "default": {"kind": "me"},
    },
    {
        "key": "日付",
        "label": "日付",
        "type": "date",
        "required": True,
        "default": {"kind": "today"},
    },
    {
        "key": "内容",
        "label": "報告の内容",
        "type": "select",
        "required": True,
        "options": ["欠席", "遅刻", "早退"],
    },
    {"key": "理由", "label": "理由", "type": "textarea"},
]
ABSENCE_TEMPLATE = (
    "*【報告者】* {{報告者}}\n*【報告の内容】* ゼミの{{内容}}\n"
    "*【日付】* {{日付}}\n*【理由】* {{理由}}"
)


# --- the pure rules (shared vectors) ------------------------------------------------------------


@pytest.mark.parametrize("case", VECTORS["render"], ids=lambda c: c["name"])
def test_render_vectors(case: dict[str, Any]) -> None:
    cleaned = clean_values(case["fields"], case["values"])
    assert render(case["template"], case["fields"], cleaned) == case["expected"]


@pytest.mark.parametrize("case", VECTORS["values"], ids=lambda c: c["name"])
def test_value_vectors(case: dict[str, Any]) -> None:
    fields = case.get("fields", VECTORS["value_fields"])
    if case["errors"] is None:
        assert clean_values(fields, case["values"]) == case["cleaned"]
    else:
        with pytest.raises(ValuesError) as caught:
            clean_values(fields, case["values"])
        assert caught.value.fields == case["errors"]


def test_key_vectors() -> None:
    for key in VECTORS["keys"]["valid"]:
        assert valid_key(key), key
    for key in VECTORS["keys"]["invalid"]:
        assert not valid_key(key), key


def test_seed_templates_only_name_their_own_fields() -> None:
    seeds = workflow_templates()
    assert [t.name for t in seeds] == ["学部ゼミ案内", "院ゼミ案内", "ゼミ欠席報告", "書誌情報報告"]
    for seed in seeds:
        keys = [field.key for field in seed.fields]
        assert placeholders(seed.template) == keys or set(placeholders(seed.template)) <= set(keys)
        assert set(keys) <= set(placeholders(seed.template)), seed.name
    absence = seeds[2]
    assert [f.type for f in absence.fields] == ["user", "date", "select", "textarea"]
    assert absence.fields[0].default is not None and absence.fields[0].default.kind == "me"
    assert absence.fields[2].options == ["欠席", "遅刻", "早退"]


# --- helpers ------------------------------------------------------------------------------------


async def _channel(client: AsyncClient, name: str, members: list[User], **extra: Any) -> str:
    created = await client.post("/api/v1/channels", json={"name": name, **extra})
    assert created.status_code == 201, created.text
    cid = str(created.json()["id"])
    for user in members:
        added = await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(user.id)})
        assert added.status_code == 200, added.text
    return cid


def _payload(cid: str, **fields: Any) -> dict[str, Any]:
    return {
        "name": "ゼミ欠席報告",
        "emoji": "🙇",
        "description": "欠席を報告します",
        "channel_id": cid,
        "fields": ABSENCE_FIELDS,
        "template": ABSENCE_TEMPLATE,
        **fields,
    }


async def _create(client: AsyncClient, cid: str, **fields: Any) -> Any:
    return await client.post("/api/v1/workflows", json=_payload(cid, **fields))


async def _submit(
    client: AsyncClient, wid: str, values: dict[str, Any], key: str | None = None
) -> Any:
    return await client.post(
        f"/api/v1/workflows/{wid}/submit",
        json={"client_msg_id": key or str(uuid.uuid4()), "values": values},
    )


# --- managing -----------------------------------------------------------------------------------


async def test_create_list_update_delete_and_who_may(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")  # the channel's owner
    bob = await make_user(db, "bob")  # a member
    carol = await make_user(db, "carol")  # not a member
    root = await make_user(db, "root", role="admin")  # a member
    boss = await make_user(db, "boss", role="admin")  # not a member
    guest = await make_user(db, "guest", role="guest")
    as_user(alice)
    cid = await _channel(client, "absence", [bob, root, guest], type="private")
    other = await _channel(client, "seminar", [bob])

    created = await _create(client, cid, offered_channel_ids=[other, cid])
    assert created.status_code == 201, created.text
    wf = created.json()
    assert wf["name"] == "ゼミ欠席報告" and wf["emoji"] == "🙇" and wf["enabled"]
    # The target comes first and once.
    assert wf["offered_channel_ids"] == [cid, other]
    assert wf["can_manage"] and wf["can_run"] and wf["run_blocked"] is None
    assert [f["key"] for f in wf["fields"]] == ["報告者", "日付", "内容", "理由"]
    assert wf["fields"][3] == {
        "key": "理由",
        "label": "理由",
        "type": "textarea",
        "required": False,
        "help": "",
        "options": [],
        "multiple": False,
        "default": None,
    }
    wid = wf["id"]

    # Members see it where it is offered, and may run it; they do not manage it.
    as_user(bob)
    offered = (await client.get(f"/api/v1/channels/{other}/workflows")).json()
    assert [(w["id"], w["can_manage"], w["can_run"]) for w in offered] == [(wid, False, True)]
    assert (await client.get("/api/v1/workflows")).json() == []
    for call in (
        _create(client, cid, name="別の報告"),
        client.patch(f"/api/v1/workflows/{wid}", json={"enabled": False}),
        client.delete(f"/api/v1/workflows/{wid}"),
    ):
        response = await call
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "workflow_manage_restricted"

    # Someone who cannot read the private target neither sees nor learns it exists.
    as_user(carol)
    # (#seminar is public: she reads its list, which leaves out the private target's workflow.)
    assert (await client.get(f"/api/v1/channels/{cid}/workflows")).status_code == 403
    assert (await client.get(f"/api/v1/channels/{other}/workflows")).json() == []
    for response in (
        await client.get(f"/api/v1/workflows/{wid}"),
        await client.patch(f"/api/v1/workflows/{wid}", json={"enabled": False}),
        await _submit(client, wid, {}),
    ):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "workflow_not_found"
    assert (await _create(client, cid)).json()["error"]["code"] == "channel_not_found"
    # Nor an administrator outside it.
    as_user(boss)
    assert (await client.get("/api/v1/workflows")).json() == []
    hidden = await client.patch(f"/api/v1/workflows/{wid}", json={"enabled": False})
    assert hidden.status_code == 404
    # A guest never manages, even a member.
    as_user(guest)
    assert (await _create(client, cid, name="x")).json()["error"]["code"] == "guest_restricted"
    assert (await client.get("/api/v1/workflows")).json() == []

    # An administrator who is a member manages it.
    as_user(root)
    assert [w["id"] for w in (await client.get("/api/v1/workflows")).json()] == [wid]
    changed = await client.patch(
        f"/api/v1/workflows/{wid}",
        json={"name": "  欠席  報告 ", "emoji": None, "enabled": False, "offered_channel_ids": []},
    )
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert body["name"] == "欠席 報告" and body["emoji"] is None and not body["enabled"]
    assert body["offered_channel_ids"] == [cid]
    assert body["run_blocked"] == "disabled" and not body["can_run"]
    assert (await client.delete(f"/api/v1/workflows/{wid}")).status_code == 204
    assert (await client.get(f"/api/v1/workflows/{wid}")).status_code == 404
    assert (await client.get(f"/api/v1/channels/{cid}/workflows")).json() == []

    actions = (
        (
            await db.execute(
                select(AuditLog.action).where(AuditLog.target_id == wid).order_by(AuditLog.id)
            )
        )
        .scalars()
        .all()
    )
    assert list(actions) == ["workflow.created", "workflow.updated", "workflow.deleted"]


async def test_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "absence", [bob])
    elsewhere = await _channel(client, "elsewhere", [])
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()["id"]

    def code(response: Any) -> str:
        return str(response.json()["error"]["code"])

    unknown = await _create(client, cid, template="{{日付}} {{名前}} {{ 理由 }}")
    assert unknown.status_code == 400 and code(unknown) == "workflow_template_invalid"
    assert unknown.json()["error"]["details"]["unknown"] == ["名前"]
    assert code(await _create(client, cid, name="Help")) == "workflow_name_reserved"
    assert code(await _create(client, cid, name="wf")) == "workflow_name_reserved"
    assert code(await _create(client, dm)) == "workflow_channel_unsupported"
    assert code(await _create(client, cid, offered_channel_ids=[dm])) == (
        "workflow_channel_unsupported"
    )
    assert (await _create(client, str(uuid.uuid4()))).status_code == 404
    first = await _create(client, cid, name="Report")
    assert first.status_code == 201
    taken = await _create(client, cid, name="report")
    assert taken.status_code == 409 and code(taken) == "workflow_name_taken"
    renamed = await client.patch(f"/api/v1/workflows/{first.json()['id']}", json={"name": "REPORT"})
    assert renamed.status_code == 200  # its own name in another case
    # Bob is not a member of #elsewhere: he may not offer a workflow there.
    as_user(bob)
    other = await _channel(client, "bobs", [])
    mine = await _create(client, other, name="Bob", offered_channel_ids=[elsewhere])
    assert mine.status_code == 404 and code(mine) == "channel_not_found"
    as_user(alice)

    bad_fields: list[list[dict[str, Any]]] = [
        [{"key": "a b", "label": "x", "type": "text"}],
        [{"key": "a", "label": "x", "type": "select"}],
        [{"key": "a", "label": "x", "type": "select", "options": ["欠席", "欠席"]}],
        [{"key": "a", "label": "x", "type": "text", "options": ["x"]}],
        [{"key": "a", "label": "x", "type": "text", "multiple": True}],
        [{"key": "a", "label": "x", "type": "text", "default": {"kind": "today"}}],
        [{"key": "a", "label": "x", "type": "date", "default": {"kind": "me"}}],
        [{"key": "a", "label": "x", "type": "date", "default": {"kind": "next_weekday"}}],
        [{"key": "a", "label": "x", "type": "date", "default": {"kind": "literal", "value": "x"}}],
        [{"key": "a", "label": "x", "type": "date", "default": {"kind": "today", "time": "9:00"}}],
        [
            {
                "key": "a",
                "label": "x",
                "type": "select",
                "options": ["y"],
                "default": {"kind": "literal", "value": "z"},
            }
        ],
        [
            {
                "key": "a",
                "label": "x",
                "type": "checkbox",
                "default": {"kind": "literal", "value": "x"},
            }
        ],
        [{"key": "a", "label": "x", "type": "user", "default": {"kind": "literal", "value": "x"}}],
        [{"key": "a", "label": "x", "type": "number"}],
        [{"key": "a", "label": "x", "type": "text"}, {"key": "a", "label": "y", "type": "text"}],
        [{"key": f"k{i}", "label": "x", "type": "text"} for i in range(21)],
    ]
    for fields in bad_fields:
        response = await _create(client, cid, name="Bad", fields=fields, template="x")
        assert response.status_code == 422, (fields, response.text)
    good = await _create(
        client,
        cid,
        name="Good",
        fields=[
            {
                "key": "日時",
                "label": "日時",
                "type": "datetime",
                "default": {"kind": "next_weekday", "weekday": 1, "time": "13:00"},
            },
            {
                "key": "ok",
                "label": "OK",
                "type": "checkbox",
                "default": {"kind": "literal", "value": True},
            },
        ],
        template="{{日時}} {{ok}}",
    )
    assert good.status_code == 201, good.text
    # Clearing the fields without the template that names them is refused.
    cleared = await client.patch(f"/api/v1/workflows/{good.json()['id']}", json={"fields": []})
    assert code(cleared) == "workflow_template_invalid"
    assert (
        await client.patch(f"/api/v1/workflows/{good.json()['id']}", json={"template": None})
    ).status_code == 422
    # A fixed message with no fields is fine.
    fixed = await _create(client, cid, name="Fixed", fields=[], template="出席します")
    assert fixed.status_code == 201
    # An archived target takes no new workflows.
    await client.post(f"/api/v1/channels/{elsewhere}/archive")
    assert code(await _create(client, elsewhere, name="Late")) == "channel_archived"


# --- submitting ---------------------------------------------------------------------------------


async def test_submit_posts_as_the_submitter_with_mentions_and_a_label(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    cid = await _channel(client, "absence", [bob, carol])
    wid = (await _create(client, cid)).json()["id"]

    as_user(bob)
    key = str(uuid.uuid4())
    values = {
        "報告者": [str(bob.id)],
        "日付": "2026-07-28",
        "内容": "欠席",
        "理由": "体調不良 <!channel> <@" + str(carol.id) + ">",
    }
    posted = await _submit(client, wid, values, key)
    assert posted.status_code == 201, posted.text
    message = posted.json()
    assert message["sender_id"] == str(bob.id) and message["channel_id"] == cid
    assert message["workflow"] == {"id": wid, "name": "ゼミ欠席報告"}
    assert message["body"] == (
        f"*【報告者】* <@{bob.id}>\n*【報告の内容】* ゼミの欠席\n*【日付】* 2026年7月28日 (火)\n"
        f"*【理由】* 体調不良 \uff1c!channel> \uff1c@{carol.id}>"
    )
    # Only the user field mentions (Bob himself here); the typed text calls nobody.
    assert message["mentioned_user_ids"] == [str(bob.id)] and message["mention_all"] is False
    assert message["client_msg_id"] == key

    # A retry with the same key returns the same message, also after the workflow changed.
    as_user(alice)
    await client.patch(f"/api/v1/workflows/{wid}", json={"enabled": False})
    as_user(bob)
    again = await _submit(client, wid, {}, key)
    assert again.status_code == 200 and again.json()["id"] == message["id"]
    rows = (await db.execute(select(Message).where(Message.sender_id == bob.id))).scalars().all()
    assert len(rows) == 1
    # Paused: a new submission is refused.
    paused = await _submit(client, wid, values)
    assert paused.status_code == 409 and paused.json()["error"]["code"] == "workflow_disabled"
    # The same key for another workflow is a conflict, not that message.
    as_user(alice)
    await client.patch(f"/api/v1/workflows/{wid}", json={"enabled": True})
    other = (await _create(client, cid, name="Other", fields=[], template="x")).json()["id"]
    as_user(bob)
    clash = await _submit(client, other, {}, key)
    assert clash.status_code == 409 and clash.json()["error"]["code"] == "idempotency_conflict"

    # The event carries the label; history too; an ordinary message has none.
    event = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "message.created")
                .order_by(OutboxEvent.id.desc())
            )
        )
        .scalars()
        .first()
    )
    assert event is not None and event.payload["message"]["workflow"]["id"] == wid
    plain = await client.post(
        f"/api/v1/channels/{cid}/messages", json={"client_msg_id": str(uuid.uuid4()), "body": "hi"}
    )
    assert plain.json()["workflow"] is None
    history = (await client.get(f"/api/v1/channels/{cid}/messages")).json()["messages"]
    labels = {m["body"][:6]: m["workflow"] for m in history}
    assert labels["hi"] is None
    assert any(m["workflow"] == {"id": wid, "name": "ゼミ欠席報告"} for m in history)

    # Renamed or deleted: the posted message keeps the name it was posted under.
    as_user(alice)
    await client.patch(f"/api/v1/workflows/{wid}", json={"name": "欠席連絡"})
    await client.delete(f"/api/v1/workflows/{wid}")
    kept = (await client.get(f"/api/v1/messages/{message['id']}")).json()
    assert kept["workflow"] == {"id": wid, "name": "ゼミ欠席報告"}
    # A deleted message shows no label.
    as_user(bob)
    await client.delete(f"/api/v1/messages/{message['id']}")
    gone = (await client.get(f"/api/v1/channels/{cid}/messages")).json()["messages"]
    assert all(m["workflow"] is None for m in gone if m["deleted"])


async def test_template_channel_mention_and_several_people(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    cid = await _channel(client, "seminar", [bob, carol])
    fields = [
        {"key": "回", "label": "回", "type": "text", "required": True},
        {"key": "日時", "label": "日時", "type": "datetime", "required": True},
        {"key": "発表者", "label": "発表者", "type": "user", "multiple": True},
    ]
    template = (
        "<!channel> *【第 {{回}} 回学部ゼミのお知らせ】*\n"
        "• *日時*\uff1a{{日時}}\n• *発表者*\uff1a{{発表者}}"
    )
    wid = (
        await _create(client, cid, name="学部ゼミ案内", fields=fields, template=template)
    ).json()["id"]
    posted = await _submit(
        client,
        wid,
        {"回": "6", "日時": "2026-05-19T13:00", "発表者": [str(bob.id), str(carol.id)]},
    )
    assert posted.status_code == 201, posted.text
    message = posted.json()
    assert message["body"].startswith("<!channel> *【第 6 回学部ゼミのお知らせ】*")
    assert "2026年5月19日 (火) 13:00" in message["body"]
    assert message["mention_all"] is True
    assert message["mentioned_user_ids"] == [str(bob.id), str(carol.id)]


async def test_no_mention_from_a_value_and_its_surroundings(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """Review v0.1.30 #4: the owner's `URL: <{{link}}>` with `!channel` typed by a member, a `<`
    and `!here>` in two fields, `<@{{who_id}}>` with an id typed in: no mention, no @channel. The
    owner's own mention and the user field still mention."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    cid = await _channel(client, "links", [bob, carol])
    fields = [
        {"key": "link", "label": "URL", "type": "text"},
        {"key": "a", "label": "A", "type": "text"},
        {"key": "b", "label": "B", "type": "text"},
        {"key": "who_id", "label": "ID", "type": "text"},
        {"key": "who", "label": "誰", "type": "user"},
    ]
    template = "URL: <{{link}}>\n{{a}}{{b}}\n担当 <@{{who_id}}>\n<@{{who}}> {{who}}"
    wid = (await _create(client, cid, name="リンク", fields=fields, template=template)).json()["id"]
    as_user(bob)
    posted = await _submit(
        client,
        wid,
        {
            "link": "!channel",
            "a": "<",
            "b": "!here>",
            "who_id": str(carol.id),
            "who": [str(bob.id)],
        },
    )
    assert posted.status_code == 201, posted.text
    message = posted.json()
    assert message["body"] == (
        f"URL: \uff1c!channel>\n\uff1c!here>\n担当 \uff1c@{carol.id}>\n<@<@{bob.id}>> <@{bob.id}>"
    )
    assert message["mention_all"] is False
    assert message["mentioned_user_ids"] == [str(bob.id)]


async def test_values_are_checked_on_the_server(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bot = await make_user(db, "hook", role="bot")
    gone = await make_user(db, "gone")
    gone.deactivated_at = datetime.now(UTC)
    await db.commit()
    as_user(alice)
    cid = await _channel(client, "absence", [])
    wid = (await _create(client, cid)).json()["id"]

    async def fields_of(values: dict[str, Any]) -> dict[str, str]:
        response = await _submit(client, wid, values)
        assert response.status_code == 400, response.text
        error = response.json()["error"]
        assert error["code"] == "workflow_values_invalid"
        return dict(error["details"]["fields"])

    assert await fields_of({}) == {"報告者": "required", "日付": "required", "内容": "required"}
    ok = {"報告者": [str(alice.id)], "日付": "2026-07-28", "内容": "欠席"}
    assert await fields_of({**ok, "内容": "早退する"}) == {"内容": "not_an_option"}
    assert await fields_of({**ok, "日付": "07/28"}) == {"日付": "invalid"}
    assert await fields_of({**ok, "理由": "あ" * 4001}) == {"理由": "too_long"}
    assert await fields_of({**ok, "報告者": [str(bot.id)]}) == {"報告者": "user_not_found"}
    assert await fields_of({**ok, "報告者": [str(gone.id)]}) == {"報告者": "user_not_found"}
    assert await fields_of({**ok, "報告者": [str(uuid.uuid4())]}) == {"報告者": "user_not_found"}
    assert await fields_of({**ok, "誰": "x"}) == {"誰": "invalid"}
    # Nothing was posted by any of these.
    count = (await db.execute(select(Message).where(Message.channel_id == uuid.UUID(cid)))).all()
    assert count == []
    assert (await _submit(client, wid, ok)).status_code == 201


async def test_who_may_submit_follows_posting(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")  # owner of #news
    bob = await make_user(db, "bob")  # a member of both
    carol = await make_user(db, "carol")  # only in #lobby
    root = await make_user(db, "root", role="admin")
    as_user(alice)
    news = await _channel(client, "news", [bob, root])
    lobby = await _channel(client, "lobby", [bob, carol])
    wid = (
        await _create(
            client,
            news,
            name="お知らせ",
            fields=[],
            template="お知らせです",
            offered_channel_ids=[lobby],
        )
    ).json()["id"]
    await client.patch(f"/api/v1/channels/{news}", json={"posting_policy": "owners"})

    as_user(bob)
    [listed] = (await client.get(f"/api/v1/channels/{lobby}/workflows")).json()
    assert listed["run_blocked"] == "posting_restricted" and not listed["can_run"]
    refused = await _submit(client, wid, {})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "posting_restricted"

    as_user(carol)  # sees it (#news is public) but is not a member of the target
    [listed] = (await client.get(f"/api/v1/channels/{lobby}/workflows")).json()
    assert listed["run_blocked"] == "not_a_member"
    refused = await _submit(client, wid, {})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "not_a_member"

    as_user(root)  # administrators may post in an announcement channel
    [listed] = (await client.get(f"/api/v1/channels/{news}/workflows")).json()
    assert listed["can_run"]
    assert (await _submit(client, wid, {})).status_code == 201

    as_user(alice)
    await client.post(f"/api/v1/channels/{news}/archive")
    [listed] = (await client.get(f"/api/v1/channels/{news}/workflows")).json()
    assert listed["run_blocked"] == "archived"
    archived = await _submit(client, wid, {})
    assert archived.status_code == 409 and archived.json()["error"]["code"] == "channel_archived"


async def test_templates_and_slash_lookup_lists(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    seeds = (await client.get("/api/v1/workflow-templates")).json()
    assert [s["name"] for s in seeds] == [
        "学部ゼミ案内",
        "院ゼミ案内",
        "ゼミ欠席報告",
        "書誌情報報告",
    ]
    cid = await _channel(client, "seminar", [])
    other = await _channel(client, "other", [])
    # Every seed saves as it is (the editor only adds the target).
    for seed in seeds:
        created = await client.post(
            "/api/v1/workflows",
            json={
                "name": seed["name"],
                "emoji": seed["emoji"],
                "description": seed["description"],
                "channel_id": cid,
                "fields": seed["fields"],
                "template": seed["template"],
            },
        )
        assert created.status_code == 201, created.text
    # The channel's list (what `/name` and the menu look in) is by name; not offered elsewhere.
    names = [w["name"] for w in (await client.get(f"/api/v1/channels/{cid}/workflows")).json()]
    assert sorted(names) == sorted(s["name"] for s in seeds)
    assert (await client.get(f"/api/v1/channels/{other}/workflows")).json() == []


async def test_confirm_defaults_on_and_can_be_switched_off(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """`confirm` (WORKFLOWS.md §11): on by default; the server stores it and posts the same way
    either way (asking first is the clients' part)."""
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "attendance", [])
    asking = (await _create(client, cid)).json()
    assert asking["confirm"] is True

    quick = await _create(
        client,
        cid,
        name="出勤",
        emoji=":custom_party:",
        fields=[],
        template="出勤しました",
        confirm=False,
    )
    assert quick.status_code == 201, quick.text
    wf = quick.json()
    assert wf["confirm"] is False and wf["emoji"] == ":custom_party:"
    listed = (await client.get(f"/api/v1/channels/{cid}/workflows")).json()
    assert {w["name"]: w["confirm"] for w in listed} == {"ゼミ欠席報告": True, "出勤": False}

    # Left out of a PATCH it stays; sent it changes and is audited; null is refused.
    kept = await client.patch(f"/api/v1/workflows/{wf['id']}", json={"description": "x"})
    assert kept.json()["confirm"] is False
    on = await client.patch(f"/api/v1/workflows/{wf['id']}", json={"confirm": True})
    assert on.status_code == 200 and on.json()["confirm"] is True
    bad = await client.patch(f"/api/v1/workflows/{wf['id']}", json={"confirm": None})
    assert bad.status_code == 422
    details: Sequence[dict[str, Any]] = (
        (
            await db.execute(
                select(AuditLog.details)
                .where(AuditLog.target_id == wf["id"], AuditLog.action == "workflow.updated")
                .order_by(AuditLog.id)
            )
        )
        .scalars()
        .all()
    )
    assert details[-1] == {"fields": ["confirm"]}

    # Posting is unchanged.
    await client.patch(f"/api/v1/workflows/{wf['id']}", json={"confirm": False})
    posted = await _submit(client, wf["id"], {})
    assert posted.status_code == 201, posted.text
    assert posted.json()["body"] == "出勤しました"


async def test_emoji_takes_the_longest_custom_name(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """The editor's picker offers every custom emoji (WORKFLOWS.md §11.3), and their names are up
    to 32 characters (emoji.service.NAME): such a `:name:` is stored, not a 422 (nor a 500 from
    the column, migration 0113)."""
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "emoji", [])
    longest = "a" * 32
    assert EMOJI_NAME.match(longest) and not EMOJI_NAME.match(longest + "a")
    created = await _create(client, cid, emoji=f":{longest}:")
    assert created.status_code == 201, created.text
    wid = created.json()["id"]
    assert created.json()["emoji"] == f":{longest}:"
    assert (await client.get(f"/api/v1/workflows/{wid}")).json()["emoji"] == f":{longest}:"
    changed = await client.patch(f"/api/v1/workflows/{wid}", json={"emoji": ":" + "b" * 32 + ":"})
    assert changed.status_code == 200 and changed.json()["emoji"] == ":" + "b" * 32 + ":"
    # Longer than any custom emoji's name: refused as before.
    too_long = await _create(client, cid, name="長すぎ", emoji=":" + "a" * 33 + ":")
    assert too_long.status_code == 422
    kept = await client.patch(f"/api/v1/workflows/{wid}", json={"emoji": ":" + "a" * 33 + ":"})
    assert kept.status_code == 422
