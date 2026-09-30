"""Canvases, the rest of the server (M42, CANVAS.md §4.8-§4.14): search (Japanese / English, title
and body, membership, the index in EXPLAIN), images bound to a canvas (access, the release of
unreferenced ones), version pruning, the trash purge (audited), sharing, and the /c/ page."""

import io
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, Response
from PIL import Image
from sqlalchemy import insert, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.attachments.models import Attachment
from app.modules.audit.models import AuditLog
from app.modules.canvases import service as canvases
from app.modules.canvases.models import Canvas, CanvasRevision
from app.modules.search import repository as search_repo
from app.modules.search.snippet import make_snippet
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"
Actor = Callable[[User], None]


def key() -> str:
    return str(uuid.uuid4())


def png_bytes() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (32, 24), (10, 120, 200)).save(out, format="PNG")
    return out.getvalue()


async def _channel(client: AsyncClient, name: str, **extra: Any) -> str:
    created = await client.post(f"{API}/channels", json={"name": name, **extra})
    assert created.status_code == 201, created.text
    return str(created.json()["id"])


async def _add(client: AsyncClient, channel_id: str, *users: User) -> None:
    for user in users:
        added = await client.post(
            f"{API}/channels/{channel_id}/members", json={"user_id": str(user.id)}
        )
        assert added.status_code in (200, 201), added.text


async def _create(client: AsyncClient, channel_id: str, **body: Any) -> Response:
    return await client.post(
        f"{API}/channels/{channel_id}/canvases", json={"client_save_id": key(), **body}
    )


async def _canvas(client: AsyncClient, channel_id: str, **body: Any) -> dict[str, Any]:
    created = await _create(client, channel_id, **body)
    assert created.status_code == 201, created.text
    result: dict[str, Any] = created.json()
    return result


async def _save(client: AsyncClient, canvas: dict[str, Any], body: str) -> dict[str, Any]:
    """Save on the head (direct save); returns the canvas after it."""
    head = (await client.get(f"{API}/canvases/{canvas['id']}")).json()
    saved = await client.put(
        f"{API}/canvases/{canvas['id']}/content",
        json={"base_rev_id": head["head_rev_id"], "body": body, "client_save_id": key()},
    )
    assert saved.status_code == 200, saved.text
    result: dict[str, Any] = saved.json()["canvas"]
    return result


async def _search(client: AsyncClient, q: str, **params: Any) -> dict[str, Any]:
    response = await client.get(f"{API}/search/canvases", params={"q": q, **params})
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def titles(result: dict[str, Any]) -> list[str]:
    return [hit["canvas"]["title"] for hit in result["hits"]]


async def _upload(client: AsyncClient, name: str = "図.png") -> str:
    uploaded = await client.post(
        f"{API}/attachments", files={"file": (name, png_bytes(), "image/png")}
    )
    assert uploaded.status_code == 201, uploaded.text
    return str(uploaded.json()["id"])


async def _status(db: AsyncSession, attachment_id: str) -> tuple[str, uuid.UUID | None]:
    row = await db.get(Attachment, uuid.UUID(attachment_id), populate_existing=True)
    assert row is not None
    return row.status, row.canvas_id


# --- search (CANVAS.md §4.8) --------------------------------------------------------------------


