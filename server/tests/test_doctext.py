"""app/core/doctext (docs/WIKI.md §2.3, M120): the pure document parts shared by canvases and wiki
pages. The canvases' own tests (test_canvas*.py) cover the behaviour through the canvas API; these
check the shared pieces directly."""

import uuid
from typing import NoReturn

import pytest

from app.core.doctext import body as doc
from app.core.doctext import markers, merge
from app.core.doctext.revisions import thin_statement
from app.core.doctext.save import save_flow
from app.core.errors import AppError
from app.modules.canvases import markers as canvas_markers
from app.modules.canvases import merge as canvas_merge
from app.modules.canvases import service as canvases
from app.modules.messages import mentions


def test_canvas_modules_reexport_the_shared_parts() -> None:
    assert canvas_merge.merge3 is merge.merge3
    assert canvas_markers.with_marker is markers.with_marker
    assert canvases.count_tasks is doc.count_tasks
    assert canvases.TASK_LINE is markers.TASK_LINE


def test_mention_patterns_match_the_messages_ones() -> None:
    assert doc.MENTION_USER.pattern == mentions.MENTION_USER.pattern
    assert doc.MENTION_GROUP.pattern == mentions.MENTION_GROUP.pattern


def test_clean_body_codes() -> None:
    assert doc.clean_body("a\r\nb\rc") == "a\nb\nc"
    with pytest.raises(AppError) as caught:
        doc.clean_body("x" * 11, max_length=10, code="page_too_large", what="A page")
    assert caught.value.code == "page_too_large"
    assert caught.value.status == 422


def test_page_refs() -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    text = (
        f"[A](page:{a}) and https://chat.example.org/p/{str(b).upper()} "
        f"and again [A](page:{a}) but not attachment:{uuid.uuid4()} nor /c/{uuid.uuid4()}"
    )
    assert doc.page_refs(text) == [a, b]
    assert doc.page_refs(f"image:{a}") == []


def test_thin_statement_names_its_tables() -> None:
    sql = str(
        thin_statement(revisions="r_tab", documents="d_tab", fk="doc_id", thinnable=("save",))
    )
    assert "DELETE FROM r_tab" in sql
    assert "JOIN d_tab c ON c.id = r.doc_id" in sql
    assert "r.kind IN ('save')" in sql


class _Recorder:
    def __init__(self) -> None:
        self.heads: list[tuple[str, str, uuid.UUID, uuid.UUID | None]] = []
        self.sides: list[tuple[str, uuid.UUID]] = []

    async def write_head(
        self, body: str, kind: str, parent: uuid.UUID, save_id: uuid.UUID | None
    ) -> uuid.UUID:
        self.heads.append((body, kind, parent, save_id))
        return uuid.uuid4()

    async def write_side(
        self, body: str, parent: uuid.UUID, parent_body: str, save_id: uuid.UUID
    ) -> uuid.UUID:
        self.sides.append((body, parent))
        return uuid.uuid4()


async def _refuse(conflicts: tuple[merge.Conflict, ...], timed_out: bool) -> NoReturn:
    raise AppError(409, "page_conflict", "conflict")


async def _flow(rec: _Recorder, *, head: str, base: str, body: str, same_base: bool) -> str:
    head_id, base_id = uuid.uuid4(), uuid.uuid4()
    outcome = await save_flow(
        head_body=head,
        head_rev_id=head_id,
        base_rev_id=head_id if same_base else base_id,
        base_body=base,
        body=body,
        client_save_id=uuid.uuid4(),
        on_conflict="fail",
        write_head=rec.write_head,
        write_side=rec.write_side,
        refuse=_refuse,
        clean=doc.clean_body,
    )
    return outcome.kind


async def test_save_flow_steps() -> None:
    rec = _Recorder()
    assert await _flow(rec, head="a", base="a", body="a", same_base=True) == "unchanged"
    assert rec.heads == []
    assert await _flow(rec, head="a", base="a", body="b", same_base=True) == "saved"
    assert [h[1] for h in rec.heads] == ["save"]

    rec = _Recorder()
    kind = await _flow(
        rec, head="one\ntwo\nthree", base="one\n2\nthree", body="1\n2\nthree", same_base=False
    )
    assert kind == "merged"
    assert [s[0] for s in rec.sides] == ["1\n2\nthree"]
    assert rec.heads[0][0] == "1\ntwo\nthree" and rec.heads[0][1] == "merge"

    rec = _Recorder()
    with pytest.raises(AppError):
        await _flow(rec, head="x y", base="a", body="b c", same_base=False)
    assert rec.heads == [] and rec.sides == []
