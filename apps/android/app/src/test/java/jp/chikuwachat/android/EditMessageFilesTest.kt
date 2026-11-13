package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.ui.EditFiles
import jp.chikuwachat.android.ui.EditFilesSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M186 (docs/CHANNEL_FILES.md §7.6): the edit dialog takes files off a message and adds new ones. */
class EditMessageFilesTest {
    private fun file(id: String, name: String = "$id.png", type: String = "image/png") =
        AttachmentOut(id = id, filename = name, contentType = type, sizeBytes = 10, hasThumbnail = true)

    private val now = CoroutineScope(Dispatchers.Unconfined)

    private fun session(vararg ids: String, max: Int = 10) = EditFilesSession(ids.map { file(it) }, max) { it.message ?: "failed" }

    @Test fun attachmentIdsAreSentOnlyWhenTheFilesChanged() {
        assertNull(EditFiles.attachmentIds(listOf("a", "b"), listOf("a", "b"))) // the body only, as before M186
        assertNull(EditFiles.attachmentIds(emptyList(), emptyList()))
        assertEquals(listOf("b"), EditFiles.attachmentIds(listOf("a", "b"), listOf("b")))
        assertEquals(listOf("a", "b", "n1"), EditFiles.attachmentIds(listOf("a", "b"), listOf("a", "b", "n1")))
        assertEquals(emptyList<String>(), EditFiles.attachmentIds(listOf("a"), emptyList())) // every file taken off
    }

    @Test fun anEmptyBodySavesWhileAFileIsLeft() {
        assertTrue(EditFiles.canSave("", files = 1, uploads = 0, saving = false))
        assertTrue(EditFiles.canSave("  ", files = 2, uploads = 0, saving = false))
        assertTrue(EditFiles.canSave("text", files = 0, uploads = 0, saving = false))
        assertFalse("nothing left: that is a delete", EditFiles.canSave(" \n", files = 0, uploads = 0, saving = false))
        assertFalse("a file still going up", EditFiles.canSave("text", files = 1, uploads = 1, saving = false))
        assertFalse(EditFiles.canSave("text", files = 1, uploads = 0, saving = true))
    }

    @Test fun anOlderServerIsToldByTheFilesItAnswers() {
        assertFalse("nothing sent, nothing to compare", EditFiles.ignoredByServer(null, listOf("a", "b")))
        assertFalse(EditFiles.ignoredByServer(listOf("a", "n1", "n2"), listOf("a", "n2", "n1"))) // the new ones by upload time
        assertFalse(EditFiles.ignoredByServer(emptyList(), emptyList()))
        assertTrue("one taken off is still there", EditFiles.ignoredByServer(listOf("b"), listOf("a", "b")))
        assertTrue("one added is not there", EditFiles.ignoredByServer(listOf("a", "n1"), listOf("a")))
    }

    @Test fun removingAndAddingMakeTheList() = runBlocking {
        val edit = session("a", "b", "c")
        assertNull(edit.attachmentIds())
        edit.remove(edit.files[1])
        assertEquals(listOf("a", "c"), edit.attachmentIds())
        val upload = CompletableDeferred<Result<AttachmentOut>>()
        assertTrue(edit.add(listOf(EditFilesSession.Upload("new.png", send = { upload.await() })), now))
        assertEquals(1, edit.uploads.size)
        assertFalse("not while it goes up", edit.canSave("", saving = false))
        upload.complete(Result.success(file("n1")))
        assertTrue(edit.uploads.isEmpty())
        assertEquals(listOf("a", "c", "n1"), edit.attachmentIds()) // the kept ones in place, the new one after them
        assertTrue(edit.canSave("", saving = false))
    }

    @Test fun takingEveryFileOffLeavesTheBodyToSave() {
        val edit = session("a")
        edit.remove(edit.files.single())
        assertEquals(emptyList<String>(), edit.attachmentIds())
        assertFalse(edit.canSave("", saving = false))
        assertTrue(edit.canSave("still text", saving = false))
    }

