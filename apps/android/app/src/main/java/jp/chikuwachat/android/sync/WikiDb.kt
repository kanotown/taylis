package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.api.DatabaseOut
import jp.chikuwachat.android.api.DbProperty
import jp.chikuwachat.android.api.DbRow
import jp.chikuwachat.android.api.DbRowDetail
import jp.chikuwachat.android.api.DbRowQueryOut
import jp.chikuwachat.android.api.DbRowRef
import jp.chikuwachat.android.api.DbRowWithRefs
import jp.chikuwachat.android.api.DbView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import java.text.NumberFormat
import java.time.LocalDate
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Currency
import java.util.Locale
import java.util.UUID

/*
 * M124 (docs/WIKI.md §5.5, §5.7, §5.8, §18.2): wiki databases on the phone. The server sorts and filters (a saved view's
 * rules); the phone shows the result: a table view as a list of cards (the title and a few properties from the view's
 * visible columns), a calendar view as an agenda of a month (each day with the rows on it; a range on every day it
 * covers). A row opens as its page with the properties above the body, each cell saved on its own with
 * PATCH /wiki/rows/{id}/props {set, client_op_id} (a retry with the same id changes nothing again; the last writer
 * wins per cell). Nothing here edits a schema or a view (§5.5: phones only read them).
 */

/** The database endpoints (WIKI.md §18.2), apart from [WikiApi] (ApiClient has both). */
interface WikiDbApi {
    suspend fun wikiDatabase(databaseId: String): DatabaseOut
    /** A view's rows (its sort and filter); `range`: a calendar's days. */
    suspend fun queryRows(databaseId: String, viewId: String?, range: DbRange?, cursor: String?, limit: Int): DbRowQueryOut
    /** M146: `template` Default sends nothing (the database's default template, if any); `tz` for 「今日」. */
    suspend fun createRow(
        databaseId: String, title: String, props: JsonObject, clientSaveId: String,
        template: RowTemplateChoice = RowTemplateChoice.Default, tz: String? = null,
    ): DbRowWithRefs
    suspend fun wikiRow(rowId: String): DbRowDetail
    suspend fun setRowProps(rowId: String, set: JsonObject, clientOpId: String): DbRowWithRefs
    /** Rows a relation cell may link to: only rows of the related database I can read. */
    suspend fun relationCandidates(databaseId: String, propId: String, q: String): List<DbRowRef>
}

/** The calendar's window: rows whose date on `propId` touches [start, end]. */
data class DbRange(val propId: String, val start: LocalDate, val end: LocalDate)

/** A date cell: "YYYY-MM-DD", or with `time` ISO 8601 with its offset; `end` makes it a range. */
@Serializable
data class DbDateValue(val start: String, val end: String? = null, val time: Boolean = false)

/** What a cell needs to be read as text: people's names, linked rows' titles, the words for the hidden and untitled. */
data class DbCellContext(
    val names: (String) -> String,
    val refs: Map<String, DbRowRef>,
    val hidden: String,
    val untitled: String,
    val zone: ZoneId,
    val locale: Locale,
    /** A date as shown ("2026/10/07"), a date with time ("2026/10/07 9:30"). */
    val datePattern: String = "y/MM/dd",
    /** M146: a row template's 「今日」 ({"start": "@today"}) and 「自分」 ("@me") as shown. */
    val todayWord: String = WikiTemplates.TODAY,
    val meWord: String = WikiTemplates.ME,
)

/** A card of the table: the row's icon and title, then the chosen properties that have a value (name, text). */
data class DbCard(val rowId: String, val icon: String?, val title: String, val lines: List<Pair<String, String>>)

/** One row on a day of the agenda; `first` / `last`: the whole span (a range shows on each day it covers). */
data class AgendaEntry(val rowId: String, val first: LocalDate, val last: LocalDate) {
    val multiDay: Boolean get() = first != last
}

data class AgendaDay(val day: LocalDate, val entries: List<AgendaEntry>)

