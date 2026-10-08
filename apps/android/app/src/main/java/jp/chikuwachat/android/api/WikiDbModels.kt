package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/*
 * M124 (docs/WIKI.md §5, §18.2): wiki databases on the phone. The shapes are openapi.json's DatabaseOut / PropertyOut /
 * ViewOut / RowOut / RowRef / RowQueryOut / RowWithRefs / RowDetailOut / ReferencedBy. A cell's value stays a
 * JsonElement (its shape depends on the property's type); plain @Serializable data only (R8: no reflection).
 */

@Serializable
data class DbOption(val id: String, val name: String = "", val color: String = "gray")

/** Where a relation points. A database I cannot read has no id or title (its rows are 「アクセスできないページ」). */
@Serializable
data class DbRelation(
    val databaseId: String? = null,
    val databaseTitle: String? = null,
    val pairId: String? = null,
    val primary: Boolean = true,
)

@Serializable
data class DbProperty(
    val id: String,
    /** "" for the title property of a new database: shown as 「名前」. */
    val name: String = "",
    /** title | text | number | select | multi_select | date | person | checkbox | url | relation | created_time | … */
    val type: String = "text",
    val options: List<DbOption> = emptyList(),
    /** number | integer | percent | yen (number only). */
    val numberFormat: String? = null,
    val relation: DbRelation? = null,
)

@Serializable
data class DbViewColumn(val propId: String, val width: Int? = null, val hidden: Boolean = false)

@Serializable
data class DbSortKey(val propId: String, val direction: String = "asc")

@Serializable
data class DbFilterCondition(val propId: String, val op: String, val value: JsonElement? = null)

@Serializable
data class DbFilterGroup(val combinator: String = "and", val conditions: List<DbFilterCondition> = emptyList())

/**
 * M147 (WIKI.md §25.1): rows in groups by one property. A key is an option id, a user id, "true" / "false", a day
 * "YYYY-MM-DD" (a week by its Monday) or a month "YYYY-MM"; "" is the group of rows with no value (「なし」).
 */
@Serializable
data class DbGroupBy(
    val propId: String,
    /** day | week | month (dates only; null: day). */
    val dateUnit: String? = null,
    val hidden: List<String> = emptyList(),
    val hideEmpty: Boolean = false,
)

/** A saved view (the server applies its sort, filter and groups; the phone only shows the result, M148). */
@Serializable
data class DbView(
    val id: String,
    /** "" for a view without a name: shown as its type's word (「表」「ボード」…). */
    val name: String = "",
    /** table | calendar | board | list | gallery (M147); anything else shows as a table. */
    val type: String = "table",
    val columns: List<DbViewColumn> = emptyList(),
    val sort: List<DbSortKey> = emptyList(),
    val filter: DbFilterGroup? = null,
    val datePropId: String? = null,
    /** M147: the groups (a board's columns); null: none. */
    val groupBy: DbGroupBy? = null,
    /** M147, a gallery's picture: body (the body's first image) | none. */
    val cover: String = "body",
    /** M147, a gallery's card size: small | medium | large (the phone always shows 2 columns). */
    val cardSize: String = "medium",
)

@Serializable
data class DbLimits(val rows: Int = 0, val properties: Int = 0, val options: Int = 0, val views: Int = 0)

/** GET /wiki/databases/{id}: the schema (title property first), the saved views, my level. */
@Serializable
data class DatabaseOut(
    val pageId: String,
    val schemaVersion: Long = 0,
    val properties: List<DbProperty> = emptyList(),
    val views: List<DbView> = emptyList(),
    val myLevel: String = "view",
    val rowCount: Int = 0,
    val limits: DbLimits? = null,
    /** M146: the row templates (oldest first) and the one 「＋ 新規」 uses when nothing is chosen. */
    val templates: List<DbTemplateRef> = emptyList(),
    val defaultTemplateId: String? = null,
)

/** M146: a row template of a database (GET /wiki/databases/{id}'s `templates`). */
@Serializable
data class DbTemplateRef(val id: String, val title: String = "", val icon: String? = null)

/** A row without its body. `relations`: the readable linked rows per property; `hiddenRelations`: properties that also link to rows I cannot read. */
@Serializable
data class DbRow(
    val id: String,
    val databaseId: String = "",
    val title: String = "",
    val icon: String? = null,
    val position: String = "",
    val version: Long = 0,
    val headRevId: String = "",
    val props: Map<String, JsonElement> = emptyMap(),
    val relations: Map<String, List<String>> = emptyMap(),
    val hiddenRelations: List<String> = emptyList(),
    val createdAt: String = "",
    val createdBy: String = "",
    val updatedAt: String = "",
    val updatedBy: String = "",
    /** M147: a gallery card's picture (only asked with `covers: true`). */
    val cover: DbRowCover? = null,
)

/** M147: the first image of a row's body (attached to the row): `/attachments/{id}/thumbnail` when `thumbnail`, else …/content. */
@Serializable
data class DbRowCover(val attachmentId: String, val thumbnail: Boolean = false, val width: Int? = null, val height: Int? = null)

/** M147: a group of a grouped answer (named on the phone from the option, the person, the checkbox or the date). */
@Serializable
data class DbRowGroup(val key: String, val count: Int = 0, val hidden: Boolean = false)

/** A linked row I can read. */
@Serializable
data class DbRowRef(val id: String, val databaseId: String = "", val title: String = "", val icon: String? = null)

@Serializable
data class DbRowQueryOut(
    val rows: List<DbRow> = emptyList(),
    val refs: List<DbRowRef> = emptyList(),
    val total: Int = 0,
    val nextCursor: String? = null,
    val schemaVersion: Long = 0,
    /** M147 (`grouped: true`): every group in order with its count (hidden ones too); null when not grouped. */
    val groups: List<DbRowGroup>? = null,
    /** M147: the group of each of `rows` (as long as `rows`; a row with several values is once in each of its groups). */
    val rowGroups: List<String>? = null,
)

@Serializable
data class DbRowWithRefs(val row: DbRow, val refs: List<DbRowRef> = emptyList())

/** Rows I can read that link to this one through a one-way relation. */
@Serializable
data class DbReferencedBy(
    val databaseId: String,
    val databaseTitle: String = "",
    val propId: String = "",
    val propName: String = "",
    val rows: List<DbRowRef> = emptyList(),
)

/** GET /wiki/rows/{id}: the row's cells with its database's schema. */
@Serializable
data class DbRowDetail(
    val row: DbRow,
    val database: DatabaseOut,
    val databaseTitle: String = "",
    val refs: List<DbRowRef> = emptyList(),
    val referencedBy: List<DbReferencedBy> = emptyList(),
)
