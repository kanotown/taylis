package jp.chikuwachat.android.sync

import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.DriveChannelPostsOut
import jp.chikuwachat.android.api.DriveChildrenOut
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DriveLocationOut
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/*
 * CF5 (docs/CHANNEL_FILES.md §12.4, 「CF5 の Android」): a file over the attachments' limit (100 MB) added to the composer, or shared
 * into a conversation, goes up with the drive's background upload (DriveUploadCenter, DRIVE.md §6) instead of being
 * refused, and a `/d/<item_id>` link to it goes into the draft (the composer) or is posted (the share sheet) once it is
 * there. Where it goes (§26, the same on every client): a public or private channel whose files go to its drive → that
 * drive's 「投稿のファイル › 2026-10」 (POST /drive/channel-posts; an older server: the top's listing and `path`); such a
 * channel with the switch off → the channel drive's top; a channel drive I cannot write (an owners-only channel) and a
 * DM → マイドライブ. Plain Kotlin (LargeFilesTest).
 */

/** A drive upload that belongs to a conversation (kept in its [DriveUploadJob]). */
@Serializable
data class DrivePost(
    val channelId: String,
    val parentId: String? = null,
    /** Where it was meant to go: [LargeFiles.PLACE_POSTS] / [LargeFiles.PLACE_CHANNEL] / [LargeFiles.PLACE_MINE]. */
    val place: String,
    /** [LargeFiles.MODE_DRAFT] (the link goes into the draft) or [LargeFiles.MODE_SEND] (the share sheet: it is posted). */
    val mode: String = LargeFiles.MODE_DRAFT,
    /** The idempotency key of the posted link (MODE_SEND), made once with the job. */
    val clientMsgId: String? = null,
    /** 「#general」 for the panel and the notifications. */
    val channelTitle: String = "",
    /** Where it went once resolved (マイドライブ when the channel's drive could not be written). */
    val resolved: String? = null,
    /** The link is in the draft / the message was posted: never twice. */
    val linked: Boolean = false,
    /** CF5 §26: the server's month-folder zone when it said (bootstrap); for a server without POST /drive/channel-posts. */
    val zone: String? = null,
)

/** The calls that find the folder (ApiClient; a fake in LargeFilesTest). */
interface DrivePostApi {
    /** CF5 §26: POST /drive/channel-posts (a server before it: 404 / 405, no such route). */
    suspend fun driveChannelPosts(channelId: String): DriveChannelPostsOut
    suspend fun resolveDriveLocation(channelId: String?): DriveLocationOut
    suspend fun driveChildren(folderId: String, sort: String, order: String, cursor: String?, limit: Int): DriveChildrenOut
    /** POST /drive/folders {parent_id, path}: the folder of that name, made when missing (mkdir -p). */
    suspend fun ensureDriveFolderPath(parentId: String, path: String, clientOpId: String): DriveItemOut
}

object LargeFiles {
    const val PLACE_POSTS = "posts"
    const val PLACE_CHANNEL = "channel"
    const val PLACE_MINE = "mine"
    const val MODE_DRAFT = "draft"
    const val MODE_SEND = "send"

    /**
     * The zone of the month folders when the server does not say (`CHANNEL_FILES_TZ`, default Asia/Tokyo; bootstrap's
     * `channel_files_timezone` since §26). Only a server without POST /drive/channel-posts needs it.
     */
    val MONTH_ZONE: ZoneId = ZoneId.of("Asia/Tokyo")

    fun zoneOf(name: String?): ZoneId = name?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: MONTH_ZONE

    /** Over the attachments' limit (bootstrap `limits`; unknown size or limits: not). */
    fun overLimit(size: Long?, limits: Limits?): Boolean = limits != null && size != null && size > limits.maxAttachmentBytes

