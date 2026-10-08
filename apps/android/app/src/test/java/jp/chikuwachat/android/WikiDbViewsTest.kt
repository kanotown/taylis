package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DatabaseOut
import jp.chikuwachat.android.api.DbGroupBy
import jp.chikuwachat.android.api.DbOption
import jp.chikuwachat.android.api.DbProperty
import jp.chikuwachat.android.api.DbRow
import jp.chikuwachat.android.api.DbRowGroup
import jp.chikuwachat.android.api.DbRowQueryOut
import jp.chikuwachat.android.api.DbView
import jp.chikuwachat.android.sync.DatabaseSession
import jp.chikuwachat.android.sync.DbCellContext
import jp.chikuwachat.android.sync.DbGroupWords
import jp.chikuwachat.android.sync.DbQueryOptions
import jp.chikuwachat.android.sync.DbRange
import jp.chikuwachat.android.sync.DbViewWords
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.WikiDb
import jp.chikuwachat.android.sync.WikiDbOptions
import jp.chikuwachat.android.sync.WikiDbViews
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

private val TOKYO = ZoneId.of("Asia/Tokyo")
private val TITLE_P = DbProperty("title", "", "title")
private val STAGE = DbProperty(
    "stage", "段階", "select",
    options = listOf(DbOption("o1", "未着手", "gray"), DbOption("o2", "進行中", "blue"), DbOption("o3", "完了", "green")),
)
private val TAGS = DbProperty("tags", "タグ", "multi_select", options = listOf(DbOption("t1", "ML"), DbOption("t2", "HCI")))
private val WHO = DbProperty("who", "担当", "person")
private val DONE = DbProperty("done", "完了", "checkbox")
private val DUE = DbProperty("due", "締切", "date")
private val NOTE = DbProperty("note", "メモ", "text")
private val MADE = DbProperty("made", "作成日時", "created_time")

private val BOARD = DbView("b1", type = "board", groupBy = DbGroupBy("stage"))

private fun db(level: String = "edit", views: List<DbView> = listOf(BOARD)) = DatabaseOut(
    pageId = "db1", schemaVersion = 4, properties = listOf(TITLE_P, STAGE, TAGS, WHO, DONE, DUE, NOTE, MADE), views = views, myLevel = level,
)

private fun r(id: String, props: Map<String, JsonElement> = emptyMap()) =
    DbRow(id = id, databaseId = "db1", title = id, props = props, createdBy = "u1", updatedBy = "u1")

private fun people(vararg ids: String) = JsonArray(ids.map(::JsonPrimitive))

private val CTX = DbCellContext(
    names = { mapOf("u1" to "加納", "u2" to "海老").getValue(it) }, refs = emptyMap(), hidden = "アクセスできないページ",
    untitled = "無題", zone = TOKYO, locale = Locale.JAPAN,
)

private val WORDS = DbGroupWords(none = "なし", checked = "オン", unchecked = "オフ", weekOf = { "$it の週" }, monthPattern = "y年M月")

/** A board by stage: o1 [r1], o2 [r2, r3], o3 hidden, "" [r4]. */
private fun boardAnswer() = DbRowQueryOut(
    rows = listOf(
        r("r1", mapOf("stage" to JsonPrimitive("o1"))), r("r2", mapOf("stage" to JsonPrimitive("o2"))),
        r("r3", mapOf("stage" to JsonPrimitive("o2"))), r("r4"),
    ),
    total = 4, schemaVersion = 4,
    groups = listOf(DbRowGroup("o1", 1, false), DbRowGroup("o2", 2, false), DbRowGroup("o3", 5, true), DbRowGroup("", 1, false)),
    rowGroups = listOf("o1", "o2", "o2", ""),
)

/**
 * M148 (docs/WIKI.md §25.4): the view types on the phone — the shapes read (and an older server's), the names of
 * unnamed views, what a query asks, the sections and their names, a board card's move (the values, one op id
 * however many tries, put back on a refusal, edit only), folding, and paging a grouped view.
 */
class WikiDbViewsTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private var ids = 0
    private fun options() = WikiDbOptions(newId = { "op${++ids}" }, retryWait = {}, zone = { TOKYO }, today = { LocalDate.of(2026, 10, 8) }, now = { 7_000L })

    // --- shapes -----------------------------------------------------------------------------------------------------

    @Test
    fun viewsAnswersAndCoversDecode() {
        val view = Codec.snake.decodeFromString(
            DbView.serializer(),
            """{"id":"b1","name":"","type":"board","columns":[],"sort":[],"filter":null,"date_prop_id":null,
               "group_by":{"prop_id":"stage","date_unit":null,"hidden":["o3"],"hide_empty":true},"cover":"none","card_size":"large"}""",
        )
        assertEquals(DbGroupBy("stage", null, listOf("o3"), true), view.groupBy)
        assertEquals("none", view.cover)
        assertEquals("large", view.cardSize)
        val answer = Codec.snake.decodeFromString(
            DbRowQueryOut.serializer(),
            """{"rows":[{"id":"r1","database_id":"db1","title":"A","icon":null,"position":"a0","version":1,"head_rev_id":"h",
               "props":{},"relations":{},"hidden_relations":[],"created_at":"2026-10-08T00:00:00Z","created_by":"u1",
               "updated_at":"2026-10-08T00:00:00Z","updated_by":"u1",
               "cover":{"attachment_id":"a1","thumbnail":true,"width":800,"height":600}}],
               "refs":[],"total":1,"next_cursor":null,"schema_version":4,
               "groups":[{"key":"o1","count":1,"hidden":false},{"key":"","count":0,"hidden":false}],"row_groups":["o1"]}""",
        )
        assertEquals(listOf(DbRowGroup("o1", 1, false), DbRowGroup("", 0, false)), answer.groups)
        assertEquals(listOf("o1"), answer.rowGroups)
        assertEquals("a1", answer.rows.single().cover!!.attachmentId)
        assertTrue(answer.rows.single().cover!!.thumbnail)
        // A server before M147: no groups, no covers, a view without the new keys.
        val old = Codec.snake.decodeFromString(DbRowQueryOut.serializer(), """{"rows":[],"refs":[],"total":0,"next_cursor":null,"schema_version":1}""")
        assertNull(old.groups)
        assertNull(old.rowGroups)
        val plain = Codec.snake.decodeFromString(DbView.serializer(), """{"id":"v1","type":"table"}""")
        assertNull(plain.groupBy)
        assertEquals("body", plain.cover)
    }

    @Test
    fun unnamedViewsAreCalledByTheirType() {
        val words = DbViewWords("表", "ボード", "リスト", "ギャラリー", "カレンダー")
        assertEquals("ボード", WikiDbViews.name(DbView("b", type = "board"), words))
        assertEquals("リスト", WikiDbViews.name(DbView("l", type = "list"), words))
        assertEquals("ギャラリー", WikiDbViews.name(DbView("g", type = "gallery"), words))
        assertEquals("カレンダー", WikiDbViews.name(DbView("c", type = "calendar"), words))
        assertEquals("表", WikiDbViews.name(DbView("t"), words))
        // A type this app does not know reads as a table; a name always wins.
        assertEquals("表", WikiDbViews.name(DbView("x", type = "timeline"), words))
        assertEquals("table", WikiDbViews.kind(DbView("x", type = "timeline")))
        assertEquals("進み", WikiDbViews.name(DbView("b", name = "進み", type = "board"), words))
    }

    @Test
    fun aQueryAsksForGroupsTheZoneAndAGallerysPictures() {
        assertEquals(DbQueryOptions(grouped = true, covers = false, tz = "Asia/Tokyo"), WikiDbViews.queryOptions(BOARD, TOKYO))
        assertEquals(DbQueryOptions(grouped = true, covers = false, tz = "Asia/Tokyo"), WikiDbViews.queryOptions(DbView("t"), TOKYO))
        assertEquals(DbQueryOptions(grouped = true, covers = true, tz = "Asia/Tokyo"), WikiDbViews.queryOptions(DbView("g", type = "gallery"), TOKYO))
        assertEquals(DbQueryOptions(grouped = true, covers = false, tz = "Asia/Tokyo"), WikiDbViews.queryOptions(DbView("g", type = "gallery", cover = "none"), TOKYO))
        assertEquals(DbQueryOptions(), WikiDbViews.queryOptions(DbView("c", type = "calendar"), TOKYO))
        assertEquals(
            """{"view_id":"g","cursor":"o:1000","limit":1000,"grouped":true,"covers":true,"tz":"Asia/Tokyo"}""",
            WikiDbViews.queryBody("g", null, "o:1000", 1000, DbQueryOptions(true, true, "Asia/Tokyo")).toString(),
        )
        // A calendar's body is as before M148.
        assertEquals(
            """{"view_id":"c","range":{"prop_id":"due","start":"2026-09-30","end":"2026-11-01"},"limit":1000}""",
            WikiDbViews.queryBody("c", DbRange("due", LocalDate.of(2026, 9, 30), LocalDate.of(2026, 11, 1)), null, 1000).toString(),
        )
    }

    // --- sections and names ----------------------------------------------------------------------------------------

    @Test
    fun sectionsFollowTheGroupsWithoutHiddenOnes() {
        val a = boardAnswer()
        val sections = WikiDbViews.sections(a.rows, a.rowGroups, a.groups)!!
        assertEquals(listOf("o1", "o2", ""), sections.map { it.key })
        assertEquals(listOf(1, 2, 1), sections.map { it.count })
        assertEquals(listOf("r2", "r3"), sections[1].rows.map { it.id })
        // An empty group still shows (a board's empty column); a row with several values is in each of its groups.
        val multi = WikiDbViews.sections(
            listOf(r("r1"), r("r1"), r("r2")), listOf("t1", "t2", "t2"),
            listOf(DbRowGroup("t1", 1, false), DbRowGroup("t2", 2, false), DbRowGroup("", 0, false)),
        )!!
        assertEquals(listOf(listOf("r1"), listOf("r1", "r2"), emptyList()), multi.map { s -> s.rows.map { it.id } })
        // Not grouped: no group_by (groups empty), an older server (null), a mismatch.
        assertNull(WikiDbViews.sections(a.rows, emptyList(), emptyList()))
        assertNull(WikiDbViews.sections(a.rows, null, null))
        assertNull(WikiDbViews.sections(a.rows, listOf("o1"), a.groups))
    }

    @Test
    fun groupsAreNamedFromOptionsPeopleCheckboxesAndDates() {
        assertEquals("進行中", WikiDbViews.groupLabel(STAGE, "o2", null, CTX, WORDS))
        assertEquals("なし", WikiDbViews.groupLabel(STAGE, "", null, CTX, WORDS))
        assertEquals("なし", WikiDbViews.groupLabel(STAGE, "gone", null, CTX, WORDS))
        assertEquals("HCI", WikiDbViews.groupLabel(TAGS, "t2", null, CTX, WORDS))
        assertEquals("海老", WikiDbViews.groupLabel(WHO, "u2", null, CTX, WORDS))
        assertEquals("なし", WikiDbViews.groupLabel(WHO, "", null, CTX, WORDS))
        assertEquals("オン", WikiDbViews.groupLabel(DONE, "true", null, CTX, WORDS))
        assertEquals("オフ", WikiDbViews.groupLabel(DONE, "false", null, CTX, WORDS))
        assertEquals("2026/10/08", WikiDbViews.groupLabel(DUE, "2026-10-08", null, CTX, WORDS))
        assertEquals("2026/10/08", WikiDbViews.groupLabel(DUE, "2026-10-08", "day", CTX, WORDS))
        assertEquals("2026/10/05 の週", WikiDbViews.groupLabel(DUE, "2026-10-05", "week", CTX, WORDS))
        assertEquals("2026年10月", WikiDbViews.groupLabel(MADE, "2026-10", "month", CTX, WORDS))
        assertEquals("なし", WikiDbViews.groupLabel(DUE, "", "week", CTX, WORDS))
        assertEquals("なし", WikiDbViews.groupLabel(null, "o1", null, CTX, WORDS))
        assertEquals("blue", WikiDbViews.groupColor(STAGE, "o2"))
        assertNull(WikiDbViews.groupColor(STAGE, ""))
        assertNull(WikiDbViews.groupColor(WHO, "u1"))
    }

    // --- moving a card -----------------------------------------------------------------------------------------------

    @Test
    fun aMoveWritesTheGroupsValue() {
        val row = r("r1", mapOf("stage" to JsonPrimitive("o1"), "who" to people("u1", "u2"), "done" to JsonPrimitive(false)))
        assertEquals("""{"stage":"o2"}""", WikiDbViews.moveSet(STAGE, row, "o1", "o2").toString())
        assertEquals("""{"stage":null}""", WikiDbViews.moveSet(STAGE, row, "o1", "").toString())
        assertEquals("""{"done":true}""", WikiDbViews.moveSet(DONE, row, "false", "true").toString())
        assertEquals("""{"done":false}""", WikiDbViews.moveSet(DONE, row, "true", "false").toString())
        // A person: the one of the old column goes, the one of the new column comes; 「なし」 clears.
        assertEquals("""{"who":["u2","u3"]}""", WikiDbViews.moveSet(WHO, row, "u1", "u3").toString())
        assertEquals("""{"who":["u2"]}""", WikiDbViews.moveSet(WHO, row, "u1", "u2").toString())
        assertEquals("""{"who":null}""", WikiDbViews.moveSet(WHO, row, "u1", "").toString())
        assertEquals("""{"who":["u4"]}""", WikiDbViews.moveSet(WHO, r("r2"), "", "u4").toString())
        assertNull(WikiDbViews.moveSet(TAGS, row, "t1", "t2"))
        assertEquals("""{"set":{"stage":"o2"},"client_op_id":"k1"}""", WikiDbViews.moveBody(WikiDbViews.moveSet(STAGE, row, "o1", "o2")!!, "k1").toString())
        assertEquals(listOf("o2", ""), WikiDbViews.moveTargets(WikiDbViews.sections(boardAnswer().rows, boardAnswer().rowGroups, boardAnswer().groups)!!, "o1"))
    }

    @Test
    fun onlyEditorsMoveCardsOfABoardBySelectPersonOrCheckbox() {
        assertTrue(WikiDbViews.canMove(db(), BOARD))
        assertTrue(WikiDbViews.canMove(db("full"), BOARD))
        assertFalse(WikiDbViews.canMove(db("view"), BOARD))
        assertFalse(WikiDbViews.canMove(db("comment"), BOARD))
        assertTrue(WikiDbViews.canMove(db(), DbView("b", type = "board", groupBy = DbGroupBy("who"))))
        assertTrue(WikiDbViews.canMove(db(), DbView("b", type = "board", groupBy = DbGroupBy("done"))))
        assertFalse(WikiDbViews.canMove(db(), DbView("b", type = "board", groupBy = DbGroupBy("tags"))))
        assertFalse(WikiDbViews.canMove(db(), DbView("b", type = "board")))
        assertFalse(WikiDbViews.canMove(db(), DbView("t", groupBy = DbGroupBy("stage"))))
        assertFalse(WikiDbViews.canMove(db(), DbView("b", type = "board", groupBy = DbGroupBy("deleted"))))
    }

    @Test
    fun aMoveShowsAtOnceRetriesWithTheSameIdAndReadsAgain() = runBlocking {
        val api = FakeWikiDbApi().apply { db = db(); answer = { boardAnswer() } }
        val session = DatabaseSession("db1", api, null, scope, options())
        session.refresh()
        assertEquals(DbQueryOptions(true, false, "Asia/Tokyo"), api.queryOptions.single())
        assertEquals(WikiDbViews.GROUPED_PAGE, api.queries.single().third)
        assertEquals(listOf("o1", "o2", ""), session.sections!!.map { it.key })

        // The server answers the move after two network failures; every try carries one op id.
        api.failures.add(ApiException.Network(IOException("offline")))
        api.failures.add(ApiException.Network(IOException("offline")))
        var seen: List<String>? = null
        api.answer = {
            seen = seen ?: session.sections!!.first { it.key == "o2" }.rows.map { it.id }
            boardAnswer()
        }
        session.moveRow("r1", "o1", "o2")
        assertEquals(3, api.moves.size)
        assertEquals(1, api.moves.map { it.third }.distinct().size)
        assertEquals("""{"stage":"o2"}""", api.moves.first().second.toString())
        // Before the view was read again the card was already in its new group, in the rows' own order (the server
        // keeps the row's place).
        assertEquals(listOf("r1", "r2", "r3"), seen)
        assertEquals(listOf("database db1", "query b1 -", "move r1", "move r1", "move r1", "database db1", "query b1 -"), api.calls)
        assertTrue(session.moving.isEmpty())
    }

    @Test
    fun aRefusedMoveGoesBack() = runBlocking {
        val api = FakeWikiDbApi().apply { db = db(); answer = { boardAnswer() } }
        val session = DatabaseSession("db1", api, null, scope, options())
        session.refresh()
        api.failures.add(ApiException.Api(403, "page_edit_restricted", "no"))
        try {
            session.moveRow("r2", "o2", "")
            fail("a refusal is thrown")
        } catch (e: ApiException.Api) {
            assertEquals("page_edit_restricted", e.code)
        }
        assertEquals(1, api.moves.size) // not sent again
        assertEquals(listOf(listOf("r1"), listOf("r2", "r3"), listOf("r4")), session.sections!!.map { s -> s.rows.map { it.id } })
        assertEquals(listOf(1, 2, 1), session.sections!!.map { it.count })
        assertEquals(JsonPrimitive("o2"), session.rows[1].props["stage"])
        // A reader cannot move at all (nothing is sent).
        val reader = DatabaseSession("db1", FakeWikiDbApi().apply { db = db("view"); answer = { boardAnswer() } }, null, scope, options())
        reader.refresh()
        reader.moveRow("r1", "o1", "o2")
        assertEquals(listOf("o1", "o2", "o2", ""), reader.rowGroups)
    }

    @Test
    fun aPersonsCardAlreadyInTheTargetGroupIsShownThereOnce() = runBlocking {
        val view = DbView("b2", type = "board", groupBy = DbGroupBy("who"))
        val both = r("r1", mapOf("who" to people("u1", "u2")))
        val api = FakeWikiDbApi().apply {
            db = db(views = listOf(view))
            answer = { DbRowQueryOut(listOf(both, both), total = 2, groups = listOf(DbRowGroup("u1", 1, false), DbRowGroup("u2", 1, false)), rowGroups = listOf("u1", "u2")) }
        }
        val session = DatabaseSession("db1", api, null, scope, options())
        session.refresh()
        var during: List<List<String>>? = null
        var counts: List<Int>? = null
        api.answer = {
            if (during == null) {
                during = session.sections!!.map { s -> s.rows.map { it.id } }
                counts = session.sections!!.map { it.count }
            }
            DbRowQueryOut(listOf(r("r1", mapOf("who" to people("u2")))), total = 1, groups = listOf(DbRowGroup("u1", 0, false), DbRowGroup("u2", 1, false)), rowGroups = listOf("u2"))
        }
        session.moveRow("r1", "u1", "u2")
        assertEquals("""{"who":["u2"]}""", api.moves.single().second.toString())
        assertEquals(listOf(emptyList(), listOf("r1")), during)
        assertEquals(listOf(0, 1), counts)
    }

    // --- folding, paging, the copy kept -------------------------------------------------------------------------------

    @Test
    fun sectionsFoldPerViewAndAGroupedViewPagesWithoutLosingRepeats() = runBlocking {
        val list = DbView("l1", type = "list", groupBy = DbGroupBy("tags"))
        val disk = MemoryPersistence()
        val api = FakeWikiDbApi().apply {
            db = db(views = listOf(list, BOARD))
            answer = { cursor ->
                val groups = listOf(DbRowGroup("t1", 2, false), DbRowGroup("t2", 2, false))
                if (cursor == null) DbRowQueryOut(listOf(r("r1"), r("r2")), total = 4, nextCursor = "o:2", groups = groups, rowGroups = listOf("t1", "t1"))
                // The next page repeats r1 in another group (once in each of its groups) and r2 in its own (a repeat).
                else DbRowQueryOut(listOf(r("r2"), r("r1"), r("r3")), total = 4, groups = groups, rowGroups = listOf("t1", "t2", "t2"))
            }
        }
        val session = DatabaseSession("db1", api, Store(disk), scope, options())
        session.refresh()
        session.loadMore()
        assertEquals(listOf(listOf("r1", "r2"), listOf("r1", "r3")), session.sections!!.map { s -> s.rows.map { it.id } })
        assertEquals(listOf("o:2"), api.calls.filter { it.startsWith("query") }.map { it.split(" ")[2] }.drop(1))

        session.toggleSection("t1")
        assertTrue(session.isCollapsed("t1"))
        assertFalse(session.isCollapsed("t2"))
        session.selectView("b1")
        assertFalse(session.isCollapsed("t1")) // another view has its own
        session.selectView("l1")
        assertTrue(session.isCollapsed("t1"))
        session.toggleSection("t1")
        assertFalse(session.isCollapsed("t1"))

        // The copy kept for offline reading has the groups too.
        val again = Store(disk).also { it.load() }
        val offline = DatabaseSession("db1", api, again, scope, options())
        assertTrue(offline.sections != null)
    }
}
