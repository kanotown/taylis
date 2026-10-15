package jp.chikuwachat.android

import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.platform.EmojiDiskCache
import jp.chikuwachat.android.platform.EmojiImageKey
import jp.chikuwachat.android.platform.EmojiImageLoader
import jp.chikuwachat.android.platform.SizedLru
import jp.chikuwachat.android.sync.Store
import java.io.File
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** docs/EMOJI.md, image cache: custom emoji pictures come from memory or disk, not the server, once fetched. */
class EmojiImageCacheTest {
    private val root: File = Files.createTempDirectory("emoji").toFile()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var now = 1_000_000_000L
    private val requests = Collections.synchronizedList(mutableListOf<String>())
    /** What the fake server serves, by "server|path". */
    private val served = HashMap<String, ByteArray>()

    @After fun tearDown() {
        scope.cancel()
        root.deleteRecursively()
    }

    private fun key(server: String = "https://a.example", id: String = "e1", version: String = "image/png-128x128", immutable: Boolean = false) =
        EmojiImageKey(server, id, version, immutable, "/api/v1/emoji/$id/image")

    private fun disk(maxBytes: Long = 1_000_000) = EmojiDiskCache(root, maxBytes) { now }

    private fun loader(
        disk: EmojiDiskCache = disk(),
        concurrency: Int = 4,
        fetch: suspend (EmojiImageKey) -> ByteArray = { key ->
            requests += "${key.serverUrl}|${key.path}"
            served["${key.serverUrl}|${key.path}"] ?: throw IllegalStateException("404")
        },
    ) = EmojiImageLoader(
        disk, scope, fetch, decode = { bytes -> String(bytes) }, sizeOf = { it.length.toLong() }, memoryBytes = 1_000,
        concurrency = concurrency, io = Dispatchers.IO, decodeDispatcher = Dispatchers.Default, clock = { now },
    )

    private fun serve(key: EmojiImageKey, text: String) { served["${key.serverUrl}|${key.path}"] = text.toByteArray() }

    @Test fun aSecondLoadComesFromMemoryAndANewProcessFromDisk() = runBlocking {
        val k = key()
        serve(k, "png-1")
        assertEquals("png-1", loader().let { first ->
            assertEquals("png-1", first.image(k))
            first.image(k) // memory
        })
        assertEquals(1, requests.size)
        // The app starts again: a new loader (empty memory) over the same folder.
        assertEquals("png-1", loader().image(k))
        assertEquals(1, requests.size)
    }

    @Test fun serversNeverShareAPicture() = runBlocking {
        val a = key(server = "https://a.example")
        val b = key(server = "https://b.example")
        serve(a, "from-a")
        serve(b, "from-b")
        val loader = loader()
        assertEquals("from-a", loader.image(a))
        assertEquals("from-b", loader.image(b)) // same id and version, other server: asked there
        assertEquals(2, requests.size)
        val disk = disk()
        assertTrue(disk.folder(a.serverUrl) != disk.folder(b.serverUrl))
        assertEquals("from-b", String(disk.read(b)!!.bytes))
    }

    @Test fun signingOutClearsOnlyThatServer() = runBlocking {
        val a = key(server = "https://a.example")
        val b = key(server = "https://b.example")
        serve(a, "from-a")
        serve(b, "from-b")
        val loader = loader()
        loader.image(a)
        loader.image(b)
        loader.clear(a.serverUrl)
        assertNull(loader.cached(a))
        assertEquals("from-b", loader.cached(b))
        assertFalse(disk().folder(a.serverUrl).exists())
        assertNotNull(disk().read(b))
        loader.image(a)
        assertEquals(3, requests.size) // a is asked again, b was not
    }

    @Test fun aFetchThatEndsAfterSignOutIsNotKept() = runBlocking {
        val k = key()
        val gate = CompletableDeferred<Unit>()
        val loader = loader(fetch = { gate.await(); "late".toByteArray() })
        val pending = async(Dispatchers.Default) { loader.image(k) }
        delay(50)
        loader.clear(k.serverUrl)
        gate.complete(Unit)
        pending.await()
        assertNull(loader.cached(k))
        assertNull(disk().read(k))
    }

    @Test fun manyWaitersShareOneRequest() = runBlocking {
        val k = key()
        val count = AtomicInteger()
        val gate = CompletableDeferred<Unit>()
        val loader = loader(fetch = { count.incrementAndGet(); gate.await(); "once".toByteArray() })
        val waiters = (1..20).map { async(Dispatchers.Default) { loader.image(k) } }
        delay(50)
        gate.complete(Unit)
        assertEquals(List(20) { "once" }, waiters.awaitAll())
        assertEquals(1, count.get())
    }

    @Test fun atMostFourRequestsAtATime() = runBlocking {
        val running = AtomicInteger()
        val most = AtomicInteger()
        val gate = CompletableDeferred<Unit>()
        val loader = loader(concurrency = 4, fetch = { key ->
            most.accumulateAndGet(running.incrementAndGet(), ::maxOf)
            gate.await()
            running.decrementAndGet()
            key.id.toByteArray()
        })
        val all = (1..12).map { i -> async(Dispatchers.Default) { loader.image(key(id = "e$i")) } }
        delay(100)
        assertEquals(4, running.get())
        gate.complete(Unit)
        assertEquals((1..12).map { "e$it" }, withTimeout(5_000) { all.awaitAll() })
        assertEquals(4, most.get())
    }

