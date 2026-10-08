"""M149 (docs/WIKI.md §22.5): callouts and toggles on the server. The Notion import writes
`::: callout` / `::: toggle` containers, `app.cli wiki-rewrite-callouts` rewrites the quotes an
earlier import wrote, and the search indexes and snippets hold only the content."""

import importlib.util
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import cli
from app.core.doctext.blocks import BODY_SQL, reading_text, strip_container_markers
from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.importer.core import ImportFailed
from app.modules.importer.notion_export import convert_markdown, is_icon, rewrite_quote_callouts
from app.modules.importer.notion_import import rewrite_callouts
from app.modules.users.models import User
from app.modules.wiki.models import WikiPage, WikiPageRevision
from tests.helpers import make_user
from tests.test_notion_import import HOME, run_import, write_zip
from tests.wiki_helpers import API, Actor, create_page, save


def convert(body: str) -> Any:
    return convert_markdown(body, link_fn=lambda _l, _o: None, bare_fn=str, mention_fn=str)


# --- the import ----------------------------------------------------------------------------------


def test_aside_becomes_a_callout() -> None:
    out = convert("前\n<aside>\n💡\n\n**大事**な点\n\n- 一つ目\n\n</aside>\n後\n")
    assert out.body == "前\n::: callout 💡\n**大事**な点\n\n- 一つ目\n:::\n後\n"
    assert out.unsupported == {}


def test_aside_without_icon_and_with_a_word_first() -> None:
    assert convert("<aside>\nただの文\n</aside>\n").body == "::: callout\nただの文\n:::\n"
    # a short word is not an icon (no symbol in it), nor is ASCII
    assert convert("<aside>\n注意\nx\n</aside>\n").body == "::: callout\n注意\nx\n:::\n"
    assert convert("<aside>\nOK\nx\n</aside>\n").body == "::: callout\nOK\nx\n:::\n"
    # an icon alone, and a two-character emoji (with U+FE0F)
    assert convert("<aside>\n⚠️\n</aside>\n").body == "::: callout ⚠️\n:::\n"
    info = "\u2139\ufe0f"  # information source (ruff: ambiguous with i when written out)
    assert convert(f"<aside>\n{info}\n- a\n</aside>\n").body == f"::: callout {info}\n- a\n:::\n"


def test_details_becomes_a_toggle() -> None:
    body = "<details>\n<summary>詳しく <b>見る</b></summary>\n\n中身\n\n- [ ] タスク\n</details>\n"
    assert convert(body).body == "::: toggle 詳しく 見る\n中身\n\n- [ ] タスク\n:::\n"
    assert convert("<details>\n本文だけ\n</details>\n").body == "::: toggle\n本文だけ\n:::\n"


def test_nesting_two_deep_then_the_old_way() -> None:
    body = (
        "<aside>\n💡\n外\n<details>\n<summary>中</summary>\n入れ子\n"
        "<aside>\n🔥\n三段目\n</aside>\n<details>\n<summary>深い</summary>\nx\n</details>\n"
        "</details>\n</aside>\n"
    )
    out = convert(body)
    assert out.body == (
        "::: callout 💡\n外\n::: toggle 中\n入れ子\n> 🔥 三段目\n- 深い\n    x\n:::\n:::\n"
    )
    assert out.unsupported == {
        "コールアウト（3 段目の入れ子）→ 引用": 1,
        "トグル（3 段目の入れ子）→ 箇条書き": 1,
    }


def test_code_inside_and_around_is_left_alone() -> None:
    body = (
        "```\n<aside>\n💡\n```\n"
        "<aside>\n📝\n```\n</aside>\n> 💡 x\n```\n</aside>\n"
        "~~~\n<details>\n~~~\n"
    )
    assert convert(body).body == (
        "```\n<aside>\n💡\n```\n"
        "::: callout 📝\n```\n</aside>\n> 💡 x\n```\n:::\n"
        "~~~\n<details>\n~~~\n"
    )


def test_is_icon() -> None:
    for icon in ("💡", "⚠️", "\u2139", "‼️", "✅", "🇯🇵"):
        assert is_icon(icon), icon
    for text in ("", "注意", "「引用」", "OK", "-", "#", "…", "1️⃣", "💡💡💡💡💡"):
        assert not is_icon(text), text


# --- rewriting the quotes of the M125 import -----------------------------------------------------


def test_rewrite_a_callout_quote() -> None:
    assert rewrite_quote_callouts("> 💡 Remember **this**.\n") == (
        "::: callout 💡\nRemember **this**.\n:::\n"
    )
    old = "前\n\n> ⚠️\n>\n> - 一つ目\n> - 二つ目\n>\n後\n"
    assert rewrite_quote_callouts(old) == "前\n\n::: callout ⚠️\n- 一つ目\n- 二つ目\n:::\n後\n"


