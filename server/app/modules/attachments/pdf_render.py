"""The first page of a PDF as a WebP thumbnail, and the page count (M108, docs/PREVIEWS.md).

Run as a child process (`python -m app.modules.attachments.pdf_render IN OUT WIDTH MAX_HEIGHT`)
by previews.render_pdf, never imported by the app: PDFium parses a file someone else sent, so a
crash, a hang or a memory spike stays in the child, which the parent kills past its timeout.
Prints one JSON line {"pages", "width", "height"}; exit status 2 means "not a PDF it can read"
(broken, encrypted, empty).
"""

import json
import sys

# Beyond these a page's size (in points) is treated as nonsense rather than rendered.
MAX_PAGE_POINTS = 14_400  # 200 inches, PDF's own limit
MIN_PAGE_POINTS = 1.0


def render(src: str, dest: str, width: int, max_height: int) -> dict[str, int]:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(src)
    try:
        pages = len(pdf)
        if pages < 1:
            raise ValueError("the PDF has no pages")
        page = pdf[0]
        try:
            page_w, page_h = page.get_size()
            if not (
                MIN_PAGE_POINTS <= page_w <= MAX_PAGE_POINTS
                and MIN_PAGE_POINTS <= page_h <= MAX_PAGE_POINTS
            ):
                raise ValueError(f"page size {page_w}x{page_h} pt")
            # A page as wide as the thumbnail, or less wide when it is very tall (a long strip
            # stays readable in the card's box instead of becoming a sliver).
            scale = min(width / page_w, max_height / page_h)
            bitmap = page.render(scale=scale, fill_color=(255, 255, 255, 255), rotation=0)
            image = bitmap.to_pil().convert("RGB")  # a fresh image: no metadata carried over
        finally:
            page.close()
    finally:
        pdf.close()
    image.save(dest, format="WEBP", quality=80, method=4)
    return {"pages": pages, "width": image.width, "height": image.height}


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: pdf_render IN OUT WIDTH MAX_HEIGHT", file=sys.stderr)
        return 64
    src, dest, width, max_height = argv[0], argv[1], int(argv[2]), int(argv[3])
    try:
        info = render(src, dest, width, max_height)
    except Exception as exc:  # pypdfium2.PdfiumError, ValueError: unreadable for us
        print(f"unreadable PDF: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
