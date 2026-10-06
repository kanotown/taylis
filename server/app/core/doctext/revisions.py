"""How old versions of a document are thinned (CANVAS.md §4.9 / §4.14, WIKI.md §7.2).

The policy is shared by canvases and wiki pages; the SQL is per table (thin_statement builds it
for a revisions table and its documents table).

Every version of the last day stays (the bases of editing devices); after that side versions go
and a run of one author's versions keeps the last of every ten minutes. Versions are thinned once,
soon after they pass KEEP_ALL_REVISIONS: only THIN_LOOKBACK back is read again each hour (a server
that was down longer leaves a few extra versions, never fewer). An image no version refers to any
more is let go IMAGE_GRACE after it was bound.
"""

from collections.abc import Sequence
from datetime import timedelta

from sqlalchemy import TextClause, text

KEEP_ALL_REVISIONS = timedelta(hours=24)
THIN_BUCKET = timedelta(minutes=10)
THIN_LOOKBACK = timedelta(days=7)
IMAGE_GRACE = timedelta(hours=24)


def thin_statement(
    *, revisions: str, documents: str, fk: str, thinnable: Sequence[str]
) -> TextClause:
    """Among the versions made between :since and :before, a run of consecutive versions of the
    `thinnable` kinds by one author (no label, not the head) keeps the last one of every :bucket.
    Other kinds (create, restore, erased, …), labelled and head versions are always kept, and end
    a run. The names are the modules' own constants, never user input."""
    kinds = ", ".join(f"'{kind}'" for kind in thinnable)
    return text(
        f"""
    WITH old AS (
        SELECT r.id, r.{fk}, r.author_id, r.created_at,
               (r.kind IN ({kinds}) AND r.label IS NULL
                AND r.id <> c.head_rev_id) AS thin
        FROM {revisions} r JOIN {documents} c ON c.id = r.{fk}
        WHERE r.kind <> 'side' AND r.created_at < :before AND r.created_at >= :since
    ), marked AS (
        SELECT old.*,
               CASE WHEN thin AND lag(thin) OVER w AND lag(author_id) OVER w = author_id
                    THEN 0 ELSE 1 END AS starts
        FROM old
        WINDOW w AS (PARTITION BY {fk} ORDER BY created_at, id)
    ), runs AS (
        SELECT marked.*,
               sum(starts) OVER (PARTITION BY {fk} ORDER BY created_at, id) AS run
        FROM marked
    ), ranked AS (
        SELECT id, thin,
               row_number() OVER (
                   PARTITION BY {fk}, run,
                                date_bin(:bucket, created_at, TIMESTAMPTZ '2000-01-01 00:00:00+00')
                   ORDER BY created_at DESC, id DESC
               ) AS rn
        FROM runs
    )
    DELETE FROM {revisions}
    WHERE id IN (SELECT id FROM ranked WHERE thin AND rn > 1)
    """
    )
