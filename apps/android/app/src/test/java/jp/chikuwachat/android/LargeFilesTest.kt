package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.DriveChildrenOut
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DriveLocationOut
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import jp.chikuwachat.android.share.SharePayload
import jp.chikuwachat.android.share.SharedFile
import jp.chikuwachat.android.sync.DrivePost
import jp.chikuwachat.android.sync.DrivePostApi
import jp.chikuwachat.android.sync.DriveUploadJob
import jp.chikuwachat.android.sync.DriveUploadRules
import jp.chikuwachat.android.sync.DriveUploader
import jp.chikuwachat.android.sync.LargeFiles
import jp.chikuwachat.android.sync.UploadOutcome
import jp.chikuwachat.android.sync.UploadState
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/** CF5 (docs/CHANNEL_FILES.md §12.4, 「CF5 の Android」): files over the attachments' limit go to the drive and come back as a link. */
class LargeFilesTest {
    private val on = WorkspaceSettingsOut(channelFilesToDrive = true)
    private val off = WorkspaceSettingsOut(channelFilesToDrive = false)
    private val limits = Limits(maxMessageLength = 100, maxAttachmentBytes = 1000, maxAttachmentsPerMessage = 2)

    private fun channel(type: String, filesToDrive: Boolean? = null, archived: Boolean = false) = ChannelOut(
        id = "c1", type = type, name = "m2-seminar", archived = archived, lastSeq = 0, createdAt = "", updatedAt = "", filesToDrive = filesToDrive,
    )

    /** A drive with a channel location (root `root`) and マイドライブ (root `mine-root`). */
    private class FakeDrive(var canWrite: Boolean = true, val rootPages: List<List<DriveItemOut>> = emptyList()) : DrivePostApi {
        val resolved = mutableListOf<String?>()
        val listed = mutableListOf<String?>()
        val paths = mutableListOf<Pair<String, String>>()
        var failResolve: Throwable? = null

        override suspend fun resolveDriveLocation(channelId: String?): DriveLocationOut {
            failResolve?.let { throw it }
            resolved += channelId
            return if (channelId == null) DriveLocationOut(id = "mine", kind = "user", rootId = "mine-root", name = "マイドライブ", canWrite = true)
            else DriveLocationOut(id = "loc", kind = "channel", channelId = channelId, rootId = "root", name = "m2-seminar", canWrite = canWrite)
        }

        override suspend fun driveChildren(folderId: String, sort: String, order: String, cursor: String?, limit: Int): DriveChildrenOut {
            listed += cursor
            val index = cursor?.toInt() ?: 0
            val items = rootPages.getOrElse(index) { emptyList() }
            return DriveChildrenOut(folder = DriveItemOut(id = folderId, kind = "folder"), items = items, nextCursor = if (index + 1 < rootPages.size) (index + 1).toString() else null)
        }

        override suspend fun ensureDriveFolderPath(parentId: String, path: String, clientOpId: String): DriveItemOut {
            paths += parentId to path
            return DriveItemOut(id = "month-$path", kind = "folder", name = path, parentId = parentId)
        }
    }

    private fun folder(id: String, name: String, role: String? = null) = DriveItemOut(id = id, kind = "folder", name = name, systemRole = role)
    private val posts = folder("posts", "投稿のファイル", "channel_posts")
    // 2026-10-31 15:30 UTC = 2026-11-01 00:30 in Tokyo.
    private val now = java.time.Instant.parse("2026-10-31T15:30:00Z").toEpochMilli()

    @Test
    fun whereALargeFileGoes() {
        assertEquals(LargeFiles.PLACE_POSTS, LargeFiles.place(channel("public"), on, true))
        assertEquals(LargeFiles.PLACE_POSTS, LargeFiles.place(channel("private"), on, null))
        // The switch off (the channel's or the workspace's): the channel drive's top, not 「投稿のファイル」.
        assertEquals(LargeFiles.PLACE_CHANNEL, LargeFiles.place(channel("public", filesToDrive = false), on, true))
        assertEquals(LargeFiles.PLACE_CHANNEL, LargeFiles.place(channel("public"), off, true))
        // A DM has no drive: マイドライブ.
        assertEquals(LargeFiles.PLACE_MINE, LargeFiles.place(channel("dm"), on, true))
        assertEquals(LargeFiles.PLACE_MINE, LargeFiles.place(channel("group_dm"), on, true))
        // Archived, unknown, or a server without the drive: refused as before.
        assertNull(LargeFiles.place(channel("public", archived = true), on, true))
        assertNull(LargeFiles.place(null, on, true))
        assertNull(LargeFiles.place(channel("public"), on, false))
    }

