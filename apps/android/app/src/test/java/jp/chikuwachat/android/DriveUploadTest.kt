package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.AttachmentPreviewOut
import jp.chikuwachat.android.api.DriveFileOut
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DriveUploadCompleteOut
import jp.chikuwachat.android.sync.ConflictChoice
import jp.chikuwachat.android.sync.DriveNames
import jp.chikuwachat.android.sync.DriveUploadJob
import jp.chikuwachat.android.sync.DriveUploadJobs
import jp.chikuwachat.android.sync.DriveUploadRules
import jp.chikuwachat.android.sync.FileBytes
import jp.chikuwachat.android.sync.UploadOutcome
import jp.chikuwachat.android.sync.UploadState
import jp.chikuwachat.android.ui.DocumentHold
import jp.chikuwachat.android.ui.driveDocumentHold
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** 2026-10-24 (docs/DRIVE.md §6, §27.3, §28): the phone's drive uploads against a fake server, the jobs on disk, the viewer's rules. */
class DriveUploadTest {
    private val ten = ByteArray(10) { (it * 7).toByte() }

    @Test
    fun partsFollowThePartSizeAndCarryTheirSha() = runBlocking {
        val server = FakeUploadServer()
        val outcome = UploadHarness(server, partsAtOnce = 2).uploader.run(uploadJob(10), MemoryBytes(ten))
        assertTrue(outcome is UploadOutcome.Done)
        val byNumber = server.parts.associateBy { it.number }
        assertEquals(setOf(1, 2, 3), byNumber.keys)
        assertEquals(ten.copyOfRange(0, 4).toList(), byNumber.getValue(1).bytes)
        assertEquals(ten.copyOfRange(4, 8).toList(), byNumber.getValue(2).bytes)
        assertEquals(ten.copyOfRange(8, 10).toList(), byNumber.getValue(3).bytes)
        assertEquals(sha256Hex(ten.copyOfRange(8, 10)), byNumber.getValue(3).sha)
        val done = (outcome as UploadOutcome.Done).job
        assertEquals("item-u1", done.itemId)
        assertEquals(listOf("c-a.bin" to "fail"), server.creates)
        assertEquals(0, DriveUploadRules.partCount(0, 16))
        assertEquals(306, DriveUploadRules.partCount(5_130_000_000, 16L * 1024 * 1024))
        assertEquals(8L to 10L, DriveUploadRules.partRange(3, 10, 4))
        assertEquals(listOf(2, 4), DriveUploadRules.missingParts(4, listOf(1, 3)))
        assertEquals(6L, DriveUploadRules.sentBytes(listOf(1, 3, 3), 10, 4))
    }

    @Test
    fun anEmptyFileHasNoParts() = runBlocking {
        val server = FakeUploadServer()
        assertTrue(UploadHarness(server).uploader.run(uploadJob(0), MemoryBytes(ByteArray(0))) is UploadOutcome.Done)
        assertTrue(server.parts.isEmpty())
        assertEquals(1, server.completes)
    }

    @Test
    fun aResumeSkipsThePartsTheServerHas() = runBlocking {
        val server = FakeUploadServer()
        val made = server.createDriveUpload("c-a.bin", "folder", "a.bin", 10, null, "fail")
        server.sessions[made.id] = made.copy(receivedParts = listOf(1, 2))
        val start = uploadJob(10).copy(uploadId = made.id, state = UploadState.UPLOADING)
        assertTrue(UploadHarness(server).uploader.run(start, MemoryBytes(ten)) is UploadOutcome.Done)
        assertEquals(listOf(3), server.parts.map { it.number })
        assertEquals(1, server.creates.size) // the session was asked for (GET), not made again
    }

    @Test
    fun aNetworkFailureWaitsThenAsksTheSessionAgain() = runBlocking {
        val server = FakeUploadServer()
        var failed = false
        server.partFailure = { n -> if (n == 2 && !failed) { failed = true; ApiException.Network(java.io.IOException("cut")) } else null }
        val harness = UploadHarness(server)
        assertTrue(harness.uploader.run(uploadJob(10), MemoryBytes(ten)) is UploadOutcome.Done)
        assertEquals(listOf(DriveUploadRules.RETRY_MIN_MS), harness.waits)
        assertTrue(harness.saved.any { it.state == UploadState.WAITING && it.error == "network" })
        assertTrue(server.gets >= 1)
        assertEquals(listOf(1, 2, 3), server.parts.map { it.number }) // part 1 not sent twice
    }

