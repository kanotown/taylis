package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.AttachmentDriveOut
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DriveChildrenOut
import jp.chikuwachat.android.api.DriveCrumb
import jp.chikuwachat.android.api.DriveDownloadTicketOut
import jp.chikuwachat.android.api.DriveItemDetailOut
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DriveLocationListOut
import jp.chikuwachat.android.api.DriveLocationOut
import jp.chikuwachat.android.api.DriveMessageFileOut
import jp.chikuwachat.android.api.DriveMessageFilesOut
import jp.chikuwachat.android.api.DrivePostOut
import jp.chikuwachat.android.api.DriveSearchOut
import jp.chikuwachat.android.api.DriveZipOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import jp.chikuwachat.android.sync.ChannelFiles
import jp.chikuwachat.android.sync.DriveApi
import jp.chikuwachat.android.sync.DriveHub
import jp.chikuwachat.android.sync.DriveLinkState
import jp.chikuwachat.android.sync.DriveNames
import jp.chikuwachat.android.sync.DriveSearchLoader
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.describeDriveError
import jp.chikuwachat.android.sync.toOut
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** CF4 (docs/CHANNEL_FILES.md §12, §19.3): files posted in a channel live in its drive — the wire, the rules, the cache. */
class ChannelFilesTest {
    /** A message as the server (CF1) sends it: one posted file in the drive, one plain attachment, one tombstone. */
    private val withDrive = """
        {"id": "0199a000-0000-7000-8000-000000000001", "channel_id": "c1", "sender_id": "u1", "parent_id": null,
         "also_in_channel": false, "seq": 12, "updated_seq": 15, "client_msg_id": "k1", "type": "user", "body": "資料です",
         "mentioned_user_ids": [], "mention_all": false, "reactions": [], "reply_count": 0, "reply_user_ids": [],
         "last_reply_at": null, "created_at": "2026-10-28T06:02:00Z", "edited_at": null, "deleted": false, "pinned_at": null,
         "pinned_by": null, "priority": null, "ack_requested": false, "acks": [], "poll": null, "collection": null,
         "tasks": [], "system_event": null, "workflow": null, "call": null,
         "attachments": [
           {"id": "a1", "filename": "ゼミ資料.pdf", "content_type": "application/pdf", "size_bytes": 482133, "width": null,
            "height": null, "has_thumbnail": false, "has_poster": false, "duration_ms": null, "status": "attached",
            "created_at": "2026-10-28T06:01:40Z", "preview": {"status": "ready", "pages": 12, "width": 1240, "height": 1754},
            "drive": {"item_id": "i1", "version_id": "v1", "version_number": 1, "state": "available"}},
           {"id": "a2", "filename": "memo.txt", "content_type": "text/plain", "size_bytes": 12, "width": null, "height": null,
            "has_thumbnail": false, "has_poster": false, "duration_ms": null, "status": "attached",
            "created_at": "2026-10-28T06:01:41Z", "preview": null, "drive": null},
           {"id": "a3", "filename": "old.png", "content_type": "image/png", "size_bytes": 900, "width": 10, "height": 10,
            "has_thumbnail": false, "has_poster": false, "duration_ms": null, "status": "attached",
            "created_at": "2026-10-28T06:01:42Z", "preview": null,
            "drive": {"item_id": null, "version_id": null, "version_number": null, "state": "deleted"}}
         ]}
    """.trimIndent()

    /** The same message from a server before CF1: no `drive` at all. */
    private val withoutDrive = """
        {"id": "m0", "channel_id": "c1", "sender_id": "u1", "seq": 3, "updated_seq": 3, "type": "user", "body": "",
         "mentioned_user_ids": [], "mention_all": false, "reactions": [], "reply_count": 0, "created_at": "2026-09-01T00:00:00Z",
         "deleted": false,
         "attachments": [{"id": "a9", "filename": "a.pdf", "content_type": "application/pdf", "size_bytes": 5, "has_thumbnail": false,
                          "status": "attached", "created_at": "2026-09-01T00:00:00Z"}]}
    """.trimIndent()

    private fun attachment(state: String?, itemId: String? = "i1") = AttachmentOut(
        id = "a", filename = "f.pdf", contentType = "application/pdf", sizeBytes = 1,
        drive = state?.let { AttachmentDriveOut(itemId = itemId, versionId = "v", versionNumber = 1, state = it) },
    )

    private fun channel(type: String, filesToDrive: Boolean? = null, archived: Boolean = false) = ChannelOut(
        id = "c1", type = type, name = "m2-seminar", archived = archived, lastSeq = 0, createdAt = "", updatedAt = "", filesToDrive = filesToDrive,
    )