    @Test
    fun overTheLimitOnlyWhenBothAreKnown() {
        assertTrue(LargeFiles.overLimit(1001, limits))
        assertFalse(LargeFiles.overLimit(1000, limits))
        assertFalse(LargeFiles.overLimit(null, limits))
        assertFalse(LargeFiles.overLimit(5000, null))
    }

    @Test
    fun theMonthIsTheWorkspaceZones() {
        assertEquals("2026-11", LargeFiles.monthName(now))
        assertEquals("2026-10", LargeFiles.monthName(now, ZoneId.of("UTC")))
    }

    @Test
    fun theLinkGoesOnALineOfItsOwnOnce() {
        val link = LargeFiles.link("https://chat.example/", "i1")
        assertEquals("https://chat.example/d/i1", link)
        assertEquals(link, LargeFiles.withLink("", link))
        assertEquals(link, LargeFiles.withLink("  ", link))
        assertEquals("見てください\n$link", LargeFiles.withLink("見てください", link))
        assertEquals("見てください\n$link", LargeFiles.withLink("見てください\n", link))
        assertEquals("a\n$link", LargeFiles.withLink("a\n$link", link))
    }

    @Test
    fun aChannelsFileGoesIntoTheMonthOfPostedFiles() = runBlocking {
        val drive = FakeDrive(rootPages = listOf(listOf(folder("f1", "資料"), posts, folder("f2", "論文"))))
        val post = DrivePost(channelId = "c1", place = LargeFiles.PLACE_POSTS)
        val resolved = LargeFiles.resolve(drive, post, now)
        assertEquals(LargeFiles.Resolved("loc", "month-2026-11", "#m2-seminar › 投稿のファイル › 2026-11", LargeFiles.PLACE_POSTS), resolved)
        assertEquals(listOf("posts" to "2026-11"), drive.paths)
        assertEquals(listOf<String?>("c1"), drive.resolved)
    }

    @Test
    fun postedFilesAreLookedForOverPagesAndNotPastTheFolders() = runBlocking {
        val second = FakeDrive(rootPages = listOf(listOf(folder("f1", "a")), listOf(posts)))
        assertEquals("posts", LargeFiles.postsFolder(second, "root")?.id)
        assertEquals(listOf(null, "1"), second.listed)
        // Folders come first: the first file ends the search (no 「投稿のファイル」, no further pages).
        val none = FakeDrive(rootPages = listOf(listOf(folder("f1", "a"), DriveItemOut(id = "x", kind = "file", name = "x.pdf")), listOf(posts)))
        assertNull(LargeFiles.postsFolder(none, "root"))
        assertEquals(listOf<String?>(null), none.listed)
        // A plain folder of the same name is not it.
        assertNull(LargeFiles.postsFolder(FakeDrive(rootPages = listOf(listOf(folder("p", "投稿のファイル")))), "root"))
    }

    @Test
    fun noPostedFilesYetTheSwitchOffOrNoWriteAndDms() = runBlocking {
        // 「投稿のファイル」 not made yet (only the server makes it): the drive's top, nothing made by the phone.
        val empty = FakeDrive()
        assertEquals(LargeFiles.Resolved("loc", "root", "#m2-seminar", LargeFiles.PLACE_CHANNEL), LargeFiles.resolve(empty, DrivePost("c1", place = LargeFiles.PLACE_POSTS), now))
        assertTrue(empty.paths.isEmpty())
        // The switch off: the top, the posted files not even looked for.
        val withPosts = FakeDrive(rootPages = listOf(listOf(posts)))
        assertEquals("root", LargeFiles.resolve(withPosts, DrivePost("c1", place = LargeFiles.PLACE_CHANNEL), now).folderId)
        assertTrue(withPosts.listed.isEmpty())
        // A channel drive I cannot write (an owners-only channel): マイドライブ.
        val readOnly = FakeDrive(canWrite = false, rootPages = listOf(listOf(posts)))
        assertEquals(LargeFiles.Resolved("mine", "mine-root", "マイドライブ", LargeFiles.PLACE_MINE), LargeFiles.resolve(readOnly, DrivePost("c1", place = LargeFiles.PLACE_POSTS), now))
        assertEquals(listOf("c1", null), readOnly.resolved)
        // A DM: マイドライブ straight away.
        val dm = FakeDrive()
        assertEquals("mine-root", LargeFiles.resolve(dm, DrivePost("d1", place = LargeFiles.PLACE_MINE), now).folderId)
        assertEquals(listOf<String?>(null), dm.resolved)
    }