    /**
     * Where a large file added in [channel] goes (null: nowhere — an archived or unknown conversation, or a server
     * without the drive: the file is refused as before).
     */
    fun place(channel: ChannelOut?, settings: WorkspaceSettingsOut, driveAvailable: Boolean?): String? {
        channel ?: return null
        if (channel.archived || driveAvailable == false) return null
        return when (channel.type) {
            "public", "private" -> if (ChannelFiles.filesGoToDrive(channel, settings)) PLACE_POSTS else PLACE_CHANNEL
            "dm", "group_dm" -> PLACE_MINE
            else -> null
        }
    }

    /** The question before a large file goes up (§26, asked once): where it goes, as [place] says. */
    fun askText(place: String): String = when (place) {
        PLACE_POSTS -> L10n.str(R.string.large_file_ask_posts)
        PLACE_CHANNEL -> L10n.str(R.string.large_file_ask_channel)
        else -> L10n.str(R.string.large_file_ask_mine)
    }

    /** The files the question is about: 「「a.mp4」（1.2 GB）」, or 「2 件のファイル（合わせて 3 GB）」. */
    fun askFiles(names: List<String>, sizes: List<Long?>, format: (Long) -> String): String {
        val total = sizes.sumOf { it ?: 0L }
        return if (names.size == 1) L10n.str(R.string.large_file_ask_one, names[0], format(total))
        else L10n.str(R.string.large_file_ask_many, names.size, format(total))
    }

    /** The month folder of [nowMs]: 「2026-10」. */
    fun monthName(nowMs: Long, zone: ZoneId = MONTH_ZONE): String =
        DateTimeFormatter.ofPattern("yyyy-MM").format(Instant.ofEpochMilli(nowMs).atZone(zone))

    fun link(baseUrl: String, itemId: String): String = baseUrl.trimEnd('/') + "/d/" + itemId

    /** The draft with [link] added on a line of its own (at the end, after what is typed). */
    fun withLink(text: String, link: String): String = when {
        text.isBlank() -> link
        text.contains(link) -> text
        text.endsWith("\n") -> text + link
        else -> text + "\n" + link
    }

    /** Where a job went: its location, folder and 「#general › 投稿のファイル › 2026-10」. */
    data class Resolved(val locationId: String, val folderId: String, val label: String, val place: String)

    /**
     * Finds the folder of [post] (§12.4, §26): with the channel's files going to its drive, POST /drive/channel-posts
     * names (and makes when missing) 「投稿のファイル › 2026-10」; refused (403: I cannot write the channel's drive) →
     * マイドライブ; the switch off meanwhile → the drive's top. A server without that route: the channel's drive (one I
     * cannot write → マイドライブ), its 「投稿のファイル」 (`system_role = channel_posts`, folders come first in the
     * listing) and the month under it (`path`), or the drive's top while 「投稿のファイル」 is not there yet.
     */
    suspend fun resolve(api: DrivePostApi, post: DrivePost, nowMs: Long, newId: () -> String = { UUID.randomUUID().toString() }): Resolved {
        if (post.place == PLACE_POSTS) {
            val out = try {
                api.driveChannelPosts(post.channelId)
            } catch (e: ApiException.Api) {
                if (e.status == 403) null else if (noChannelPostsRoute(e)) return legacy(api, post, nowMs, newId) else throw e
            }
            if (out != null && out.location.canWrite) {
                val drive = DriveNames.locationName(out.location)
                val month = out.monthFolder
                if (out.postsFolder != null && month != null) {
                    val label = listOf(drive, L10n.str(R.string.channel_files_folder), month.name.ifEmpty { out.month }).joinToString(" › ")
                    return Resolved(out.location.id, month.id, label, PLACE_POSTS)
                }
                return Resolved(out.location.id, out.location.rootId, drive, PLACE_CHANNEL)
            }
            return mine(api)
        }
        return legacy(api, post, nowMs, newId)
    }

    /** A server before §26 (no POST /drive/channel-posts), not a refusal of it. */
    private fun noChannelPostsRoute(e: ApiException.Api): Boolean = e.status == 405 || (e.status == 404 && e.code != "drive_item_not_found")