    @Test
    fun theDriveFieldDecodesAndSurvivesTheStoreAndAnOlderServerStillDecodes() {
        val message = Codec.snake.decodeFromString(MessageOut.serializer(), withDrive)
        assertEquals(AttachmentDriveOut("i1", "v1", 1, "available"), message.attachments[0].drive)
        assertNull(message.attachments[1].drive)
        assertEquals(AttachmentDriveOut(null, null, null, "deleted"), message.attachments[2].drive)
        // Persisted as JSON (Room's rows, no migration) and back to the wire shape for the thread rows.
        val state = MessageState.from(message)
        val persisted = Codec.plain.decodeFromString(MessageState.serializer(), Codec.plain.encodeToString(MessageState.serializer(), state))
        assertEquals(message.attachments, persisted.attachments)
        assertEquals(message.attachments, persisted.toOut()?.attachments)
        // A row stored by the app before CF4 (no `drive` key) and a server before CF1 read as plain attachments.
        val old = Codec.snake.decodeFromString(MessageOut.serializer(), withoutDrive)
        assertNull(old.attachments.single().drive)
        assertEquals(ChannelFiles.Look.PLAIN, ChannelFiles.look(old.attachments.single()))
    }

    @Test
    fun eachStateHasItsLookAndNothingOfADeletedFileShows() {
        assertEquals(ChannelFiles.Look.PLAIN, ChannelFiles.look(attachment(null)))
        assertEquals(ChannelFiles.Look.PLAIN, ChannelFiles.look(attachment("available")))
        assertEquals(ChannelFiles.Look.MOVED, ChannelFiles.look(attachment("moved")))
        assertEquals(ChannelFiles.Look.DELETED, ChannelFiles.look(attachment("trashed")))
        assertEquals(ChannelFiles.Look.DELETED, ChannelFiles.look(attachment("deleted", itemId = null)))
        // A state this app does not know yet shows nothing of the file (the safe side), as a moved one without an item.
        assertEquals(ChannelFiles.Look.DELETED, ChannelFiles.look(attachment("archived")))
        assertEquals(ChannelFiles.Look.DELETED, ChannelFiles.look(attachment("moved", itemId = null)))
        // 「ドライブで表示」: in the channel's drive or moved, never from the trash or a tombstone.
        assertEquals("i1", ChannelFiles.driveItem(attachment("available")))
        assertEquals("i1", ChannelFiles.driveItem(attachment("moved")))
        assertNull(ChannelFiles.driveItem(attachment("trashed")))
        assertNull(ChannelFiles.driveItem(attachment(null)))
        // 「戻す」: a file in the trash, for who can write the channel's drive (unknown: not offered).
        assertTrue(ChannelFiles.canRestore(attachment("trashed"), true))
        assertFalse(ChannelFiles.canRestore(attachment("trashed"), false))
        assertFalse(ChannelFiles.canRestore(attachment("trashed"), null))
        assertFalse(ChannelFiles.canRestore(attachment("deleted", itemId = null), true))
        assertFalse(ChannelFiles.canRestore(attachment("available"), true))
        assertTrue(ChannelFiles.hasPostedFiles(listOf(attachment(null), attachment("trashed"))))
        assertFalse(ChannelFiles.hasPostedFiles(listOf(attachment(null), attachment("deleted", itemId = null))))
        assertEquals(listOf("i1"), ChannelFiles.itemIds(listOf(attachment(null), attachment("moved"), attachment("deleted", itemId = null))))
    }

    @Test
    fun theDeleteConfirmationAsksOnlyWhenAFileWouldGoToTheTrash() {
        val wire = """{"files": [
            {"attachment_id": "a1", "item_id": "i1", "state": "available", "trash": true, "reason": null},
            {"attachment_id": "a2", "item_id": "i2", "state": "available", "trash": false, "reason": "changed"},
            {"attachment_id": "a3", "item_id": "i3", "state": "moved", "trash": false, "reason": "moved"}]}"""
        val files = Codec.snake.decodeFromString(DriveMessageFilesOut.serializer(), wire).files
        assertEquals(DriveMessageFileOut("a2", "i2", "available", false, "changed"), files[1])
        val plan = ChannelFiles.DeletePlan.of(files)
        assertEquals(ChannelFiles.DeletePlan(trash = 1, changed = 1, stay = 1), plan)
        assertTrue(plan.asks)
        assertEquals("auto", plan.query(ticked = true))
        assertEquals("keep", plan.query(ticked = false))
        // Nothing to trash (someone else's files, or changed ones): no checkbox, nothing sent.
        val none = ChannelFiles.DeletePlan.of(files.drop(1))
        assertFalse(none.asks)
        assertNull(none.query(ticked = true))
        assertNull(ChannelFiles.DeletePlan.of(emptyList()).query(ticked = false))
    }