    @Test fun aFailedUploadIsTakenOutOrTriedAgain() = runBlocking {
        val edit = session("a")
        var attempts = 0
        var cleaned = 0
        val upload = EditFilesSession.Upload("big.mov", send = {
            attempts += 1
            if (attempts == 1) Result.failure(IllegalStateException("too large")) else Result.success(file("n1", "big.mov", "video/quicktime"))
        }, cleanup = { cleaned += 1 })
        edit.add(listOf(upload), now)
        assertEquals("too large", upload.failed)
        assertFalse("a failed file blocks the save until it is taken out or sent", edit.canSave("text", saving = false))
        edit.retry(upload, now)
        assertNull(upload.failed)
        assertTrue(edit.uploads.isEmpty())
        assertEquals(listOf("a", "n1"), edit.attachmentIds())
        assertEquals(1, cleaned)

        val other = EditFilesSession.Upload("x.pdf", send = { Result.failure(IllegalStateException("offline")) }, cleanup = { cleaned += 1 })
        edit.add(listOf(other), now)
        edit.discard(other)
        assertTrue(edit.uploads.isEmpty())
        assertEquals(2, cleaned)
        assertTrue(edit.canSave("", saving = false))
    }

    @Test fun theLimitCountsKeptFilesAndUploads() {
        val edit = session("a", "b", max = 3)
        var cleaned = 0
        val two = List(2) { EditFilesSession.Upload("p$it.png", send = { Result.success(file("n$it")) }, cleanup = { cleaned += 1 }) }
        assertFalse(edit.add(two, now))
        assertTrue(edit.overLimit)
        assertTrue("none went up", edit.uploads.isEmpty())
        assertEquals(2, cleaned)
        assertFalse(edit.full)
        assertTrue(edit.add(two.take(1), now))
        assertFalse(edit.overLimit)
        assertTrue(edit.full)
        edit.remove(edit.files.first())
        assertFalse(edit.full)
    }

    @Test fun closingLetsTheUploadsGo() = runBlocking {
        val edit = session("a")
        var cleaned = 0
        val going = CompletableDeferred<Result<AttachmentOut>>()
        val failed = EditFilesSession.Upload("f.png", send = { Result.failure(IllegalStateException("no")) }, cleanup = { cleaned += 1 })
        val late = EditFilesSession.Upload("l.png", send = { going.await() }, cleanup = { cleaned += 1 })
        edit.add(listOf(failed, late), now)
        edit.end()
        assertEquals(1, cleaned)
        going.complete(Result.success(file("n1")))
        assertEquals(2, cleaned)
        assertNull("nothing comes in after the dialog closed", edit.attachmentIds())
        assertFalse(edit.add(listOf(EditFilesSession.Upload("x", send = { Result.success(file("n2")) })), now))
    }

    @Test fun theEditSendsTheFilesOnlyWhenGiven() = runBlocking {
        val bodies = ArrayList<String>()
        val message = """{"id":"m1","channel_id":"c1","sender_id":"u","seq":3,"updated_seq":4,"body":"","created_at":"2026-11-13T00:00:00Z","deleted":false,
            "attachments":[{"id":"a","filename":"a.png","content_type":"image/png","size_bytes":10}]}"""
        val client = ApiClient("http://server", OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val buffer = okio.Buffer()
            chain.request().body?.writeTo(buffer)
            bodies.add("${chain.request().method} ${chain.request().url.encodedPath} ${buffer.readUtf8()}")
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("ok")
                .body(message.toResponseBody("application/json".toMediaType())).build()
        }).build())
        client.accessToken = "a"
        client.editMessage("m1", "text")
        val answer = client.editMessage("m1", "", listOf("a", "n1"))
        client.editMessage("m1", "only text", emptyList())
        assertEquals("""PATCH /api/v1/messages/m1 {"body":"text"}""", bodies[0])
        assertEquals("""PATCH /api/v1/messages/m1 {"body":"","attachment_ids":["a","n1"]}""", bodies[1])
        assertEquals("""PATCH /api/v1/messages/m1 {"body":"only text","attachment_ids":[]}""", bodies[2])
        // This answer kept the old files: what an older server does.
        assertTrue(EditFiles.ignoredByServer(listOf("a", "n1"), answer.attachments.map { it.id }))
    }
}
