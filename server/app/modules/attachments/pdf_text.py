"""The text of a PDF, for the drive's full-text search (docs/DRIVE.md §29).

Run as a child process (`python -m app.modules.attachments.pdf_text IN OUT MAX_BYTES`) by
drive.texts, never imported for its PDF work by the app: PDFium parses a file someone else sent,
so a crash, a hang or a memory spike stays in the child, which the parent kills past its timeout
(as pdf_render.py for the previews). The child lowers its own priority: the extraction is
background work.

Writes the text (UTF-8, at most MAX_BYTES) to OUT and prints one JSON line:
{"status": "ok", "pages", "page_starts", "chars", "truncated"} or {"status": "encrypted"} (a
password is needed to open it) or {"status": "unreadable"} (broken, not a PDF).

`clean` is also the app's (plain text files are read in the app: no parser is involved).
"""

import json
import os
import re
import sys
import unicodedata

# PDFium's FPDF_ERR_PASSWORD.
ERR_PASSWORD = 4

# NFKC has already made no-break and ideographic spaces plain ones.
_SPACES = re.compile(r"[ \t]+")
_AROUND_NEWLINE = re.compile(r" ?\n ?")
_BLANK_LINES = re.compile(r"\n{3,}")


def _wide(ch: str) -> bool:
    """A character written without spaces between words (Japanese, Chinese, full-width forms)."""
    return unicodedata.east_asian_width(ch) in ("W", "F")


def _keep(ch: str) -> bool:
    if ch in "\n\t":
        return True
    category = unicodedata.category(ch)
    # Control characters (NUL cannot go into PostgreSQL's text), surrogates, non-characters.
    return category not in ("Cc", "Cs", "Cn", "Co") and ch not in "￾￿"


def clean(raw: str, *, join_lines: bool) -> str:
    """NFKC (as PGroonga's normaliser folds, so a found word is found again in the text),
    without control characters, runs of spaces folded. `join_lines` (PDFs, whose lines are cut
    wherever the page's width ended): a line break between two Japanese characters goes away
    (「研究計\\n画」 is 「研究計画」, so the phrase is found), another one becomes a space, and a
    word hyphenated at the end of a line is joined."""
    text = unicodedata.normalize("NFKC", raw.replace("\r\n", "\n").replace("\r", "\n"))
    text = "".join(ch for ch in text if _keep(ch))
    text = _SPACES.sub(" ", text)
    text = _AROUND_NEWLINE.sub("\n", text)
    if join_lines:
        out: list[str] = []
        lines = [line for line in text.split("\n") if line]
        for line in lines:
            if not out:
                out.append(line)
                continue
            prev = out[-1]
            if prev.endswith("-") and len(prev) > 1 and prev[-2].isalpha() and line[0].islower():
                out[-1] = prev[:-1] + line
            elif _wide(prev[-1]) and _wide(line[0]):
                out[-1] = prev + line
            else:
                out[-1] = prev + " " + line
        return out[0] if out else ""
    return _BLANK_LINES.sub("\n\n", text).strip()


def cut(text: str, max_bytes: int) -> str:
    """The longest start of `text` within `max_bytes` of UTF-8 (never half a character)."""
    data = text.encode("utf-8")
    if len(data) <= max_bytes:
        return text
    return data[:max_bytes].decode("utf-8", errors="ignore")


def extract(src: str, dest: str, max_bytes: int) -> dict[str, object]:
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(src)
    except pdfium.PdfiumError as exc:
        if getattr(exc, "err_code", None) == ERR_PASSWORD:
            return {"status": "encrypted"}
        return {"status": "unreadable"}
    parts: list[str] = []
    starts: list[int] = []
    length = 0  # characters so far
    size = 0  # UTF-8 bytes so far
    truncated = False
    try:
        pages = len(pdf)
        for index in range(pages):
            page = pdf[index]
            try:
                textpage = page.get_textpage()
                try:
                    raw = textpage.get_text_range()
                finally:
                    textpage.close()
            finally:
                page.close()
            text = clean(raw, join_lines=True)
            starts.append(length)
            piece = text + "\n"
            piece_size = len(piece.encode("utf-8"))
            if size + piece_size > max_bytes:
                piece = cut(piece, max_bytes - size)
                parts.append(piece)
                length += len(piece)
                truncated = True
                break
            parts.append(piece)
            length += len(piece)
            size += piece_size
    finally:
        pdf.close()
    body = "".join(parts).rstrip("\n")
    with open(dest, "w", encoding="utf-8") as out:
        out.write(body)
    chars = sum(1 for ch in body if not ch.isspace())
    return {
        "status": "ok",
        "pages": pages,
        "page_starts": starts,
        "chars": chars,
        "truncated": truncated,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: pdf_text IN OUT MAX_BYTES", file=sys.stderr)
        return 64
    try:
        os.nice(10)
    except OSError:
        pass
    src, dest, max_bytes = argv[0], argv[1], int(argv[2])
    try:
        info = extract(src, dest, max_bytes)
    except Exception as exc:  # pypdfium2.PdfiumError on a page, ValueError: unreadable for us
        print(f"unreadable PDF: {exc}", file=sys.stderr)
        info = {"status": "unreadable"}
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
