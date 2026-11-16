package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ResponseLimits
import jp.chikuwachat.android.platform.BoundedImage
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 2026-11-16 (a hostile-server review): a server's oversized picture or answer never crashes the app. A 5100 × 5100 icon
 * ran out of memory in the title at every start; whole-body reads took any size.
 */
class BoundedImageTest {
    // --- pictures ---------------------------------------------------------------------------------

    @Test fun oversizedPicturesAreNotDecoded() {
        var reads = 0
        val read = { _: Int -> reads++; "picture" }
        // 5100 × 5100 = 26 megapixels: over the small limit (icons, avatars, emoji), under the large one (photos).
        assertNull(BoundedImage.decodeWith(5100 to 5100, 256, BoundedImage.SMALL_MAX_PIXELS, read))
        assertEquals(0, reads)
        assertEquals("picture", BoundedImage.decodeWith(5100 to 5100, 2048, BoundedImage.MAX_PIXELS, read))
        assertNull(BoundedImage.decodeWith(65535 to 65535, 2048, BoundedImage.MAX_PIXELS, read))
        // Not a picture, or a broken header.
        assertNull(BoundedImage.decodeWith(null, 256, BoundedImage.MAX_PIXELS, read))
        assertNull(BoundedImage.decodeWith(0 to 10, 256, BoundedImage.MAX_PIXELS, read))
        assertNull(BoundedImage.decodeWith(-1 to -1, 256, BoundedImage.MAX_PIXELS, read))
        assertEquals(1, reads)
    }

    @Test fun picturesAreSampledToTheirDisplaySize() {
        var sample = 0
        BoundedImage.decodeWith(5100 to 3000, 256, BoundedImage.MAX_PIXELS) { sample = it; Unit }
        assertEquals(32, sample) // 5100 / 32 = 159 ≤ 256 < 5100 / 16
        assertEquals(1, BoundedImage.sampleSize(256, 256, 256))
        assertEquals(2, BoundedImage.sampleSize(257, 100, 256))
        assertEquals(1, BoundedImage.sampleSize(100, 4000, 4096))
        assertEquals(4, BoundedImage.sampleSize(3000, 8000, 2048))
        assertTrue(BoundedImage.allowed(4000, 4000, BoundedImage.SMALL_MAX_PIXELS))
        assertFalse(BoundedImage.allowed(4001, 4000, BoundedImage.SMALL_MAX_PIXELS))
    }

    @Test fun anOutOfMemoryErrorIsNoPicture() {
        assertNull(BoundedImage.decodeWith(100 to 100, 256, BoundedImage.MAX_PIXELS) { throw OutOfMemoryError("100 MB") })
        assertNull(BoundedImage.decodeWith(100 to 100, 256, BoundedImage.MAX_PIXELS) { throw IllegalArgumentException("bad") })
    }

    @Test fun gifCanvasesAreReadFromTheHeader() {
        fun gif(width: Int, height: Int) = "GIF89a".toByteArray() + byteArrayOf(width.toByte(), (width shr 8).toByte(), height.toByte(), (height shr 8).toByte(), 0, 0, 0)
        assertEquals(65535 to 65535, BoundedImage.gifCanvas(gif(65535, 65535)))
        assertEquals(64 to 48, BoundedImage.gifCanvas(gif(64, 48)))
        assertFalse(BoundedImage.allowed(65535, 65535, BoundedImage.MAX_GIF_PIXELS))
        assertFalse(BoundedImage.allowed(2049, 2048, BoundedImage.MAX_GIF_PIXELS))
        assertTrue(BoundedImage.allowed(2048, 2048, BoundedImage.MAX_GIF_PIXELS))
        assertNull(BoundedImage.gifCanvas("\u0089PNG\r\n\u001a\n0000".toByteArray(Charsets.ISO_8859_1)))
        assertNull(BoundedImage.gifCanvas("GIF8".toByteArray()))
    }