    private suspend fun mine(api: DrivePostApi): Resolved {
        val mine = api.resolveDriveLocation(null)
        return Resolved(mine.id, mine.rootId, DriveNames.locationName(mine), PLACE_MINE)
    }

    private suspend fun legacy(api: DrivePostApi, post: DrivePost, nowMs: Long, newId: () -> String): Resolved {
        if (post.place != PLACE_MINE) {
            val location = api.resolveDriveLocation(post.channelId)
            if (location.canWrite) {
                val drive = DriveNames.locationName(location)
                if (post.place == PLACE_POSTS) {
                    val posts = postsFolder(api, location.rootId)
                    if (posts != null) {
                        val name = monthName(nowMs, zoneOf(post.zone))
                        val month = api.ensureDriveFolderPath(posts.id, name, newId())
                        val label = listOf(drive, L10n.str(R.string.channel_files_folder), month.name.ifEmpty { name }).joinToString(" › ")
                        return Resolved(location.id, month.id, label, PLACE_POSTS)
                    }
                }
                return Resolved(location.id, location.rootId, drive, PLACE_CHANNEL)
            }
        }
        return mine(api)
    }

    /** 「投稿のファイル」 among the root's folders (listed first; the pages stop at the first file). */
    suspend fun postsFolder(api: DrivePostApi, rootId: String): DriveItemOut? {
        var cursor: String? = null
        repeat(MAX_PAGES) {
            val page = api.driveChildren(rootId, "name", "asc", cursor, 200)
            for (item in page.items) {
                if (!item.isFolder) return null
                if (item.isChannelPosts) return item
            }
            cursor = page.nextCursor ?: return null
        }
        return null
    }

    private const val MAX_PAGES = 20

    /** The job with its folder filled in (and where it went). */
    fun applied(job: DriveUploadJob, resolved: Resolved): DriveUploadJob = job.copy(
        locationId = resolved.locationId, parentId = resolved.folderId, label = resolved.label,
        post = job.post?.copy(resolved = resolved.place),
    )

    /** A job of a conversation still to find its folder. */
    fun needsFolder(job: DriveUploadJob): Boolean = job.post != null && job.parentId.isEmpty()

    /** Finished, its link not yet in the draft (MODE_DRAFT) or posted (MODE_SEND). */
    fun linkPending(job: DriveUploadJob, mode: String): Boolean =
        job.state == UploadState.DONE && job.itemId != null && job.post?.mode == mode && job.post.linked == false

    /** The composer's uploads of one conversation and account (the finished ones whose link went in leave the row). */
    fun composerJobs(jobs: List<DriveUploadJob>, serverUrl: String?, userId: String?, channelId: String, parentId: String?): List<DriveUploadJob> =
        jobs.filter { job ->
            val post = job.post ?: return@filter false
            job.serverUrl == serverUrl && job.userId == userId && post.mode == MODE_DRAFT &&
                post.channelId == channelId && post.parentId == parentId &&
                job.state != UploadState.CANCELLED && job.state != UploadState.SKIPPED && !(job.state == UploadState.DONE && post.linked)
        }

    /** The row's state: 「ドライブにアップロード中 · 45%」, 「準備中」, 「接続を待っています…」, 「失敗（…）」. */
    fun status(job: DriveUploadJob, live: Long?, failure: (String?) -> String?): String {
        val percent = if (job.size > 0) ((maxOf(job.sentBytes, live ?: 0L).coerceAtMost(job.size) * 100) / job.size).toInt() else 0
        return when (job.state) {
            UploadState.PREPARING -> L10n.str(R.string.drive_upload_state_preparing)
            UploadState.WAITING -> L10n.str(R.string.drive_upload_state_waiting)
            UploadState.COMPLETING -> L10n.str(R.string.drive_upload_state_completing)
            UploadState.FAILED -> L10n.str(R.string.drive_upload_state_failed, failure(job.error) ?: "")
            UploadState.DONE -> L10n.str(R.string.large_file_done)
            else -> L10n.str(R.string.large_file_uploading, percent)
        }
    }
}
