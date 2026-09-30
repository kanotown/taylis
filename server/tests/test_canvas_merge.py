"""The canvas merge (CANVAS.md §4.4, app/modules/canvases/merge.py): pure, no database.

Fixtures in tests/fixtures/canvas_merge/*.json fix the rules; random edits by two people check
that no edit is lost; the timings check the 200 ms budget.
"""

import json
import random
import time
from pathlib import Path
from typing import Any

import pytest

from app.modules.canvases.merge import Conflict, merge3, tokenize

FIXTURES = Path(__file__).parent / "fixtures" / "canvas_merge"
DOCS = Path(__file__).resolve().parents[2] / "docs"
BUDGET = 0.2  # seconds (CANVAS.md §4.4 / §8)


def _fixtures() -> list[tuple[str, dict[str, Any]]]:
    return [(p.stem, json.loads(p.read_text())) for p in sorted(FIXTURES.glob("*.json"))]


@pytest.mark.parametrize(("name", "case"), _fixtures(), ids=[n for n, _ in _fixtures()])
def test_fixture(name: str, case: dict[str, Any]) -> None:
    result = merge3(case["base"], case["ours"], case["theirs"], resolve=case["resolve"])
    assert result.text == case["expected"], name
    assert [c.__dict__ for c in result.conflicts] == case["conflicts"], name
    assert not result.timed_out


def test_there_are_fixtures_for_each_rule() -> None:
    names = [n for n, _ in _fixtures()]
    assert len(names) >= 15
    cases = [c for _, c in _fixtures()]
    assert any(c["conflicts"] for c in cases) and any(not c["conflicts"] for c in cases)
    assert {c["resolve"] for c in cases} == {"fail", "ours", "theirs", "both"}


# --- words -------------------------------------------------------------------------------------


def test_tokenize_japanese_and_english() -> None:
    assert tokenize("研究計画を来週までに提出する。") == [
        "研究計画",
        "を",
        "来週",
        "までに",
        "提出",
        "する",
        "。",
    ]
    assert tokenize("- [ ] item two") == ["-", " ", "[", " ", "]", " ", "item", " ", "two"]
    assert tokenize("- [x] データ整理") == ["-", " ", "[", "x", "]", " ", "データ", "整理"]
    assert tokenize("a\n\nb  c") == ["a", "\n", "\n", "b", "  ", "c"]
    assert tokenize("") == []


def test_tokenize_is_lossless() -> None:
    alphabet = "abc XYZ 012 あいう アイウ 漢字 、。\uff01\uff1f ,.!? []()@#📅\n\t-_'"
    rng = random.Random(7)
    for _ in range(500):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 60)))
        assert "".join(tokenize(text)) == text


# --- simple laws -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("base", "other"),
    [("", "a\nb"), ("a\nb\n", ""), ("x", "x"), ("a\nb\nc", "a\nB\nc\nd"), ("\n\n", "\n")],
)
def test_one_sided_changes_come_through_unchanged(base: str, other: str) -> None:
    assert merge3(base, other, base).text == other
    assert merge3(base, base, other).text == other
    assert merge3(base, other, other).text == other


def test_deterministic() -> None:
    case = dict(_fixtures())["19_both_edit_same_line_and_one_inserts"]
    first = merge3(case["base"], case["ours"], case["theirs"])
    for _ in range(20):
        assert merge3(case["base"], case["ours"], case["theirs"]) == first


# --- no edit is lost (random, fixed seeds) -----------------------------------------------------

WORDS_EN = "data model sync canvas merge server client review deadline paper slide figure".split()
WORDS_JA = ["研究", "実験", "結果", "ゼミ", "発表", "論文", "データ", "サーバ", "確認", "提出"]


def _sentence(rng: random.Random) -> str:
    if rng.random() < 0.5:
        return " ".join(rng.choice(WORDS_EN) for _ in range(rng.randint(3, 8))) + f" {rng.random()}"
    parts = ["".join(rng.choice(WORDS_JA) for _ in range(rng.randint(1, 3))) for _ in range(3)]
    return "、".join(parts) + f"。{rng.randint(0, 10**9)}"


