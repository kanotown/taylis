package jp.chikuwachat.android

import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.VideoTiles
import jp.chikuwachat.android.ui.formatDuration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M82 Android: video tiles from the server's size, poster and length (M79), and the sync of filled-in videos. */
class VideoAttachmentsTest {
    private fun clip(
        hasPoster: Boolean = false, width: Int? = null, height: Int? = null, durationMs: Long? = null, sizeBytes: Long = 1_992_294,
        hasThumbnail: Boolean = false, contentType: String = "video/mp4",
    ) = AttachmentOut("v1", "clip.mp4", contentType, sizeBytes, width, height, hasThumbnail, hasPoster = hasPoster, durationMs = durationMs)

    // --- the tile model -----------------------------------------------------------------------------

    @Test fun aVideoIsToldByItsContentTypeNeverByItsThumbnailFlag() {
        // The shipped app took every attachment with a thumbnail for a photo; a video with one is still a video.
        val flagged = clip(hasThumbnail = true)
        assertTrue(flagged.isVideo)
        assertFalse(flagged.isImage)
        assertTrue(clip(contentType = "Video/QuickTime").isVideo)
        val photo = AttachmentOut("p", "p.png", "image/png", 10, 4, 3, hasThumbnail = true)
        assertTrue(photo.isImage)
        assertFalse(photo.isVideo)
        assertFalse(AttachmentOut("p", "big.png", "image/png", 10).isImage) // no thumbnail: a file row, as before
        assertFalse(AttachmentOut("d", "a.pdf", "application/pdf", 10, hasThumbnail = true).isImage)
        // What /thumbnail has a picture for.
        assertTrue(photo.hasPreviewPicture)
        assertTrue(clip(hasPoster = true).hasPreviewPicture)
        assertFalse(clip().hasPreviewPicture)
        assertFalse(AttachmentOut("d", "a.pdf", "application/pdf", 10, hasPoster = true).hasPreviewPicture)
    }

    @Test fun theTileHasTheServersShapeFromTheStart() {
        assertEquals(VideoTiles.Box(280, 158), VideoTiles.box(clip(width = 1920, height = 1080)))
        assertEquals(VideoTiles.Box(135, 240), VideoTiles.box(clip(width = 1080, height = 1920)))
        assertEquals(VideoTiles.Box(240, 240), VideoTiles.box(clip(width = 1000, height = 1000)))
        assertEquals(VideoTiles.Box(160, 120), VideoTiles.box(clip(width = 160, height = 120))) // never scaled up
        // Unknown or nonsense sizes: the neutral square.
        assertEquals(VideoTiles.Box(180, 180), VideoTiles.box(clip()))
        assertEquals(VideoTiles.Box(180, 180), VideoTiles.box(clip(width = 0, height = 720)))
        assertNull(VideoTiles.fit(-1, 720))
        assertEquals(16f / 9f, VideoTiles.aspectRatio(clip()), 0.0001f)
        assertEquals(0.5625f, VideoTiles.aspectRatio(clip(width = 1080, height = 1920)), 0.0001f)
    }

    @Test fun thePosterShowsWhenTheServerHasOneElseThePlainTileOrTheOldRow() {
        assertEquals(VideoTiles.Look.POSTER, VideoTiles.look(clip(hasPoster = true, width = 1920, height = 1080)))
        assertEquals(VideoTiles.Look.POSTER, VideoTiles.look(clip(hasPoster = true)))
        // The poster did not load: the tile stays (its shape does not change), with a film icon.
        assertEquals(VideoTiles.Look.PLAIN, VideoTiles.look(clip(hasPoster = true, width = 1920, height = 1080), posterFailed = true))
        assertEquals(VideoTiles.Look.PLAIN, VideoTiles.look(clip(hasPoster = true), posterFailed = true))
        // A size without a poster (the server read the size but not a frame).
        assertEquals(VideoTiles.Look.PLAIN, VideoTiles.look(clip(width = 640, height = 480)))
        // Nothing known (a server before M79, a video not probed yet): the file row it always was; nothing is downloaded.
        assertEquals(VideoTiles.Look.ROW, VideoTiles.look(clip()))
        assertEquals(VideoTiles.Look.ROW, VideoTiles.look(clip(), posterFailed = true))
    }

