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

/** A saved view (the server applies its sort and filter; the phone only shows the result). */
@Serializable
data class DbView(
    val id: String,
    /** "" for the first view of a new database: shown as 「表」. */
    val name: String = "",
    /** table | calendar (board later). */
    val type: String = "table",
    val columns: List<DbViewColumn> = emptyList(),
    val sort: List<DbSortKey> = emptyList(),
    val filter: DbFilterGroup? = null,
    val datePropId: String? = null,
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
)

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
)

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
