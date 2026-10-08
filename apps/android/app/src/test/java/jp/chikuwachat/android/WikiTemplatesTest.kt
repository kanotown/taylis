package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DatabaseOut
import jp.chikuwachat.android.api.DbProperty
import jp.chikuwachat.android.api.DbRow
import jp.chikuwachat.android.api.DbTemplateRef
import jp.chikuwachat.android.api.PageDuplicateOut
import jp.chikuwachat.android.api.PageOut
import jp.chikuwachat.android.api.WikiTemplatesOut
import jp.chikuwachat.android.sync.DatabaseSession
import jp.chikuwachat.android.sync.DbCellContext
import jp.chikuwachat.android.sync.DuplicateOutcome
import jp.chikuwachat.android.sync.PageTemplateChoice
import jp.chikuwachat.android.sync.RowTemplateChoice
import jp.chikuwachat.android.sync.TemplateBanner
import jp.chikuwachat.android.sync.WikiDb
import jp.chikuwachat.android.sync.WikiDbOptions
import jp.chikuwachat.android.sync.WikiTemplates
import jp.chikuwachat.android.sync.WikiTemplatesApi
import jp.chikuwachat.android.ui.TemplatePick
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.time.ZoneId
import java.util.Locale

/** M146 (docs/WIKI.md §24.3): templates and duplicating on the phone — the shapes, the requests and the screens' rules. */
class WikiTemplatesTest {
    private class Seen(val method: String, val path: String, val body: JsonObject?)

    private val seen = ArrayList<Seen>()

    private fun client(answer: (String) -> Pair<Int, String>): ApiClient {
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val raw = request.body?.let { Buffer().also { buffer -> it.writeTo(buffer) }.readUtf8() }
            seen.add(Seen(request.method, request.url.encodedPath, raw?.takeIf { it.isNotEmpty() }?.let { Codec.plain.parseToJsonElement(it).jsonObject }))
            val (status, body) = answer(request.url.encodedPath)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("stub")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()
        return ApiClient("http://server", http).also { it.accessToken = "t" }
    }

    private fun pageJson(id: String = "p1", kind: String = "page", template: Boolean = false, parent: String? = null) =
        """{"id":"$id","parent_id":${parent?.let { "\"$it\"" } ?: "null"},"position":"a0","kind":"$kind","title":"週報","icon":"🗒","version":1,
        "head_rev_id":"r1","meta_seq":7,"inherit_access":true,"task_total":0,"task_done":0,"created_by":"u1","updated_by":"u1",
        "created_at":"2026-10-08T00:00:00Z","updated_at":"2026-10-08T00:00:00Z","my_level":"full","private":false,"is_template":$template,
        "body":"## {{date}}","breadcrumbs":[],"children":[]}"""

    private val rowJson = """{"row":{"id":"r9","database_id":"db1","title":"実験","icon":null,"position":"a","version":1,"head_rev_id":"r1",
        "props":{"due":{"start":"2026-10-08","end":null,"time":false}},"relations":{},"hidden_relations":[],"created_at":"","created_by":"u1",
        "updated_at":"","updated_by":"u1"},"refs":[]}"""

    // --- decoding --------------------------------------------------------------------------------------------------

    @Test
    fun theShapesDecode() = runBlocking {
        val api = client { path ->
            when {
                path.endsWith("/wiki/templates") -> 200 to """{"pages":[${pageJson("t1", template = true).replace("\"breadcrumbs\":[],\"children\":[]", "\"x\":1")}],
                    "builtins":[{"id":"b1","key":"weekly","name":"週報","description":"毎週の報告","title":"週報 {{week}}","body":"","position":2,"builtin":true,"hidden":false,"updated_at":"2026-10-01T00:00:00Z"},
                    {"id":"b2","key":"minutes","name":"議事録","description":null,"title":"","body":"","position":1,"builtin":true,"hidden":false}]}"""
                path.endsWith("/databases/db1") -> 200 to """{"page_id":"db1","schema_version":3,"properties":[],"views":[],"my_level":"edit","row_count":0,
                    "limits":{"rows":5000,"properties":100,"options":200,"views":20},"templates":[{"id":"t1","title":"実験ノート","icon":"🧪"},{"id":"t2","title":"","icon":null}],
                    "default_template_id":"t2"}"""
                path.endsWith("/duplicate") -> 201 to """{"page":${pageJson("r9", kind = "row", parent = "db1")},"row":$rowJson}"""
                else -> 200 to pageJson(template = true)
            }
        }
        val gallery = api.wikiTemplates()
        assertTrue(gallery.pages.single().isTemplate)
        assertEquals(listOf("weekly", "minutes"), gallery.builtins.map { it.key })
        val db = api.wikiDatabase("db1")
        assertEquals(listOf(DbTemplateRef("t1", "実験ノート", "🧪"), DbTemplateRef("t2", "", null)), db.templates)
        assertEquals("t2", db.defaultTemplateId)
        val page = api.wikiPage("p1", null)!!
        assertTrue(page.isTemplate)
        assertTrue(page.item.isTemplate)
        val copy = api.duplicateWikiPage("r1", topLevel = false, clientSaveId = "k")
        assertEquals("row", copy.page.kind)
        assertEquals("r9", copy.row!!.row.id)
        // An older server: no is_template, no templates — nothing breaks.
        val old = Codec.snake.decodeFromString(DatabaseOut.serializer(), """{"page_id":"db1","schema_version":1,"properties":[],"views":[],"my_level":"view"}""")
        assertTrue(old.templates.isEmpty())
        assertNull(old.defaultTemplateId)
        assertFalse(Codec.snake.decodeFromString(PageOut.serializer(), """{"id":"p"}""").isTemplate)
    }

