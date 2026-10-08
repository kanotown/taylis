"""Templates and copies of pages (M145, docs/WIKI.md §22.3): page templates (who makes and reads
them, kept out of the tree, search and backlinks), making a page from one with its placeholders
and its files copied, row templates with dynamic values and a database's default, duplicating
pages and rows, and the Notion import's row pages not in the CSV becoming row templates."""

import csv
import io
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment
from app.modules.canvases import service as canvases
from app.modules.canvases import templates as tpl
from app.modules.canvases.models import CanvasTemplate
from app.modules.importer.models import ImportRef
from app.modules.importer.notion_import import NotionImport, convert_notion_templates
from app.modules.wiki.models import WikiDatabase, WikiNotice, WikiPage
from tests.helpers import make_user
from tests.test_notion_import import _page, _people, export_files, run_import, write_zip
from tests.wiki_helpers import (
    API,
    Actor,
    add_row,
    assert_acl_consistent,
    create_database,
    create_page,
    key,
    option_id,
    prop_id,
    save,
    schema,
    set_access,
    set_cells,
    titles,
)


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (16, 12), (1, 2, 3)).save(out, format="PNG")
    return out.getvalue()


async def _upload(client: AsyncClient) -> str:
    response = await client.post(
        f"{API}/attachments", files={"file": ("x.png", _png(), "image/png")}
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def _templates(client: AsyncClient) -> dict[str, Any]:
    response = await client.get(f"{API}/wiki/templates")
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


async def _tree_ids(client: AsyncClient) -> set[str]:
    return {p["id"] for p in (await client.get(f"{API}/wiki/tree")).json()["pages"]}


async def _duplicate(
    client: AsyncClient, page_id: str, *, expect: int = 201, **body: Any
) -> dict[str, Any]:
    response = await client.post(
        f"{API}/wiki/pages/{page_id}/duplicate", json={"client_save_id": key(), **body}
    )
    assert response.status_code == expect, response.text
    out: dict[str, Any] = response.json()
    return out


def _attachment_ids(body: str) -> list[str]:
    return re.findall(r"attachment:([0-9a-f-]{36})", body)


def _today(tz: str) -> tuple[str, ...]:
    """The day in `tz` now."""
    now = datetime.now(ZoneInfo(tz))
    return (now.date().isoformat(),)


# --- page templates ------------------------------------------------------------------------------


async def test_page_templates_are_pages_out_of_the_tree_listed_for_their_readers(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    gina = await make_user(db, "gina", role="guest")
    await canvases.ensure_builtin_templates(db)
    await db.commit()
    as_user(alice)
    cursor = (await client.get(f"{API}/wiki/tree")).json()["cursor"]
    shared = await create_page(client, title="週報", body="GPU の報告 {{date}}", is_template=True)
    mine = await create_page(
        client, title="Private tpl", body="mine", is_template=True, access_="private"
    )
    assert shared["is_template"] is True and shared["parent_id"] is None
    # not in the tree, nor in the change feed (an id to drop at most)
    assert shared["id"] not in await _tree_ids(client)
    changes = (await client.get(f"{API}/wiki/changes", params={"since": cursor})).json()
    assert shared["id"] not in {p["id"] for p in changes["pages"]}
    # listed with the built-in ones; shared → everyone reads it, I manage it
    listed = await _templates(client)
    assert [p["id"] for p in listed["pages"]] == [mine["id"], shared["id"]]
    assert {b["key"] for b in listed["builtins"]} >= {"weekly_report", "minutes"}
    access_ = (await client.get(f"{API}/wiki/pages/{shared['id']}/access")).json()
    assert {(g["principal_type"], g["level"]) for g in access_["own"]} == {
        ("workspace", "view"),
        ("user", "full"),
    }
    # not in search, lookup or backlinks
    target = await create_page(client, title="Target")
    linking = await create_page(
        client, title="Linking tpl", body=f"[t](page:{target['id']})", is_template=True
    )
    backlinks = (await client.get(f"{API}/wiki/pages/{target['id']}/backlinks")).json()
    assert linking["id"] not in {p["id"] for p in backlinks}
    found = (await client.get(f"{API}/search/pages", params={"q": "GPU"})).json()
    assert found["total"] == 0
    lookup = (await client.get(f"{API}/wiki/pages/lookup", params={"q": "週報"})).json()
    assert lookup == []

    as_user(bob)
    listed = await _templates(client)
    assert [p["id"] for p in listed["pages"]] == [linking["id"], shared["id"]]
    assert listed["pages"][1]["my_level"] == "view"
    edit = await client.patch(f"{API}/wiki/pages/{shared['id']}", json={"title": "x"})
    assert edit.status_code == 403 and edit.json()["error"]["code"] == "page_edit_restricted"
    # anyone (not a guest) makes templates
    bobs = await create_page(client, title="Bob's", is_template=True)
    assert bobs["is_template"]

    as_user(gina)
    assert (await _templates(client))["pages"] == []
    refused = await create_page(client, title="g", is_template=True, expect=403)
    assert refused["error"]["code"] == "guest_restricted"
    await assert_acl_consistent(db)


async def test_template_place_rules(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    top = await create_page(client, title="Top")
    child = await create_page(client, parent_id=top["id"], title="Child")
    database = await create_database(client, title="DB")
    template = await create_page(client, title="Tpl", is_template=True)

    # a template is made at the top level only (the request shape)
    response = await client.post(
        f"{API}/wiki/pages",
        json={"client_save_id": key(), "parent_id": top["id"], "is_template": True},
    )
    assert response.status_code == 422
    # a page with subpages, a page under another, a database: not templates
    for page_id in (top["id"], child["id"], database["page_id"]):
        refused = await client.patch(f"{API}/wiki/pages/{page_id}", json={"is_template": True})
        assert refused.status_code == 400, refused.text
        assert refused.json()["error"]["code"] == "wiki_template_invalid"
    # nothing goes under a template; it does not move under a page
    under = await create_page(client, parent_id=template["id"], title="x", expect=400)
    assert under["error"]["code"] == "invalid_page_parent"
    moved = await client.post(
        f"{API}/wiki/pages/{template['id']}/move", json={"parent_id": top["id"]}
    )
    assert moved.status_code == 400 and moved.json()["error"]["code"] == "wiki_template_invalid"

    # a top-level page without subpages becomes one (and leaves the tree), and back
    lone = await create_page(client, title="Lone")
    cursor = (await client.get(f"{API}/wiki/tree")).json()["cursor"]
    turned = await client.patch(f"{API}/wiki/pages/{lone['id']}", json={"is_template": True})
    assert turned.status_code == 200 and turned.json()["is_template"] is True
    changes = (await client.get(f"{API}/wiki/changes", params={"since": cursor})).json()
    assert lone["id"] in changes["removed"]
    assert lone["id"] not in await _tree_ids(client)
    back = await client.patch(f"{API}/wiki/pages/{lone['id']}", json={"is_template": False})
    assert back.json()["is_template"] is False
    assert lone["id"] in await _tree_ids(client)


async def test_a_page_from_a_template_puts_in_placeholders_and_copies_files(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    image = await _upload(client)
    template = await create_page(
        client,
        title="週報 {{date}} {{me_name}}",
        body=(
            "報告: {{me}} ({{date}} {{time}})\n週: {{week}}\n親: {{parent}}\n"
            f"先生: <@{bob.id}>\n![図](attachment:{image})\n{{{{unknown}}}}\n"
        ),
        icon="📝",
        is_template=True,
    )
    # the template keeps its placeholders, and naming bob in it tells him nothing
    assert "{{date}}" in template["body"] and "{{me}}" in template["body"]
    assert await db.scalar(select(func.count()).select_from(WikiNotice)) == 0
    parent = await create_page(client, title="Lab")

    response = await client.post(
        f"{API}/wiki/pages",
        json={
            "client_save_id": key(),
            "parent_id": parent["id"],
            "template_page_id": template["id"],
            "tz": "Asia/Tokyo",
        },
    )
    assert response.status_code == 201, response.text
    page = response.json()
    days = _today("Asia/Tokyo")
    assert any(
        page["title"] == f"週報 {tpl.format_date(datetime.fromisoformat(d).date())} Alice"
        for d in days
    )
    assert f"報告: <@{alice.id}> (" in page["body"]
    assert re.search(r"\(\d{4}-\d{2}-\d{2} \(.\) \d{2}:\d{2}\)", page["body"])
    assert re.search(r"週: \d{4}-W\d{2}", page["body"])
    assert "親: Lab" in page["body"] and "{{unknown}}" in page["body"]
    assert page["icon"] == "📝" and page["is_template"] is False
    assert page["parent_id"] == parent["id"]
    # the image is the page's own copy (the template's stays)
    [copy_id] = _attachment_ids(page["body"])
    assert copy_id != image
    copy = await db.get(Attachment, uuid.UUID(copy_id))
    original = await db.get(Attachment, uuid.UUID(image))
    assert copy is not None and original is not None
    assert copy.page_id == uuid.UUID(page["id"]) and copy.status == "attached"
    assert original.page_id == uuid.UUID(template["id"])
    assert copy.storage_key != original.storage_key and copy.thumbnail_key
    assert await app.state.blobs.exists(copy.storage_key)
    assert await app.state.blobs.exists(copy.thumbnail_key)
    content = await client.get(f"{API}/attachments/{copy_id}/content")
    assert content.status_code == 200 and content.content == _png()
    # the page made from it tells bob (he can read it: it inherits Lab's workspace edit)
    notices = (await db.execute(select(WikiNotice.user_id))).scalars().all()
    assert notices == [bob.id]

    # given title and body win (no files copied then)
    response = await client.post(
        f"{API}/wiki/pages",
        json={
            "client_save_id": key(),
            "template_page_id": template["id"],
            "title": "Mine",
            "body": "own",
        },
    )
    assert response.json()["title"] == "Mine" and response.json()["body"] == "own"

    # a template someone cannot read is not found; a page that is not a template neither
    private = await create_page(client, title="P", is_template=True, access_="private")
    as_user(bob)
    for template_id in (private["id"], parent["id"], str(uuid.uuid4())):
        refused = await client.post(
            f"{API}/wiki/pages",
            json={"client_save_id": key(), "template_page_id": template_id},
        )
        assert refused.status_code == 404, refused.text
        assert refused.json()["error"]["code"] == "template_not_found"
    both = await client.post(
        f"{API}/wiki/pages",
        json={
            "client_save_id": key(),
            "template_page_id": template["id"],
            "template_key": "minutes",
        },
    )
    assert both.status_code == 422
    # a retry is the same page
    save_id = key()
    first = await client.post(
        f"{API}/wiki/pages",
        json={"client_save_id": save_id, "template_page_id": template["id"]},
    )
    again = await client.post(
        f"{API}/wiki/pages",
        json={"client_save_id": save_id, "template_page_id": template["id"]},
    )
    assert first.status_code == 201 and again.status_code == 200
    assert first.json()["id"] == again.json()["id"]
    assert (
        await db.scalar(
            select(func.count())
            .select_from(Attachment)
            .where(Attachment.page_id == uuid.UUID(first.json()["id"]))
        )
        == 1
    )
    # a built-in one keeps working
    await canvases.ensure_builtin_templates(db)
    await db.commit()
    minutes = await client.post(
        f"{API}/wiki/pages",
        json={"client_save_id": key(), "template_key": "minutes", "tz": "Asia/Tokyo"},
    )
    assert minutes.status_code == 201 and minutes.json()["title"].startswith("議事録 20")
    await assert_acl_consistent(db)


async def test_an_empty_page_starts_from_a_template(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await canvases.ensure_builtin_templates(db)
    await db.commit()
    as_user(alice)
    image = await _upload(client)
    template = await create_page(
        client,
        title="議事録 {{date}}",
        body=f"# {{{{parent}}}} の議事録\n![x](attachment:{image})\n",
        icon="🗒",
        is_template=True,
    )
    lab = await create_page(client, title="Lab")
    as_user(bob)
    empty = await create_page(client, parent_id=lab["id"], title="", body="")

    def apply(page_id: str, **body: Any) -> Any:
        return client.post(
            f"{API}/wiki/pages/{page_id}/apply-template",
            json={"client_save_id": key(), "tz": "Asia/Tokyo", **body},
        )

    response = await apply(empty["id"], template_page_id=template["id"])
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["title"].startswith("議事録 20") and page["icon"] == "🗒"
    assert page["body"].startswith("# Lab の議事録")
    [copy] = _attachment_ids(page["body"])
    assert copy != image
    assert page["id"] in await _tree_ids(client)
    # a page with a body does not
    again = await apply(empty["id"], template_key="minutes")
    assert again.status_code == 409 and again.json()["error"]["code"] == "wiki_page_not_empty"
    # a title of its own stays; a built-in one works too
    named = await create_page(client, parent_id=lab["id"], title="Kickoff", body="")
    page = (await apply(named["id"], template_key="minutes")).json()
    assert page["title"] == "Kickoff" and page["body"].startswith("# 議事録 20")
    neither = await client.post(
        f"{API}/wiki/pages/{named['id']}/apply-template", json={"client_save_id": key()}
    )
    assert neither.status_code == 422
    # reading is not enough
    as_user(alice)
    await set_access(
        client, lab["id"], [("user", str(alice.id), "full"), ("user", str(bob.id), "view")]
    )
    blank = await create_page(client, parent_id=lab["id"], title="", body="")
    as_user(bob)
    refused = await apply(blank["id"], template_key="minutes")
    assert refused.status_code == 403


async def _shown_anywhere(client: AsyncClient, page_id: str) -> str:
    """Everything the editor gets back about a page: the page, its history and each version."""
    out = [(await client.get(f"{API}/wiki/pages/{page_id}")).text]
    listed = await client.get(f"{API}/wiki/pages/{page_id}/revisions")
    assert listed.status_code == 200, listed.text
    out.append(listed.text)
    for item in listed.json()["items"]:
        one = await client.get(f"{API}/wiki/pages/{page_id}/revisions/{item['id']}")
        assert one.status_code == 200, one.text
        out.append(one.text)
    return "\n".join(out)


async def test_a_template_does_not_write_a_hidden_parents_title(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    """REVIEW-v0.1.48 #2: {{parent}} / {{channel}} on a page whose parent the actor cannot read
    become "" (as at the top level), for a page template and a built-in one, and when the
    parent's share is taken away just before."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    db.add(
        CanvasTemplate(
            key="leak-check",
            name="Leak check",
            title="{{channel}} memo",
            body="parent=[{{parent}}] channel=[{{channel}}]\n",
            position=99,
        )
    )
    await db.commit()
    secret = "CONFIDENTIAL acquisition target"
    as_user(alice)
    parent = await create_page(client, title=secret, access_="private")
    children = [
        await create_page(client, parent_id=parent["id"], title="", body="") for _ in range(3)
    ]
    for child in children:
        await set_access(
            client,
            child["id"],
            [("user", str(alice.id), "full"), ("user", str(bob.id), "edit")],
            inherit=False,
        )
    as_user(bob)
    assert (await client.get(f"{API}/wiki/pages/{parent['id']}")).status_code == 404
    template = await create_page(
        client,
        title="{{parent}} notes",
        body="parent=[{{parent}}] channel=[{{channel}}]\n",
        is_template=True,
    )

    def apply(page_id: str, **body: Any) -> Any:
        return client.post(
            f"{API}/wiki/pages/{page_id}/apply-template",
            json={"client_save_id": key(), "tz": "Asia/Tokyo", **body},
        )

    for child, how in zip(
        children[:2],
        [{"template_page_id": template["id"]}, {"template_key": "leak-check"}],
        strict=True,
    ):
        response = await apply(child["id"], **how)
        assert response.status_code == 200, response.text
        page = response.json()
        assert page["body"].startswith("parent=[] channel=[]"), page["body"]
        assert page["title"] in ("notes", "memo")
        assert secret not in response.text
        assert secret not in await _shown_anywhere(client, child["id"])

    # readable when applied: its title; the share taken away just before: ""
    as_user(alice)
    await set_access(
        client, parent["id"], [("user", str(alice.id), "full"), ("user", str(bob.id), "view")]
    )
    readable = await create_page(client, parent_id=parent["id"], title="", body="")
    await set_access(
        client,
        readable["id"],
        [("user", str(alice.id), "full"), ("user", str(bob.id), "edit")],
        inherit=False,
    )
    as_user(bob)
    page = (await apply(readable["id"], template_page_id=template["id"])).json()
    assert page["body"].startswith(f"parent=[{secret}]") and page["title"] == f"{secret} notes"
    as_user(alice)
    await set_access(client, parent["id"], [("user", str(alice.id), "full")])
    as_user(bob)
    assert (await client.get(f"{API}/wiki/pages/{parent['id']}")).status_code == 404
    response = await apply(children[2]["id"], template_page_id=template["id"])
    assert response.status_code == 200, response.text
    assert response.json()["body"].startswith("parent=[] channel=[]")
    assert secret not in await _shown_anywhere(client, children[2]["id"])
    await assert_acl_consistent(db)


async def test_template_variables_keep_canvases_as_they_were() -> None:
    ctx = tpl.Context(
        today=datetime(2026, 10, 1).date(),
        me_id=uuid.UUID(int=1),
        me_name="Me",
        channel="general",
    )
    assert tpl.expand("{{date}} {{time}} {{parent}}", ctx, title=False) == (
        "2026-10-01 (木) {{time}} {{parent}}"
    )
    wiki = tpl.Context(
        today=datetime(2026, 10, 1).date(),
        me_id=uuid.UUID(int=1),
        me_name="Me",
        channel="Lab",
        time="09:30",
        parent="Lab",
    )
    assert tpl.expand("{{time}} {{parent}} {{me}}", wiki, title=True) == "09:30 Lab Me"


# --- row templates -------------------------------------------------------------------------------


async def _tasks(client: AsyncClient) -> dict[str, Any]:
    database = await create_database(client, title="Tasks")
    await schema(
        client,
        database,
        {"op": "add", "name": "Due", "type": "date"},
        {"op": "add", "name": "Owner", "type": "person"},
        {
            "op": "add",
            "name": "Stage",
            "type": "select",
            "options": [{"name": "todo"}, {"name": "done"}],
        },
        {"op": "add", "name": "Note", "type": "text"},
    )
    return database


async def _row(client: AsyncClient, database: dict[str, Any], **body: Any) -> Any:
    response = await client.post(
        f"{API}/wiki/databases/{database['page_id']}/rows",
        json={"client_save_id": key(), **body},
    )
    return response


async def test_row_templates_dynamic_values_and_the_default(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    database = await _tasks(client)
    due, owner, stage, note = (prop_id(database, n) for n in ("Due", "Owner", "Stage", "Note"))
    todo = option_id(database, "Stage", "todo")
    image = await _upload(client)
    made = await _row(
        client,
        database,
        title="Weekly {{date}}",
        is_template=True,
        props={due: {"start": "@today"}, owner: ["@me", str(bob.id)], stage: todo, note: "n"},
        body=f"Report by {{{{me}}}} on {{{{date}}}}\n![x](attachment:{image})\n",
    )
    assert made.status_code == 201, made.text
    template = made.json()["row"]
    assert template["props"][due] == {"start": "@today", "end": None, "time": False}
    assert template["props"][owner] == ["@me", str(bob.id)]
    # a row (not a template) cannot hold 「今日」
    refused = await _row(client, database, title="x", props={due: {"start": "@today"}})
    assert refused.status_code == 422
    await add_row(client, database, "Real")

    # not a row of the table, the count, the CSV or a relation's candidates
    assert await titles(client, database) == ["Real"]
    got = (await client.get(f"{API}/wiki/databases/{database['page_id']}")).json()
    assert got["row_count"] == 1 and got["default_template_id"] is None
    assert got["templates"] == [{"id": template["id"], "title": "Weekly {{date}}", "icon": None}]
    exported = await client.get(f"{API}/wiki/databases/{database['page_id']}/export.csv")
    assert [r[0] for r in csv.reader(io.StringIO(exported.text.lstrip("﻿")))][1:] == ["Real"]
    await schema(
        client,
        database,
        {
            "op": "add",
            "name": "Self",
            "type": "relation",
            "relation": {"database_id": database["page_id"]},
        },
    )
    rel = prop_id(database, "Self")
    candidates = await client.get(
        f"{API}/wiki/databases/{database['page_id']}/properties/{rel}/candidates"
    )
    assert [r["title"] for r in candidates.json()] == ["Real"]
    # the template's body is edited as a page; its values as a row's (still dynamic)
    page = (await client.get(f"{API}/wiki/pages/{template['id']}")).json()
    assert page["is_template"] and page["kind"] == "row"
    await set_cells(client, template["id"], {owner: ["@me"]})

    # a row from it: 「今日」 and 「自分」 put in, the body's placeholders too, the file copied
    as_user(bob)
    response = await _row(client, database, template_id=template["id"], tz="Asia/Tokyo")
    assert response.status_code == 201, response.text
    row = response.json()["row"]
    assert row["props"][due]["start"] in _today("Asia/Tokyo")
    assert row["props"][owner] == [str(bob.id)]
    assert row["props"][stage] == todo and row["props"][note] == "n"
    assert row["title"].startswith("Weekly 20")
    body = (await client.get(f"{API}/wiki/pages/{row['id']}")).json()["body"]
    assert body.startswith(f"Report by <@{bob.id}> on 20")
    [copy] = _attachment_ids(body)
    assert copy != image
    # given values and a title win
    response = await _row(
        client,
        database,
        template_id=template["id"],
        title="Mine",
        props={stage: option_id(database, "Stage", "done"), due: "2026-12-24"},
    )
    row = response.json()["row"]
    assert row["title"] == "Mine" and row["props"][due]["start"] == "2026-12-24"
    assert row["props"][stage] == option_id(database, "Stage", "done")

    # the default: a new row starts from it unless blank (or a template)
    set_default = await client.put(
        f"{API}/wiki/databases/{database['page_id']}/default-template",
        json={"template_id": template["id"]},
    )
    assert (
        set_default.status_code == 200
        and set_default.json()["default_template_id"] == template["id"]
    )
    plain = (await _row(client, database, title="")).json()["row"]
    assert plain["title"].startswith("Weekly") and plain["props"][stage] == todo
    blank = (await _row(client, database, title="B", blank=True)).json()["row"]
    assert blank["props"] == {}
    # another database's template is not one of this database's
    other = await _tasks(client)
    wrong = await _row(client, other, template_id=template["id"])
    assert wrong.status_code == 404 and wrong.json()["error"]["code"] == "template_not_found"
    wrong_default = await client.put(
        f"{API}/wiki/databases/{other['page_id']}/default-template",
        json={"template_id": template["id"]},
    )
    assert wrong_default.status_code == 404

    # a template made a row again is not the default any more (and is a row of the table)
    back = await client.patch(f"{API}/wiki/pages/{template['id']}", json={"is_template": False})
    assert back.status_code == 200, back.text
    got = (await client.get(f"{API}/wiki/databases/{database['page_id']}")).json()
    assert got["default_template_id"] is None and got["templates"] == []
    # a row becomes a template with 「テンプレートにする」
    real = next(
        r
        for r in (
            await client.post(f"{API}/wiki/databases/{database['page_id']}/query", json={})
        ).json()["rows"]
        if r["title"] == "Real"
    )
    turned = await client.patch(f"{API}/wiki/pages/{real['id']}", json={"is_template": True})
    assert turned.status_code == 200 and turned.json()["is_template"]
    assert "Real" not in await titles(client, database)
    await assert_acl_consistent(db)


async def test_row_templates_follow_the_database_access(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    database = await _tasks(client)
    template = (await _row(client, database, title="T", is_template=True)).json()["row"]
    await set_access(
        client,
        database["page_id"],
        [("user", str(alice.id), "full"), ("user", str(bob.id), "view")],
        inherit=False,
    )
    as_user(bob)
    got = (await client.get(f"{API}/wiki/databases/{database['page_id']}")).json()
    assert [t["id"] for t in got["templates"]] == [template["id"]]
    for response in (
        await _row(client, database, template_id=template["id"]),
        await _row(client, database, title="x", is_template=True),
        await client.put(
            f"{API}/wiki/databases/{database['page_id']}/default-template",
            json={"template_id": template["id"]},
        ),
        await client.patch(f"{API}/wiki/pages/{template['id']}", json={"is_template": False}),
    ):
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "page_edit_restricted"


# --- duplicate -----------------------------------------------------------------------------------


async def test_duplicate_a_page_beside_it_with_its_files(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    gina = await make_user(db, "gina", role="guest")
    as_user(alice)
    lab = await create_page(client, title="Lab")
    image = await _upload(client)
    source = await create_page(
        client,
        parent_id=lab["id"],
        title="Notes",
        body=f"{{{{date}}}} <@{bob.id}>\n![x](attachment:{image})\n",
        icon="📒",
    )
    after = await create_page(client, parent_id=lab["id"], title="After")
    await create_page(client, parent_id=source["id"], title="Sub")
    notices = await db.scalar(select(func.count()).select_from(WikiNotice))

    copy = (await _duplicate(client, source["id"]))["page"]
    assert copy["title"] == "Notes（コピー）" and copy["icon"] == "📒"
    assert copy["parent_id"] == lab["id"] and copy["children"] == []
    assert copy["body"].startswith(f"{{{{date}}}} <@{bob.id}>")  # placeholders as they are
    [copy_image] = _attachment_ids(copy["body"])
    assert copy_image != image
    stored = await db.get(Attachment, uuid.UUID(copy_image))
    assert stored is not None and stored.page_id == uuid.UUID(copy["id"])
    assert await app.state.blobs.exists(stored.storage_key)
    # beside the original, before the next one; nobody told again
    order = [
        c["title"] for c in (await client.get(f"{API}/wiki/pages/{lab['id']}")).json()["children"]
    ]
    assert order == ["Notes", "Notes（コピー）", "After"]
    assert after["id"] != copy["id"]
    assert await db.scalar(select(func.count()).select_from(WikiNotice)) == notices
    # access: Lab's (inherited)
    access_ = (await client.get(f"{API}/wiki/pages/{copy['id']}/access")).json()
    assert access_["own"] == [] and access_["inherit_access"]
    # the reader's language
    english = await client.post(
        f"{API}/wiki/pages/{source['id']}/duplicate",
        json={"client_save_id": key()},
        headers={"Accept-Language": "en"},
    )
    assert english.json()["page"]["title"] == "Notes (copy)"
    # a retry is the same copy
    save_id = key()
    first = await client.post(
        f"{API}/wiki/pages/{source['id']}/duplicate", json={"client_save_id": save_id}
    )
    again = await client.post(
        f"{API}/wiki/pages/{source['id']}/duplicate", json={"client_save_id": save_id}
    )
    assert (first.status_code, again.status_code) == (201, 200)
    assert first.json()["page"]["id"] == again.json()["page"]["id"]

    # 「テンプレートとして保存」: a template at the top level (the original stays)
    saved = (await _duplicate(client, source["id"], as_template=True))["page"]
    assert saved["is_template"] and saved["parent_id"] is None and saved["title"] == "Notes"
    assert saved["id"] in {p["id"] for p in (await _templates(client))["pages"]}
    assert (await client.get(f"{API}/wiki/pages/{source['id']}")).json()["is_template"] is False
    # a template's copy as a page (without putting the placeholders in)
    used = (await _duplicate(client, saved["id"], as_template=False))["page"]
    assert not used["is_template"] and used["title"] == "Notes" and used["parent_id"] is None

    # a private page's copy at the top level stays private
    private = await create_page(client, title="Secret", access_="private")
    secret_copy = (await _duplicate(client, private["id"]))["page"]
    assert secret_copy["private"] is True
    # a database is not duplicated (yet)
    database = await create_database(client, parent_id=lab["id"])
    refused = await _duplicate(client, database["page_id"], expect=400)
    assert refused["error"]["code"] == "wiki_cannot_duplicate"

    # bob reads (does not edit) a page shared with him alone: not beside it, at the top yes
    await set_access(
        client,
        private["id"],
        [("user", str(alice.id), "full"), ("user", str(bob.id), "view")],
        inherit=False,
    )
    inner = await create_page(client, parent_id=private["id"], title="Inner")
    as_user(bob)
    refused = await _duplicate(client, inner["id"], expect=403)
    assert refused["error"]["code"] == "page_edit_restricted"
    top = (await _duplicate(client, inner["id"], parent_id=None))["page"]
    assert top["parent_id"] is None
    # a guest makes no template and no top-level page
    await set_access(
        client,
        top["id"],
        [("user", str(bob.id), "full"), ("user", str(gina.id), "view")],
        inherit=False,
    )
    as_user(gina)
    for body in ({"as_template": True}, {"parent_id": None}):
        refused = await _duplicate(client, top["id"], expect=403, **body)
        assert refused["error"]["code"] == "guest_restricted"
    await assert_acl_consistent(db)


async def test_duplicate_a_row_with_its_values(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    database = await _tasks(client)
    await schema(
        client,
        database,
        {
            "op": "add",
            "name": "Self",
            "type": "relation",
            "relation": {"database_id": database["page_id"]},
        },
    )
    stage, owner, rel = (prop_id(database, n) for n in ("Stage", "Owner", "Self"))
    todo = option_id(database, "Stage", "todo")
    first = await add_row(client, database, "First")
    second = await add_row(
        client, database, "Second", {stage: todo, owner: [str(bob.id)], rel: [first["id"]]}
    )
    await add_row(client, database, "Third")

    out = await _duplicate(client, second["id"])
    row = out["row"]["row"]
    assert out["page"]["kind"] == "row" and row["title"] == "Second（コピー）"
    assert row["props"][stage] == todo and row["props"][owner] == [str(bob.id)]
    assert row["relations"][rel] == [first["id"]]
    assert await titles(client, database) == ["First", "Second", "Second（コピー）", "Third"]
    # as a row template of the same database
    template = (await _duplicate(client, second["id"], as_template=True))["row"]["row"]
    got = (await client.get(f"{API}/wiki/databases/{database['page_id']}")).json()
    assert [t["id"] for t in got["templates"]] == [template["id"]]
    # a template with 「今日」 duplicated as a row puts it in
    due = prop_id(database, "Due")
    dynamic = (
        await _row(client, database, title="D", is_template=True, props={due: "@today"})
    ).json()["row"]
    made = (await _duplicate(client, dynamic["id"], as_template=False))["row"]["row"]
    assert made["props"][due]["start"] != "@today"
    # a row stays in its database
    other = await _tasks(client)
    refused = await _duplicate(client, first["id"], parent_id=other["page_id"], expect=400)
    assert refused["error"]["code"] == "invalid_page_parent"


# --- the Notion import ---------------------------------------------------------------------------


async def test_notion_rows_not_in_the_csv_become_row_templates(
    app: FastAPI, db: AsyncSession, tmp_path: Path, client: AsyncClient, as_user: Actor
) -> None:
    people = await _people(db)
    path = write_zip(tmp_path / "e.zip", export_files())
    report = await run_import(app, db, path)
    assert report.counts["row templates: new"] == 1
    template = await _page(db, "Template", "row")
    assert template.is_template
    papers = await _page(db, "Papers", "database")
    as_user(people["bob"])
    got = (await client.get(f"{API}/wiki/databases/{papers.id}")).json()
    assert [t["title"] for t in got["templates"]] == ["Template"]
    assert got["row_count"] == 3
    # running it again changes nothing
    again = await run_import(app, db, path)
    assert again.templates == [] and "row templates: turned" not in again.counts


async def _as_before_m145(db: AsyncSession) -> None:
    """The rows an import before M145 made: rows, without the template entries."""
    await db.execute(delete(ImportRef).where(ImportRef.kind == "template"))
    await db.execute(update(WikiPage).where(WikiPage.kind == "row").values(is_template=False))
    await db.commit()


async def test_the_cli_turns_rows_imported_before_into_templates_once(
    app: FastAPI, db: AsyncSession, tmp_path: Path, client: AsyncClient, as_user: Actor
) -> None:
    people = await _people(db)
    files = export_files()
    files[f"Home/Papers/Draft {'d' * 32}.md"] = "# Draft\n\nStage: draft\n"
    path = write_zip(tmp_path / "e.zip", files)
    await run_import(app, db, path)
    await _as_before_m145(db)
    # someone changed one of them since: it stays a row
    draft = await _page(db, "Draft", "row")
    as_user(people["bob"])
    await set_cells(client, str(draft.id), {"title": "Draft (used)"})

    dry = await convert_notion_templates(
        db, path, actor_username="admin", settings=app.state.settings, dry_run=True
    )
    assert dry.dry_run and len(dry.templates) == 1 and "Template" in dry.templates[0]
    assert len(dry.templates_left) == 1 and "Draft" in dry.templates_left[0]
    assert not (await _page(db, "Template", "row")).is_template

    done = await convert_notion_templates(
        db, path, actor_username="admin", settings=app.state.settings, dry_run=False
    )
    assert len(done.templates) == 1
    template = await _page(db, "Template", "row")
    assert template.is_template
    assert not (await _page(db, "Draft (used)", "row")).is_template
    # again: nothing
    again = await convert_notion_templates(
        db, path, actor_username="admin", settings=app.state.settings, dry_run=False
    )
    assert again.templates == []
    # made a row again by someone: a later run (or import) leaves it a row
    await db.refresh(people["bob"])  # the runs committed the session the actor came from
    response = await client.patch(f"{API}/wiki/pages/{template.id}", json={"is_template": False})
    assert response.status_code == 200, response.text
    later = await convert_notion_templates(
        db, path, actor_username="admin", settings=app.state.settings, dry_run=False
    )
    assert later.templates == []
    report = await run_import(app, db, path)
    assert report.templates == []
    assert not (await _page(db, "Template", "row")).is_template
    record = await db.get(WikiDatabase, template.parent_id)
    assert record is not None


async def test_the_cli_leaves_rows_changed_after_its_plan(
    app: FastAPI,
    db: AsyncSession,
    tmp_path: Path,
    client: AsyncClient,
    as_user: Actor,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REVIEW-v0.1.48 #6: rows planned as unchanged that someone renames, writes in, makes a
    template and a row again, or trashes before the conversion locks them stay rows (reported),
    with no template entry; the untouched one is converted."""
    people = await _people(db)
    files = export_files()
    for name, nid in (("Draft", "d"), ("Spare", "e"), ("Gone", "f"), ("Idle", "9")):
        files[f"Home/Papers/{name} {nid * 32}.md"] = f"# {name}\n\nStage: draft\n"
    path = write_zip(tmp_path / "e.zip", files)
    await run_import(app, db, path)
    await _as_before_m145(db)
    ids = {
        n: (await _page(db, n, "row")).id for n in ("Template", "Draft", "Spare", "Gone", "Idle")
    }
    papers_id = (await _page(db, "Papers", "database")).id
    await db.refresh(people["bob"])
    await db.commit()

    real = NotionImport._convert_templates

    async def edits_first(job: NotionImport) -> int:
        assert len(job._plan_templates()) == 5  # all planned as unchanged
        as_user(people["bob"])
        await set_cells(client, str(ids["Template"]), {"title": "An actual research project"})
        draft = (await client.get(f"{API}/wiki/pages/{ids['Draft']}")).json()
        assert (await save(client, draft, "# Draft\n\nreal notes\n")).status_code == 200
        for flag in (True, False):
            response = await client.patch(
                f"{API}/wiki/pages/{ids['Spare']}", json={"is_template": flag}
            )
            assert response.status_code == 200, response.text
        assert (await client.delete(f"{API}/wiki/pages/{ids['Gone']}")).status_code == 204
        return await real(job)

    monkeypatch.setattr(NotionImport, "_convert_templates", edits_first)
    report = await convert_notion_templates(
        db, path, actor_username="admin", settings=app.state.settings, dry_run=False
    )

    assert len(report.templates) == 1 and "Idle" in report.templates[0]
    assert report.counts["row templates: turned"] == 1
    left = " ".join(report.templates_left)
    assert all(n in left for n in ("Template", "Draft", "Spare")) and "Gone" not in left
    db.expire_all()
    for name in ("Template", "Draft", "Spare", "Gone"):
        page = await db.get(WikiPage, ids[name])
        assert page is not None and not page.is_template, name
    idle = await db.get(WikiPage, ids["Idle"])
    assert idle is not None and idle.is_template
    refs = (
        await db.execute(select(ImportRef.target_id).where(ImportRef.kind == "template"))
    ).scalars()
    assert set(refs) == {ids["Idle"]}
    await db.refresh(people["bob"])
    response = await client.post(f"{API}/wiki/databases/{papers_id}/query", json={"limit": 50})
    assert response.status_code == 200, response.text
    listed = {r["id"] for r in response.json()["rows"]}
    assert {str(ids[n]) for n in ("Template", "Draft", "Spare")} <= listed
    assert str(ids["Idle"]) not in listed


async def test_cli_parses_wiki_notion_templates() -> None:
    from app import cli

    args = cli.build_parser().parse_args(
        ["wiki-notion-templates", "x.zip", "--actor", "admin", "--dry-run"]
    )
    assert args.func is cli.cmd_wiki_notion_templates and args.dry_run