    @Test
    fun theComposerSaysWhereFilesGoInChannelsOnly() {
        val on = WorkspaceSettingsOut(channelFilesToDrive = true)
        val off = WorkspaceSettingsOut(channelFilesToDrive = false)
        assertTrue(ChannelFiles.filesGoToDrive(channel("public"), on))
        assertTrue(ChannelFiles.filesGoToDrive(channel("private"), on))
        assertFalse(ChannelFiles.filesGoToDrive(channel("dm"), on))
        assertFalse(ChannelFiles.filesGoToDrive(channel("group_dm"), on))
        assertFalse(ChannelFiles.filesGoToDrive(channel("public", archived = true), on))
        // The channel's own choice wins over the workspace's.
        assertFalse(ChannelFiles.filesGoToDrive(channel("public", filesToDrive = false), on))
        assertTrue(ChannelFiles.filesGoToDrive(channel("public", filesToDrive = true), off))
        assertFalse(ChannelFiles.filesGoToDrive(channel("public"), off))
        assertFalse(ChannelFiles.filesGoToDrive(null, on))
        // A server before CF1 sends no switch: it files nothing, so the line never shows.
        assertFalse(Codec.snake.decodeFromString(WorkspaceSettingsOut.serializer(), """{"show_membership_messages": true}""").channelFilesToDrive)
        assertTrue(Codec.snake.decodeFromString(WorkspaceSettingsOut.serializer(), """{"channel_files_to_drive": true}""").channelFilesToDrive)
        val decoded = Codec.snake.decodeFromString(ChannelOut.serializer(),
            """{"id": "c1", "type": "public", "archived": false, "last_seq": 0, "created_at": "", "updated_at": "", "files_to_drive": false, "files_to_drive_effective": false}""")
        assertEquals(false, decoded.filesToDrive)
        assertEquals(ChannelFiles.Choice.OFF, ChannelFiles.Choice.of(decoded.filesToDrive))
        assertEquals(ChannelFiles.Choice.WORKSPACE, ChannelFiles.Choice.of(null))
        assertEquals(listOf(null, true, false), ChannelFiles.Choice.entries.map { it.value })
        assertEquals("ワークスペースに従う（する）", ChannelFiles.choiceLabel(ChannelFiles.Choice.WORKSPACE, true))
        assertEquals("しない", ChannelFiles.choiceLabel(ChannelFiles.Choice.OFF, true))
        assertEquals("all", ChannelFiles.origin(true))
        assertEquals("uploads", ChannelFiles.origin(false))
    }

    @Test
    fun theSpecialFolderReadsInTheUiLanguageWithItsOwnIcon() {
        val wire = """{"id": "p1", "location_id": "loc", "parent_id": "root", "kind": "folder", "name": "投稿のファイル",
            "size_bytes": null, "content_type": null, "content_modified_at": null, "created_by": null, "created_at": "",
            "updated_by": null, "updated_at": "", "version_count": 0, "file": null, "link_count": 0, "trashed_at": null,
            "trashed_by": null, "system_role": "channel_posts", "posted": false, "posts": null}"""
        val folder = Codec.snake.decodeFromString(DriveItemOut.serializer(), wire)
        assertTrue(folder.isChannelPosts)
        assertEquals("投稿のファイル", DriveNames.displayName(folder))
        assertEquals(DriveNames.Icon.CHANNEL_POSTS, DriveNames.icon(folder))
        val plain = folder.copy(id = "f2", name = "論文", systemRole = null)
        assertEquals("論文", DriveNames.displayName(plain))
        assertEquals(DriveNames.Icon.FOLDER, DriveNames.icon(plain))
        // Crumbs carry no role: an id seen with one, or the channel drive's top folder of the server's name.
        val path = listOf(DriveCrumb("root", "m2-seminar"), DriveCrumb("p1", "投稿のファイル"), DriveCrumb("m", "2026-10"))
        assertEquals("#m2-seminar › 投稿のファイル › 2026-10", DriveNames.pathLine(path, "channel"))
        val moved = listOf(DriveCrumb("root", "研究室ドライブ"), DriveCrumb("x", "論文"), DriveCrumb("p9", "投稿のファイル"))
        assertEquals("研究室ドライブ › 論文 › 投稿のファイル", DriveNames.pathLine(moved, "workspace"))
        // A file from a post, with the messages showing it.
        val file = Codec.snake.decodeFromString(DriveItemOut.serializer(),
            """{"id": "i1", "kind": "file", "name": "ゼミ資料.pdf", "created_at": "", "updated_at": "", "posted": true,
                "posts": [{"message_id": "m1", "channel_id": "c1", "parent_id": "r1", "sender_id": "u1", "version_number": 1,
                           "posted_at": "2026-10-28T06:02:00Z"}]}""")
        assertTrue(file.posted)
        assertEquals(DrivePostOut("m1", "c1", "r1", "u1", 1, "2026-10-28T06:02:00Z"), file.posts?.single())
        assertEquals("三井 · 10/28 15:02 · #m2-seminar（スレッド）", ChannelFiles.postLine(file.posts.orEmpty().single(), "三井", "m2-seminar", "10/28 15:02"))
        assertEquals("10/28 15:02 · #m2-seminar", ChannelFiles.postLine(file.posts.orEmpty().single().copy(parentId = null), null, "m2-seminar", "10/28 15:02"))
    }