    @Test
    fun theGalleryLeavesOutHiddenBuiltinsAndSortsThem() {
        val out = Codec.snake.decodeFromString(
            WikiTemplatesOut.serializer(),
            """{"pages":[],"builtins":[{"id":"1","key":"b","name":"B","position":2},{"id":"2","key":"h","name":"H","position":0,"hidden":true},{"id":"3","key":"a","name":"A","position":1}]}""",
        )
        val gallery = WikiTemplates.gallery(out)
        assertEquals(listOf("a", "b"), gallery.builtins.map { it.key })
        assertFalse(gallery.isEmpty)
        assertTrue(WikiTemplates.gallery(WikiTemplatesOut()).isEmpty)
    }

    // --- requests ----------------------------------------------------------------------------------------------------

    @Test
    fun aNewPageNamesItsTemplateAndZone() = runBlocking {
        val api = client { 201 to pageJson() }
        api.createWikiPage(null, null, "workspace", "Asia/Tokyo", "k1", PageTemplateChoice.Builtin("weekly"))
        val builtin = seen.last().body!!
        assertEquals("weekly", builtin["template_key"]!!.jsonPrimitive.content)
        assertFalse(builtin.containsKey("template_page_id"))
        assertFalse(builtin.containsKey("title")) // the template's title
        assertEquals("Asia/Tokyo", builtin["tz"]!!.jsonPrimitive.content)
        assertEquals("workspace", builtin["access"]!!.jsonPrimitive.content)
        api.createWikiPage("p1", "メモ", "workspace", "Asia/Tokyo", "k2", PageTemplateChoice.Page("t1"))
        val page = seen.last().body!!
        assertEquals("t1", page["template_page_id"]!!.jsonPrimitive.content)
        assertFalse(page.containsKey("template_key"))
        assertEquals("p1", page["parent_id"]!!.jsonPrimitive.content)
        api.createWikiPage(null, null, "private", null, "k3", PageTemplateChoice.Blank)
        val blank = seen.last().body!!
        assertFalse(blank.containsKey("template_key") || blank.containsKey("template_page_id") || blank.containsKey("tz"))
        assertEquals("/api/v1/wiki/pages", seen.last().path)
    }

    @Test
    fun applyTemplateAndDuplicateBodies() = runBlocking {
        val api = client { path -> if (path.endsWith("/duplicate")) 201 to """{"page":${pageJson("p2")},"row":null}""" else 200 to pageJson() }
        api.applyWikiTemplate("p1", PageTemplateChoice.Builtin("minutes"), "Asia/Tokyo", "k1")
        assertEquals("/api/v1/wiki/pages/p1/apply-template", seen.last().path)
        assertEquals("POST", seen.last().method)
        assertEquals(
            buildJsonObject { put("template_key", "minutes"); put("tz", "Asia/Tokyo"); put("client_save_id", "k1") },
            seen.last().body,
        )
        api.duplicateWikiPage("p1", topLevel = false, clientSaveId = "k2")
        assertEquals("/api/v1/wiki/pages/p1/duplicate", seen.last().path)
        // Beside the original: no parent_id at all (the server puts it next to the original).
        assertEquals(buildJsonObject { put("client_save_id", "k2") }, seen.last().body)
        api.duplicateWikiPage("p1", topLevel = true, clientSaveId = "k3")
        val top = seen.last().body!!
        assertTrue(top.containsKey("parent_id"))
        assertEquals(JsonNull, top["parent_id"])
    }