def _document(rng: random.Random, lines: int) -> list[str]:
    out: list[str] = []
    for _ in range(lines):
        out.append("" if rng.random() < 0.12 else f"- [ ] {_sentence(rng)}")
    return out


def _apply(base: list[str], edits: dict[int, tuple[str, str]]) -> list[str]:
    """edits: line → (kind, text) with kind replace / delete / insert (a new line after it)."""
    out: list[str] = []
    for i, line in enumerate(base):
        kind, text = edits.get(i, ("keep", ""))
        if kind == "replace":
            out.append(text)
        elif kind != "delete":
            out.append(line)
        if kind == "insert":
            out.append(text)
    return out


def _random_edits(
    rng: random.Random, base: list[str], taken: set[int], count: int, tag: str
) -> dict[int, tuple[str, str]]:
    """`count` edits on lines at least two away from the other person's (`taken`)."""
    edits: dict[int, tuple[str, str]] = {}
    candidates = [i for i, line in enumerate(base) if line]
    rng.shuffle(candidates)
    for i in candidates:
        if len(edits) == count:
            break
        if any(abs(i - j) < 2 for j in taken):
            continue
        kind = rng.choice(["replace", "replace", "delete", "insert"])
        edits[i] = (kind, f"- [x] {tag} {_sentence(rng)}")
    return edits


def test_random_edits_on_different_lines_are_all_kept() -> None:
    """300 runs: each person edits (replaces, deletes, adds after) 1-6 lines, away from the
    other's; the merge is exactly both sets of edits, without a conflict."""
    for seed in range(300):
        rng = random.Random(seed)
        base = _document(rng, rng.randint(20, 150))
        ours = _random_edits(rng, base, set(), rng.randint(1, 6), "ours")
        theirs = _random_edits(rng, base, set(ours), rng.randint(1, 6), "theirs")
        expected = _apply(base, {**ours, **theirs})
        result = merge3(
            "\n".join(base), "\n".join(_apply(base, ours)), "\n".join(_apply(base, theirs))
        )
        assert result.conflicts == (), seed
        assert result.text == "\n".join(expected), seed


def test_random_line_edits_in_a_real_document() -> None:
    """300 runs on docs/SYNC_PROTOCOL.md (tables, blank lines, repeated lines): two people each
    change a few lines that occur once in the document; both changes are always kept."""
    base = (DOCS / "SYNC_PROTOCOL.md").read_text().split("\n")
    counts: dict[str, int] = {}
    for line in base:
        counts[line] = counts.get(line, 0) + 1
    unique = [i for i, line in enumerate(base) if line.strip() and counts[line] == 1]
    for seed in range(300):
        rng = random.Random(1000 + seed)
        picked = rng.sample(unique, 8)
        ours = {i: ("replace", base[i] + " (追記 ours)") for i in picked[:4]}
        theirs = {
            i: ("replace", "theirs: " + base[i])
            for i in picked[4:]
            if all(abs(i - j) >= 2 for j in ours)
        }
        result = merge3(
            "\n".join(base), "\n".join(_apply(base, ours)), "\n".join(_apply(base, theirs))
        )
        assert result.conflicts == (), seed
        assert result.text == "\n".join(_apply(base, {**ours, **theirs})), seed


def test_random_edits_at_both_ends_of_one_line() -> None:
    """200 runs: two people change the same line, one near its start and one near its end
    (English words, or Japanese clauses without spaces); both changes are kept."""
    for seed in range(200):
        rng = random.Random(5000 + seed)
        if seed % 2:
            words = [rng.choice(WORDS_EN) + str(n) for n in range(rng.randint(5, 12))]
            ours_words, theirs_words = list(words), list(words)
            ours_words[0] = "START"
            theirs_words[-1] = "END"
            base, ours, theirs = (" ".join(w) for w in (words, ours_words, theirs_words))
            expected = " ".join(["START", *words[1:-1], "END"])
        else:
            clauses = [
                "".join(rng.choice(WORDS_JA) for _ in range(2)) + "を" + rng.choice(WORDS_JA)
                for _ in range(rng.randint(3, 6))
            ]
            ours_c, theirs_c = list(clauses), list(clauses)
            ours_c[0] = "前半を直した"
            theirs_c[-1] = "後半も直した"
            base, ours, theirs = ("、".join(c) + "。" for c in (clauses, ours_c, theirs_c))
            expected = "、".join(["前半を直した", *clauses[1:-1], "後半も直した"]) + "。"
        prefix = "- [ ] " if rng.random() < 0.5 else ""
        result = merge3(prefix + base, prefix + ours, prefix + theirs)
        assert result.conflicts == (), seed
        assert result.text == prefix + expected, seed