    private class FakeDrive : DriveApi {
        val items = HashMap<String, () -> DriveItemDetailOut>()
        var reads = 0
        val origins = mutableListOf<String>()
        var locations = DriveLocationListOut()
        override suspend fun driveLocations() = locations
        override suspend fun resolveDriveLocation(channelId: String?) = DriveLocationOut(id = "l", kind = "channel", channelId = channelId, rootId = "r")
        override suspend fun driveChildren(folderId: String, sort: String, order: String, cursor: String?, limit: Int): DriveChildrenOut = throw ApiException.Api(404, "drive_item_not_found", "gone")
        override suspend fun driveItem(itemId: String): DriveItemDetailOut {
            reads += 1
            return (items[itemId] ?: throw ApiException.Api(404, "drive_item_not_found", "gone"))()
        }
        override suspend fun searchDrive(q: String, locationId: String?, cursor: String?, limit: Int, origin: String): DriveSearchOut {
            origins += origin
            return DriveSearchOut()
        }
        override suspend fun driveDownloadTicket(itemId: String) = DriveDownloadTicketOut("/t")
        override suspend fun driveZip(itemIds: List<String>) = DriveZipOut("/z")
    }

    @Test
    fun aMovedFileIsProbedOnceAndReadAgainWhenItsMessageChanges() = runBlocking {
        val api = FakeDrive()
        val hub = DriveHub(api, CoroutineScope(Dispatchers.Unconfined), clock = { 0L }, debounceMs = 0)
        // Moved where I cannot read it: 「表示できないファイル」, from the cache the next time.
        assertEquals(DriveLinkState.Unreadable, hub.link("i1"))
        assertEquals(DriveLinkState.Unreadable, hub.link("i1"))
        assertEquals(1, api.reads)
        // message.updated (moved back, or somewhere I can read): forgotten, read again.
        api.items["i1"] = { DriveItemDetailOut(DriveItemOut(id = "i1", name = "ゼミ資料.pdf"), listOf(DriveCrumb("r", "研究室ドライブ")), "workspace") }
        hub.forget(listOf("i1", "unknown"))
        assertNull(hub.peekLink("i1"))
        assertTrue(hub.link("i1") is DriveLinkState.Ok)
        assertEquals(2, api.reads)
        // Whether I can write the channel's drive (「戻す」): unknown before the locations, then by the channel's location.
        assertNull(hub.canWriteChannelDrive("c1"))
        api.locations = DriveLocationListOut(listOf(DriveLocationOut(id = "l1", kind = "channel", channelId = "c1", rootId = "r1", canWrite = true)))
        hub.loadLocations()
        assertEquals(true, hub.canWriteChannelDrive("c1"))
        assertEquals(false, hub.canWriteChannelDrive("c2"))
        // A 「投稿のファイル」 seen in a listing names its crumb wherever it is (even renamed by an older server's rule).
        hub.noteItems(listOf(DriveItemOut(id = "p9", kind = "folder", name = "投稿のファイル", systemRole = "channel_posts")))
        assertTrue("p9" in hub.systemFolders)
    }

    @Test
    fun theDriveSearchSendsTheOriginChosen() = runBlocking {
        val api = FakeDrive()
        val loader = DriveSearchLoader(api, "loc", ::describeDriveError)
        loader.search("資料")
        loader.origin = ChannelFiles.origin(false)
        loader.search("資料")
        assertEquals(listOf("all", "uploads"), api.origins)
    }
}