    @Test
    fun aNewRowSendsNothingForTheDefaultTemplateIdOrBlank() = runBlocking {
        val api = client { 201 to rowJson }
        api.createRow("db1", "", JsonObject(emptyMap()), "k1", RowTemplateChoice.Default, "Asia/Tokyo")
        val default = seen.last().body!!
        assertFalse(default.containsKey("template_id") || default.containsKey("blank"))
        assertEquals("Asia/Tokyo", default["tz"]!!.jsonPrimitive.content)
        api.createRow("db1", "実験", JsonObject(emptyMap()), "k2", RowTemplateChoice.Template("t1"), null)
        assertEquals("t1", seen.last().body!!["template_id"]!!.jsonPrimitive.content)
        assertFalse(seen.last().body!!.containsKey("tz"))
        api.createRow("db1", "", JsonObject(emptyMap()), "k3", RowTemplateChoice.Blank, null)
        assertEquals(JsonPrimitive(true), seen.last().body!!["blank"])
        assertFalse(seen.last().body!!.containsKey("template_id"))
        assertEquals("/api/v1/wiki/databases/db1/rows", seen.last().path)
    }

    @Test
    fun theDatabaseSessionPassesTheChoiceAndZone() = runBlocking {
        val api = FakeWikiDbApi()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val session = DatabaseSession("db1", api, null, scope, WikiDbOptions(retryWait = {}, zone = { ZoneId.of("Asia/Tokyo") }))
        session.refresh()
        session.createRow("", RowTemplateChoice.Template("t1"))
        assertEquals(RowTemplateChoice.Template("t1"), api.templates.last())
        session.createRow("次")
        assertEquals(RowTemplateChoice.Default, api.templates.last())
    }

    // --- duplicating: one key, and the top level when beside is not mine ------------------------------------------------

    private class FakeTemplatesApi : WikiTemplatesApi {
        val keys = ArrayList<Pair<Boolean, String>>()
        val failures = ArrayDeque<Throwable>()
        override suspend fun wikiTemplates() = WikiTemplatesOut()
        override suspend fun applyWikiTemplate(pageId: String, template: PageTemplateChoice, tz: String?, clientSaveId: String) = PageOut(pageId)
        override suspend fun duplicateWikiPage(pageId: String, topLevel: Boolean, clientSaveId: String): PageDuplicateOut {
            keys.add(topLevel to clientSaveId)
            failures.removeFirstOrNull()?.let { throw it }
            return PageDuplicateOut(PageOut("copy", parentId = if (topLevel) null else "parent"))
        }
    }

    @Test
    fun aDuplicateRetriedAfterALostAnswerUsesTheSameKey() = runBlocking {
        val api = FakeTemplatesApi()
        api.failures.add(ApiException.Network(IOException("offline")))
        val outcome = WikiTemplates.duplicate(api, "p1", "page", topLevel = false, key = "k1", wait = {})
        assertEquals("copy", (outcome as DuplicateOutcome.Made).out.page.id)
        assertEquals(listOf(false to "k1", false to "k1"), api.keys)
    }

    @Test
    fun aPlaceThatIsNotMineAsksAboutTheTopLevel() = runBlocking {
        val restricted = ApiException.Api(403, "page_edit_restricted", "no")
        val api = FakeTemplatesApi()
        api.failures.add(restricted)
        assertEquals(DuplicateOutcome.NeedsTopLevel, WikiTemplates.duplicate(api, "p1", "page", topLevel = false, key = "k1", wait = {}))
        val top = WikiTemplates.duplicate(api, "p1", "page", topLevel = true, key = "k2", wait = {})
        assertNull((top as DuplicateOutcome.Made).out.page.parentId)
        assertEquals(true to "k2", api.keys.last())
        // A row stays in its database; at the top level a 403 is an error; other errors are errors.
        for ((kind, top2, error) in listOf(
            Triple("row", false, restricted), Triple("page", true, restricted), Triple("page", false, ApiException.Api(400, "wiki_cannot_duplicate", "db")),
        )) {
            api.failures.add(error)
            try {
                WikiTemplates.duplicate(api, "p1", kind, topLevel = top2, key = "k", wait = {})
                fail("expected $error")
            } catch (e: ApiException.Api) {
                assertEquals(error.code, e.code)
            }
        }
    }