def test_conflicts_never_lose_text() -> None:
    """100 runs: both rewrite the end of the same line (a conflict), and each also edits another
    line. With on_conflict=both the result keeps every line either side wrote."""
    for seed in range(100):
        rng = random.Random(9000 + seed)
        base = _document(rng, 30)
        filled = [i for i, line in enumerate(base) if line]
        target, mine, other = filled[0], filled[-1], filled[len(filled) // 2]
        ours, theirs = list(base), list(base)
        ours[target] = base[target] + "OURS"
        theirs[target] = base[target] + "THEIRS"
        ours[mine] = "- [x] ours elsewhere"
        theirs[other] = "- [x] theirs elsewhere"
        result = merge3("\n".join(base), "\n".join(ours), "\n".join(theirs), resolve="both")
        assert len(result.conflicts) == 1, seed
        assert result.conflicts[0].ours == ours[target], seed
        merged = result.text.split("\n")
        for line in (theirs[target], f"> {ours[target]}", ours[mine], theirs[other]):
            assert line in merged, (seed, line)


# --- time budget -------------------------------------------------------------------------------


def _big_document() -> str:
    text = "\n".join(p.read_text() for p in sorted(DOCS.glob("*.md")))
    return text[:100_000]


def test_a_100k_character_merge_is_within_budget() -> None:
    base = _big_document().split("\n")
    rng = random.Random(3)
    picked = rng.sample(range(len(base)), 40)
    ours, theirs = list(base), list(base)
    for i in picked[:20]:
        ours[i] += " (ours)"
    for i in picked[20:]:
        theirs[i] = "(theirs) " + theirs[i]
    started = time.perf_counter()
    result = merge3("\n".join(base), "\n".join(ours), "\n".join(theirs))
    elapsed = time.perf_counter() - started
    assert not result.timed_out
    assert elapsed < BUDGET, f"{elapsed * 1000:.1f} ms"
    assert "(ours)" in result.text and "(theirs)" in result.text


@pytest.mark.parametrize(
    "line", ["- [ ] 項目 {n}", "- [ ] 同じ行"], ids=["alike lines", "identical lines"]
)
def test_3000_alike_lines_merge_within_budget(line: str) -> None:
    """CANVAS.md §7: 3,000 alike lines took the prototype 334 ms and gave a false conflict.
    Here one person edits the first and last lines, the other the middle one."""
    base = [line.format(n=n % 7) for n in range(3000)]
    ours, theirs = list(base), list(base)
    ours[0] = "- [x] first"
    ours[-1] = "- [x] last"
    theirs[1500] = "- [x] middle"
    started = time.perf_counter()
    result = merge3("\n".join(base), "\n".join(ours), "\n".join(theirs))
    elapsed = time.perf_counter() - started
    assert elapsed < BUDGET, f"{elapsed * 1000:.1f} ms"
    assert result.conflicts == ()
    merged = result.text.split("\n")
    assert (merged[0], merged[1500], merged[-1]) == ("- [x] first", "- [x] middle", "- [x] last")


def test_past_the_budget_the_whole_document_is_one_conflict() -> None:
    base, ours, theirs = "a\nb\nc", "A\nb\nc", "a\nb\nC"
    result = merge3(base, ours, theirs, budget_seconds=-1)
    assert result.timed_out
    assert result.conflicts == (Conflict(base, ours, theirs, 0, 0),)
    assert result.text == theirs
    both = merge3(base, ours, theirs, resolve="both", budget_seconds=-1)
    assert both.text == "a\nb\nC\n> A\n> b\n> c"
    assert merge3(base, ours, theirs, resolve="ours", budget_seconds=-1).text == ours
