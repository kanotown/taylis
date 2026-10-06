"""One-line push text (PUSH_NOTIFICATIONS.md): markdown flattened like the clients' previews."""

import json
import uuid
from pathlib import Path

from app.modules.messages.mentions import notification_text

VECTORS = Path(__file__).resolve().parents[2] / "apps" / "shared" / "inline-format.json"
MATH = Path(__file__).resolve().parents[2] / "apps" / "shared" / "math.json"


def test_tables_flatten_to_their_cells() -> None:  # M15g
    body = "担当表\n| 項目 | 担当 |\n| :--- | :-: |\n| API | 田中 |\n| a \\| b | **UI** |\n以上"
    assert notification_text(body, {}) == "担当表 項目 担当 API 田中 a | b UI 以上"


def test_other_markdown_still_flattens() -> None:
    assert (
        notification_text("# 見出し\n- **太字** と `code`\n> 引用", {})
        == "見出し 太字 と code 引用"
    )


def test_inline_markup_matches_the_shared_vectors() -> None:  # M107
    """Only real emphasis is stripped: `_` inside a word (snake_case, e-mail addresses), URLs and
    escapes stay (apps/shared/inline-format.json, the cases every client tests against)."""
    cases = json.loads(VECTORS.read_text(encoding="utf-8"))["cases"]
    assert len(cases) > 20
    for case in cases:
        assert notification_text(case["line"], {}) == case["plain"], case["name"]


def test_names_from_mentions_are_not_read_as_emphasis() -> None:  # M107
    body = "<@00000000-0000-7000-8000-0000000000a1> _see_ a_b_c"
    names = {uuid.UUID("00000000-0000-7000-8000-0000000000a1"): "snake_case_user"}
    assert notification_text(body, names) == "@snake_case_user see a_b_c"


def test_math_keeps_its_tex_source() -> None:
    """TeX math stays as written, dollars and all; prices and escapes as the clients read them
    (apps/shared/math.json)."""
    cases = json.loads(MATH.read_text(encoding="utf-8"))["inline"]
    assert len(cases) > 20
    for case in cases:
        assert notification_text(case["line"], {}) == case["plain"], case["name"]
    assert notification_text("$$\na_1 * b_1 = c\n$$", {}) == "$$ a_1 * b_1 = c $$"
