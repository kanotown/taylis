"""API shapes of wiki databases (docs/WIKI.md §5, §11.2; M123).

A database is a page of kind `database`; its rows are pages of kind `row` below it. The schema
(properties with stable ids) and the saved views live in wiki_databases; a row's values in
wiki_pages.props ({prop_id: value}); relations in wiki_relations (never in props).
"""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.wiki.schemas import Level, PageOut, _valid_zone

PropType = Literal[
    "title",
    "text",
    "number",
    "select",
    "multi_select",
    "date",
    "person",
    "checkbox",
    "url",
    "relation",
    "created_time",
    "updated_time",
    "created_by",
    "updated_by",
]
# The types a schema change may add or turn a property into (title is the one made with it).
NewPropType = Literal[
    "text",
    "number",
    "select",
    "multi_select",
    "date",
    "person",
    "checkbox",
    "url",
    "relation",
    "created_time",
    "updated_time",
    "created_by",
    "updated_by",
]
OptionColor = Literal["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]
# number: as written; integer: rounded for display; percent: 0.5 shows 50 %; yen: ¥1,200.
NumberFormat = Literal["number", "integer", "percent", "yen"]
ViewType = Literal["table", "calendar"]
FilterOp = Literal[
    "contains",
    "not_contains",
    "equals",
    "not_equals",
    "starts_with",
    "is_empty",
    "is_not_empty",
    "gt",
    "gte",
    "lt",
    "lte",
    "before",
    "after",
    "on_or_before",
    "on_or_after",
    "between",
]

_ID = r"^[a-z0-9_]{1,24}$"
Id = Annotated[str, Field(pattern=_ID)]


class SelectOption(BaseModel):
    id: Id
    name: str = Field(min_length=1, max_length=100)
    color: OptionColor = "gray"


class OptionIn(BaseModel):
    """An option in a schema change: a new one has no id (the server gives one)."""

    model_config = ConfigDict(extra="forbid")

    id: Id | None = None
    name: str = Field(min_length=1, max_length=100)
    color: OptionColor = "gray"

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("An option needs a name")
        return value


class RelationOut(BaseModel):
    """Where a relation points. A database I cannot read (or one that is gone) has no id or
    title here: its rows show as 「アクセスできないページ」 (WIKI.md §5.7)."""

    database_id: UUID | None
    database_title: str | None
    # Two-way: the property on that database that shows the other side (null: one-way).
    pair_id: str | None
    # false: this property is the reverse side of `pair_id` (Notion's two-way relation).
    primary: bool


class PropertyOut(BaseModel):
    id: str
    # "" for the title property of a new database: clients show their own word (「名前」).
    name: str
    type: PropType
    # select / multi_select: in display order (also the sort order).
    options: list[SelectOption]
    number_format: NumberFormat | None
    relation: RelationOut | None


class ViewColumn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prop_id: Id
    width: int | None = Field(default=None, ge=60, le=1000)
    hidden: bool = False


class SortKey(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prop_id: Id
    direction: Literal["asc", "desc"] = "asc"


class FilterCondition(BaseModel):
    """One condition. value: text (contains…), a number (gt…), an option id (select), a user
    id or "me" (person), a row id (relation), true / false (checkbox), "YYYY-MM-DD" (date), or
    {"start", "end"} dates (between). is_empty / is_not_empty take none.

    Relation: a saved view's condition on a row the reader cannot read comes as
    "restricted:<n>" (n: the condition's index in the saved view) instead of the row id
    (WIKI.md §5.7). Clients show it as an unreadable row and send it back unchanged: saving the
    view keeps the hidden row id; in a query it matches like an unreadable row (nothing)."""

    model_config = ConfigDict(extra="forbid")

    prop_id: Id
    op: FilterOp
    value: Any = None


class FilterGroup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    combinator: Literal["and", "or"] = "and"
    conditions: list[FilterCondition] = Field(default_factory=list, max_length=20)


class ViewIn(BaseModel):
    """PUT /wiki/databases/{id}/views/{view_id}: a saved view (shared by everyone who reads the
    database). Board views come later: `type` grows a value, the rest stays."""

    model_config = ConfigDict(extra="forbid")

    # "" for the first view of a new database: clients show their own word (「表」).
    name: str = Field(default="", max_length=60)
    type: ViewType = "table"
    # The table's columns in order (left out: shown after these, in schema order).
    columns: list[ViewColumn] = Field(default_factory=list, max_length=80)
    sort: list[SortKey] = Field(default_factory=list, max_length=5)
    filter: FilterGroup | None = None
    # calendar: the date property that places rows on days.
    date_prop_id: Id | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return " ".join(value.split())


class ViewOut(ViewIn):
    id: str


class DatabaseLimits(BaseModel):
    rows: int
    properties: int
    options: int
    views: int


class TemplateRef(BaseModel):
    """A row template of the database (M145, WIKI.md §22.3): open it as a page to edit it."""

    id: UUID
    title: str
    icon: str | None


class DatabaseOut(BaseModel):
    """GET /wiki/databases/{id}. `properties` in display order; the title property first."""

    page_id: UUID
    schema_version: int
    properties: list[PropertyOut]
    views: list[ViewOut]
    my_level: Level
    # The rows (row templates are not rows: they are in `templates`).
    row_count: int
    limits: DatabaseLimits
    # M145: the row templates (「新規 ▾」), oldest first, and the one 「新規」 starts from.
    templates: list[TemplateRef] = Field(default_factory=list)
    default_template_id: UUID | None = None


class DefaultTemplateIn(BaseModel):
    """PUT /wiki/databases/{id}/default-template (M145, edit): the row template a new row starts
    from when POST …/rows names none (null: none)."""

    model_config = ConfigDict(extra="forbid")

    template_id: UUID | None


class RelationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The database whose rows it links to (this one for a relation within the database).
    database_id: UUID
    # Two-way: a property is added to that database too, showing the rows that link to its rows.
    two_way: bool = False
    # The name of that property ("": the clients' word); two-way only.
    pair_name: str = Field(default="", max_length=100)


class AddProperty(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["add"]
    name: str = Field(default="", max_length=100)
    type: NewPropType
    options: list[OptionIn] = Field(default_factory=list, max_length=200)
    number_format: NumberFormat | None = None
    relation: RelationIn | None = None
    # Place it after this property (left out: at the end).
    after_id: Id | None = None


class UpdateProperty(BaseModel):
    """Rename, change the options (a removed option is cleared from the rows) or the number
    format. Left-out fields stay."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["update"]
    id: Id
    name: str | None = Field(default=None, max_length=100)
    options: list[OptionIn] | None = Field(default=None, max_length=200)
    number_format: NumberFormat | None = None


class RetypeProperty(BaseModel):
    """Change the type; the server converts every row's value (WIKI.md §5.2: values it cannot
    convert are kept for 30 days and come back if the type is changed back)."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["retype"]
    id: Id
    type: NewPropType
    number_format: NumberFormat | None = None
    relation: RelationIn | None = None


class DeleteProperty(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["delete"]
    id: Id


class ReorderProperties(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["reorder"]
    # Every property id in the new order (the title property stays first).
    ids: list[Id] = Field(max_length=60)


SchemaOp = Annotated[
    AddProperty | UpdateProperty | RetypeProperty | DeleteProperty | ReorderProperties,
    Field(discriminator="op"),
]


class SchemaChange(BaseModel):
    """PATCH /wiki/databases/{id}/schema (edit access; deleting a property or an option, changing
    a type and a two-way relation: full access). 409 wiki_schema_conflict when the schema changed
    since `base_schema_version`: read it again and redo the change."""

    model_config = ConfigDict(extra="forbid")

    base_schema_version: int
    ops: list[SchemaOp] = Field(min_length=1, max_length=20)


class DateValue(BaseModel):
    """A date property's value. time false: "YYYY-MM-DD"; time true: ISO 8601 with its offset
    ("2026-10-07T09:30:00+09:00"). end: a range (not before start), else null."""

    start: str
    end: str | None = None
    time: bool = False


# A cell: text / url / a select option id (str), number, checkbox (bool), multi-select option ids
# or person user ids or relation row ids (list), a date. null clears it.
PropValue = str | float | bool | list[str] | DateValue


class RowOut(BaseModel):
    """A row without its body (GET /wiki/pages/{id} has the body)."""

    id: UUID
    database_id: UUID
    title: str
    icon: str | None
    position: str
    version: int
    head_rev_id: UUID
    # Stored values by property id (no relations; empty cells are left out).
    props: dict[str, PropValue]
    # Relation and reverse-relation cells: the linked rows I can read, in order (titles in refs).
    relations: dict[str, list[UUID]]
    # Relation properties that also link to rows I cannot read: one 「アクセスできないページ」,
    # never their ids, titles or how many.
    hidden_relations: list[str]
    created_at: datetime
    created_by: UUID
    updated_at: datetime
    updated_by: UUID


class RowRef(BaseModel):
    """A linked row I can read."""

    id: UUID
    database_id: UUID
    title: str
    icon: str | None


class DateRange(BaseModel):
    """The calendar's window: rows whose date (or date range) on `prop_id` touches [start, end]."""

    model_config = ConfigDict(extra="forbid")

    prop_id: Id
    start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def _order(self) -> "DateRange":
        if self.end < self.start:
            raise ValueError("end is before start")
        return self


class RowQuery(BaseModel):
    """POST /wiki/databases/{id}/query. A saved view's sort and filter, unless `sort` / `filter`
    are given (a sort or filter not saved: WIKI.md §5.4)."""

    model_config = ConfigDict(extra="forbid")

    view_id: str | None = Field(default=None, max_length=24)
    sort: list[SortKey] | None = Field(default=None, max_length=5)
    filter: FilterGroup | None = None
    range: DateRange | None = None
    cursor: str | None = Field(default=None, max_length=40)
    limit: int = Field(default=100, ge=1, le=1000)


class RowQueryOut(BaseModel):
    rows: list[RowOut]
    # Titles of the linked rows in `rows` that I can read.
    refs: list[RowRef]
    # The rows that match (all pages of the answer).
    total: int
    next_cursor: str | None
    schema_version: int


class RowCreate(BaseModel):
    """POST /wiki/databases/{id}/rows. M145 (WIKI.md §22.3): a new row starts from `template_id`,
    else (unless `blank`) from the database's default template: its title, icon, body
    (placeholders put in with `tz`), values (a date's 「今日」 and a person's 「自分」 put in) and
    files. The given `props` (and a title that is not empty, and a body) win over the
    template's."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(default="", max_length=200)
    icon: str | None = Field(default=None, max_length=64)
    # A date may be {"start": "@today"} and a person ["@me"] in a row template (put in when a
    # row is made from it).
    props: dict[str, Any] = Field(default_factory=dict)
    body: str | None = None
    # M145: a row template of this database (404 template_not_found otherwise).
    template_id: UUID | None = None
    # M145: start empty even when the database has a default template.
    blank: bool = False
    # M145: make a row template (never from the default template).
    is_template: bool = False
    # The client's IANA zone (a template's {{date}} and 「今日」); UTC when left out.
    tz: str | None = Field(default=None, max_length=64)
    # Idempotency key: a retry returns the row made by the first request (200).
    client_save_id: UUID

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        return " ".join(value.split())

    _tz = field_validator("tz")(_valid_zone)


class RowPropsUpdate(BaseModel):
    """PATCH /wiki/rows/{id}/props: each cell given is replaced (the last write wins per cell,
    WIKI.md §5.3); null clears it. `title` sets the title. A retry with the same client_op_id
    changes nothing again."""

    model_config = ConfigDict(extra="forbid")

    set: dict[str, Any] = Field(min_length=1, max_length=60)
    client_op_id: UUID


class RowWithRefs(BaseModel):
    row: RowOut
    refs: list[RowRef]


class PageDuplicateOut(BaseModel):
    """POST /wiki/pages/{id}/duplicate (M145): the copy; for a row also its cells."""

    page: PageOut
    row: RowWithRefs | None


class ReferencedBy(BaseModel):
    """Rows I can read that link here through a one-way relation (two-way ones are columns)."""

    database_id: UUID
    database_title: str
    prop_id: str
    prop_name: str
    rows: list[RowRef]


class RowDetailOut(BaseModel):
    """GET /wiki/rows/{id}: the row's cells with its database's schema (the row page shows them
    above the body)."""

    row: RowOut
    database: DatabaseOut
    database_title: str
    refs: list[RowRef]
    referenced_by: list[ReferencedBy]


class WikiRowsChangedData(BaseModel):
    """wiki.rows.changed (audience: who can read the database when sent): re-run the open
    table / calendar; read GET /wiki/databases/{id} when schema_version moved."""

    database_id: UUID
    # Increases with every such event (wiki_rows_seq).
    seq: int
    # The schema and views now: read GET /wiki/databases/{id} again when it moved.
    schema_version: int