def test_rewrite_leaves_other_quotes_and_code() -> None:
    body = (
        "> 引用です\n> 💡 二行目\n\n"  # the run does not begin with an icon
        "> Hello 💡\n\n"  # an ASCII word first
        "> 「注意」 です\n\n"
        "> - 💡 a list\n\n"
        "```\n> 💡 code\n```\n"
        "~~~\n> 🔥 code\n~~~\n"
    )
    assert rewrite_quote_callouts(body) == body


def test_rewrite_nested_and_idempotent() -> None:
    old = "> 💡 外\n>\n> > ⚠️ 内\n> > > 🔥 三段目\n> 外の続き\n\n> 📌 次\n"
    new = rewrite_quote_callouts(old)
    assert new == (
        "::: callout 💡\n外\n\n::: callout ⚠️\n内\n> 🔥 三段目\n:::\n外の続き\n:::\n\n"
        "::: callout 📌\n次\n:::\n"
    )
    assert rewrite_quote_callouts(new) == new
    # what the new import writes is left as it is too
    imported = convert("<aside>\n💡\n<aside>\n⚠️\n<aside>\n🔥\nx\n</aside>\n</aside>\n</aside>\n")
    assert rewrite_quote_callouts(imported.body) == imported.body


def test_rewrite_keeps_code_inside_a_callout() -> None:
    old = "> 💡 例\n> ```\n> > 💡 not a callout\n> :::\n> ```\n"
    assert rewrite_quote_callouts(old) == (
        "::: callout 💡\n例\n```\n> 💡 not a callout\n:::\n```\n:::\n"
    )


# --- the command ---------------------------------------------------------------------------------

OLD_HOME = "# Home\n\nIntro.\n\n> 💡 Remember **this**.\n\n> just a quote\n"
OLD_GUIDE = "# Guide\n\n> 🔥 Hot\n> - [ ] task\n"
OLD_PLAIN = "# Plain\n\nNothing to rewrite.\n"
GUIDE_ID = "b" * 31 + "2"
PLAIN_ID = "c" * 31 + "3"


async def _import_old_bodies(app: FastAPI, db: AsyncSession, tmp_path: Path) -> None:
    """Pages imported before M149 (their bodies as the M125 import wrote them)."""
    await make_user(db, "admin", role="admin")
    files: dict[str, bytes | str] = {
        f"Home {HOME}.md": "# Home\n\nIntro.\n",
        f"Home/Guide {GUIDE_ID}.md": "# Guide\n\nx\n",
        f"Home/Plain {PLAIN_ID}.md": OLD_PLAIN,
    }
    await run_import(app, db, write_zip(tmp_path / "e.zip", files))
    for title, body in (("Home", OLD_HOME), ("Guide", OLD_GUIDE)):
        page = await _page(db, title)
        head = await db.get(WikiPageRevision, page.head_rev_id)
        assert head is not None and head.kind == "import"
        page.body = head.body = body.split("\n", 2)[2]
    await db.commit()


async def _page(db: AsyncSession, title: str) -> WikiPage:
    page = (await db.execute(select(WikiPage).where(WikiPage.title == title))).scalars().one()
    await db.refresh(page)
    return page


async def _count(db: AsyncSession, model: Any) -> int:
    return int((await db.execute(select(func.count()).select_from(model))).scalar_one())