    private fun postJob(post: DrivePost = DrivePost("c1", place = LargeFiles.PLACE_POSTS)) =
        uploadJob(10).copy(locationId = "", parentId = "", label = "#m2-seminar", onConflict = "rename", post = post)

    @Test
    fun theUploaderFindsTheFolderFirstThenUploadsThere() = runBlocking {
        val server = FakeUploadServer()
        val parents = mutableListOf<String>()
        val saved = mutableListOf<DriveUploadJob>()
        val drive = FakeDrive(rootPages = listOf(listOf(posts)))
        val uploader = DriveUploader(object : jp.chikuwachat.android.sync.DriveWriteApi by server {
            override suspend fun createDriveUpload(clientUploadId: String, parentId: String, name: String, sizeBytes: Long, contentModifiedMs: Long?, onConflict: String) =
                server.createDriveUpload(clientUploadId, parentId.also { parents += it }, name, sizeBytes, contentModifiedMs, onConflict)
        }, save = { saved += it; true }, sleep = {}, partsAtOnce = 1,
            findFolder = { job -> LargeFiles.applied(job, LargeFiles.resolve(drive, job.post!!, now)) })
        val outcome = uploader.run(postJob(), MemoryBytes(ByteArray(10) { it.toByte() }))
        val done = (outcome as UploadOutcome.Done).job
        assertEquals(listOf("month-2026-11"), parents)
        assertEquals("loc", done.locationId)
        assertEquals("#m2-seminar › 投稿のファイル › 2026-11", done.label)
        assertEquals(LargeFiles.PLACE_POSTS, done.post?.resolved)
        assertEquals(UploadState.DONE, done.state)
        assertTrue(LargeFiles.linkPending(done, LargeFiles.MODE_DRAFT))
        assertFalse(LargeFiles.linkPending(done, LargeFiles.MODE_SEND))
        // Once found it is not looked for again (a retry, a resume).
        assertEquals(1, drive.resolved.size)
        assertFalse(LargeFiles.needsFolder(done))
    }

    @Test
    fun findingTheFolderWaitsOnTheNetworkAndFailsOnARefusal() = runBlocking {
        val drive = FakeDrive().apply { failResolve = ApiException.Network(java.io.IOException("down")) }
        val waits = mutableListOf<Long>()
        val uploader = DriveUploader(FakeUploadServer(), save = { true }, sleep = { waits += it }, partsAtOnce = 1, quickRetries = 2,
            findFolder = { job -> LargeFiles.applied(job, LargeFiles.resolve(drive, job.post!!, now)) })
        val retry = uploader.run(postJob(), MemoryBytes(ByteArray(10)))
        assertTrue(retry is UploadOutcome.Retry)
        assertEquals(2, waits.size)
        drive.failResolve = ApiException.Api(403, "guest_restricted", "guest")
        val failed = uploader.run(postJob(DrivePost("d1", place = LargeFiles.PLACE_MINE)), MemoryBytes(ByteArray(10)))
        assertEquals("guest_restricted", (failed as UploadOutcome.Failed).job.error)
    }

    @Test
    fun aRetryAfterTheFolderMovedFindsItAgain() {
        val moved = postJob().copy(locationId = "loc", parentId = "month", state = UploadState.FAILED, error = "drive_upload_target_moved")
        val again = DriveUploadRules.retry(moved) { "new" }
        assertTrue(LargeFiles.needsFolder(again))
        assertEquals("new", again.clientUploadId)
        // A drive file of the drive screen keeps its folder.
        assertEquals("folder", DriveUploadRules.retry(uploadJob(10).copy(state = UploadState.FAILED, error = "drive_upload_target_moved")) { "n" }.parentId)
    }

