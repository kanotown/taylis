"""Writes emoji-frequent.json: the emoji picker's 「よく使う」 (docs/EMOJI.md §9.4) on every client — how uses are
remembered and ranked (frecency with a half-life), how the list is seeded from what a client stored before, how many
are shown so that whole rows are filled (a text emoji's pill takes as many cells as it is wide), and the cases each
client's tests run.

Run from this directory: python3 gen_emoji_frequent.py
"""

import json
import math

DAY = 24 * 3600 * 1000
HALF_LIFE = 14 * DAY
KEPT = 64
ROWS = 2
SEED_STEP = 1000


def decayed(score: float, last: int, now: int) -> float:
    return score * 2 ** (-max(0, now - last) / HALF_LIFE)


def rank_key(entry: dict) -> float:
    """Higher first. log2(score) + last / half-life orders entries as their scores decayed to any common moment would."""
    return math.log2(entry["score"]) + entry["last"] / HALF_LIFE


def ranked(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=lambda e: (-rank_key(e), -e["last"], e["glyph"].encode("utf-16-be")))


def record(entries: list[dict], glyph: str, now: int) -> list[dict]:
    if not glyph:
        return entries
    out = [dict(e) for e in entries]
    for e in out:
        if e["glyph"] == glyph:
            e["score"] = decayed(e["score"], e["last"], now) + 1
            e["last"] = max(e["last"], now)
            return out
    if len(out) >= KEPT:
        out = ranked(out)[: KEPT - 1]
    out.append({"glyph": glyph, "score": 1.0, "last": now})
    return out


def seed(legacy: list[dict], now: int) -> list[dict]:
    """What a client stored before (newest first, with a count where it kept one): each once, `count` (else 1) as its
    score, a second apart from `now` backwards."""
    out: list[dict] = []
    seen: set[str] = set()
    for item in legacy:
        glyph = item["glyph"]
        if not glyph or glyph in seen:
            continue
        seen.add(glyph)
        out.append({"glyph": glyph, "score": float(max(1, item.get("count", 1))), "last": now - len(out) * SEED_STEP})
    return ranked(out)[:KEPT]


def span(pill: float, cell: float, gap: float, columns: int) -> int:
    """Cells a pill `pill` wide takes in a grid of `cell`-wide columns `gap` apart (n cells span n·cell + (n−1)·gap)."""
    return min(columns, max(1, math.ceil((pill + gap) / (cell + gap) - 1e-9)))


def pill_aspect(label: str) -> float:
    """An estimate of a text emoji pill's width / height where it is not measured (Desktop / Web, Android):
    0.6 em per character below U+2E80, 1 em from there (CJK), at 0.68 of the height, plus 0.28 of the height a side."""
    ems = sum(0.6 if ord(c) < 0x2E80 else 1.0 for c in label)
    return max(1.0, ems * 0.68 + 0.56)


def fill(items: list[dict], columns: int, rows: int = ROWS) -> list[list[str]]:
    """「よく使う」's rows: in rank order, each item goes in the first row with room for its span (an item no row has
    room for is left out), until every row is full or the items run out."""
    free = [columns] * rows
    out: list[list[str]] = [[] for _ in range(rows)]
    for item in items:
        if not any(free):
            break
        s = min(columns, max(1, item.get("span", 1)))
        for r in range(rows):
            if free[r] >= s:
                out[r].append(item["glyph"])
                free[r] -= s
                break
    return [row for row in out if row]


T0 = 1_790_000_000_000  # 2026-09-21

RANK_CASES = [
    {
        "name": "more uses come first",
        "uses": [["👍", T0], ["🎉", T0 + 1000], ["👍", T0 + 2000], ["😂", T0 + 3000]],
    },
    {
        "name": "among single uses the latest first",
        "uses": [["a1", T0], ["a2", T0 + 60_000], ["a3", T0 + 120_000]],
    },
    {
        "name": "old habits fade: five uses a month ago lose to two this week",
        "uses": [["🙏", T0]] * 5 + [["🔥", T0 + 30 * DAY], ["🔥", T0 + 31 * DAY]],
    },
    {
        "name": "but not to one use today",
        "uses": [["🙏", T0]] * 5 + [["🔥", T0 + 20 * DAY]],
    },
    {
        "name": "a use with an earlier clock still counts",
        "uses": [["x", T0 + 10_000], ["y", T0 + 5000], ["x", T0]],
    },
    {
        "name": "custom emoji are ranked like the others",
        "uses": [[":hanpen:", T0], [":hanpen:", T0 + 1000], ["👀", T0 + 2000]],
    },
]


def rank_cases() -> list[dict]:
    out = []
    for case in RANK_CASES:
        entries: list[dict] = []
        for glyph, t in case["uses"]:
            entries = record(entries, glyph, t)
        out.append({"name": case["name"], "uses": case["uses"], "ranked": [e["glyph"] for e in ranked(entries)]})
    return out


