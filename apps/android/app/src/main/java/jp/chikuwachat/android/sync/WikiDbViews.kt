package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.DatabaseOut
import jp.chikuwachat.android.api.DbProperty
import jp.chikuwachat.android.api.DbRow
import jp.chikuwachat.android.api.DbRowGroup
import jp.chikuwachat.android.api.DbView
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/*
 * M148 (docs/WIKI.md §22.4, §25): the view types on the phone. The server groups (POST …/query with `grouped: true`
 * and the device's `tz`) and the phone shows its answer: a board as a section of cards per group (each card's ⋮ moves
 * it to another group with POST /wiki/rows/{id}/move), a gallery as a 2-column grid of cards with the body's first
 * image (`covers: true`), a list as the cards of a table, and a table / list / gallery with a group_by as sections
 * under headers. A section folds on this device only (not saved). The view's settings are only read (§25.4).
 */

/** What a query asks besides the view (M147): groups, gallery pictures, the zone of the days of a time. */
data class DbQueryOptions(val grouped: Boolean? = null, val covers: Boolean = false, val tz: String? = null)

/** The words for a view without a name, by its type. */
data class DbViewWords(val table: String, val board: String, val list: String, val gallery: String, val calendar: String)

/** The words a group's header needs (「なし」, a checkbox's state, 「{day} の週」, a month). */
data class DbGroupWords(
    val none: String,
    val checked: String,
    val unchecked: String,
    val weekOf: (String) -> String,
    /** A month as shown ("y年M月"). */
    val monthPattern: String,
)

/** A group as shown: its key, how many rows it has (all of them, not only those read), the rows read so far. */
data class DbSection(val key: String, val count: Int, val rows: List<DbRow>)

object WikiDbViews {
    const val TABLE = "table"
    const val BOARD = "board"
    const val LIST = "list"
    const val GALLERY = "gallery"
    const val CALENDAR = "calendar"

    /** Rows per page of a grouped view (as Desktop: a lab's database of a few hundred rows is one read). */
    const val GROUPED_PAGE = 1000

    /** Types a board's card can be moved by (§25.1: writing the column's value). */
    val BOARD_TYPES = setOf("select", "person", "checkbox")

    /** The view's layout; a type this app does not know shows as a table (cards). */
    fun kind(view: DbView?): String = when (view?.type) {
        BOARD, LIST, GALLERY, CALENDAR -> view.type
        else -> TABLE
    }

    /** A view's name; one without a name is called by its type (never 「表」 for a board). */
    fun name(view: DbView, words: DbViewWords): String = view.name.ifBlank {
        when (kind(view)) {
            BOARD -> words.board
            LIST -> words.list
            GALLERY -> words.gallery
            CALENDAR -> words.calendar
            else -> words.table
        }
    }

    /** M148: every view but a calendar asks in groups with this device's zone; a gallery also for its pictures. */
    fun queryOptions(view: DbView?, zone: ZoneId): DbQueryOptions {
        if (kind(view) == CALENDAR) return DbQueryOptions()
        return DbQueryOptions(grouped = true, covers = kind(view) == GALLERY && view?.cover != "none", tz = zone.id)
    }

    /** POST /wiki/databases/{id}/query's body. */
    fun queryBody(viewId: String?, range: DbRange?, cursor: String?, limit: Int, options: DbQueryOptions = DbQueryOptions()): JsonObject = buildJsonObject {
        viewId?.let { put("view_id", it) }
        range?.let { r ->
            put("range", buildJsonObject {
                put("prop_id", r.propId)
                put("start", r.start.toString())
                put("end", r.end.toString())
            })
        }
        cursor?.let { put("cursor", it) }
        put("limit", limit)
        options.grouped?.let { put("grouped", it) }
        if (options.covers) put("covers", true)
        options.tz?.let { put("tz", it) }
    }

    /** POST /wiki/rows/{id}/move's body: the cells only (the server keeps the row's place); the same id on a retry. */
    fun moveBody(set: JsonObject, clientOpId: String): JsonObject = buildJsonObject {
        put("set", set)
        put("client_op_id", clientOpId)
    }

