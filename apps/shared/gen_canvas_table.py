"""Writes canvas_table.json: the table editor's rules (CANVAS.md §17, M57) and the cases every client is tested
against: reading a Markdown table into rows and columns, writing it back, finding the table at the caret, inserting a
new one, and the edits (rows, columns, alignment).

Run from this directory: python3 gen_canvas_table.py
"""

import json
import re

SEPARATOR = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")


def split_row(line: str) -> list[str]:
    """Cells of one row: outer pipes dropped, split on unescaped pipes, `\\|` read as `|`, each trimmed."""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    cells, cur, i = [], "", 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            cur += "|"
            i += 2
            continue
        if s[i] == "|":
            cells.append(cur.strip())
            cur = ""
        else:
            cur += s[i]
        i += 1
    cells.append(cur.strip())
    return cells


def align_of(cell: str) -> str | None:
    c = cell.strip()
    left, right = c.startswith(":"), c.endswith(":")
    if left and right:
        return "center"
    if left:
        return "left"
    if right:
        return "right"
    return None


def parse(lines: list[str]) -> dict:
    """A table block (header, separator, body rows) as {align, header, rows}; body rows padded or cut to the header."""
    header = split_row(lines[0])
    n = len(header)
    seps = split_row(lines[1])
    align = [align_of(seps[i]) if i < len(seps) else None for i in range(n)]
    rows = []
    for line in lines[2:]:
        cells = split_row(line)
        rows.append((cells + [""] * n)[:n])
    return {"align": align, "header": header, "rows": rows}


def cell_text(text: str) -> str:
    """A cell as written: one line (line breaks become spaces), `|` escaped, trimmed."""
    return re.sub(r"\s*\r?\n\s*", " ", text).strip().replace("|", "\\|")


def serialize(table: dict) -> list[str]:
    def row(cells: list[str]) -> str:
        return "| " + " | ".join(cell_text(c) for c in cells) + " |"

    marks = {None: "---", "left": ":---", "center": ":---:", "right": "---:"}
    sep = "| " + " | ".join(marks[a] for a in table["align"]) + " |"
    return [row(table["header"]), sep] + [row(r) for r in table["rows"]]


def is_row(line: str) -> bool:
    return line.lstrip().startswith("|")


def find_table(text: str, caret_line: int) -> list[int] | None:
    """[first, last] line of the table whose lines include caret_line: consecutive lines starting with `|` whose
    second line is a separator. None when the caret is not in a table."""
    lines = text.split("\n")
    if not (0 <= caret_line < len(lines)) or not is_row(lines[caret_line]):
        return None
    start = caret_line
    while start > 0 and is_row(lines[start - 1]):
        start -= 1
    end = caret_line
    while end + 1 < len(lines) and is_row(lines[end + 1]):
        end += 1
    if end - start < 1 or not SEPARATOR.match(lines[start + 1]):
        return None
    return [start, end]


NEW_TABLE = {"align": [None, None, None], "header": ["列1", "列2", "列3"], "rows": [["", "", ""], ["", "", ""]]}


def insert_table(text: str, caret_line: int) -> dict:
    """Insert NEW_TABLE after the caret's line (at the start when the text is empty), with a blank line between it and
    any text before or after. Returns the new text and the table's [first, last] line."""
    lines = text.split("\n") if text else []
    at = min(caret_line + 1, len(lines)) if lines else 0
    block = serialize(NEW_TABLE)
    before = lines[:at]
    after = lines[at:]
    if before and before[-1].strip():
        before = before + [""]
    if after and after[0].strip():
        after = [""] + after
    out = before + block + after
    first = len(before)
    return {"text": "\n".join(out), "range": [first, first + len(block) - 1]}


