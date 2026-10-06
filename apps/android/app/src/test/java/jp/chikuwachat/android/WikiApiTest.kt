package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.Codec
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M122: the /wiki requests as the server reads them (docs/WIKI.md §14.2), through a stubbed OkHttp (no network). */
class WikiApiTest {
    private class Seen(val method: String, val path: String, val query: String?, val ifNoneMatch: String?, val body: JsonObject?)

    private val seen = ArrayList<Seen>()

    private fun client(handler: (Request) -> Triple<Int, String, String?>): ApiClient {
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val raw = request.body?.let { Buffer().also { buffer -> it.writeTo(buffer) }.readUtf8() }
            seen.add(Seen(request.method, request.url.encodedPath, request.url.query, request.header("If-None-Match"), raw?.takeIf { it.isNotEmpty() }?.let { Codec.plain.parseToJsonElement(it).jsonObject }))
            val (status, body, etag) = handler(request)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("stub")
                .apply { if (etag != null) header("ETag", etag) }
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()
        return ApiClient("http://server", http).also { it.accessToken = "t" }
    }

    private val pageJson = """{"id":"p1","parent_id":null,"position":"a0","kind":"page","title":"手順","icon":"📘","version":3,"head_rev_id":"r3",
        "meta_seq":7,"inherit_access":true,"task_total":0,"task_done":0,"created_by":"u1","updated_by":"u2","created_at":"2026-10-07T00:00:00Z",
        "updated_at":"2026-10-07T01:00:00Z","my_level":"edit","private":false,"body":"本文",
        "breadcrumbs":[{"id":null,"title":null,"icon":null,"readable":false}],"children":[]}"""

    @Test
    fun theTreeCarriesItsEtagAndA304KeepsWhatIsHere() = runBlocking {
        val api = client { request ->
            if (request.header("If-None-Match") == "\"e1\"") Triple(304, "", null)
            else Triple(200, """{"pages":[{"id":"a","parent_id":null,"position":"a","kind":"page","title":"A","icon":null,"version":1,"head_rev_id":"r","meta_seq":1,
                "inherit_access":true,"task_total":0,"task_done":0,"created_by":"u","updated_by":"u","created_at":"","updated_at":"","my_level":"full","private":true}],"cursor":12}""", "\"e1\"")
        }
        val (tree, etag) = api.wikiTree(null)
        assertEquals(12L, tree!!.cursor)
        assertTrue(tree.pages.single().private)
        assertEquals("full", tree.pages.single().myLevel)
        assertEquals("\"e1\"", etag)
        val (again, kept) = api.wikiTree("\"e1\"")
        assertNull(again)
        assertEquals("\"e1\"", kept)
        assertEquals("\"e1\"", seen.last().ifNoneMatch)
    }

    @Test
    fun theFeedThePageAndItsEtag() = runBlocking {
        val api = client { request ->
            when {
                request.url.encodedPath == "/api/v1/wiki/changes" -> Triple(200, """{"pages":[],"removed":["x"],"cursor":9,"reset":false}""", null)
                request.header("If-None-Match") == "\"v3-edit\"" -> Triple(304, "", null)
                else -> Triple(200, pageJson, "\"v3-edit\"")
            }
        }
        val changes = api.wikiChanges(7)
        assertEquals("since=7", seen.last().query)
        assertEquals(listOf("x"), changes.removed)
        val page = api.wikiPage("p1", null)!!
        assertEquals("本文", page.body)
        assertFalse(page.breadcrumbs!!.single().readable)
        assertNull(api.wikiPage("p1", "\"v3-edit\""))
    }

    @Test
    fun aSaveSendsTheWholeBodyItsBaseAndKey() = runBlocking {
        val content = pageJson.substringBefore(",\n        \"breadcrumbs\"") + "}"
        val api = client { Triple(200, """{"page":$content,"submitted_rev_id":"r3","merged":true}""", null) }
        val out = api.saveWikiPage("p1", "r2", "本文", "k1", "both")
        assertEquals("PUT", seen.last().method)
        assertEquals("/api/v1/wiki/pages/p1/content", seen.last().path)
        val body = seen.last().body!!
        assertEquals(listOf("base_rev_id", "body", "client_save_id", "on_conflict"), body.keys.toList())
        assertEquals("r2", body["base_rev_id"]!!.jsonPrimitive.content)
        assertEquals("both", body["on_conflict"]!!.jsonPrimitive.content)
        assertTrue(out.merged)
        assertNull(out.page.breadcrumbs)
    }

    @Test
    fun aNewPageSendsItsAccessOnlyAtTheTopLevel() = runBlocking {
        val api = client { Triple(201, pageJson, null) }
        api.createWikiPage(null, "メモ", "private", "Asia/Tokyo", "k1")
        val top = seen.last().body!!
        assertEquals("private", top["access"]!!.jsonPrimitive.content)
        assertFalse(top.containsKey("parent_id"))
        assertEquals("k1", top["client_save_id"]!!.jsonPrimitive.content)
        api.createWikiPage("p1", null, "workspace", null, "k2")
        val child = seen.last().body!!
        assertEquals("p1", child["parent_id"]!!.jsonPrimitive.content)
        assertFalse(child.containsKey("access"))
        assertFalse(child.containsKey("title"))
    }

    @Test
    fun resolveAndSearch() = runBlocking {
        val api = client { request ->
            if (request.url.encodedPath.endsWith("/resolve")) Triple(200, """[{"id":"a","title":"A","icon":null,"kind":"page"}]""", null)
            else Triple(200, """{"hits":[],"keywords":["gpu"],"limit":20,"offset":0,"has_more":false,"total":0}""", null)
        }
        assertEquals("A", api.resolveWikiPages(listOf("a", "b")).single().title)
        assertEquals(listOf("a", "b"), seen.last().body!!["ids"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("gpu"), api.searchPages("GPU 予約", 20, 0).keywords)
        assertEquals("/api/v1/search/pages", seen.last().path)
        assertTrue(seen.last().query!!.startsWith("q=GPU 予約&"))
    }
}
