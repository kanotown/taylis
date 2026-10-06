"""M123: wiki databases (docs/WIKI.md §5): schema and views, relations, unconverted values

Revision ID: 0097
Revises: 0096
Create Date: 2026-10-07

- wiki_databases: a database page's schema (properties with stable ids) and saved views (table /
  calendar) and schema_version (a change on an older one is refused). wiki_rows_seq numbers
  wiki.rows.changed.
  Rows are wiki_pages of kind row below it (0095 made the kind and the props column).
- wiki_relations: one link of a relation property (src row, property, dst row); a two-way
  relation's reverse property reads the same rows from the other end (index on dst).
- wiki_props_legacy: values a type change could not convert, kept 30 days.
- wiki_pages_rows_idx: a database's live rows in their order.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0097"
down_revision: str | None = "0096"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE wiki_databases (
          page_id        uuid PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE,
          schema         jsonb NOT NULL,
          views          jsonb NOT NULL,
          schema_version bigint NOT NULL DEFAULT 1
        )
        """
    )
    op.execute("CREATE SEQUENCE wiki_relation_seq")
    op.execute("CREATE SEQUENCE wiki_rows_seq")
    op.execute(
        """
        CREATE TABLE wiki_relations (
          src_page_id     uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          prop_id         varchar(24) NOT NULL,
          dst_page_id     uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          src_database_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          position        integer NOT NULL,
          seq             bigint NOT NULL DEFAULT nextval('wiki_relation_seq'),
          PRIMARY KEY (src_page_id, prop_id, dst_page_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX wiki_relations_dst_idx ON wiki_relations "
        "(dst_page_id, src_database_id, prop_id)"
    )
    op.execute("CREATE INDEX wiki_relations_prop_idx ON wiki_relations (src_database_id, prop_id)")
    op.execute(
        """
        CREATE TABLE wiki_props_legacy (
          id         uuid PRIMARY KEY,
          page_id    uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          prop_id    varchar(24) NOT NULL,
          prop_type  varchar(16) NOT NULL,
          value      jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX wiki_props_legacy_page_idx ON wiki_props_legacy (page_id, prop_id)")
    op.execute("CREATE INDEX wiki_props_legacy_created_idx ON wiki_props_legacy (created_at)")
    op.execute(
        "CREATE INDEX wiki_pages_rows_idx ON wiki_pages (parent_id, position, id) "
        "WHERE kind = 'row' AND deleted_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS wiki_pages_rows_idx")
    op.execute("DROP TABLE IF EXISTS wiki_props_legacy")
    op.execute("DROP TABLE IF EXISTS wiki_relations")
    op.execute("DROP SEQUENCE IF EXISTS wiki_relation_seq")
    op.execute("DROP SEQUENCE IF EXISTS wiki_rows_seq")
    op.execute("DROP TABLE IF EXISTS wiki_databases")
