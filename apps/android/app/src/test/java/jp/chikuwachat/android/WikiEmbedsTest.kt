package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.DatabaseOut
import jp.chikuwachat.android.api.DbProperty
import jp.chikuwachat.android.api.DbRow
import jp.chikuwachat.android.api.DbRowQueryOut
import jp.chikuwachat.android.api.DbView
import jp.chikuwachat.android.sync.EmbedCache
import jp.chikuwachat.android.sync.EmbedLoad
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.WikiDbApi
import jp.chikuwachat.android.sync.WikiHub
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** An embed's endpoints whose database read can be held (an answer on its way while the session ends). */
private class HeldDbApi(private val inner: FakeWikiDbApi = FakeWikiDbApi()) : WikiDbApi by inner {
    var hold: CompletableDeferred<Unit>? = null

    override suspend fun wikiDatabase(databaseId: String): DatabaseOut {
        hold?.await()
        return inner.wikiDatabase(databaseId)
    }

    fun secret() {
        inner.db = DatabaseOut(
            pageId = "db1", schemaVersion = 1, properties = listOf(DbProperty("title", "", "title")),
            views = listOf(DbView("v1", name = "A の非公開ビュー")), myLevel = "view",
        )
        inner.answer = { DbRowQueryOut(listOf(DbRow(id = "r1", databaseId = "db1", title = "A の機密の行")), total = 1, schemaVersion = 1) }
    }

    fun refuse() {
        inner.failures.add(ApiException.Api(403, "forbidden", "no"))
    }
}

/**
 * M149 (WIKI.md §22.5): an embedded database's rows are kept per session (the WikiHub of one server and account). After
 * a sign-out, another account opening the same embed finds nothing of the first one's — not what was read, and not an
 * answer that came after the sign-out.
 */
class WikiEmbedsTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private fun hub() = WikiHub(null, Store(MemoryPersistence()), scope)
    private val key = EmbedCache.key("db1", "v1")

    @Test
    fun anotherAccountAfterSignOutSeesNothingOfTheFirst() = runBlocking {
        val a = hub()
        val api = HeldDbApi().apply { secret() }
        val got = EmbedCache.load(a.embeds, api, "db1", "v1", 5)
        assertEquals("A の機密の行", (got as EmbedLoad.Rows).rows.rows.single().title)
        assertEquals("A の機密の行", a.embeds.get(key)!!.rows.single().title)

        a.stop() // sign-out: the engine (and its hub) stops
        assertNull(a.embeds.get(key))

        val b = hub()
        assertNull(b.embeds.get(key)) // nothing to draw before B's own answer
        val refused = HeldDbApi().apply { secret(); refuse() }
        assertEquals(EmbedLoad.Denied, EmbedCache.load(b.embeds, refused, "db1", "v1", 5))
        assertNull(b.embeds.get(key))
        assertNull(a.embeds.get(key))
    }

    @Test
    fun anAnswerThatComesAfterTheSignOutIsNotKeptOrShown() = runBlocking {
        val a = hub()
        val api = HeldDbApi().apply { secret(); hold = CompletableDeferred() }
        val reading = async { EmbedCache.load(a.embeds, api, "db1", "v1", 5) }
        assertTrue(!reading.isCompleted)

        a.stop()
        val b = hub()
        api.hold!!.complete(Unit) // A's answer lands after the session ended

        assertEquals(EmbedLoad.Failed, reading.await())
        assertNull(a.embeds.get(key))
        assertNull(b.embeds.get(key))
        assertTrue(a.embeds.isClosed)
        // And nothing put into the ended session's cache is kept.
        assertEquals(EmbedLoad.Failed, EmbedCache.load(a.embeds, HeldDbApi().apply { secret() }, "db1", "v1", 5))
        assertNull(a.embeds.get(key))
    }
}