object WikiDb {
    const val TITLE = "title"
    /** Types a person sets on a row (title too, through the page's title). */
    val EDITABLE = setOf("title", "text", "number", "select", "multi_select", "date", "person", "checkbox", "url", "relation")
    /** Computed by the server from the row: shown, never edited. */
    val COMPUTED = setOf("created_time", "updated_time", "created_by", "updated_by")

    fun isDateish(type: String): Boolean = type == "date" || type == "created_time" || type == "updated_time"

    // --- levels (WIKI.md §4.1, §18.1: rows follow the database; adding and editing rows is edit) -------------------

    fun canEditRows(level: String?): Boolean = WikiLevels.canEdit(level)

    fun canEditCell(level: String?, prop: DbProperty): Boolean = canEditRows(level) && prop.type in EDITABLE

    // --- names ---------------------------------------------------------------------------------------------------

    fun propName(prop: DbProperty, titleWord: String): String = prop.name.ifBlank { if (prop.type == "title") titleWord else prop.id }

    fun viewName(view: DbView, tableWord: String, calendarWord: String): String =
        view.name.ifBlank { if (view.type == "calendar") calendarWord else tableWord }

    /** The view shown: the chosen one while it exists, else the first. */
    fun viewOf(database: DatabaseOut?, viewId: String?): DbView? =
        database?.views?.let { views -> views.firstOrNull { it.id == viewId } ?: views.firstOrNull() }

    // --- reading a cell -----------------------------------------------------------------------------------------

