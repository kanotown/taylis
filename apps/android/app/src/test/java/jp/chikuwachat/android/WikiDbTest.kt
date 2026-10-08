package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DatabaseOut
import jp.chikuwachat.android.api.DbOption
import jp.chikuwachat.android.api.DbProperty
import jp.chikuwachat.android.api.DbRelation
import jp.chikuwachat.android.api.DbRow
import jp.chikuwachat.android.api.DbRowDetail
import jp.chikuwachat.android.api.DbRowQueryOut
import jp.chikuwachat.android.api.DbRowRef
import jp.chikuwachat.android.api.DbRowWithRefs
import jp.chikuwachat.android.api.DbView
import jp.chikuwachat.android.api.DbViewColumn
import jp.chikuwachat.android.sync.DatabaseSession
import jp.chikuwachat.android.sync.DbCellContext
import jp.chikuwachat.android.sync.DbDateValue
import jp.chikuwachat.android.sync.DbRange
import jp.chikuwachat.android.sync.RelationChip
import jp.chikuwachat.android.sync.RelationChips
import jp.chikuwachat.android.sync.RowSession
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.WIKI_DB_KEY
import jp.chikuwachat.android.sync.WikiDb
import jp.chikuwachat.android.sync.WikiDbApi
import jp.chikuwachat.android.sync.WikiDbOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth
import java.time.ZoneId
import java.util.Locale

private val TOKYO = ZoneId.of("Asia/Tokyo")
private val NEW_YORK = ZoneId.of("America/New_York")

private val STAGE = DbProperty(
    "stage", "段階", "select",
    options = listOf(DbOption("o1", "実験中", "blue"), DbOption("o2", "執筆中", "green")),
)
private val TAGS = DbProperty("tags", "タグ", "multi_select", options = listOf(DbOption("t1", "ML"), DbOption("t2", "HCI")))
private val PRICE = DbProperty("price", "価格", "number", numberFormat = "yen")
private val RATE = DbProperty("rate", "進み", "number", numberFormat = "percent")
private val DUE = DbProperty("due", "締切", "date")
private val WHO = DbProperty("who", "担当", "person")
private val DONE = DbProperty("done", "完了", "checkbox")
private val LINK = DbProperty("link", "URL", "url")
private val NOTE = DbProperty("note", "メモ", "text")
private val PAPERS = DbProperty("papers", "論文", "relation", relation = DbRelation("db2", "論文", null, true))
private val MADE = DbProperty("made", "作成日時", "created_time")
private val TITLE = DbProperty("title", "", "title")

private fun database(level: String = "edit", views: List<DbView> = listOf(DbView("v1"))) = DatabaseOut(
    pageId = "db1", schemaVersion = 3,
    properties = listOf(TITLE, STAGE, TAGS, PRICE, RATE, DUE, WHO, DONE, LINK, NOTE, PAPERS, MADE),
    views = views, myLevel = level, rowCount = 2,
)

private fun row(
    id: String, title: String = id, props: Map<String, JsonElement> = emptyMap(), relations: Map<String, List<String>> = emptyMap(),
    hidden: List<String> = emptyList(),
) = DbRow(
    id = id, databaseId = "db1", title = title, props = props, relations = relations, hiddenRelations = hidden,
    createdAt = "2026-10-07T00:30:00+00:00", createdBy = "u1", updatedAt = "2026-10-07T00:30:00+00:00", updatedBy = "u2",
)

private fun day(text: String) = WikiDb.dateJson(DbDateValue(text, null, false))
private fun range(start: String, end: String?, time: Boolean = false) = WikiDb.dateJson(DbDateValue(start, end, time))

private fun ctx(zone: ZoneId = TOKYO, refs: Map<String, DbRowRef> = emptyMap()) = DbCellContext(
    names = { id -> mapOf("u1" to "加納", "u2" to "海老").getValue(id) }, refs = refs, hidden = "アクセスできないページ",
    untitled = "無題", zone = zone, locale = Locale.JAPAN,
)