    @Test fun streamsAreReadUpToALimit() {
        assertArrayEquals(ByteArray(100) { 1 }, BoundedImage.readAtMost(ByteArray(100) { 1 }.inputStream(), 100))
        assertNull(BoundedImage.readAtMost(ByteArray(101).inputStream(), 100))
        assertArrayEquals(ByteArray(0), BoundedImage.readAtMost(ByteArray(0).inputStream(), 100))
    }

    // --- answers ----------------------------------------------------------------------------------

    private val small = ResponseLimits(json = 1_000, bytes = 2_000, small = 500)

    private fun serving(body: ByteArray, declared: Long? = null, served: Buffer = Buffer()): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            served.write(body)
            val responseBody = if (declared == null) body.toResponseBody("application/json".toMediaType())
            else object : okhttp3.ResponseBody() {
                override fun contentType() = "application/octet-stream".toMediaType()
                override fun contentLength() = declared
                override fun source() = served
            }
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("stub").body(responseBody).build()
        }).build()

    private fun assertTooLarge(block: suspend () -> Unit) = runBlocking {
        try {
            block()
            fail("expected response_too_large")
        } catch (e: ApiException.Api) {
            assertEquals(ResponseLimits.TOO_LARGE, e.code)
            assertFalse(e.isRetryable)
        }
    }

    @Test fun bytesAreReadUpToTheLimit() = runBlocking {
        val exact = ApiClient("http://server", serving(ByteArray(2_000) { 7 }), limits = small)
        assertEquals(2_000, exact.fetchBytes("/api/v1/attachments/a/thumbnail").size)
        assertEquals(400, ApiClient("http://server", serving(ByteArray(400)), limits = small).fetchBytes("/x", small.small).size)
        assertTooLarge { ApiClient("http://server", serving(ByteArray(2_001)), limits = small).fetchBytes("/x") }
        assertTooLarge { ApiClient("http://server", serving(ByteArray(501)), limits = small).fetchBytes("/x", small.small) }
        assertTooLarge { ApiClient("http://server", serving(ByteArray(501)), limits = small).serverIcon("1") }
    }

    @Test fun aDeclaredLengthOverTheLimitIsNotRead() {
        val served = Buffer()
        assertTooLarge { ApiClient("http://server", serving(ByteArray(10), declared = 5_000_000_000L, served = served), limits = small).fetchBytes("/x") }
        assertEquals(10L, served.size) // not a byte taken
    }

    @Test fun jsonIsReadUpToTheLimit() = runBlocking {
        val user = """{"id":"u","username":"alice","display_name":"Alice","role":"member","created_at":"","updated_at":"","must_change_password":false}"""
        val ok = ApiClient("http://server", serving(user.toByteArray()), limits = small).apply { accessToken = "a" }
        assertEquals("alice", ok.me().username)
        val padded = user.dropLast(1) + ",\"pad\":\"" + "x".repeat(1_000) + "\"}"
        assertTooLarge { ApiClient("http://server", serving(padded.toByteArray()), limits = small).apply { accessToken = "a" }.me() }
    }

    @Test fun aDownloadStopsAtTheAttachmentsSize() {
        val dir = Files.createTempDirectory("bounded").toFile()
        try {
            val target = File(dir, "a/file.pdf")
            runBlocking { ApiClient("http://server", serving(ByteArray(300) { 3 })).downloadTo("/x", target, 300) }
            assertEquals(300L, target.length())
            val other = File(dir, "b/file.pdf")
            assertTooLarge { ApiClient("http://server", serving(ByteArray(301))).downloadTo("/x", other, 300) }
            assertFalse(other.exists())
            assertFalse(File(other.parentFile, "file.pdf.part").exists()) // nothing half-written stays
            assertTooLarge { ApiClient("http://server", serving(ByteArray(10), declared = 301)).downloadTo("/x", other, 300) }
            assertFalse(other.exists())
        } finally {
            dir.deleteRecursively()
        }
    }
}