    @Test fun theLatestWishGoesFirst() = runBlocking {
        val order = Collections.synchronizedList(mutableListOf<String>())
        val gate = CompletableDeferred<Unit>()
        val loader = loader(concurrency = 1, fetch = { key -> order += key.id; gate.await(); key.id.toByteArray() })
        val first = async(Dispatchers.Default) { loader.image(key(id = "e1")) }
        delay(50)
        val queued = (2..5).map { i -> async(Dispatchers.Default) { loader.image(key(id = "e$i")) }.also { delay(30) } }
        gate.complete(Unit)
        withTimeout(5_000) { (listOf(first) + queued).awaitAll() }
        assertEquals(listOf("e1", "e5", "e4", "e3", "e2"), order) // scrolled into view last = asked first
    }

    @Test fun aServerVersionIsNeverAskedAgainButAStandInIsCheckedOnceADay() = runBlocking {
        val versioned = key(id = "v", version = "abc", immutable = true)
        val plain = key(id = "p")
        serve(versioned, "v1")
        serve(plain, "p1")
        loader().apply { image(versioned); image(plain) }
        assertEquals(2, requests.size)
        now += 2L * 24 * 60 * 60 * 1000
        serve(plain, "p2") // replaced on the server
        val updated = CompletableDeferred<String>()
        val later = loader()
        assertEquals("v1", later.image(versioned))
        assertEquals("p1", later.image(plain) { updated.complete(it) }) // the cached one at once…
        assertEquals("p2", withTimeout(5_000) { updated.await() }) // …the new one after the check
        assertEquals(3, requests.size)
        assertEquals("p2", later.cached(plain))
    }

    @Test fun aNewVersionReplacesTheOldFile() = runBlocking {
        val old = key(version = "image/png-128x128")
        val new = key(version = "image/png-180x180")
        serve(old, "old")
        loader().image(old)
        serve(new, "new")
        loader().image(new)
        assertNull(disk().read(old))
        assertEquals(1, disk().folder(old.serverUrl).listFiles()!!.size)
    }

    @Test fun theLeastRecentlyUsedFilesGoPastTheLimit() {
        val disk = disk(maxBytes = 3 * (12 + 100))
        val keys = (1..4).map { key(id = "e$it") }
        keys.take(3).forEach { k -> now += 1000; assertTrue(disk.write(k, ByteArray(100), disk.generation(k.serverUrl))) }
        now += 1000
        assertNotNull(disk.read(keys[0])) // used again: e2 is now the oldest
        now += 1000
        disk.write(keys[3], ByteArray(100), disk.generation(keys[3].serverUrl))
        assertNotNull(disk.read(keys[0]))
        assertNull(disk.read(keys[1]))
        assertNotNull(disk.read(keys[2]))
        assertNotNull(disk.read(keys[3]))
        assertTrue(disk.sizeOnDisk() <= 3 * 112)
    }

    @Test fun aBrokenFileIsAMiss() {
        val disk = disk()
        val k = key()
        disk.write(k, "ok".toByteArray(), 0)
        disk.folder(k.serverUrl).listFiles()!!.single().writeText("junk")
        assertNull(disk.read(k))
        assertTrue(disk.folder(k.serverUrl).listFiles()!!.isEmpty())
    }

    @Test fun theMemoryLimitDropsTheLeastRecentlyUsed() {
        val lru = SizedLru<String>(10) { it.length.toLong() }
        lru["a"] = "aaaa"
        lru["b"] = "bbbb"
        assertEquals("aaaa", lru["a"])
        lru["c"] = "cccc"
        assertEquals(setOf("a", "c"), lru.keys())
    }

    @Test fun aFailedFetchIsTriedAgainLater() = runBlocking {
        val k = key()
        val loader = loader()
        assertNull(loader.image(k))
        serve(k, "now")
        assertEquals("now", loader.image(k))
        assertArrayEquals("now".toByteArray(), disk().read(k)!!.bytes)
    }

    @Test fun aReplacedImageIsDrawnAgain() {
        val store = Store()
        val row = CustomEmojiOut("e1", "wave", "image/png", 128, 128, "u", "t")
        store.replaceCustomEmoji(listOf(row))
        store.setEmojiImage("e1", Drawn)
        store.applyCustomEmoji(row.copy(label = "手を振る"), deleted = false)
        assertTrue(store.emojiImages.containsKey("e1")) // a new name keeps the picture
        store.applyCustomEmoji(row.copy(label = "手を振る", imageVersion = "v2"), deleted = false)
        assertFalse(store.emojiImages.containsKey("e1")) // a replaced image is fetched again (under its new version)
        store.setEmojiImage("e1", Drawn)
        store.replaceCustomEmoji(listOf(row.copy(imageVersion = "v2", width = 180, height = 180)))
        assertFalse(store.emojiImages.containsKey("e1")) // an older server: the size changed
    }

    /** A drawn image stand-in (a JVM test has no Bitmap). */
    private object Drawn : androidx.compose.ui.graphics.ImageBitmap {
        override val width = 1
        override val height = 1
        override val colorSpace = androidx.compose.ui.graphics.colorspace.ColorSpaces.Srgb
        override val hasAlpha = true
        override val config = androidx.compose.ui.graphics.ImageBitmapConfig.Argb8888
        override fun readPixels(buffer: IntArray, startX: Int, startY: Int, width: Int, height: Int, bufferOffset: Int, stride: Int) {}
        override fun prepareToDraw() {}
    }
}