/** M124: the database endpoints on a pretend server (the server's own tests cover its rules). */
class FakeWikiDbApi : WikiDbApi {
    var db = database()
    var rows = listOf(row("r1"), row("r2"))
    var refs = emptyList<DbRowRef>()
    val calls = ArrayList<String>()
    val queries = ArrayList<Triple<String?, DbRange?, Int>>()
    val ops = ArrayList<Pair<JsonObject, String>>()
    val creates = ArrayList<Pair<JsonObject, String>>()
    val templates = ArrayList<jp.chikuwachat.android.sync.RowTemplateChoice>()
    val failures = ArrayDeque<Throwable>()
    var detail: DbRowDetail? = null
    var candidates = emptyList<DbRowRef>()

    private fun fail() { failures.removeFirstOrNull()?.let { throw it } }

    override suspend fun wikiDatabase(databaseId: String): DatabaseOut {
        calls.add("database $databaseId")
        fail()
        return db
    }

    override suspend fun queryRows(databaseId: String, viewId: String?, range: DbRange?, cursor: String?, limit: Int): DbRowQueryOut {
        calls.add("query ${viewId ?: "-"} ${cursor ?: "-"}")
        queries.add(Triple(viewId, range, limit))
        fail()
        return DbRowQueryOut(rows, refs, rows.size, if (cursor == null && limit == DatabaseSession.PAGE && rows.size > 1) "o:1" else null, db.schemaVersion)
    }

    override suspend fun createRow(databaseId: String, title: String, props: JsonObject, clientSaveId: String, template: jp.chikuwachat.android.sync.RowTemplateChoice, tz: String?): DbRowWithRefs {
        templates.add(template)
        creates.add(props to clientSaveId)
        fail()
        return DbRowWithRefs(row("new", title, props))
    }

    override suspend fun wikiRow(rowId: String): DbRowDetail {
        calls.add("row $rowId")
        fail()
        return detail ?: DbRowDetail(row(rowId), db, "研究", refs)
    }

    override suspend fun setRowProps(rowId: String, set: JsonObject, clientOpId: String): DbRowWithRefs {
        ops.add(set to clientOpId)
        fail()
        val (key, value) = set.entries.single()
        val prop = db.properties.firstOrNull { it.id == key }
        val now = detail?.row ?: row(rowId)
        val next = WikiDb.applyLocal(now, key, value, prop?.type)
        detail = (detail ?: DbRowDetail(now, db, "研究")).copy(row = next)
        return DbRowWithRefs(next, refs)
    }

    override suspend fun relationCandidates(databaseId: String, propId: String, q: String): List<DbRowRef> {
        calls.add("candidates $propId $q")
        return candidates
    }
}

/**
 * M124 (docs/WIKI.md §5.5, §5.7, §5.8, §18.2): what a card shows, the agenda of a calendar view (ranges on every day,
 * times on this device's day), the values sent per type, a cell's save (one op id however many tries, the cell put
 * back on a refusal), links to rows I cannot read, and what each level may do.
 */
class WikiDbTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private var ids = 0
    private fun options(today: LocalDate = LocalDate.of(2026, 10, 7)) =
        WikiDbOptions(newId = { "op${++ids}" }, retryWait = {}, zone = { TOKYO }, today = { today }, now = { 5_000L })

    // --- cards ----------------------------------------------------------------------------------------------------

    @Test
    fun aCardShowsTheFirstVisibleColumnsOfTheViewWithAValue() {
        val view = DbView(
            "v1", columns = listOf(DbViewColumn("title"), DbViewColumn("due"), DbViewColumn("stage", hidden = true), DbViewColumn("price"), DbViewColumn("who")),
        )
        val db = database(views = listOf(view))
        // Listed columns in their order without hidden ones, then the rest of the schema in order.
        assertEquals(listOf("title", "due", "price", "who", "tags", "rate", "done", "link", "note", "papers", "made"), WikiDb.visibleColumns(db, view).map { it.id })
        assertEquals(listOf("due", "price", "who"), WikiDb.cardProps(db, view).map { it.id })
        // No view columns: the schema's order.
        assertEquals(listOf("stage", "tags", "price"), WikiDb.cardProps(db, DbView("v2")).map { it.id })

        val r = row("r1", title = "", props = mapOf("price" to JsonPrimitive(1200.0), "who" to JsonArray(listOf(JsonPrimitive("u1"), JsonPrimitive("u2")))))
        val card = WikiDb.card(r, WikiDb.cardProps(db, view), ctx(), "名前")
        assertEquals("無題", card.title)
        // The empty date is left out; the others read as text.
        assertEquals(listOf("価格" to "￥1,200", "担当" to "加納, 海老"), card.lines)
    }

    @Test
    fun cellsReadAsTextPerType() {
        val r = row(
            "r1",
            props = mapOf(
                "stage" to JsonPrimitive("o2"), "tags" to JsonArray(listOf(JsonPrimitive("t2"), JsonPrimitive("gone"), JsonPrimitive("t1"))),
                "rate" to JsonPrimitive(0.5), "done" to JsonPrimitive(true), "due" to range("2026-10-07", "2026-10-09"),
                "note" to JsonPrimitive("メモ"),
            ),
        )
        val c = ctx()
        assertEquals("執筆中", WikiDb.cellText(STAGE, r, c))
        assertEquals("HCI, ML", WikiDb.cellText(TAGS, r, c))
        assertEquals("50%", WikiDb.cellText(RATE, r, c))
        assertEquals("✓", WikiDb.cellText(DONE, r, c))
        assertEquals("2026/10/07 → 2026/10/09", WikiDb.cellText(DUE, r, c))
        assertEquals("メモ", WikiDb.cellText(NOTE, r, c))
        // Created at 00:30 UTC: 9:30 in Tokyo, the evening before in New York.
        assertEquals("2026/10/07 9:30", WikiDb.cellText(MADE, r, c))
        assertEquals("2026/10/06 20:30", WikiDb.cellText(MADE, r, ctx(NEW_YORK)))
        assertEquals("", WikiDb.cellText(PRICE, r, c))
        assertEquals("名前", WikiDb.propName(TITLE, "名前"))
        assertEquals("表", WikiDb.viewName(DbView("v1"), "表", "カレンダー"))
        assertEquals("カレンダー", WikiDb.viewName(DbView("v2", type = "calendar"), "表", "カレンダー"))
        assertEquals("予定", WikiDb.viewName(DbView("v3", name = "予定", type = "calendar"), "表", "カレンダー"))
    }

    // --- the agenda -----------------------------------------------------------------------------------------------

    @Test
    fun theAgendaPutsARangeOnEveryDayItCoversWithinTheMonth() {
        val rows = listOf(
            row("a", props = mapOf("due" to day("2026-10-07"))),
            row("b", props = mapOf("due" to range("2026-09-29", "2026-10-02"))), // from last month
            row("c", props = mapOf("due" to range("2026-10-30", "2026-11-03"))), // into next month
            row("d"), // no date: not shown
            row("e", props = mapOf("due" to range("2026-10-07", "2026-10-05"))), // an end before the start: the start only
        )
        val days = WikiDb.agenda(rows, DUE, LocalDate.of(2026, 10, 1), LocalDate.of(2026, 10, 31), TOKYO)
        assertEquals(
            listOf("2026-10-01" to listOf("b"), "2026-10-02" to listOf("b"), "2026-10-07" to listOf("a", "e"), "2026-10-30" to listOf("c"), "2026-10-31" to listOf("c")),
            days.map { it.day.toString() to it.entries.map { e -> e.rowId } },
        )
        val b = days.first().entries.single()
        assertTrue(b.multiDay)
        assertEquals(LocalDate.of(2026, 9, 29), b.first)
        assertEquals(LocalDate.of(2026, 10, 2), b.last)
        assertFalse(days[2].entries.first().multiDay)
    }

    @Test
    fun aTimedDateFallsOnThisDevicesDay() {
        // 23:30 UTC on Oct 7 is Oct 8 in Tokyo and still Oct 7 in New York; a range keeps its days in each zone.
        val r = row("t", props = mapOf("due" to range("2026-10-07T23:30:00+00:00", "2026-10-08T23:30:00+00:00", time = true)))
        val month = YearMonth.of(2026, 10)
        assertEquals(
            listOf("2026-10-08", "2026-10-09"),
            WikiDb.agenda(listOf(r), DUE, month.atDay(1), month.atEndOfMonth(), TOKYO).map { it.day.toString() },
        )
        assertEquals(
            listOf("2026-10-07", "2026-10-08"),
            WikiDb.agenda(listOf(r), DUE, month.atDay(1), month.atEndOfMonth(), NEW_YORK).map { it.day.toString() },
        )
        // A date without time is the day written, whatever the zone.
        assertEquals(LocalDate.of(2026, 10, 7), WikiDb.dayOf("2026-10-07", NEW_YORK))
        // The server is asked one day more on each side.
        assertEquals(DbRange("due", LocalDate.of(2026, 9, 30), LocalDate.of(2026, 11, 1)), WikiDb.monthRange(DUE, month))
        // The calendar's property: the view's, else the first date.
        assertEquals("due", WikiDb.datePropOf(database(), DbView("v", type = "calendar"))?.id)
        assertEquals("made", WikiDb.datePropOf(database(), DbView("v", type = "calendar", datePropId = "made"))?.id)
        assertEquals("due", WikiDb.datePropOf(database(), DbView("v", type = "calendar", datePropId = "stage"))?.id)
    }

    // --- values sent ----------------------------------------------------------------------------------------------

    @Test
    fun valuesAreEncodedPerType() {
        assertEquals(JsonPrimitive("メモ"), WikiDb.encodeText("  メモ "))
        assertEquals(JsonNull, WikiDb.encodeText("   "))
        assertEquals(1200.0, WikiDb.parseNumber("¥1,200")!!, 0.0)
        assertEquals(0.5, WikiDb.parseNumber("50%")!!, 1e-9)
        assertEquals(-3.25, WikiDb.parseNumber(" -3.25 ")!!, 0.0)
        assertNull(WikiDb.parseNumber("abc"))
        assertNull(WikiDb.parseNumber("1e400"))
        assertEquals(JsonPrimitive(12.5), WikiDb.encodeNumber(12.5))
        assertEquals(JsonNull, WikiDb.encodeNumber(null))
        assertEquals(JsonPrimitive("https://example.com/a"), WikiDb.encodeUrl(" https://example.com/a "))
        assertNull(WikiDb.encodeUrl("ftp://example.com"))
        assertNull(WikiDb.encodeUrl("example.com"))
        assertEquals(JsonNull, WikiDb.encodeUrl(""))
        assertEquals(JsonPrimitive("o1"), WikiDb.encodeSelect("o1"))
        assertEquals(JsonNull, WikiDb.encodeSelect(null))
        assertEquals(JsonArray(listOf(JsonPrimitive("t1"), JsonPrimitive("t2"))), WikiDb.encodeIds(listOf("t1", "t2", "t1")))
        assertEquals(JsonNull, WikiDb.encodeIds(emptyList()))
        // A relation is always a list (the server keeps the hidden links).
        assertEquals(JsonArray(emptyList()), WikiDb.encodeRelation(emptyList()))
        assertEquals(JsonPrimitive(false), WikiDb.encodeCheckbox(false))
    }

    @Test
    fun datesAreDaysOrTimesAtThisDevicesOffset() {
        val d = LocalDate.of(2026, 10, 7)
        assertEquals("""{"start":"2026-10-07","end":null,"time":false}""", WikiDb.encodeDate(d, null, null, null, TOKYO).toString())
        assertEquals("""{"start":"2026-10-07","end":"2026-10-09","time":false}""", WikiDb.encodeDate(d, d.plusDays(2), null, null, TOKYO).toString())
        // An end that is not after the start is no range.
        assertEquals("""{"start":"2026-10-07","end":null,"time":false}""", WikiDb.encodeDate(d, d, null, null, TOKYO).toString())
        assertEquals(
            """{"start":"2026-10-07T09:30:00+09:00","end":null,"time":true}""",
            WikiDb.encodeDate(d, null, LocalTime.of(9, 30), null, TOKYO).toString(),
        )
        // The end's time defaults to the start's; New York is on summer time in October.
        assertEquals(
            """{"start":"2026-10-07T09:30:00-04:00","end":"2026-10-08T09:30:00-04:00","time":true}""",
            WikiDb.encodeDate(d, d.plusDays(1), LocalTime.of(9, 30), null, NEW_YORK).toString(),
        )
        // And back for the editor, in this device's zone.
        val parts = WikiDb.dateParts(DbDateValue("2026-10-07T00:30:00+00:00", "2026-10-07T03:00:00+00:00", true), TOKYO, d)
        assertEquals(WikiDb.DateParts(d, d, LocalTime.of(9, 30), LocalTime.of(12, 0)), parts)
        assertEquals(WikiDb.DateParts(d, null, null, null), WikiDb.dateParts(null, TOKYO, d))
        assertEquals(DbDateValue("2026-10-07", null, false), WikiDb.asDate(day("2026-10-07")))
    }

    // --- relations I cannot read ----------------------------------------------------------------------------------

    @Test
    fun hiddenRelationsAreOneChipWithNoIdOrCount() {
        val refs = mapOf("p1" to DbRowRef("p1", "db2", "論文 A", "📄"))
        val r = row("r1", relations = mapOf("papers" to listOf("p1", "p9")), hidden = listOf("papers"))
        val chips = RelationChips.of(PAPERS, r, refs, "無題")
        assertEquals(listOf(RelationChip.Row("p1", "論文 A", "📄"), RelationChip.Row("p9", "無題", null), RelationChip.Hidden), chips)
        assertEquals(1, chips.count { it == RelationChip.Hidden })
        assertEquals("論文 A, 無題, アクセスできないページ", WikiDb.cellText(PAPERS, r, ctx(refs = refs)))
        // Only hidden links: just the one chip.
        assertEquals(listOf(RelationChip.Hidden), RelationChips.of(PAPERS, row("r2", hidden = listOf("papers")), refs, "無題"))
        assertTrue(RelationChips.of(PAPERS, row("r3"), refs, "無題").isEmpty())
        // The answer's shape decodes (relations and hidden_relations, values as JSON).
        val decoded = Codec.snake.decodeFromString(
            DbRow.serializer(),
            """{"id":"r1","database_id":"db1","title":"t","icon":null,"position":"a","version":2,"head_rev_id":"h","props":{"due":{"start":"2026-10-07","end":null,"time":false},"price":12},"relations":{"papers":["p1"]},"hidden_relations":["papers"],"created_at":"x","created_by":"u1","updated_at":"x","updated_by":"u1"}""",
        )
        assertEquals(listOf("papers"), decoded.hiddenRelations)
        assertEquals(12.0, WikiDb.number(decoded.props["price"])!!, 0.0)
        assertEquals("2026-10-07", WikiDb.asDate(decoded.props["due"])?.start)
    }

    // --- levels ---------------------------------------------------------------------------------------------------

    @Test
    fun levelRules() {
        assertFalse(WikiDb.canEditRows("view"))
        assertTrue(WikiDb.canEditRows("edit"))
        assertTrue(WikiDb.canEditRows("full"))
        assertFalse(WikiDb.canEditRows(null))
        assertTrue(WikiDb.canEditCell("edit", STAGE))
        assertTrue(WikiDb.canEditCell("edit", PAPERS))
        assertFalse(WikiDb.canEditCell("edit", MADE))
        assertFalse(WikiDb.canEditCell("view", STAGE))
    }

    @Test
    fun aViewOnlyRowSendsNothing() = runBlocking {
        val api = FakeWikiDbApi().apply { db = database(level = "view") }
        val session = RowSession("r1", api, scope, options())
        session.refresh()
        assertFalse(session.editable)
        assertFalse(session.save("stage", JsonPrimitive("o1")))
        assertTrue(api.ops.isEmpty())
    }

    // --- saving a cell --------------------------------------------------------------------------------------------

    @Test
    fun aCellIsSentAgainWithTheSameOpIdAfterANetworkFailure() = runBlocking {
        val api = FakeWikiDbApi()
        val session = RowSession("r1", api, scope, options())
        session.refresh()
        api.failures.add(ApiException.Network(IOException("offline")))
        assertTrue(session.save("stage", JsonPrimitive("o1")))
        assertEquals(2, api.ops.size)
        assertEquals(api.ops[0].second, api.ops[1].second)
        assertEquals("""{"stage":"o1"}""", api.ops[0].first.toString())
        assertEquals(JsonPrimitive("o1"), session.detail!!.row.props["stage"])
        // The next change is another operation.
        assertTrue(session.save("done", JsonPrimitive(true)))
        assertTrue(api.ops[2].second != api.ops[0].second)
        assertTrue(session.saving.isEmpty())
    }

    @Test
    fun aRefusedCellGoesBackAndIsReported() = runBlocking {
        val errors = ArrayList<Throwable>()
        val api = FakeWikiDbApi()
        api.detail = DbRowDetail(row("r1", props = mapOf("note" to JsonPrimitive("前")), relations = mapOf("papers" to listOf("p1"))), api.db, "研究")
        val session = RowSession("r1", api, scope, options(), onError = { errors.add(it) })
        session.refresh()
        api.failures.add(ApiException.Api(422, "wiki_invalid_property_value", "bad"))
        assertFalse(session.save("note", JsonPrimitive("後")))
        assertEquals(1, api.ops.size) // a refusal is not sent again
        assertEquals(JsonPrimitive("前"), session.detail!!.row.props["note"])
        api.failures.add(ApiException.Api(422, "wiki_invalid_property_value", "bad"))
        assertFalse(session.save("papers", WikiDb.encodeRelation(emptyList())))
        assertEquals(listOf("p1"), session.detail!!.row.relations["papers"])
        assertEquals(2, errors.size)
        // A relation set locally replaces the readable links; the title goes to the row's title.
        assertTrue(session.save("papers", WikiDb.encodeRelation(listOf("p2"))))
        assertEquals(listOf("p2"), session.detail!!.row.relations["papers"])
        assertTrue(session.save("title", JsonPrimitive("新しい題")))
        assertEquals("新しい題", session.detail!!.row.title)
        // Clearing a cell removes it.
        assertTrue(session.save("note", JsonNull))
        assertNull(session.detail!!.row.props["note"])
    }

    // --- the database ---------------------------------------------------------------------------------------------

    @Test
    fun aTableReadsPagesAndTheLastDatabaseIsKeptForOffline() = runBlocking {
        val disk = MemoryPersistence()
        val api = FakeWikiDbApi()
        val session = DatabaseSession("db1", api, Store(disk), scope, options())
        session.refresh()
        assertEquals(listOf("database db1", "query v1 -"), api.calls)
        assertEquals(Triple("v1", null, DatabaseSession.PAGE), api.queries.single())
        assertEquals(listOf("r1", "r2"), session.rows.map { it.id })
        assertEquals("o:1", session.nextCursor)
        api.rows = listOf(row("r2"), row("r3"))
        session.loadMore()
        assertEquals(listOf("r1", "r2", "r3"), session.rows.map { it.id })
        assertNotNull(disk.meta[WIKI_DB_KEY])

        // Restarted offline: the kept rows show, marked as the copy from when they were read.
        val again = Store(disk).also { it.load() }
        val offline = DatabaseSession("db1", FakeWikiDbApi().apply { failures.add(ApiException.Network(IOException("offline"))) }, again, scope, options())
        assertEquals(listOf("r1", "r2"), offline.rows.map { it.id })
        assertEquals(5_000L, offline.offlineSince)
        offline.refresh()
        assertNotNull(offline.loadError)
        assertEquals(listOf("r1", "r2"), offline.rows.map { it.id })
        // Another database starts empty.
        assertTrue(DatabaseSession("db9", api, again, scope, options()).rows.isEmpty())
    }

    @Test
    fun aCalendarAsksForItsMonthAndANewRowTakesTheDay() = runBlocking {
        val api = FakeWikiDbApi().apply { db = database(views = listOf(DbView("v1"), DbView("cal", type = "calendar", datePropId = "due"))) }
        val session = DatabaseSession("db1", api, null, scope, options(today = LocalDate.of(2026, 10, 7)))
        session.refresh()
        session.selectView("cal")
        val (view, asked, limit) = api.queries.last()
        assertEquals("cal", view)
        assertEquals(DbRange("due", LocalDate.of(2026, 9, 30), LocalDate.of(2026, 11, 1)), asked)
        assertEquals(1000, limit)
        // In this month: today; in another month: its first day. A network failure sends the same key again.
        session.createRow("実験")
        assertEquals("2026-10-07", api.creates.last().first["due"]!!.jsonObject["start"]!!.jsonPrimitive.content)
        session.moveMonth(1)
        assertEquals(DbRange("due", LocalDate.of(2026, 10, 31), LocalDate.of(2026, 12, 1)), api.queries.last().second)
        api.failures.add(ApiException.Network(IOException("offline")))
        session.createRow("次")
        assertEquals("2026-11-01", api.creates.last().first["due"]!!.jsonObject["start"]!!.jsonPrimitive.content)
        assertEquals(api.creates[api.creates.size - 1].second, api.creates[api.creates.size - 2].second)
        // A table's new row has no date.
        session.selectView("v1")
        session.createRow("表の行")
        assertTrue(api.creates.last().first.isEmpty())
    }
}