def kept_case() -> dict:
    """KEPT + 1 single uses a minute apart, then one more use of the first: the oldest single use is forgotten."""
    uses = [[f"e{i}", T0 + i * 60_000] for i in range(KEPT + 1)]
    entries: list[dict] = []
    for glyph, t in uses:
        entries = record(entries, glyph, t)
    return {"uses_count": KEPT + 1, "step": 60_000, "start": T0, "count": len(entries),
            "forgotten": "e0", "first": ranked(entries)[0]["glyph"]}


SEED_CASES = [
    {"name": "a recent list (Desktop / Web, Android, iOS's emoji.recent)", "legacy": [{"glyph": g} for g in ["🎉", "👍", ":party:", "👍"]]},
    {"name": "iOS's counts (emoji.usage), newest first", "legacy": [{"glyph": "👀", "count": 1}, {"glyph": "👍", "count": 5}, {"glyph": "🎉", "count": 2}]},
    {"name": "nothing", "legacy": []},
]

SPAN_CASES = [
    (30, 40, 0, 8), (40, 40, 0, 8), (41, 40, 0, 8), (120, 40, 0, 8), (500, 40, 0, 8),
    (70, 39, 4, 8), (82, 39, 4, 8), (83, 39, 4, 8), (10, 40, 0, 8),
]

ASPECT_CASES = ["OK", "ありがとう", "確認しました", "LGTM!", "了解", "x"]

ITEMS = [{"glyph": f"s{i}"} for i in range(1, 21)]
FILL_CASES = [
    {"name": "squares only: two full rows of 8", "columns": 8, "items": ITEMS},
    {"name": "fewer than the rows hold: all of them", "columns": 8, "items": ITEMS[:5]},
    {"name": "a wider grid takes more", "columns": 10, "items": ITEMS},
    {"name": "a pill of 3 takes 3 cells", "columns": 8,
     "items": [{"glyph": "s1"}, {"glyph": ":thanks:", "span": 3}] + ITEMS[1:]},
    {"name": "a pill that no longer fits the first row goes to the second; squares fill the first", "columns": 8,
     "items": ITEMS[:6] + [{"glyph": ":kakunin:", "span": 3}] + ITEMS[6:]},
    {"name": "a pill no row has room for any more is left out", "columns": 8,
     "items": ITEMS[:14] + [{"glyph": ":long:", "span": 4}] + ITEMS[14:]},
    {"name": "few items: a pill on the second row stays", "columns": 8,
     "items": ITEMS[:7] + [{"glyph": ":ok:", "span": 3}]},
    {"name": "wider than the grid: one whole row", "columns": 8,
     "items": [{"glyph": ":huge:", "span": 12}] + ITEMS},
]


def main() -> None:
    doc = {
        "_comment": (
            "docs/EMOJI.md §9.4: the emoji picker's 「よく使う」 / \"Frequently used\" on Desktop / Web, iOS and Android, per "
            "device. A use: a reaction I add (any way), an emoji put in the composer from the picker or the `:` "
            "completion; not a choice (a status, a section's icon, the quick reaction slots). record(glyph, now ms): an "
            "entry's score decays by half every half_life_ms, then +1 (a new one starts at 1); last = max(last, now); "
            "at most `kept` entries, the lowest ranked one forgotten for a new one. rank: by log2(score) + last / "
            "half_life_ms (higher first: the order of the decayed scores at any moment), then last (later first), then the "
            "glyph (UTF-16 code units). seed: without a stored list, a client starts from what it kept before (newest first): each glyph once, "
            "its count (else 1) as the score, last = now − i × seed_step_ms. Shown: unknown custom `:name:`s left out, "
            "then fill(columns, rows): in rank order each item goes in the first row with `span` cells free (squares 1, "
            "a text emoji's pill span(pill width, column width, gap, columns) = min(columns, max(1, ceil((pill + gap) / "
            "(cell + gap)))) ), left out when no row has room, until the rows are full. pill_aspect: the pill's width / "
            "height where it is not measured (max(1, ems × 0.68 + 0.56), 0.6 em a character below U+2E80, else 1). "
            "Generated by gen_emoji_frequent.py."
        ),
        "half_life_ms": HALF_LIFE,
        "kept": KEPT,
        "rows": ROWS,
        "seed_step_ms": SEED_STEP,
        "rank": rank_cases(),
        "kept_case": kept_case(),
        "seed": [{"name": c["name"], "legacy": c["legacy"], "now": T0,
                  "entries": seed(c["legacy"], T0)} for c in SEED_CASES],
        "span": [{"pill": p, "cell": c, "gap": g, "columns": n, "span": span(p, c, g, n)} for p, c, g, n in SPAN_CASES],
        "pill_aspect": [{"label": label, "aspect": round(pill_aspect(label), 6)} for label in ASPECT_CASES],
        "fill": [{**c, "rows": ROWS, "expected": fill(c["items"], c["columns"])} for c in FILL_CASES],
    }
    with open("emoji-frequent.json", "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