    @Test fun lengthsReadLikeDesktops() {
        assertNull(formatDuration(null))
        assertNull(formatDuration(-1))
        assertEquals("0:00", formatDuration(0))
        assertEquals("0:01", formatDuration(1))
        assertEquals("0:01", formatDuration(499))
        assertEquals("0:07", formatDuration(7_000))
        assertEquals("0:07", formatDuration(7_499))
        assertEquals("0:08", formatDuration(7_500))
        assertEquals("1:00", formatDuration(59_600))
        assertEquals("12:34", formatDuration(754_000))
        assertEquals("1:02:03", formatDuration(3_723_000))
        assertEquals("10:00:00", formatDuration(36_000_000))
        assertEquals("0:42 · 1.9 MB", VideoTiles.label(clip(durationMs = 42_000)))
        assertEquals("1.9 MB", VideoTiles.label(clip()))
        assertEquals("動画 clip.mp4、0:42", VideoTiles.description(clip(durationMs = 42_000)))
        assertEquals("動画 clip.mp4", VideoTiles.description(clip()))
    }

    // --- decoding -------------------------------------------------------------------------------------

    @Test fun anOlderServersAttachmentDecodesWithoutTheNewFields() {
        val old = Codec.snake.decodeFromString(AttachmentOut.serializer(),
            """{"id":"v1","filename":"clip.mp4","content_type":"video/mp4","size_bytes":10,"width":null,"height":null,"has_thumbnail":false,"status":"attached","created_at":"2026-01-01T00:00:00Z"}""")
        assertFalse(old.hasPoster)
        assertNull(old.durationMs)
        assertEquals(VideoTiles.Look.ROW, VideoTiles.look(old))
        // The bare minimum, too.
        val bare = Codec.snake.decodeFromString(AttachmentOut.serializer(), """{"id":"v1","filename":"c.mp4","content_type":"video/mp4","size_bytes":10}""")
        assertFalse(bare.hasPoster)
        assertNull(bare.durationMs)
    }

    @Test fun anM79AttachmentDecodesAndSurvivesTheLocalStore() {
        val json = """{"id":"v1","filename":"clip.mp4","content_type":"video/mp4","size_bytes":1992294,"width":1080,"height":1920,
            "has_thumbnail":false,"has_poster":true,"duration_ms":42000,"status":"attached","created_at":"2026-10-02T00:00:00Z","something_later":1}"""
        val attachment = Codec.snake.decodeFromString(AttachmentOut.serializer(), json)
        assertTrue(attachment.hasPoster)
        assertEquals(42_000L, attachment.durationMs)
        assertEquals(VideoTiles.Look.POSTER, VideoTiles.look(attachment))
        assertEquals(VideoTiles.Box(135, 240), VideoTiles.box(attachment))
        // Rows are stored with the same codec: the new fields come back.
        val again = Codec.snake.decodeFromString(AttachmentOut.serializer(), Codec.snake.encodeToString(AttachmentOut.serializer(), attachment))
        assertEquals(attachment, again)
    }

    // --- sync: message.updated (change = "attachments", or one not known yet) -------------------------

    @Test fun aFilledInVideoReplacesTheRowAndAnUnknownChangeIsAppliedTheSameWay() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("lab", alice.id)
        server.join(channel.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        val engine = SyncEngine(
            server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(reconnectMinMs = 0, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer),
        )
        engine.isActive = { false }
        suspend fun settle() { repeat(20) { engine.idle(); yield() } }
        engine.start(); engine.openChannel(channel.id); settle()

        val (post, _) = server.post(channel.id, alice.id, "実験の動画")
        val before = clip().copy(status = "attached")
        server.setAttachments(channel.id, post.id, listOf(before), change = "body")
        settle()
        assertEquals(VideoTiles.Look.ROW, VideoTiles.look(store.message(channel.id, post.id)!!.attachments.single()))

        // probe-videos filled it in: message.updated with change = "attachments".
        server.setAttachments(channel.id, post.id, listOf(before.copy(width = 1920, height = 1080, hasPoster = true, durationMs = 42_000)))
        settle()
        val filled = store.message(channel.id, post.id)!!.attachments.single()
        assertTrue(filled.hasPoster)
        assertEquals(42_000L, filled.durationMs)
        assertEquals(VideoTiles.Box(280, 158), VideoTiles.box(filled))

        // A change this app does not know yet: the row is replaced like any other, and nothing breaks.
        server.setAttachments(channel.id, post.id, listOf(filled.copy(durationMs = 43_000)), change = "something_from_the_future")
        settle()
        assertEquals(43_000L, store.message(channel.id, post.id)!!.attachments.single().durationMs)
        assertEquals(EngineStatus.ONLINE, engine.status.value)
        assertEquals(server.channels.getValue(channel.id).channel.lastSeq, store.channel(channel.id)?.syncedSeq)

        // Across a dropped connection the catch-up brings the row as it is now.
        server.disconnect(bob.id)
        server.setAttachments(channel.id, post.id, listOf(filled.copy(durationMs = 44_000)))
        repeat(50) { if (engine.status.value != EngineStatus.ONLINE) settle() }
        settle()
        assertEquals(44_000L, store.message(channel.id, post.id)!!.attachments.single().durationMs)
        engine.stop(); scope.cancel()
    }
}
