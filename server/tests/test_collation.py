"""The server's name order (app/core/collation.py) is the sidebar's (apps/shared/sidebar-order.json
"names"), which a wiki database's text columns sort by (docs/WIKI.md §5.4)."""

import json
from pathlib import Path

import pytest

from app.core.collation import name_key

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "apps/shared/sidebar-order.json").read_text()
)["names"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_names_sort_as_on_the_clients(case: dict[str, list[str]]) -> None:
    assert sorted(case["input"], key=name_key) == case["sorted"]