    @Test
    fun theJobKeepsItsConversationOnDiskAndOlderJobsStillRead() {
        val job = postJob(DrivePost("c1", parentId = "p1", place = LargeFiles.PLACE_MINE, mode = LargeFiles.MODE_SEND, clientMsgId = "k", channelTitle = "#a"))
        assertEquals(job, DriveUploadJob.decode(DriveUploadJob.encode(job)))
        val old = """{"id":"j","serverUrl":"s","batchId":"b","clientUploadId":"c","name":"a","size":1,"locationId":"l","parentId":"f"}"""
        assertNull(DriveUploadJob.decode(old)?.post)
    }

    @Test
    fun theComposerShowsItsOwnConversationsUploadsUntilTheLinkIsIn() {
        val mine = postJob().copy(id = "1")
        val thread = postJob(DrivePost("c1", parentId = "p", place = LargeFiles.PLACE_POSTS)).copy(id = "2")
        val shared = postJob(DrivePost("c1", place = LargeFiles.PLACE_POSTS, mode = LargeFiles.MODE_SEND)).copy(id = "3")
        val linked = postJob(DrivePost("c1", place = LargeFiles.PLACE_POSTS, linked = true)).copy(id = "4", state = UploadState.DONE, itemId = "i")
        val waiting = postJob().copy(id = "5", state = UploadState.DONE, itemId = "i")
        val cancelled = postJob().copy(id = "6", state = UploadState.CANCELLED)
        val other = postJob().copy(id = "7", userId = "someone")
        val plain = uploadJob(10).copy(id = "8")
        val all = listOf(mine, thread, shared, linked, waiting, cancelled, other, plain)
        assertEquals(listOf("1", "5"), LargeFiles.composerJobs(all, "http://s", "me", "c1", null).map { it.id })
        assertEquals(listOf("2"), LargeFiles.composerJobs(all, "http://s", "me", "c1", "p").map { it.id })
        assertTrue(LargeFiles.composerJobs(all, "http://other", "me", "c1", null).isEmpty())
    }

    @Test
    fun theRowSaysHowFarItIs() {
        val job = postJob().copy(state = UploadState.UPLOADING, partSize = 4, partsTotal = 3, received = listOf(1))
        assertEquals("ドライブにアップロード中 · 40%", LargeFiles.status(job, null) { null })
        assertEquals("ドライブにアップロード中 · 80%", LargeFiles.status(job, 8) { null })
        assertEquals("準備中", LargeFiles.status(job.copy(state = UploadState.PREPARING), null) { null })
        assertEquals("失敗（理由）", LargeFiles.status(job.copy(state = UploadState.FAILED, error = "x"), null) { "理由" })
    }

    @Test
    fun theShareScreenTakesLargeFilesForTheDrive() {
        val small = SharedFile("1", "a.pdf", 10, "application/pdf")
        val big = SharedFile("2", "b.mp4", 5000, "video/mp4")
        val big2 = SharedFile("3", "c.mp4", 5000, "video/mp4")
        // Refused as before where the conversation has no place for them.
        assertEquals(listOf("「b.mp4」は大きすぎます（上限 1000 B）"), SharePayload.problems(listOf(small, big), "", limits))
        // Taken for the drive: no problem, a note, and not counted among the attachments (2 at most).
        assertEquals(emptyList<String>(), SharePayload.problems(listOf(small, big, big2), "", limits, toDrive = true))
        assertEquals(listOf(big, big2), SharePayload.toDrive(listOf(small, big, big2, big.copy(uri = "4", readable = false)), limits))
        assertEquals(listOf("「b.mp4」は 1000 B を超えるため、ドライブにアップロードしてリンクを投稿します。"), SharePayload.driveNotes(listOf(small, big), limits))
        assertEquals(listOf("添付は 2 件までです"), SharePayload.problems(listOf(small, small.copy(uri = "x"), small.copy(uri = "y"), big), "", limits, toDrive = true))
    }
}