async def test_command_rewrites_pages_unchanged_since_the_import(
    app: FastAPI, db: AsyncSession, tmp_path: Path, client: AsyncClient, as_user: Actor
) -> None:
    await _import_old_bodies(app, db, tmp_path)
    admin = (await db.execute(select(User).where(User.username == "admin"))).scalar_one()
    # someone edits Guide after the import: reported, left
    guide = await _page(db, "Guide")
    as_user(admin)
    page = (await client.get(f"{API}/wiki/pages/{guide.id}")).json()
    assert (await save(client, page, page["body"] + "\nmine\n")).status_code == 200
    revisions = await _count(db, WikiPageRevision)

    dry = await rewrite_callouts(db, actor_username="admin", dry_run=True)
    assert [line.split(" (")[0] for line in dry.changed] == ["Home"]
    assert [line.split(" (")[0] for line in dry.edited] == ["Guide"]
    assert await _count(db, WikiPageRevision) == revisions
    assert (await _page(db, "Home")).body == OLD_HOME.split("\n", 2)[2]

    home_before = await _page(db, "Home")
    old_head, old_version = home_before.head_rev_id, home_before.version
    events_before = await _count(db, OutboxEvent)
    report = await rewrite_callouts(db, actor_username="admin", dry_run=False)
    assert len(report.changed) == 1 and len(report.edited) == 1 and report.unchanged >= 1
    home = await _page(db, "Home")
    assert home.body == "Intro.\n\n::: callout 💡\nRemember **this**.\n:::\n\n> just a quote\n"
    assert home.version == old_version + 1
    head = await db.get(WikiPageRevision, home.head_rev_id)
    assert head is not None and head.kind == "import" and head.parent_rev_id == old_head
    assert head.body == home.body and head.title == "Home"
    assert head.lines_added > 0 and head.lines_removed > 0
    assert await _count(db, WikiPageRevision) == revisions + 1
    assert await _count(db, OutboxEvent) > events_before
    assert "mine" in (await _page(db, "Guide")).body
    assert "> 🔥 Hot" in (await _page(db, "Guide")).body
    audit = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "wiki.callouts_rewritten")))
        .scalars()
        .all()
    )
    assert len(audit) == 1 and audit[0].details == {"pages": 1, "edited": 1, "trashed": 0}

    # the page reads the same through the API, and a second run changes nothing
    shown = (await client.get(f"{API}/wiki/pages/{home.id}")).json()
    assert shown["body"] == home.body and shown["head_rev_id"] == str(home.head_rev_id)
    again = await rewrite_callouts(db, actor_username="admin", dry_run=False)
    assert again.changed == [] and len(again.edited) == 1
    assert await _count(db, WikiPageRevision) == revisions + 1
    rows = select(func.count()).where(AuditLog.action == "wiki.callouts_rewritten")
    assert (await db.execute(rows)).scalar_one() == 1


async def test_command_needs_an_administrator(db: AsyncSession) -> None:
    await make_user(db, "member")
    with pytest.raises(ImportFailed):
        await rewrite_callouts(db, actor_username="member", dry_run=True)


def test_command_line() -> None:
    args = cli.build_parser().parse_args(["wiki-rewrite-callouts", "--actor", "admin", "--dry-run"])
    assert args.func is cli.cmd_wiki_rewrite_callouts and args.dry_run and args.actor == "admin"
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["wiki-rewrite-callouts"])


# --- search --------------------------------------------------------------------------------------


def test_reading_text() -> None:
    marker = "<!--task:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b-->"
    body = (
        f"::: callout 💡\n中身\n:::\n::: toggle 詳細\n- [ ] a {marker}\n:::\n"
        "```\n:::\n```\n::: callout\nx\n:::"
    )
    assert reading_text(body) == "💡\n中身\n詳細\n- [ ] a\n```\n:::\n```\nx"
    assert strip_container_markers("no containers") == "no containers"


def test_migration_writes_the_same_pattern() -> None:
    """The index expression (migration 0109) and the query's (blocks.BODY_SQL) must be equal."""
    path = Path(__file__).parents[1] / "migrations" / "versions" / "0109_search_container_lines.py"
    spec = importlib.util.spec_from_file_location("migration_0109", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.BODY_SQL == BODY_SQL
    assert "'" not in BODY_SQL


async def test_search_finds_the_content_not_the_markers(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    body = (
        "前置き\n\n::: toggle 詳細\n中のテキスト zebra\n:::\n\n::: callout 💡\nnote giraffe\n:::\n"
    )
    page = await create_page(client, title="手順書", body=body)
    for q in ("詳細", "zebra", "giraffe", "手順書"):
        found = (await client.get(f"{API}/search/pages", params={"q": q})).json()
        assert [h["page"]["id"] for h in found["hits"]] == [page["id"]], q
        assert ":::" not in found["hits"][0]["snippet"], q
    for q in ("callout", "toggle"):
        found = (await client.get(f"{API}/search/pages", params={"q": q})).json()
        assert found["hits"] == [], q


async def test_canvas_search_finds_the_content_not_the_markers(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    created = await client.post(f"{API}/channels", json={"name": "lab"})
    channel_id = created.json()["id"]
    body = "::: callout ⚠️\n注意 zebra\n:::\n::: toggle 開く\nhidden giraffe\n:::\n"
    response = await client.post(
        f"{API}/channels/{channel_id}/canvases",
        json={"client_save_id": "3f1c1b5e-6a1b-4d8e-9a33-0b5d8f0c1a2b", "title": "C", "body": body},
    )
    assert response.status_code == 201, response.text
    for q in ("zebra", "giraffe", "開く"):
        found = (await client.get(f"{API}/search/canvases", params={"q": q})).json()
        assert len(found["hits"]) == 1, q
        assert ":::" not in found["hits"][0]["snippet"], q
    for q in ("callout", "toggle"):
        found = (await client.get(f"{API}/search/canvases", params={"q": q})).json()
        assert found["hits"] == [], q
