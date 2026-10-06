"""M120: wiki pages (docs/WIKI.md §11.1): the tree, versions, own and effective access, links,
notices, tombstones and attachments.page_id

Revision ID: 0095
Revises: 0094
Create Date: 2026-10-07

- wiki_pages: one tree per workspace (parent_id / path / position), kind page | database | row
  (database and row are used from M123; the check is here so M123 need not change it), the body
  in the canvases' Markdown, head_rev_id, and the change feed's numbers from wiki_change_seq:
  meta_seq (title, icon, parent, order, trash, access), vis_seq (who can see it may have changed:
  created, access, move, trash, restore) and created_seq (WIKI.md §10, SYNC_PROTOCOL.md §17).
- wiki_page_revisions: like canvas_revisions (plus props / import for M123 / M125).
- wiki_grants: a page's own access entries; wiki_effective_grants: the inherited result, rewritten
  for a subtree in the same transaction as every change of the tree or of access (WIKI.md §4.6).
- wiki_links: page → page links for backlinks; wiki_notices: activity items (mention / shared);
  wiki_tombstones and wiki_feed_state: purged pages for the change feed (30 days, then reset).
- wiki_pages_search_idx: PGroonga on title, body without task markers and props_text.
- attachments.page_id: an image or file in a page (read with the page's view level).

wiki_databases (the schema and views of a database) comes with M123.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0095"
down_revision: str | None = "0094"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# app/core/doctext/markers.py MARKER_SQL (written out: a migration does not import the app).
MARKER_SQL = " ?<!--task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-->"


def upgrade() -> None:
    op.execute("CREATE SEQUENCE wiki_change_seq")
    op.execute(
        """
        CREATE TABLE wiki_pages (
          id              uuid PRIMARY KEY,
          parent_id       uuid REFERENCES wiki_pages(id) ON DELETE SET NULL,
          path            uuid[] NOT NULL DEFAULT '{}',
          position        text COLLATE "C" NOT NULL,
          kind            varchar(16) NOT NULL DEFAULT 'page',
          title           varchar(200) NOT NULL DEFAULT '',
          icon            varchar(64),
          body            text NOT NULL DEFAULT '',
          version         bigint NOT NULL DEFAULT 1,
          head_rev_id     uuid NOT NULL,
          meta_seq        bigint NOT NULL,
          vis_seq         bigint NOT NULL,
          created_seq     bigint NOT NULL,
          inherit_access  boolean NOT NULL DEFAULT true,
          props           jsonb,
          props_text      text,
          task_total      integer NOT NULL DEFAULT 0,
          task_done       integer NOT NULL DEFAULT 0,
          created_by      uuid NOT NULL REFERENCES users(id),
          updated_by      uuid NOT NULL REFERENCES users(id),
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now(),
          deleted_at      timestamptz,
          deleted_by      uuid REFERENCES users(id),
          trash_root_id   uuid,
          CONSTRAINT ck_wiki_pages_kind_values CHECK (kind IN ('page', 'database', 'row')),
          CONSTRAINT ck_wiki_pages_row_props CHECK ((kind = 'row') = (props IS NOT NULL))
        )
        """
    )
    op.execute(
        "CREATE INDEX wiki_pages_children_idx ON wiki_pages (parent_id, position) "
        "WHERE deleted_at IS NULL"
    )
    op.execute("CREATE INDEX wiki_pages_path_idx ON wiki_pages USING gin (path)")
    op.execute("CREATE INDEX wiki_pages_meta_seq_idx ON wiki_pages (meta_seq)")
    op.execute(
        "CREATE INDEX wiki_pages_trash_idx ON wiki_pages (trash_root_id) "
        "WHERE trash_root_id IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX wiki_pages_search_idx ON wiki_pages USING pgroonga "
        f"((ARRAY[title::text, regexp_replace(body, '{MARKER_SQL}', '', 'g'), "
        "coalesce(props_text, '')]))"
    )
    op.execute(
        """
        CREATE TABLE wiki_page_revisions (
          id             uuid PRIMARY KEY,
          page_id        uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          version        bigint,
          kind           varchar(16) NOT NULL,
          parent_rev_id  uuid,
          author_id      uuid NOT NULL REFERENCES users(id),
          title          varchar(200) NOT NULL,
          body           text NOT NULL,
          props          jsonb,
          client_save_id uuid,
          label          varchar(80),
          lines_added    integer NOT NULL DEFAULT 0,
          lines_removed  integer NOT NULL DEFAULT 0,
          created_at     timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT ck_wiki_page_revisions_kind_values CHECK (kind IN
            ('create', 'save', 'merge', 'side', 'restore', 'erased', 'props', 'import'))
        )
        """
    )
    op.execute(
        "CREATE INDEX wiki_page_revisions_page_idx ON wiki_page_revisions (page_id, created_at)"
    )
    op.execute(
        "CREATE UNIQUE INDEX wiki_page_revisions_save_uniq ON wiki_page_revisions "
        "(author_id, client_save_id) WHERE client_save_id IS NOT NULL"
    )
    op.execute(
        """
        CREATE TABLE wiki_grants (
          id             uuid PRIMARY KEY,
          page_id        uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          principal_type varchar(16) NOT NULL,
          principal_id   uuid,
          level          varchar(8) NOT NULL,
          created_by     uuid NOT NULL REFERENCES users(id),
          created_at     timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_wiki_grants_principal UNIQUE NULLS NOT DISTINCT
            (page_id, principal_type, principal_id),
          CONSTRAINT ck_wiki_grants_principal_values CHECK (
            (principal_type = 'workspace' AND principal_id IS NULL)
            OR (principal_type IN ('group', 'user') AND principal_id IS NOT NULL)),
          CONSTRAINT ck_wiki_grants_level_values CHECK (level IN ('view', 'edit', 'full'))
        )
        """
    )
    op.execute(
        """
        CREATE TABLE wiki_effective_grants (
          page_id        uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          principal_type varchar(16) NOT NULL,
          principal_id   uuid,
          level_rank     smallint NOT NULL,
          source_page_id uuid NOT NULL,
          CONSTRAINT uq_wiki_effective_grants_principal UNIQUE NULLS NOT DISTINCT
            (page_id, principal_type, principal_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX wiki_effective_principal_idx ON wiki_effective_grants "
        "(principal_type, principal_id, page_id)"
    )
    op.execute(
        """
        CREATE TABLE wiki_links (
          src_page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          dst_page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          PRIMARY KEY (src_page_id, dst_page_id)
        )
        """
    )
    op.execute("CREATE INDEX wiki_links_dst_idx ON wiki_links (dst_page_id)")
    op.execute(
        """
        CREATE TABLE wiki_notices (
          id         uuid PRIMARY KEY,
          user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          page_id    uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
          kind       varchar(16) NOT NULL,
          rev_id     uuid,
          actor_id   uuid REFERENCES users(id) ON DELETE CASCADE,
          excerpt    varchar(200) NOT NULL DEFAULT '',
          level      varchar(8),
          at         timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT ck_wiki_notices_kind_values CHECK (kind IN ('mention', 'shared'))
        )
        """
    )
    op.execute("CREATE INDEX wiki_notices_user_idx ON wiki_notices (user_id, at DESC)")
    op.execute(
        "CREATE TABLE wiki_tombstones (page_id uuid PRIMARY KEY, seq bigint NOT NULL, "
        "purged_at timestamptz NOT NULL)"
    )
    op.execute("CREATE INDEX wiki_tombstones_seq_idx ON wiki_tombstones (seq)")
    op.execute(
        "CREATE TABLE wiki_feed_state (id smallint PRIMARY KEY CHECK (id = 1), "
        "purged_through bigint NOT NULL DEFAULT 0)"
    )
    op.execute("INSERT INTO wiki_feed_state (id, purged_through) VALUES (1, 0)")
    op.execute(
        "ALTER TABLE attachments ADD COLUMN page_id uuid "
        "REFERENCES wiki_pages(id) ON DELETE SET NULL"
    )
    op.execute(
        "CREATE INDEX attachments_page_idx ON attachments (page_id) WHERE page_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS attachments_page_idx")
    op.execute("ALTER TABLE attachments DROP COLUMN IF EXISTS page_id")
    for table in (
        "wiki_feed_state",
        "wiki_tombstones",
        "wiki_notices",
        "wiki_links",
        "wiki_effective_grants",
        "wiki_grants",
        "wiki_page_revisions",
        "wiki_pages",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table}")
    op.execute("DROP SEQUENCE IF EXISTS wiki_change_seq")