    /** The property the view groups by, when it is still in the schema. */
    fun groupProp(database: DatabaseOut?, view: DbView?): DbProperty? {
        val id = view?.groupBy?.propId ?: return null
        return database?.properties?.firstOrNull { it.id == id }
    }

    /**
     * The groups of an answer as sections: the shown groups in their order with the rows read so far (a row with
     * several values in each of its groups). null: the answer is not in groups (no group_by, an older server).
     */
    fun sections(rows: List<DbRow>, rowGroups: List<String>?, groups: List<DbRowGroup>?): List<DbSection>? {
        if (groups.isNullOrEmpty() || rowGroups == null || rowGroups.size != rows.size) return null
        val byKey = LinkedHashMap<String, MutableList<DbRow>>()
        groups.filter { !it.hidden }.forEach { byKey[it.key] = ArrayList() }
        rows.forEachIndexed { i, row -> byKey.getOrPut(rowGroups[i]) { ArrayList() }.add(row) }
        val counts = groups.associate { it.key to it.count }
        return byKey.map { (key, list) -> DbSection(key, counts[key] ?: list.size, list) }
    }

    /** A group's name: the option, the person, on / off, the day, 「{day} の週」, the month; "" is 「なし」. */
    fun groupLabel(prop: DbProperty?, key: String, unit: String?, ctx: DbCellContext, words: DbGroupWords): String {
        if (prop?.type == "checkbox") return if (key == "true") words.checked else words.unchecked
        if (key.isEmpty() || prop == null) return words.none
        return when (prop.type) {
            "select", "multi_select" -> prop.options.firstOrNull { it.id == key }?.name?.ifBlank { null } ?: words.none
            "person", "created_by", "updated_by" -> ctx.names(key)
            "date", "created_time", "updated_time" -> runCatching {
                when (unit) {
                    "month" -> YearMonth.parse(key.take(7)).format(DateTimeFormatter.ofPattern(words.monthPattern, ctx.locale))
                    else -> {
                        val day = LocalDate.parse(key.take(10)).format(DateTimeFormatter.ofPattern(ctx.datePattern, ctx.locale))
                        if (unit == "week") words.weekOf(day) else day
                    }
                }
            }.getOrDefault(key)
            else -> key
        }
    }

    /** A select group's colour (the option's), for its chip; null for other types and 「なし」. */
    fun groupColor(prop: DbProperty?, key: String): String? =
        if (prop?.type == "select" || prop?.type == "multi_select") prop.options.firstOrNull { it.id == key }?.color else null

    /** Whether a board's cards can be moved here: an editor (M144), by a select, a person or a checkbox. */
    fun canMove(database: DatabaseOut?, view: DbView?): Boolean {
        if (kind(view) != BOARD || !WikiDb.canEditRows(database?.myLevel)) return false
        return groupProp(database, view)?.type in BOARD_TYPES
    }

    /** The groups a card in `from` can go to: the other shown groups (a hidden one would hide the card). */
    fun moveTargets(sections: List<DbSection>, from: String): List<String> = sections.map { it.key }.filter { it != from }

    /**
     * The cells a move writes (§25.2): a select takes the group's option (「なし」 clears it), a checkbox the group's
     * state, a person loses the people of `from` and gains the one of `to` (「なし」 clears the cell). null: not a
     * property a card is moved by.
     */
    fun moveSet(prop: DbProperty, row: DbRow, from: String, to: String): JsonObject? {
        val value: JsonElement = when (prop.type) {
            "select" -> WikiDb.encodeSelect(to.ifEmpty { null })
            "checkbox" -> WikiDb.encodeCheckbox(to == "true")
            "person" -> if (to.isEmpty()) JsonNull else {
                val now = WikiDb.strings(WikiDb.cellValue(prop, row))
                WikiDb.encodeIds(now.filter { it != from } + to)
            }
            else -> return null
        }
        return JsonObject(mapOf(prop.id to value))
    }

    /** A collapsed section's id (per view; kept on this device only while the database is open). */
    fun sectionId(viewId: String?, key: String): String = "${viewId.orEmpty()}|$key"
}