    /** A cell's value as the server has it (computed ones from the row; a relation: the readable row ids). */
    fun cellValue(prop: DbProperty, row: DbRow): JsonElement? = when (prop.type) {
        "title" -> row.title.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive)
        "created_time" -> dateJson(DbDateValue(row.createdAt, null, true))
        "updated_time" -> dateJson(DbDateValue(row.updatedAt, null, true))
        "created_by" -> JsonArray(listOf(JsonPrimitive(row.createdBy)))
        "updated_by" -> JsonArray(listOf(JsonPrimitive(row.updatedBy)))
        "relation" -> JsonArray(row.relations[prop.id].orEmpty().map(::JsonPrimitive))
        else -> row.props[prop.id]?.takeIf { it !is JsonNull }
    }

    fun dateJson(value: DbDateValue): JsonObject = buildJsonObject {
        put("start", value.start)
        put("end", value.end?.let(::JsonPrimitive) ?: JsonNull)
        put("time", value.time)
    }

    fun asDate(value: JsonElement?): DbDateValue? {
        val obj = value as? JsonObject ?: return null
        val start = (obj["start"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val end = (obj["end"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val time = (obj["time"] as? JsonPrimitive)?.booleanOrNull ?: (start.length > 10)
        return DbDateValue(start, end, time)
    }

    fun strings(value: JsonElement?): List<String> =
        (value as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

    fun string(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun number(value: JsonElement?): Double? = (value as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

    fun checked(value: JsonElement?): Boolean = (value as? JsonPrimitive)?.booleanOrNull == true

    fun formatNumber(value: Double, format: String?, locale: Locale): String = when (format) {
        "percent" -> NumberFormat.getNumberInstance(locale).apply { maximumFractionDigits = 2 }.format(value * 100) + "%"
        "yen" -> NumberFormat.getCurrencyInstance(locale).apply { currency = Currency.getInstance("JPY"); maximumFractionDigits = 0 }.format(value)
        "integer" -> NumberFormat.getIntegerInstance(locale).apply { isGroupingUsed = false }.format(Math.round(value))
        else -> NumberFormat.getNumberInstance(locale).apply { isGroupingUsed = false; maximumFractionDigits = 10 }.format(value)
    }

    /** A date as shown: the day as written; a time in this device's zone; a range with " → ". */
    fun formatDate(value: DbDateValue, zone: ZoneId, locale: Locale, pattern: String = "y/MM/dd"): String {
        val day = DateTimeFormatter.ofPattern(pattern, locale)
        val one = { text: String ->
            if (!value.time || text.length <= 10) LocalDate.parse(text.take(10)).format(day)
            else {
                val at = OffsetDateTime.parse(text).atZoneSameInstant(zone)
                at.toLocalDate().format(day) + " " + at.toLocalTime().format(DateTimeFormatter.ofPattern("H:mm", locale))
            }
        }
        return runCatching { if (value.end != null) one(value.start) + " → " + one(value.end) else one(value.start) }.getOrDefault(value.start)
    }

    /** Linked rows as titles; a hidden link is one 「アクセスできないページ」 at the end (never its id or how many). */
    fun relationTitles(prop: DbProperty, row: DbRow, refs: Map<String, DbRowRef>, hidden: String, untitled: String): List<String> {
        val titles = row.relations[prop.id].orEmpty().map { id -> refs[id]?.title?.ifBlank { null } ?: untitled }
        return if (prop.id in row.hiddenRelations) titles + hidden else titles
    }

    /** A cell as plain text (cards, the agenda, a read-only form field). */
    fun cellText(prop: DbProperty, row: DbRow, ctx: DbCellContext): String {
        if (prop.type == "relation") return relationTitles(prop, row, ctx.refs, ctx.hidden, ctx.untitled).joinToString(", ")
        val value = cellValue(prop, row) ?: return ""
        return when (prop.type) {
            "title", "text", "url" -> string(value).orEmpty()
            "number" -> number(value)?.let { formatNumber(it, prop.numberFormat, ctx.locale) }.orEmpty()
            "checkbox" -> if (checked(value)) "✓" else ""
            "select" -> string(value)?.let { id -> prop.options.firstOrNull { it.id == id }?.name }.orEmpty()
            "multi_select" -> strings(value).mapNotNull { id -> prop.options.firstOrNull { it.id == id }?.name }.joinToString(", ")
            "date", "created_time", "updated_time" ->
                if (prop.type == "date" && WikiTemplates.isToday(value)) ctx.todayWord
                else asDate(value)?.let { formatDate(it, ctx.zone, ctx.locale, ctx.datePattern) }.orEmpty()
            "person", "created_by", "updated_by" -> strings(value).joinToString(", ") { if (it == WikiTemplates.ME) ctx.meWord else ctx.names(it) }
            else -> ""
        }
    }

    // --- cards ---------------------------------------------------------------------------------------------------

    /** The view's columns as shown: its own order (hidden ones left out), then the rest of the schema in order. */
    fun visibleColumns(database: DatabaseOut, view: DbView?): List<DbProperty> {
        val byId = database.properties.associateBy { it.id }
        val listed = view?.columns.orEmpty()
        val named = listed.map { it.propId }.toSet()
        val shown = listed.filter { !it.hidden }.mapNotNull { byId[it.propId] }
        return shown + database.properties.filter { it.id !in named }
    }

    /** The properties a card shows under the title: the first few visible columns (not the title). */
    fun cardProps(database: DatabaseOut, view: DbView?, max: Int = 3): List<DbProperty> =
        visibleColumns(database, view).filter { it.type != "title" }.take(max)

    fun card(row: DbRow, props: List<DbProperty>, ctx: DbCellContext, titleWord: String): DbCard = DbCard(
        row.id, row.icon, row.title.ifBlank { ctx.untitled },
        props.mapNotNull { prop -> cellText(prop, row, ctx).takeIf { it.isNotBlank() }?.let { propName(prop, titleWord) to it } },
    )

    // --- the calendar's agenda -----------------------------------------------------------------------------------

    /** The date property a calendar view places rows by: its own, else the first date (or date-like) property. */
    fun datePropOf(database: DatabaseOut, view: DbView?): DbProperty? {
        view?.datePropId?.let { id -> database.properties.firstOrNull { it.id == id && isDateish(it.type) }?.let { return it } }
        return database.properties.firstOrNull { it.type == "date" } ?: database.properties.firstOrNull { isDateish(it.type) }
    }

    /** The calendar day of a stored date or time: a date as written; a time on this device's day. */
    fun dayOf(text: String, zone: ZoneId): LocalDate =
        if (text.length <= 10) LocalDate.parse(text) else OffsetDateTime.parse(text).atZoneSameInstant(zone).toLocalDate()

    /** [first day, last day] of a row on a date property (null: no date, or one that does not read). */
    fun spanOf(prop: DbProperty, row: DbRow, zone: ZoneId): Pair<LocalDate, LocalDate>? {
        val value = asDate(cellValue(prop, row)) ?: return null
        return runCatching {
            val first = dayOf(value.start, zone)
            val last = value.end?.let { dayOf(it, zone) } ?: first
            first to if (last < first) first else last
        }.getOrNull()
    }

    /** The days asked of the server for a month: one more on each side (a time's day may differ by zone). */
    fun monthRange(prop: DbProperty, month: YearMonth): DbRange = DbRange(prop.id, month.atDay(1).minusDays(1), month.atEndOfMonth().plusDays(1))

    /** Each day of [from, to] with rows; a row is on every day it covers (in the order given: the server's sort). */
    fun agenda(rows: List<DbRow>, prop: DbProperty, from: LocalDate, to: LocalDate, zone: ZoneId): List<AgendaDay> {
        val days = sortedMapOf<LocalDate, MutableList<AgendaEntry>>()
        rows.forEach { row ->
            val (first, last) = spanOf(prop, row, zone) ?: return@forEach
            var day = if (first < from) from else first
            val end = if (last > to) to else last
            while (day <= end) {
                days.getOrPut(day) { ArrayList() }.add(AgendaEntry(row.id, first, last))
                day = day.plusDays(1)
            }
        }
        return days.map { (day, entries) -> AgendaDay(day, entries) }
    }

    // --- values sent (WIKI.md §18.2: the shape per type; null clears) ------------------------------------------------

    fun encodeText(text: String): JsonElement = text.trim().ifEmpty { null }?.let(::JsonPrimitive) ?: JsonNull

    /** null: not a number (the field says so). "1,200" and "¥1,200" read as 1200, "50%" as 0.5 (a percent is stored as a fraction). */
    fun parseNumber(text: String): Double? {
        val cleaned = text.trim().replace(",", "").replace("，", "").replace("¥", "").replace("￥", "").trim()
        val percent = cleaned.endsWith("%") || cleaned.endsWith("％")
        val number = cleaned.trimEnd('%', '％').trim().toDoubleOrNull()?.takeIf { it.isFinite() && kotlin.math.abs(it) <= 1e15 } ?: return null
        return if (percent) number / 100 else number
    }

    fun encodeNumber(value: Double?): JsonElement = value?.let(::JsonPrimitive) ?: JsonNull

    private val URL = Regex("""^https?://[^\s/$.?#][^\s]*$""", RegexOption.IGNORE_CASE)

    fun isUrl(text: String): Boolean = URL.matches(text.trim())

    /** null: not an http(s) URL; blank clears. */
    fun encodeUrl(text: String): JsonElement? = when {
        text.isBlank() -> JsonNull
        isUrl(text) -> JsonPrimitive(text.trim())
        else -> null
    }

    fun encodeSelect(optionId: String?): JsonElement = optionId?.let(::JsonPrimitive) ?: JsonNull

    /** Multi-select option ids or people: none clears the cell. */
    fun encodeIds(ids: List<String>): JsonElement = if (ids.isEmpty()) JsonNull else JsonArray(ids.distinct().map(::JsonPrimitive))

    /** A relation is always a list (the server keeps the links I cannot read, whatever is sent). */
    fun encodeRelation(ids: List<String>): JsonElement = JsonArray(ids.distinct().map(::JsonPrimitive))

    fun encodeCheckbox(on: Boolean): JsonElement = JsonPrimitive(on)

    private val OFFSET_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssxxx")

    /**
     * A date cell: a day ("2026-10-07"), a day range, or with a time ISO 8601 at this device's offset on that day
     * ("2026-10-07T09:30:00+09:00"); a range's end without its own time takes the start's.
     */
    fun encodeDate(start: LocalDate, end: LocalDate?, startTime: LocalTime?, endTime: LocalTime?, zone: ZoneId): JsonElement {
        if (startTime == null) {
            val last = end?.takeIf { it > start }
            return dateJson(DbDateValue(start.toString(), last?.toString(), false))
        }
        val from = ZonedDateTime.of(start, startTime, zone)
        val to = end?.let { ZonedDateTime.of(it, endTime ?: startTime, zone) }?.takeIf { it.isAfter(from) }
        return dateJson(DbDateValue(from.format(OFFSET_TIME), to?.format(OFFSET_TIME), true))
    }

    /** A date cell for the editor: the days and times in this device's zone. */
    data class DateParts(val start: LocalDate, val end: LocalDate?, val startTime: LocalTime?, val endTime: LocalTime?)

    fun dateParts(value: DbDateValue?, zone: ZoneId, today: LocalDate): DateParts {
        if (value == null) return DateParts(today, null, null, null)
        return runCatching {
            if (!value.time) DateParts(LocalDate.parse(value.start.take(10)), value.end?.let { LocalDate.parse(it.take(10)) }, null, null)
            else {
                val from = OffsetDateTime.parse(value.start).atZoneSameInstant(zone)
                val to = value.end?.let { OffsetDateTime.parse(it).atZoneSameInstant(zone) }
                DateParts(from.toLocalDate(), to?.toLocalDate(), from.toLocalTime().withSecond(0).withNano(0), to?.toLocalTime()?.withSecond(0)?.withNano(0))
            }
        }.getOrDefault(DateParts(today, null, null, null))
    }

    /** A cell's new value on the row as kept here (before the server answers): relations, the title, or props. */
    fun applyLocal(row: DbRow, propId: String, value: JsonElement, type: String?): DbRow = when {
        propId == TITLE -> row.copy(title = string(value).orEmpty())
        type == "relation" -> row.copy(relations = row.relations + (propId to strings(value)))
        value is JsonNull -> row.copy(props = row.props - propId)
        else -> row.copy(props = row.props + (propId to value))
    }
}

/** The last opened database as kept for reading offline (Room's meta "wiki:db"). */
@Serializable
data class WikiDbSnapshot(
    val databaseId: String,
    val viewId: String? = null,
    /** "2026-10" for a calendar view's month. */
    val month: String? = null,
    val database: DatabaseOut,
    val rows: List<DbRow> = emptyList(),
    val refs: List<DbRowRef> = emptyList(),
    val total: Int = 0,
    val fetchedAt: Long = 0,
)

/** Timing and ids for the sessions (tests replace them). */
class WikiDbOptions(
    val newId: () -> String = { UUID.randomUUID().toString() },
    val retryWait: suspend (Int) -> Unit = { delay(1_000L * it) },
    val zone: () -> ZoneId = { ZoneId.systemDefault() },
    val today: () -> LocalDate = { LocalDate.now() },
    val now: () -> Long = { System.currentTimeMillis() },
)

/**
 * An open database: its schema and views, the rows of the chosen view (a table 100 at a time; a calendar the month on
 * screen), kept for reading offline when it is the last one opened. [reload] reads both again (pull to refresh,
 * wiki.rows.changed, reconnecting); answers to an older read are dropped.
 */
class DatabaseSession(
    val databaseId: String,
    private val api: WikiDbApi,
    private val store: Store?,
    private val scope: CoroutineScope,
    private val options: WikiDbOptions = WikiDbOptions(),
) {
    var database: DatabaseOut? = null
        private set
    var viewId: String? = null
        private set
    var month: YearMonth = YearMonth.from(options.today())
        private set
    var rows: List<DbRow> = emptyList()
        private set
    var refs: Map<String, DbRowRef> = emptyMap()
        private set
    var total = 0
        private set
    var nextCursor: String? = null
        private set
    var loading = false
        private set
    var loadError: Throwable? = null
        private set
    /** Shown from the copy kept on this device (the server could not be read): when it was read. */
    var offlineSince: Long? = null
        private set
    private var generation = 0
    private var job: Job? = null
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version

    val view: DbView? get() = WikiDb.viewOf(database, viewId)

    private fun emit() {
        _version.value = _version.value + 1
    }

    init {
        store?.wikiDb()?.takeIf { it.databaseId == databaseId }?.let { kept ->
            database = kept.database
            viewId = kept.viewId
            kept.month?.let { runCatching { YearMonth.parse(it) }.getOrNull() }?.let { month = it }
            rows = kept.rows
            refs = kept.refs.associateBy { it.id }
            total = kept.total
            offlineSince = kept.fetchedAt
        }
    }

    /** Reads the schema and the view's first page again; a read on its way is replaced. */
    fun reload() {
        job?.cancel()
        job = scope.launch { refresh() }
    }

    suspend fun refresh() {
        val mine = ++generation
        loading = true
        emit()
        try {
            val db = api.wikiDatabase(databaseId)
            if (mine != generation) return
            database = db
            val view = WikiDb.viewOf(db, viewId)
            val answer = query(db, view, null)
            if (mine != generation) return
            rows = answer.rows
            refs = answer.refs.associateBy { it.id }
            total = answer.total
            nextCursor = answer.nextCursor
            loadError = null
            offlineSince = null
            keep()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (mine != generation) return
            Log.w("WikiDb", "could not read the database", e)
            loadError = e
        } finally {
            if (mine == generation) {
                loading = false
                emit()
            }
        }
    }

    private suspend fun query(db: DatabaseOut, view: DbView?, cursor: String?): DbRowQueryOut {
        if (view?.type == "calendar") {
            val prop = WikiDb.datePropOf(db, view) ?: return DbRowQueryOut()
            return api.queryRows(databaseId, view.id, WikiDb.monthRange(prop, month), null, 1000)
        }
        return api.queryRows(databaseId, view?.id, null, cursor, PAGE)
    }

    /** The table's next 100 rows. */
    suspend fun loadMore() {
        val db = database ?: return
        val cursor = nextCursor ?: return
        val mine = generation
        try {
            val answer = query(db, view, cursor)
            if (mine != generation) return
            val known = rows.map { it.id }.toSet()
            rows = rows + answer.rows.filter { it.id !in known }
            refs = refs + answer.refs.associateBy { it.id }
            total = answer.total
            nextCursor = answer.nextCursor
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            loadError = e
        }
        emit()
    }

    fun selectView(id: String) {
        if (id == view?.id) return
        viewId = id
        rows = emptyList()
        nextCursor = null
        emit()
        reload()
    }

    fun moveMonth(by: Long) {
        month = month.plusMonths(by)
        rows = emptyList()
        emit()
        reload()
    }

    fun showMonth(value: YearMonth) {
        if (value == month) return
        month = value
        reload()
    }

    private fun keep() {
        val db = database ?: return
        store?.saveWikiDb(
            WikiDbSnapshot(databaseId, viewId, month.toString(), db, rows.take(KEEP_ROWS), refs.values.toList(), total, options.now()),
        )
    }

    /**
     * A new row (edit): the title, and on a calendar the date of the day shown (today when in this month, else its
     * first). A failure on the network is sent again with the same key (one row, not two).
     */
    suspend fun createRow(title: String, template: RowTemplateChoice = RowTemplateChoice.Default): DbRow {
        val db = database ?: throw IllegalStateException("not loaded")
        val view = view
        val props = buildJsonObject {
            if (view?.type == "calendar") {
                val prop = WikiDb.datePropOf(db, view)
                if (prop?.type == "date") {
                    val today = options.today()
                    val day = if (YearMonth.from(today) == month) today else month.atDay(1)
                    put(prop.id, WikiDb.encodeDate(day, null, null, null, options.zone()))
                }
            }
        }
        val made = CanvasRequests.sameKey(options.newId(), wait = options.retryWait) { key -> api.createRow(databaseId, title, props, key, template, options.zone().id) }
        refs = refs + made.refs.associateBy { it.id }
        if (rows.none { it.id == made.row.id }) {
            rows = rows + made.row
            total += 1
        }
        emit()
        return made.row
    }

    fun stop() {
        job?.cancel()
    }

    companion object {
        const val PAGE = 100
        /** Rows kept for offline reading (one database). */
        const val KEEP_ROWS = 500
    }
}

/**
 * An open row's properties: GET /wiki/rows/{id} (the cells with the database's schema, linked rows' titles and the
 * one-way back references), and each change saved on its own. A change shows at once; the server's answer replaces
 * the row (the last writer wins per cell); a failure puts the cell back and is reported.
 */
class RowSession(
    val rowId: String,
    private val api: WikiDbApi,
    private val scope: CoroutineScope,
    private val options: WikiDbOptions = WikiDbOptions(),
    private val onError: (Throwable) -> Unit = {},
) {
    var detail: DbRowDetail? = null
        private set
    var loadError: Throwable? = null
        private set
    var loading = false
        private set
    /** Cells being saved (their fields show it). */
    var saving: Set<String> = emptySet()
        private set
    private var generation = 0
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version

    val level: String? get() = detail?.database?.myLevel
    val editable: Boolean get() = WikiDb.canEditRows(level)

    private fun emit() {
        _version.value = _version.value + 1
    }

    fun reload() {
        scope.launch { refresh() }
    }

    suspend fun refresh() {
        val mine = ++generation
        loading = true
        emit()
        try {
            val got = api.wikiRow(rowId)
            if (mine != generation || saving.isNotEmpty()) return
            detail = got
            loadError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (mine == generation) loadError = e
        } finally {
            if (mine == generation) loading = false
            emit()
        }
    }

    /** Sets one cell (`propId` "title" for the title) to `value` (JsonNull clears it). */
    fun set(propId: String, value: JsonElement) {
        scope.launch { save(propId, value) }
    }

    suspend fun save(propId: String, value: JsonElement): Boolean {
        val known = detail ?: return false
        val prop = known.database.properties.firstOrNull { it.id == propId }
        if (propId != WikiDb.TITLE && (prop == null || !WikiDb.canEditCell(known.database.myLevel, prop))) return false
        val before = known.row
        detail = known.copy(row = WikiDb.applyLocal(before, propId, value, prop?.type))
        generation++ // a read on its way would show the cell from before
        saving = saving + propId
        emit()
        val set = JsonObject(mapOf(propId to value))
        return try {
            val answer = CanvasRequests.sameKey(options.newId(), wait = options.retryWait) { key -> api.setRowProps(rowId, set, key) }
            detail = detail?.let { d -> d.copy(row = answer.row, refs = (d.refs.associateBy { it.id } + answer.refs.associateBy { it.id }).values.toList()) }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Back to the value from before for this cell only (others may have been saved meanwhile).
            detail = detail?.let { d ->
                val restored = if (propId == WikiDb.TITLE) d.row.copy(title = before.title)
                else if (prop?.type == "relation") d.row.copy(relations = d.row.relations + (propId to before.relations[propId].orEmpty()))
                else before.props[propId]?.let { d.row.copy(props = d.row.props + (propId to it)) } ?: d.row.copy(props = d.row.props - propId)
                d.copy(row = restored)
            }
            onError(e)
            false
        } finally {
            saving = saving - propId
            emit()
        }
    }

    /** Readable rows a relation cell may take (the related database's, by title). */
    suspend fun candidates(propId: String, q: String): List<DbRowRef> {
        val databaseId = detail?.row?.databaseId ?: return emptyList()
        return api.relationCandidates(databaseId, propId, q)
    }
}

/** A relation's chips: readable rows by title (they open), then one 「アクセスできないページ」 with no id when there are hidden links. */
sealed interface RelationChip {
    data class Row(val id: String, val title: String, val icon: String?) : RelationChip
    data object Hidden : RelationChip
}

object RelationChips {
    fun of(prop: DbProperty, row: DbRow, refs: Map<String, DbRowRef>, untitled: String): List<RelationChip> {
        val readable = row.relations[prop.id].orEmpty().map { id ->
            val ref = refs[id]
            RelationChip.Row(id, ref?.title?.ifBlank { null } ?: untitled, ref?.icon)
        }
        return if (prop.id in row.hiddenRelations) readable + RelationChip.Hidden else readable
    }
}