    @Test
    fun temporaryTroubleBeyondTheQuickRetriesIsLeftToTheWork() = runBlocking {
        val server = FakeUploadServer()
        server.partFailure = { ApiException.Api(503, "http_503", "busy") }
        val harness = UploadHarness(server)
        val outcome = harness.uploader.run(uploadJob(10), MemoryBytes(ten))
        assertTrue(outcome is UploadOutcome.Retry)
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 16_000L), harness.waits)
        assertEquals(UploadState.WAITING, (outcome as UploadOutcome.Retry).job.state)
        assertEquals(30_000L, DriveUploadRules.backoff(6))
    }

    @Test
    fun aCompletionStillJoiningIsAskedAgainEveryTwoSeconds() = runBlocking {
        val server = FakeUploadServer()
        server.completeSteps.addLast { DriveUploadCompleteOut("completing") }
        server.getSteps.addLast { it.copy(status = "completing") }
        server.getSteps.addLast { it.copy(status = "completed", itemId = "made") }
        val harness = UploadHarness(server)
        val outcome = harness.uploader.run(uploadJob(10), MemoryBytes(ten))
        assertEquals("made", (outcome as UploadOutcome.Done).job.itemId)
        assertEquals(listOf(2_000L, 2_000L), harness.waits)
        assertTrue(harness.saved.any { it.state == UploadState.COMPLETING })
    }

    @Test
    fun notActiveOnCompletionLooksAtTheSession() = runBlocking {
        val server = FakeUploadServer()
        server.completeSteps.addLast { throw ApiException.Api(409, "drive_upload_not_active", "busy") }
        server.getSteps.addLast { it.copy(status = "completed", itemId = "x") }
        assertEquals("x", (UploadHarness(server).uploader.run(uploadJob(10), MemoryBytes(ten)) as UploadOutcome.Done).job.itemId)
    }

    @Test
    fun partsTheServerNoLongerCountsAreSentAgain() = runBlocking {
        val server = FakeUploadServer()
        // REVIEW-v0.1.70 #5: the store held other bytes for part 2; the server forgets it and answers 409.
        server.completeSteps.addLast { session ->
            server.sessions[session.id] = session.copy(receivedParts = listOf(1, 3))
            throw ApiException.Api(409, "drive_upload_incomplete", "missing")
        }
        assertTrue(UploadHarness(server).uploader.run(uploadJob(10), MemoryBytes(ten)) is UploadOutcome.Done)
        assertEquals(listOf(1, 2, 3, 2), server.parts.map { it.number }.let { it.take(3).sorted() + it.drop(3) })
        assertEquals(2, server.completes)
    }

    @Test
    fun resendsStopAfterThreeRounds() = runBlocking {
        val server = FakeUploadServer()
        repeat(5) { server.completeSteps.addLast { throw ApiException.Api(409, "drive_upload_incomplete", "missing") } }
        val outcome = UploadHarness(server).uploader.run(uploadJob(10), MemoryBytes(ten))
        assertEquals("drive_upload_incomplete", (outcome as UploadOutcome.Failed).job.error)
        assertEquals(4, server.completes)
    }

    @Test
    fun aFolderMovedToAnotherDriveFailsAndIsNotStartedAgain() = runBlocking {
        val server = FakeUploadServer()
        server.completeSteps.addLast { throw ApiException.Api(409, "drive_upload_target_moved", "moved") }
        val outcome = UploadHarness(server).uploader.run(uploadJob(10), MemoryBytes(ten))
        assertEquals("drive_upload_target_moved", (outcome as UploadOutcome.Failed).job.error)
        assertEquals(UploadState.FAILED, outcome.job.state)
        assertEquals(1, server.creates.size)
        // Seen while polling (the session ended with that error): the same.
        val polled = FakeUploadServer()
        polled.completeSteps.addLast { DriveUploadCompleteOut("completing") }
        polled.getSteps.addLast { it.copy(status = "aborted", error = "drive_upload_target_moved") }
        assertEquals("drive_upload_target_moved", (UploadHarness(polled).uploader.run(uploadJob(10), MemoryBytes(ten)) as UploadOutcome.Failed).job.error)
        assertEquals(1, polled.creates.size)
        // 「やり直す」 by the person starts a new session.
        val again = DriveUploadRules.retry(outcome.job) { "fresh" }
        assertEquals(UploadState.QUEUED, again.state)
        assertEquals("fresh", again.clientUploadId)
        assertNull(again.uploadId)
    }

    @Test
    fun anExpiredSessionStartsOverWithANewClientUploadId() = runBlocking {
        val server = FakeUploadServer()
        val old = server.createDriveUpload("c-a.bin", "folder", "a.bin", 10, null, "fail")
        server.sessions[old.id] = old.copy(status = "expired", receivedParts = listOf(1))
        val start = uploadJob(10).copy(uploadId = old.id, received = listOf(1))
        val outcome = UploadHarness(server).uploader.run(start, MemoryBytes(ten)) as UploadOutcome.Done
        assertEquals("new-1", server.creates.last().first)
        assertNotEquals(old.id, outcome.job.uploadId)
        assertEquals(listOf(1, 2, 3), server.parts.filter { it.uploadId == outcome.job.uploadId }.map { it.number })
    }

    @Test
    fun aNameTakenAsksAndTheAnswerGoesOnWithTheSameClientUploadId() = runBlocking {
        val server = FakeUploadServer()
        server.taken["a.bin"] = "file"
        val harness = UploadHarness(server)
        val asked = harness.uploader.run(uploadJob(10), MemoryBytes(ten)) as UploadOutcome.Asking
        assertEquals(UploadState.ASKING, asked.job.state)
        assertEquals("file", asked.job.existingKind)
        assertEquals("create", asked.job.conflictStage)
        assertTrue(server.parts.isEmpty())
        val answered = DriveUploadRules.answer(listOf(asked.job), asked.job.id, ConflictChoice.VERSION, all = false).changed.single()
        assertEquals(UploadState.QUEUED, answered.state)
        assertTrue(harness.uploader.run(answered, MemoryBytes(ten)) is UploadOutcome.Done)
        assertEquals(listOf("c-a.bin" to "fail", "c-a.bin" to "version"), server.creates)
    }

    @Test
    fun aFolderOfTheSameNameCannotTakeAVersion() = runBlocking {
        val server = FakeUploadServer()
        server.taken["a.bin"] = "folder"
        val harness = UploadHarness(server)
        val asked = harness.uploader.run(uploadJob(10), MemoryBytes(ten)) as UploadOutcome.Asking
        assertEquals("folder", asked.job.existingKind)
        // 「上書き」 is not offered; given anyway (a batch answer) it keeps the question.
        assertTrue(DriveUploadRules.answer(listOf(asked.job), asked.job.id, ConflictChoice.VERSION, all = false).changed.isEmpty())
        val preset = asked.job.copy(state = UploadState.QUEUED, presetAnswer = ConflictChoice.VERSION, existingKind = null)
        assertTrue(harness.uploader.run(preset, MemoryBytes(ten)) is UploadOutcome.Asking)
        val renamed = DriveUploadRules.answer(listOf(asked.job), asked.job.id, ConflictChoice.RENAME, all = false).changed.single()
        assertTrue(harness.uploader.run(renamed, MemoryBytes(ten)) is UploadOutcome.Done)
        assertEquals("rename", server.creates.last().second)
    }

    @Test
    fun skipAndTheSameForTheRestOfTheBatch() = runBlocking {
        val server = FakeUploadServer()
        server.taken["a.bin"] = "file"
        server.taken["b.bin"] = "file"
        val harness = UploadHarness(server)
        val a = (harness.uploader.run(uploadJob(10, "a.bin"), MemoryBytes(ten)) as UploadOutcome.Asking).job
        val b = uploadJob(10, "b.bin")
        val other = uploadJob(10, "c.bin", batch = "b2")
        assertEquals(1, DriveUploadRules.remainingInBatch(listOf(a, b, other), a))
        val answered = DriveUploadRules.answer(listOf(a, b, other), a.id, ConflictChoice.SKIP, all = true)
        assertEquals(UploadState.SKIPPED, answered.changed.first { it.id == a.id }.state)
        val presetB = answered.changed.first { it.id == b.id }
        assertEquals(ConflictChoice.SKIP, presetB.presetAnswer)
        assertTrue(answered.changed.none { it.id == other.id })
        assertTrue(answered.abort.isEmpty()) // no session was made for a create-time conflict
        val outcome = harness.uploader.run(presetB, MemoryBytes(ten))
        assertTrue(outcome is UploadOutcome.Skipped)
        assertTrue(server.parts.isEmpty())
    }

    @Test
    fun aNameTakenAtCompletionAsksThenPatchesTheSession() = runBlocking {
        val server = FakeUploadServer()
        val harness = UploadHarness(server)
        server.completeSteps.addLast { server.taken["a.bin"] = "file"; null }
        val asked = harness.uploader.run(uploadJob(10), MemoryBytes(ten)) as UploadOutcome.Asking
        assertEquals("complete", asked.job.conflictStage)
        val answered = DriveUploadRules.answer(listOf(asked.job), asked.job.id, ConflictChoice.RENAME, all = false).changed.single()
        assertTrue(answered.patchConflict)
        assertTrue(harness.uploader.run(answered, MemoryBytes(ten)) is UploadOutcome.Done)
        assertEquals(listOf(asked.job.uploadId to "rename"), server.patches)
        assertEquals(3, server.parts.size) // not sent again
        // Skipping a completion's conflict drops the session.
        val skip = DriveUploadRules.answer(listOf(asked.job), asked.job.id, ConflictChoice.SKIP, all = false)
        assertEquals(listOf(asked.job.uploadId), skip.abort)
    }

    @Test
    fun aJobCancelledMeanwhileStopsAndItsSessionIsDropped() = runBlocking {
        val root = Files.createTempDirectory("uploads").toFile()
        try {
            val store = DriveUploadJobs(root)
            val server = FakeUploadServer()
            val start = uploadJob(10)
            store.save(start)
            store.data(start.id).writeBytes(ten)
            val harness = UploadHarness(server)
            harness.keep = { store.update(it) }
            var cancelled: DriveUploadJob? = null
            server.partFailure = { n ->
                if (n == 2 && cancelled == null) cancelled = runBlocking { store.cancel(start.id) { server } }
                null
            }
            val outcome = harness.uploader.run(start, FileBytes(store.data(start.id)))
            assertTrue(outcome is UploadOutcome.Gone)
            assertEquals("u1", (outcome as UploadOutcome.Gone).uploadId)
            assertEquals(listOf("u1"), server.aborted)
            assertEquals(UploadState.CANCELLED, store.read(start.id)!!.state)
            assertFalse(store.data(start.id).exists())
            assertNull(runBlocking { store.cancel(start.id) { server } }) // finished: nothing more
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun aCopyThatIsGoneFailsWithReadFailed() = runBlocking {
        val outcome = UploadHarness(FakeUploadServer()).uploader.run(uploadJob(10), FileBytes(File("/nonexistent/data")))
        assertEquals("read_failed", (outcome as UploadOutcome.Failed).job.error)
    }

    @Test
    fun jobsOnDisk() {
        val root = Files.createTempDirectory("uploads").toFile()
        try {
            val store = DriveUploadJobs(root)
            val mine = uploadJob(10, "a.bin").copy(createdAt = 2)
            val theirs = uploadJob(10, "b.bin").copy(userId = "other", createdAt = 1)
            val preparing = uploadJob(5, "c.bin").copy(state = UploadState.PREPARING, createdAt = 3)
            listOf(mine, theirs, preparing).forEach(store::save)
            assertEquals(listOf(theirs, mine, preparing), store.all())
            assertEquals(mine, DriveUploadJob.decode(DriveUploadJob.encode(mine)))
            // A retry's answer is not lost to a run that saves after it.
            store.change(mine.id) { it.copy(presetAnswer = ConflictChoice.RENAME) }
            assertTrue(store.update(mine.copy(received = listOf(1))))
            assertEquals(ConflictChoice.RENAME, store.read(mine.id)!!.presetAnswer)
            // A job being copied by a process that is gone fails; one copied here now stays.
            store.tidy(now = System.currentTimeMillis(), preparingHere = emptySet())
            assertEquals("read_failed", store.read(preparing.id)!!.error)
            // REVIEW-v0.1.62 #1: another account's jobs go when "me" signs in there; all of them on a sign-out.
            assertEquals(listOf(theirs.id), store.dropAccount("http://s", keepUserId = "me").map { it.id })
            assertEquals(2, store.all().size)
            store.dropAccount("http://s")
            assertTrue(store.all().isEmpty())
            assertFalse(store.update(mine))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun fileBytesReadARangeAndItsSha() {
        val file = File.createTempFile("bytes", ".bin")
        try {
            file.writeBytes(ten)
            val bytes = FileBytes(file)
            assertEquals(ten.copyOfRange(3, 9).toList(), bytes.open(3, 9).readBytes().toList())
            assertEquals(sha256Hex(ten.copyOfRange(4, 10)), bytes.sha256(4, 10))
        } finally {
            file.delete()
        }
    }

    @Test
    fun theTotalsCountBytesAndFiles() {
        val a = uploadJob(10, "a.bin").copy(state = UploadState.DONE)
        val b = uploadJob(10, "b.bin").copy(state = UploadState.UPLOADING, partSize = 4, received = listOf(1))
        val c = uploadJob(10, "c.bin").copy(state = UploadState.CANCELLED)
        val totals = DriveUploadRules.totals(listOf(a, b, c), live = mapOf(b.id to 6L))
        assertEquals(2, totals.files)
        assertEquals(1, totals.done)
        assertEquals(20L, totals.bytes)
        assertEquals(16L, totals.sent)
        assertEquals(1, totals.pending)
    }

    private fun file(name: String, type: String?, preview: AttachmentPreviewOut? = null, thumbnail: Boolean = false) =
        DriveItemOut(id = name, name = name, contentType = type, file = DriveFileOut("att", hasThumbnail = thumbnail, preview = preview))

    @Test
    fun whichViewerAndWhereItsPagesComeFrom() {
        val docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        // §27.3: every PDF and Office file opens the viewer, whatever its preview.
        assertEquals(DriveNames.Viewer.DOCUMENT, DriveNames.viewer(file("a.pdf", "application/pdf")))
        assertEquals(DriveNames.Viewer.DOCUMENT, DriveNames.viewer(file("余分な前置き.pdf", "application/octet-stream")))
        assertEquals(DriveNames.Viewer.DOCUMENT, DriveNames.viewer(file("議事録.docx", docx)))
        assertEquals(DriveNames.Viewer.DOCUMENT, DriveNames.viewer(file("old.doc", "application/x-ole-storage")))
        assertNull(DriveNames.viewer(file("メモ.txt", "text/plain")))
        assertNull(DriveNames.viewer(file("a.zip", "application/zip")))
        assertEquals(DriveNames.Icon.PDF, DriveNames.icon(file("余分な前置き.pdf", "application/octet-stream")))
        assertFalse(DriveNames.isPdf(file("pdf", "application/octet-stream")))
        assertFalse(DriveNames.isOffice(file("a.docx", "image/png")))

        val ready = AttachmentPreviewOut("ready", 3, 800, 1100)
        assertEquals(DriveNames.DocumentSource.PREVIEW, DriveNames.documentSource(file("a.pdf", "application/pdf", ready)))
        assertEquals(DriveNames.DocumentSource.ORIGINAL, DriveNames.documentSource(file("a.pdf", "application/pdf", AttachmentPreviewOut("failed"))))
        assertEquals(DriveNames.DocumentSource.ORIGINAL, DriveNames.documentSource(file("a.pdf", "application/pdf")))
        assertEquals(DriveNames.DocumentSource.MAKING, DriveNames.documentSource(file("a.docx", docx, AttachmentPreviewOut("pending"))))
        assertEquals(DriveNames.DocumentSource.FAILED, DriveNames.documentSource(file("a.docx", docx, AttachmentPreviewOut("failed"))))
        assertEquals(DriveNames.DocumentSource.ASK, DriveNames.documentSource(file("a.docx", docx)))

        assertNull(driveDocumentHold(DriveNames.DocumentSource.ORIGINAL, answeredNone = false))
        assertEquals(DocumentHold.MAKING, driveDocumentHold(DriveNames.DocumentSource.ASK, answeredNone = false))
        assertEquals(DocumentHold.UNAVAILABLE, driveDocumentHold(DriveNames.DocumentSource.ASK, answeredNone = true))
        assertEquals(DocumentHold.FAILED, driveDocumentHold(DriveNames.DocumentSource.FAILED, answeredNone = false))
    }
}