async def test_search_japanese_english_title_body_and_membership(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    guest = await make_user(db, "guest", role="guest")
    as_user(alice)
    lab = await _channel(client, "lab")
    secret = await _channel(client, "secret", type="private")
    await _add(client, lab, bob)
    await _add(client, secret, guest)
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})).json()["id"]

    minutes = await _canvas(
        client,
        lab,
        title="議事録 10/1",
        body="# 議事録\n東京で研究計画を議論した。\n\nNext meeting in Tokyo on Friday.",
    )
    weekly = await _canvas(client, lab, title="Weekly report", body="今週は実験を進めた。")
    await _canvas(client, secret, title="秘密の計画", body="東京の秘密の会議")
    in_dm = await _canvas(client, dm, title="個人メモ", body="東京駅で待ち合わせ")
    trashed = await _canvas(client, lab, title="消したメモ", body="東京タワー")
    assert (await client.delete(f"{API}/canvases/{trashed['id']}")).status_code == 204

    # Bob: the public channel and the DM, not the private channel, not the trash.
    as_user(bob)
    found = await _search(client, "東京")
    assert sorted(titles(found)) == sorted(["議事録 10/1", "個人メモ"])
    assert found["keywords"] == ["東京"] and found["total"] == 2
    assert found["has_more"] is False and found["total_capped"] is False
    hit = next(h for h in found["hits"] if h["canvas"]["id"] == minutes["id"])
    assert "東京で研究計画を議論した。" in hit["snippet"] and "body" not in hit["canvas"]
    assert hit["score"] > 0
    # English, case folded; words are ANDed; bigrams find Japanese inside words.
    assert titles(await _search(client, "tokyo")) == ["議事録 10/1"]
    assert titles(await _search(client, "東京 研究計画")) == ["議事録 10/1"]
    assert titles(await _search(client, "実験")) == ["Weekly report"]
    assert titles(await _search(client, "大阪")) == []
    # Groonga query syntax, as for messages (so the query was not searched literally).
    assert sorted(titles(await _search(client, "実験 OR tokyo"))) == [
        "Weekly report",
        "議事録 10/1",
    ]
    assert titles(await _search(client, "東京 -研究計画")) == ["個人メモ"]
    # A title-only hit: the excerpt is the start of the body.
    by_title = await _search(client, "weekly")
    assert titles(by_title) == ["Weekly report"]
    assert by_title["hits"][0]["snippet"] == "今週は実験を進めた。"
    assert titles(await _search(client, "議事録")) == ["議事録 10/1"]

    # A save updates the index at once.
    await _save(client, weekly, "今週は大阪で実験を進めた。")
    assert titles(await _search(client, "大阪")) == ["Weekly report"]

    # Modifiers and filters.
    assert sorted(titles(await _search(client, "東京 in:#lab"))) == ["議事録 10/1"]
    assert titles(await _search(client, "東京", channel_id=dm)) == ["個人メモ"]
    edited = await _search(client, "from:@bob")  # creator or last editor, no words: newest first
    assert titles(edited) == ["Weekly report"]
    assert edited["filters"]["from_username"] == "bob"
    assert sorted(titles(await _search(client, "from:@alice"))) == sorted(
        ["議事録 10/1", "Weekly report", "個人メモ"]
    )
    unknown = await _search(client, "東京 from:@nobody has:file")
    assert unknown["hits"] == []
    assert sorted(unknown["filters"]["unresolved"]) == ["from:@nobody", "has:file"]
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    assert titles(await _search(client, "東京", after=future)) == []
    assert len((await _search(client, "東京", before=future))["hits"]) == 2
    newest = await _search(client, "東京", sort="newest")
    assert titles(newest) == ["個人メモ", "議事録 10/1"]  # the DM canvas was made last
    page = await _search(client, "東京", limit=1)
    assert len(page["hits"]) == 1 and page["has_more"] is True and page["total"] == 2
    rest = await _search(client, "東京", limit=1, offset=1)
    assert (
        rest["has_more"] is False
        and rest["hits"][0]["canvas"]["id"] != (page["hits"][0]["canvas"]["id"])
    )
    # A broken query is searched literally; an empty one is refused.
    assert (await client.get(f"{API}/search/canvases", params={"q": "東京 (("})).status_code == 200
    empty = await client.get(f"{API}/search/canvases", params={"q": " "})
    assert empty.status_code == 400 and empty.json()["error"]["code"] == "empty_query"
    denied = await client.get(f"{API}/search/canvases", params={"q": "東京", "channel_id": secret})
    assert denied.status_code == 403

    # Carol has not joined the public channel: canvases are read by members only (§4.7), unlike
    # a public channel's messages.
    as_user(carol)
    assert titles(await _search(client, "東京")) == []
    # A guest reads the canvases of the conversations it belongs to.
    as_user(guest)
    assert titles(await _search(client, "東京")) == ["秘密の計画"]
    assert in_dm["id"] not in [h["canvas"]["id"] for h in (await _search(client, "東京"))["hits"]]