    // --- the screens' rules -----------------------------------------------------------------------------------------

    @Test
    fun theBannerFollowsIsTemplate() {
        assertNull(WikiTemplates.banner(null))
        assertNull(WikiTemplates.banner(PageOut("p")))
        assertEquals(TemplateBanner.PAGE, WikiTemplates.banner(PageOut("p", isTemplate = true)))
        assertEquals(TemplateBanner.ROW, WikiTemplates.banner(PageOut("r", kind = "row", isTemplate = true)))
        assertNull(WikiTemplates.banner(PageOut("d", kind = "database", isTemplate = true)))
    }

    @Test
    fun startFromATemplateOnlyOnAnEditorsEmptyPage() {
        assertTrue(WikiTemplates.canStartFromTemplate(true, "page", " \n"))
        assertFalse(WikiTemplates.canStartFromTemplate(true, "page", "本文"))
        assertFalse(WikiTemplates.canStartFromTemplate(false, "page", ""))
        assertFalse(WikiTemplates.canStartFromTemplate(true, "row", ""))
        assertFalse(WikiTemplates.canStartFromTemplate(true, "database", ""))
    }

    @Test
    fun theRowSheetPicksTheDefaultAndSendsTheRightChoice() {
        val db = DatabaseOut("db1", templates = listOf(DbTemplateRef("t1", "A"), DbTemplateRef("t2", "B")), defaultTemplateId = "t2")
        assertEquals(listOf("t2", "t1"), WikiTemplates.rowTemplates(db).map { it.id })
        assertEquals("t2", WikiTemplates.initialRowTemplate(db))
        assertEquals(RowTemplateChoice.Default, WikiTemplates.rowChoice("t2", db))
        assertEquals(RowTemplateChoice.Template("t1"), WikiTemplates.rowChoice("t1", db))
        assertEquals(RowTemplateChoice.Blank, WikiTemplates.rowChoice(null, db))
        // No default: blank is simply nothing sent; a default in the trash (not listed) counts as none.
        val none = db.copy(defaultTemplateId = null)
        assertNull(WikiTemplates.initialRowTemplate(none))
        assertEquals(RowTemplateChoice.Default, WikiTemplates.rowChoice(null, none))
        assertEquals(listOf("t1", "t2"), WikiTemplates.rowTemplates(none).map { it.id })
        assertNull(WikiTemplates.initialRowTemplate(db.copy(defaultTemplateId = "gone")))
        assertTrue(WikiTemplates.rowTemplates(null).isEmpty())
    }

    @Test
    fun aTemplateRowShowsTodayAndMe() {
        val due = DbProperty("due", "締切", "date")
        val who = DbProperty("who", "担当", "person")
        val row = DbRow(
            "t1", props = mapOf(
                "due" to buildJsonObject { put("start", "@today"); put("end", JsonNull); put("time", false) },
                "who" to JsonArray(listOf(JsonPrimitive("@me"), JsonPrimitive("u2"))),
            ),
        )
        val ctx = DbCellContext(
            names = { mapOf("u2" to "海老").getValue(it) }, refs = emptyMap(), hidden = "", untitled = "無題",
            zone = ZoneId.of("Asia/Tokyo"), locale = Locale.JAPAN, todayWord = "今日", meWord = "自分",
        )
        assertEquals("今日", WikiDb.cellText(due, row, ctx))
        assertEquals("自分, 海老", WikiDb.cellText(who, row, ctx))
        assertTrue(WikiTemplates.isToday(row.props["due"]))
        assertTrue(WikiTemplates.isToday(JsonPrimitive("@today")))
        assertFalse(WikiTemplates.isToday(JsonPrimitive("2026-10-08")))
        assertTrue(WikiTemplates.hasMe(row.props["who"]))
        // An ordinary date still reads as a date.
        val dated = row.copy(props = mapOf("due" to WikiDb.dateJson(jp.chikuwachat.android.sync.DbDateValue("2026-10-08"))))
        assertEquals("2026/10/08", WikiDb.cellText(due, dated, ctx))
    }

    @Test
    fun aTemplateChoiceSurvivesARotation() {
        for (choice in listOf(PageTemplateChoice.Blank, PageTemplateChoice.Builtin("weekly"), PageTemplateChoice.Page("t1"))) {
            assertEquals(choice, TemplatePick.decode(TemplatePick.encode(choice)))
        }
        assertEquals("", TemplatePick.encode(null))
    }
}