def op(table: dict, name: str, *args: object) -> dict:
    t = {"align": list(table["align"]), "header": list(table["header"]), "rows": [list(r) for r in table["rows"]]}
    n = len(t["header"])
    if name == "add_row":  # (index) a blank body row inserted at index (0..len(rows))
        t["rows"].insert(args[0], [""] * n)
    elif name == "delete_row":  # (index) a body row; the header stays
        del t["rows"][args[0]]
    elif name == "move_row":  # (from, to) body rows
        r = t["rows"].pop(args[0])
        t["rows"].insert(args[1], r)
    elif name == "add_column":  # (index) a blank column inserted at index (0..n), header 「列N」 with N = new count
        i = args[0]
        t["header"].insert(i, f"列{n + 1}")
        t["align"].insert(i, None)
        for r in t["rows"]:
            r.insert(i, "")
    elif name == "delete_column":  # (index) refused (unchanged) when it is the last column
        if n > 1:
            i = args[0]
            del t["header"][i]
            del t["align"][i]
            for r in t["rows"]:
                del r[i]
    elif name == "set_align":  # (index, align)
        t["align"][args[0]] = args[1]
    return t


PARSE = [
    ["| 名前 | 締切 |", "| --- | --- |", "| 予稿 | 10/3 |", "| 旅費 | 10/10 |"],
    ["|左|中央|右|", "|:--|:-:|--:|", "|a|b|c|"],
    ["| a | b |", "|---|---|", "| 1 |", "| 1 | 2 | 3 |"],
    ["| パイプ \\| 入り | x |", "| --- | --- |", "| `a\\|b` | |"],
    ["名前 | 締切", "--- | ---", "予稿 | 10/3"],
    ["| 見出しだけ |", "| --- |"],
]
SERIALIZE = [
    {"align": [None, "center", "right"], "header": ["名前", "人数", "金額"], "rows": [["a", "1", "100"]]},
    {"align": ["left", None], "header": ["x|y", "改\n行"], "rows": [["", "  空白  "]]},
]
FIND_TEXT = "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n| 表ではない |\n本文"
FIND = [0, 2, 3, 4, 5, 6, 7, 99]
INSERT = [["", 0], ["本文", 0], ["一行目\n二行目", 0], ["一行目\n\n三行目", 0], ["一行目\n二行目", 1]]
BASE = {"align": [None, None], "header": ["A", "B"], "rows": [["1", "2"], ["3", "4"]]}
OPS = [
    ["add_row", 0], ["add_row", 2], ["delete_row", 1], ["move_row", 1, 0],
    ["add_column", 1], ["add_column", 2], ["delete_column", 0], ["set_align", 1, "right"],
]


def main() -> None:
    one = op(BASE, "delete_column", 0)
    doc = {
        "_comment": (
            "CANVAS.md §17 (M57): the canvas table editor. parse: outer pipes dropped, split on unescaped pipes, "
            "`\\|` read as `|`, cells trimmed; body rows padded/cut to the header's count; separator cells give "
            "align (:--- left, :---: center, ---: right, --- null). serialize: `| a | b |` with one space, the "
            "separator `| --- | :--- | :---: | ---: |`, cells one line (breaks → space), `|` escaped, trimmed. find: "
            "the [first, last] lines of the table holding the caret's line (consecutive lines starting with `|`, the "
            "second a separator), else null. insert: a 3 × 2 table (列1..列3) after the caret's line, blank lines "
            "around it when needed; returns the text and its range. ops: add_row/delete_row/move_row on body rows, "
            "add_column (header 列N, N = new count), delete_column (not the last), set_align. Generated by "
            "gen_canvas_table.py."
        ),
        "parse": [{"lines": ls, "table": parse(ls)} for ls in PARSE],
        "serialize": [{"table": t, "lines": serialize(t)} for t in SERIALIZE],
        "round_trip": [{"lines": ls, "lines_out": serialize(parse(ls))} for ls in PARSE],
        "find": {"text": FIND_TEXT, "cases": [{"caret_line": c, "range": find_table(FIND_TEXT, c)} for c in FIND]},
        "insert": [{"text": t, "caret_line": c, **insert_table(t, c)} for t, c in INSERT],
        "ops": {
            "base": BASE,
            "cases": [{"op": o[0], "args": list(o[1:]), "table": op(BASE, o[0], *o[1:])} for o in OPS]
            + [{"op": "delete_column", "args": [0], "base": one, "table": op(one, "delete_column", 0)}],
        },
    }
    with open("canvas_table.json", "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