async def test_search_uses_the_canvases_index(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    """CANVAS.md §4.8 / §8: the query must go through canvases_search_idx (the OR form of title
    and body used none and took 1,374 ms)."""
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await _channel(client, "lab")
    for i in range(30):
        await _canvas(
            client, lab, title=f"メモ {i}", body=f"note {i} 研究 {'東京' if i % 7 else ''}"
        )
    stmt = search_repo.canvas_search_statement(
        "東京",
        search_repo.CanvasScope(channel_ids=[uuid.UUID(lab)]),
        sort="relevance",
        limit=21,
        offset=0,
        escaped=False,
    )
    sql = str(
        stmt.compile(
            dialect=postgresql.dialect(),  # type: ignore[no-untyped-call]
            compile_kwargs={"literal_binds": True},
        )
    )
    async with db.begin():
        # As the search runs it (search/service.py _limit_time).
        await db.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join(row[0] for row in (await db.execute(text(f"EXPLAIN {sql}"))).all())
        assert "canvases_search_idx" in plan, plan
        rows = (await db.execute(text(sql))).all()
    assert len(rows) == 21  # 25 match; the LIMIT


async def test_search_timing_on_many_canvases(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    """A rough timing (printed with -s): 400 canvases of about 5,000 characters each."""
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await _channel(client, "lab")
    paragraph = (
        "研究室のゼミでは、各自の進捗を報告し、次の実験計画を議論する。"
        "The weekly seminar reviews progress and plans the next experiments. "
    )
    head = (await client.get(f"{API}/channels/{lab}/canvases")).json()
    assert head == []
    channel_id = uuid.UUID(lab)
    rows = []
    for i in range(400):
        revision_id = uuid.uuid4()
        body = paragraph * 40 + (f"\n特別な語 rareword{i}" if i % 50 == 0 else "")
        rows.append(
            {
                "id": uuid.uuid4(),
                "channel_id": channel_id,
                "title": f"キャンバス {i}",
                "body": body,
                "head_rev_id": revision_id,
                "created_by": alice.id,
                "updated_by": alice.id,
            }
        )
    await db.execute(insert(Canvas), rows)
    await db.commit()
    timings: dict[str, float] = {}
    for q in ("実験", "rareword100", "seminar 実験"):
        await _search(client, q)  # warm
        started = time.perf_counter()
        result = await _search(client, q)
        timings[q] = round((time.perf_counter() - started) * 1000, 1)
        assert result["total"] == (1 if q.startswith("rare") else 400)
    print(f"\ncanvas search over 400 canvases (~5k chars): {timings}")
    assert titles(await _search(client, "rareword100")) == ["キャンバス 100"]


def test_snippet() -> None:
    body = "前置き" * 40 + "\n\n東京で会議。\n" + "後書き" * 40
    snippet = make_snippet(body, ["東京"])
    assert snippet.startswith("…") and snippet.endswith("…")
    assert "東京で会議。" in snippet and "\n" not in snippet
    assert len(snippet) <= 60 + 2 + 60 + 2
    assert make_snippet("short text", ["missing"]) == "short text"
    assert make_snippet("Hello TOKYO tower", ["tokyo"]) == "Hello TOKYO tower"
    # Full-width letters fold like PGroonga's normalizer.
    wide = "".join(chr(ord(c) + 0xFEE0) for c in "TOKYO")  # full-width TOKYO
    assert wide in make_snippet("x" * 200 + wide + "y" * 200, ["tokyo"])
    long = "a" * 300
    assert make_snippet(long, []) == "a" * 120 + "…"


# --- images (CANVAS.md §4.10) -------------------------------------------------------------------


async def test_images_bind_to_the_canvas_and_only_members_read_them(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Actor,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    lab = await _channel(client, "lab")  # public: carol could read its messages, not its canvases
    await _add(client, lab, bob)
    photo = await _upload(client)
    upper = await _upload(client, "upper.png")
    canvas = await _canvas(
        client,
        lab,
        title="実験の写真",
        body=f"![写真](attachment:{photo})\n![大文字](attachment:{upper.upper()})",
    )
    assert await _status(db, photo) == ("attached", uuid.UUID(canvas["id"]))
    assert await _status(db, upper) == ("attached", uuid.UUID(canvas["id"]))
    row = await db.get(Attachment, uuid.UUID(photo))
    assert row is not None and row.message_id is None and str(row.channel_id) == lab

    # Bob (a member) reads it; carol (not a member of the public channel) does not.
    as_user(bob)
    content = await client.get(f"{API}/attachments/{photo}/content?inline=1")
    assert content.status_code == 200 and content.content == png_bytes()
    assert (await client.get(f"{API}/attachments/{photo}/thumbnail")).status_code == 200
    as_user(carol)
    denied = await client.get(f"{API}/attachments/{photo}/content")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"
    assert (await client.get(f"{API}/attachments/{photo}")).status_code == 403
    carols = await _upload(client, "carol.png")

    # A save binds the saver's own pending uploads only; someone else's stays theirs (pending).
    as_user(bob)
    bobs = await _upload(client, "bob.png")
    after = await _save(
        client,
        canvas,
        canvas["body"] + f"\n![](attachment:{bobs})\n![](attachment:{carols})",
    )
    assert await _status(db, bobs) == ("attached", uuid.UUID(canvas["id"]))
    assert await _status(db, carols) == ("pending", None)
    # Canvas images are not in the files list (CANVAS.md §4.10: MVP).
    files = (await client.get(f"{API}/files")).json()
    assert files["items"] == []
    # Nor in the message search's file-name branch.
    found = await client.get(f"{API}/search/messages", params={"q": "bob"})
    assert found.json()["hits"] == []

    # At most MAX_ATTACHMENTS_PER_CANVAS images per canvas.
    monkeypatch.setattr(attachments, "MAX_ATTACHMENTS_PER_CANVAS", 3)
    extra = await _upload(client, "extra.png")
    refused = await client.put(
        f"{API}/canvases/{canvas['id']}/content",
        json={
            "base_rev_id": after["head_rev_id"],
            "body": after["body"] + f"\n![](attachment:{extra})",
            "client_save_id": key(),
        },
    )
    assert refused.status_code == 400
    assert refused.json()["error"]["code"] == "too_many_canvas_images"
    assert await _status(db, extra) == ("pending", None)


async def test_unreferenced_images_are_released_after_the_grace_period(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await _channel(client, "lab")
    kept = await _upload(client, "kept.png")
    dropped = await _upload(client, "dropped.png")
    labelled = await _upload(client, "labelled.png")
    canvas = await _canvas(client, lab, title="図", body=f"![](attachment:{kept})")
    # Two saves in a row by one author, then a third: the middle one (the only version with
    # `dropped`) is thinned once it is a day old, and then nothing refers to `dropped`.
    await _save(client, canvas, f"![](attachment:{kept})\n![](attachment:{dropped})")
    await _save(client, canvas, f"![](attachment:{kept})\nremoved the second image")
    # A labelled version keeps its images.
    await _save(client, canvas, f"![](attachment:{kept})\n![](attachment:{labelled})")
    history = (await client.get(f"{API}/canvases/{canvas['id']}/revisions")).json()["items"]
    labelled_rev = history[0]["id"]
    labelled_ok = await client.patch(
        f"{API}/canvases/{canvas['id']}/revisions/{labelled_rev}", json={"label": "提出版"}
    )
    assert labelled_ok.status_code == 200
    await _save(client, canvas, f"![](attachment:{kept})\nfinal")
    # The versions one second apart from the top of an hour: one ten-minute bucket, whatever
    # the clock says while the test runs.
    await db.execute(
        text(
            "UPDATE canvas_revisions r "
            "SET created_at = CAST(:base AS timestamptz) + sub.n * interval '1 second' "
            "FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n "
            "      FROM canvas_revisions WHERE canvas_id = :canvas) sub WHERE r.id = sub.id"
        ),
        {
            "base": (utcnow() - timedelta(hours=2)).replace(minute=0, second=0, microsecond=0),
            "canvas": uuid.UUID(canvas["id"]),
        },
    )
    await db.commit()
    # A pending upload that no canvas took: the attachment GC's 24 hours, as for messages.
    stray = await _upload(client, "stray.png")

    # Within the day nothing is released (every version is kept).
    assert await canvases.housekeeping(db, now=utcnow(), trash_days=30) == (0, 0, 0)
    assert await _status(db, dropped) == ("attached", uuid.UUID(canvas["id"]))

    later = utcnow() + timedelta(hours=25)
    pruned, purged, released = await canvases.housekeeping(db, now=later, trash_days=30)
    assert (pruned, purged, released) == (1, 0, 1)
    assert (await _status(db, dropped))[0] == "deleted"
    assert (await _status(db, kept))[0] == "attached"
    assert (await _status(db, labelled))[0] == "attached"
    assert (await client.get(f"{API}/attachments/{dropped}/content")).status_code == 404
    # Running again changes nothing.
    assert await canvases.housekeeping(db, now=later, trash_days=30) == (0, 0, 0)

    # The attachment GC removes the bytes of the released image and the stray upload.
    blobs: MemoryBlobStore = app.state.blobs
    assert f"attachments/{dropped}" in blobs.objects
    removed, gone = await attachments.gc(db, blobs, now=later, pending_ttl_hours=24)
    assert (removed, gone) == (1, 1)
    assert f"attachments/{dropped}" not in blobs.objects
    assert f"attachments/{stray}" not in blobs.objects
    assert f"attachments/{kept}" in blobs.objects

    # Erasing the only version that shows an image lets it go too (a secret pasted by mistake).
    secret = await _upload(client, "secret.png")
    await _save(client, canvas, f"![](attachment:{kept})\n![](attachment:{secret})")
    await _save(client, canvas, f"![](attachment:{kept})\nfinal again")
    history = (await client.get(f"{API}/canvases/{canvas['id']}/revisions")).json()["items"]
    erased = await client.delete(f"{API}/canvases/{canvas['id']}/revisions/{history[1]['id']}")
    assert erased.status_code == 200 and erased.json()["kind"] == "erased"
    assert (await canvases.housekeeping(db, now=later, trash_days=30))[2] == 1
    assert (await _status(db, secret))[0] == "deleted"


# --- pruning and the trash (CANVAS.md §4.9, §4.14) ----------------------------------------------


async def test_pruning_keeps_the_day_and_one_version_per_ten_minutes(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await _channel(client, "lab")
    canvas = await _canvas(client, lab, title="議事録", body="v0")
    canvas_id = uuid.UUID(canvas["id"])
    now = utcnow()
    # Three days ago on the hour: a ten-minute boundary.
    base = (now - timedelta(days=3)).replace(minute=0, second=0, microsecond=0)

    def rev(
        name: str, kind: str, author: User, minutes: float, label: str | None = None
    ) -> CanvasRevision:
        return CanvasRevision(
            id=uuid.uuid4(),
            canvas_id=canvas_id,
            version=None if kind == "side" else 1,
            kind=kind,
            author_id=author.id,
            title=name,
            body=name,
            label=label,
            created_at=base + timedelta(minutes=minutes),
        )

    revisions = [
        rev("a1", "save", alice, 1),
        rev("a2", "merge", alice, 2),
        rev("a3", "save", alice, 3),  # the last of this run of alice's in the first ten minutes
        rev("b1", "save", bob, 4),  # another author: ends alice's run, a run of its own
        rev("a4", "save", alice, 5),  # a new run of alice's, alone in it
        rev("a5-label", "save", alice, 6, label="提出版"),  # labelled: kept, ends the run
        rev("a6", "save", alice, 7),  # a run spanning two ten-minute buckets
        rev("a7", "save", alice, 12),
        rev("a8", "save", alice, 14),  # the last of the run in the second bucket
        rev("r1", "restore", alice, 15),  # restores are kept
        rev("s-old", "side", bob, 16),  # side versions go after a day
        rev("s-new", "side", bob, 60 * 60),  # a side version of the last day stays
        rev("n1", "save", alice, 60 * 70 - 10),  # the last day: everything is kept
        rev("n2", "save", alice, 60 * 70 - 9),
    ]
    # The head is kept whatever its age.
    head = rev("head", "save", alice, 25)
    db.add_all([*revisions, head])
    await db.flush()
    await db.execute(
        text("UPDATE canvases SET head_rev_id = :head WHERE id = :id"),
        {"head": head.id, "id": canvas_id},
    )
    await db.commit()

    removed = await canvases.prune_revisions(db, now=now)
    left = {
        r.title
        for r in (
            await db.execute(select(CanvasRevision).where(CanvasRevision.canvas_id == canvas_id))
        ).scalars()
    }
    assert left == {
        "議事録",  # the create version (titled like the canvas)
        "a3",
        "b1",
        "a4",
        "a5-label",
        "a6",
        "a8",
        "r1",
        "head",
        "s-new",
        "n1",
        "n2",
    }, left
    assert removed == 4  # a1, a2, a7, s-old
    assert await canvases.prune_revisions(db, now=now) == 0
    # The canvas itself is untouched and still saves on its head.
    assert (await client.get(f"{API}/canvases/{canvas['id']}")).json()["head_rev_id"] == str(
        head.id
    )


async def test_trash_is_purged_after_30_days_with_an_audit_entry(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await _channel(client, "lab")
    photo = await _upload(client)
    old = await _canvas(
        client, lab, title="古いメモ", body=f"![](attachment:{photo})", share_to_channel=True
    )
    recent = await _canvas(client, lab, title="最近のメモ")
    live = await _canvas(client, lab, title="残すメモ")
    for canvas in (old, recent):
        assert (await client.delete(f"{API}/canvases/{canvas['id']}")).status_code == 204
    now = utcnow()
    await db.execute(
        text("UPDATE canvases SET deleted_at = :at WHERE id = :id"),
        {"at": now - timedelta(days=31), "id": uuid.UUID(old["id"])},
    )
    await db.execute(
        text("UPDATE canvases SET deleted_at = :at WHERE id = :id"),
        {"at": now - timedelta(days=29), "id": uuid.UUID(recent["id"])},
    )
    await db.commit()

    pruned, purged, released = await canvases.housekeeping(db, now=now, trash_days=30)
    assert (pruned, purged, released) == (0, 1, 0)
    remaining = {str(c) for c in (await db.execute(select(Canvas.id))).scalars()}
    assert remaining == {recent["id"], live["id"]}
    versions = await db.execute(
        select(CanvasRevision).where(CanvasRevision.canvas_id == uuid.UUID(old["id"]))
    )
    assert versions.scalars().all() == []
    assert await _status(db, photo) == ("deleted", None)
    assert (await client.get(f"{API}/attachments/{photo}")).status_code == 404
    entry = (
        await db.execute(select(AuditLog).where(AuditLog.action == "canvas.purge"))
    ).scalar_one()
    assert entry.actor_id is None and entry.target_id == old["id"]
    assert entry.details["title"] == "古いメモ" and entry.details["channel_id"] == lab
    assert entry.details["deleted_by"] == str(alice.id) and entry.details["revisions"] == 1
    # The shared message stays in the conversation (its link now opens nothing).
    history = (await client.get(f"{API}/channels/{lab}/messages")).json()["messages"]
    assert [m["id"] for m in history] == [old["share_message_id"]]
    # Purging again finds nothing; restoring the purged canvas is a 404.
    assert await canvases.housekeeping(db, now=now, trash_days=30) == (0, 0, 0)
    assert (await client.post(f"{API}/canvases/{old['id']}/restore")).status_code == 404
    # The attachment GC removes the image's bytes.
    blobs: MemoryBlobStore = app.state.blobs
    await attachments.gc(db, blobs, now=now)
    assert f"attachments/{photo}" not in blobs.objects


# --- sharing (CANVAS.md §4.13) ------------------------------------------------------------------


async def test_share_to_channel_posts_the_permalink_once(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    lab = await _channel(client, "lab")
    await _add(client, lab, bob)

    request = {"client_save_id": key(), "title": "<!channel> 議事録", "share_to_channel": True}
    first = await client.post(f"{API}/channels/{lab}/canvases", json=request)
    assert first.status_code == 201, first.text
    canvas = first.json()
    assert canvas["share_message_id"] is not None
    again = await client.post(f"{API}/channels/{lab}/canvases", json=request)
    assert (
        again.status_code == 200 and again.json()["share_message_id"] == canvas["share_message_id"]
    )

    messages = (await client.get(f"{API}/channels/{lab}/messages")).json()["messages"]
    assert len(messages) == 1
    shared = messages[0]
    assert shared["id"] == canvas["share_message_id"] and shared["sender_id"] == str(alice.id)
    assert shared["body"] == f"📄 {chr(0xFF1C)}!channel> 議事録\nhttp://testserver/c/{canvas['id']}"
    assert shared["mention_all"] is False  # the title mentions nobody
    # One transaction: the canvas.created event already names the shared message.
    events = (
        await db.execute(
            select(OutboxEvent)
            .where(OutboxEvent.event_type.in_(["canvas.created", "message.created"]))
            .order_by(OutboxEvent.id)
        )
    ).scalars()
    by_type = {e.event_type: e for e in events}
    assert by_type["canvas.created"].payload["canvas"]["share_message_id"] == shared["id"]
    assert by_type["message.created"].payload["message"]["id"] == shared["id"]

    # Sharing a shared canvas changes nothing (idempotent).
    as_user(bob)
    same = await client.post(f"{API}/canvases/{canvas['id']}/share")
    assert same.status_code == 200 and same.json()["share_message_id"] == shared["id"]
    assert same.json()["version"] == canvas["version"]
    assert len((await client.get(f"{API}/channels/{lab}/messages")).json()["messages"]) == 1

    # A canvas made without sharing: the first share posts (the comments open its thread).
    plain = await _canvas(client, lab, title="週報")
    assert plain["share_message_id"] is None
    posted = await client.post(f"{API}/canvases/{plain['id']}/share")
    assert posted.status_code == 200
    after = posted.json()
    assert after["share_message_id"] and after["version"] == plain["version"] + 1
    assert after["updated_by"] == plain["updated_by"] and after["updated_at"] == plain["updated_at"]
    updated = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "canvas.updated")
                .order_by(OutboxEvent.id.desc())
            )
        )
        .scalars()
        .first()
    )
    assert updated is not None and updated.payload["change"] == "settings"
    assert updated.payload["canvas"]["share_message_id"] == after["share_message_id"]
    reply = await client.post(
        f"{API}/channels/{lab}/messages",
        json={"client_msg_id": key(), "body": "コメント", "parent_id": after["share_message_id"]},
    )
    assert reply.status_code == 201

    # Its message deleted, sharing again posts a new one.
    as_user(alice)
    first_share = shared["id"]
    assert (await client.delete(f"{API}/messages/{first_share}")).status_code == 200
    renewed = (await client.post(f"{API}/canvases/{canvas['id']}/share")).json()
    assert renewed["share_message_id"] not in (None, first_share)

    # Not a member: 403; unknown or trashed canvas: 404.
    as_user(carol)
    outsider = await client.post(f"{API}/canvases/{canvas['id']}/share")
    assert outsider.status_code == 403
    as_user(alice)
    assert (await client.post(f"{API}/canvases/{uuid.uuid4()}/share")).status_code == 404

    # An announcement channel: only owners and administrators post, so only they share.
    news = await _channel(client, "news")
    await _add(client, news, bob)
    announcement = await _canvas(client, news, title="お知らせ")
    await client.patch(f"{API}/channels/{news}", json={"posting_policy": "owners"})
    as_user(bob)
    restricted = await client.post(f"{API}/canvases/{announcement['id']}/share")
    assert restricted.status_code == 403
    assert restricted.json()["error"]["code"] == "posting_restricted"


# --- the /c/ page (CANVAS.md §4.5, §4.13) -------------------------------------------------------


async def test_canvas_permalink_page_and_resolution(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    """The page itself never looks the canvas up (like /m/): it is public, says nothing about
    the canvas, and is the same for an existing one and a made-up one. What a link shows is
    decided by the API the apps (and the web client) resolve it with: members read the canvas,
    others get 403, a purged or unknown canvas 404."""
    alice = await make_user(db, "alice")
    carol = await make_user(db, "carol")
    as_user(alice)
    secret = await _channel(client, "secret", type="private")
    canvas = await _canvas(client, secret, title="秘密の研究計画", body="非公開の本文")

    page = await client.get(f"/c/{canvas['id']}", headers={"Authorization": ""})
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert page.headers["x-robots-tag"] == "noindex" and page.headers["cache-control"] == "no-store"
    assert "キャンバス" in page.text
    assert "秘密の研究計画" not in page.text and "非公開の本文" not in page.text
    assert (await client.get(f"/c/{uuid.uuid4()}")).text == page.text
    assert (await client.get("/c/not-a-canvas")).status_code == 404

    assert (await client.get(f"{API}/canvases/{canvas['id']}")).status_code == 200
    as_user(carol)
    denied = await client.get(f"{API}/canvases/{canvas['id']}")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"
    missing = await client.get(f"{API}/canvases/{uuid.uuid4()}")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "canvas_not_found"
