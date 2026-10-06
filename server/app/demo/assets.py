"""Small files for the demo workspace, generated at seed time (no binary files in the repo).

A chart is drawn with Pillow (its built-in font: Latin letters only), the PDFs are
written by hand with the standard Helvetica font, and the .docx is a minimal Office Open XML
package. All of it is fictional.
"""

import io
import math
import zipfile
from xml.sax.saxutils import escape

from PIL import Image, ImageDraw, ImageFont


def chart_png() -> bytes:
    """A line chart: validation accuracy per epoch, baseline against the new schedule."""
    width, height = 960, 600
    left, right, top, bottom = 90, 40, 70, 80
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    title = ImageFont.load_default(size=26)
    small = ImageFont.load_default(size=18)
    draw.text((left, 22), "Validation accuracy (demo data)", font=title, fill="#222222")
    plot_w, plot_h = width - left - right, height - top - bottom
    low, high, epochs = 70.0, 90.0, 30

    def point(epoch: float, value: float) -> tuple[float, float]:
        x = left + plot_w * epoch / epochs
        y = top + plot_h * (1 - (value - low) / (high - low))
        return x, y

    for value in range(70, 91, 5):
        _, y = point(0, value)
        draw.line([(left, y), (width - right, y)], fill="#e6e6e6", width=1)
        draw.text((left - 50, y - 10), f"{value}%", font=small, fill="#555555")
    for epoch in range(0, epochs + 1, 5):
        x, _ = point(epoch, low)
        draw.text((x - 8, height - bottom + 10), str(epoch), font=small, fill="#555555")
    draw.text((width / 2 - 30, height - 36), "epoch", font=small, fill="#555555")
    draw.rectangle([left, top, width - right, height - bottom], outline="#999999", width=1)

    def curve(final: float, speed: float, wobble: float) -> list[tuple[float, float]]:
        return [
            point(e, 72 + (final - 72) * (1 - math.exp(-e / speed)) + wobble * math.sin(e * 1.7))
            for e in range(epochs + 1)
        ]

    series = [
        ("baseline", "#8b8d98", curve(82.4, 7.0, 0.35)),
        ("cosine + warmup", "#5b5bd6", curve(85.1, 5.0, 0.25)),
    ]
    for index, (label, colour, points) in enumerate(series):
        draw.line(points, fill=colour, width=4, joint="curve")
        y = top + 16 + index * 28
        draw.line(
            [(width - right - 230, y + 9), (width - right - 196, y + 9)], fill=colour, width=4
        )
        draw.text((width - right - 186, y), label, font=small, fill="#333333")
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def _pdf_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_pdf(title: str, pages: list[list[str]]) -> bytes:
    """A small A4 PDF with real (selectable, searchable) text; Latin characters only."""
    objects: list[bytes] = []
    page_ids: list[int] = []
    # 1: catalog, 2: pages, 3: font; pages and their content streams follow.
    next_id = 4
    page_objects: list[tuple[int, int, bytes]] = []
    for number, lines in enumerate(pages, start=1):
        ops = ["BT", "/F1 20 Tf", "56 780 Td", f"({_pdf_text(title)}) Tj", "/F1 11 Tf", "0 -34 Td"]
        for line in lines:
            ops.append(f"({_pdf_text(line)}) Tj")
            ops.append("0 -17 Td")
        ops += ["ET", "BT", "/F1 9 Tf", "500 40 Td", f"(page {number} / {len(pages)}) Tj", "ET"]
        stream = "\n".join(ops).encode("latin-1")
        page_objects.append((next_id, next_id + 1, stream))
        page_ids.append(next_id)
        next_id += 2
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for page_id, content_id, stream in page_objects:
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>".encode()
        )
        objects.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
        )
        assert page_id + 1 == content_id
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{index} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return out.getvalue()


_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" '
    'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/'
    'vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships/officeDocument" Target="word/document.xml"/>'
    "</Relationships>"
)


def simple_docx(title: str, paragraphs: list[str]) -> bytes:
    """A minimal Word document: a bold title and plain paragraphs (Japanese is fine)."""
    runs = [
        f'<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>{escape(title)}</w:t></w:r></w:p>'
    ]
    runs += [
        f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'
        for text in paragraphs
    ]
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(runs)}</w:body></w:document>"
    )
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as package:
        # [Content_Types].xml first: file-type sniffers look for it at the start of the archive.
        package.writestr("[Content_Types].xml", _CONTENT_TYPES)
        package.writestr("_rels/.rels", _RELS)
        package.writestr("word/document.xml", document)
    return out.getvalue()
