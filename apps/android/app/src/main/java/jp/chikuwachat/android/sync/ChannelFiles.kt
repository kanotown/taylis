package jp.chikuwachat.android.sync

import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.DriveMessageFileOut
import jp.chikuwachat.android.api.DrivePostOut
import jp.chikuwachat.android.api.WorkspaceSettingsOut

/**
 * CF4 (docs/CHANNEL_FILES.md §12, §19.3; the same rules as the desktop's CF2 and iOS's CF3): files posted in a public or
 * private channel are items of the channel's drive. What a message shows of each ([look]), what deleting it does to them
 * ([DeletePlan]), whether the composer says where files go ([filesGoToDrive]), the owner's switch ([Choice]) and the
 * drive search's origin. Plain rules: the screens draw, these decide.
 */
object ChannelFiles {
    /** How a message's file shows (§12.1). */
    enum class Look {
        /** A plain attachment, or a posted file still in the channel's drive: as always (with 「ドライブで表示」 when posted). */
        PLAIN,
        /** Moved to another location: shown as usual when I can read it there (`GET /drive/items/{id}`), else 「表示できないファイル」. */
        MOVED,
        /** In the drive's trash or deleted for good: 「削除されたファイル」, never its name or picture. */
        DELETED,
    }

    fun look(attachment: AttachmentOut): Look = when (attachment.drive?.state) {
        null, "available" -> Look.PLAIN
        "moved" -> if (attachment.drive.itemId == null) Look.DELETED else Look.MOVED
        // trashed, deleted, and a state this app does not know yet: nothing of the file (the safe side).
        else -> Look.DELETED
    }

    /** The drive item 「ドライブで表示」 opens: a posted file still there for the message (in the channel's drive, or moved). */
    fun driveItem(attachment: AttachmentOut): String? {
        val drive = attachment.drive ?: return null
        return drive.itemId?.takeIf { drive.state == "available" || drive.state == "moved" }
    }

    /** 「戻す」 under 「削除されたファイル」 (§6.5): a file in the trash (not deleted for good), for who can write the channel's drive. */
    fun canRestore(attachment: AttachmentOut, canWriteChannelDrive: Boolean?): Boolean =
        attachment.drive?.state == "trashed" && attachment.drive.itemId != null && canWriteChannelDrive == true

    /** Whether the message has a file in a drive (the delete's confirmation asks the server what would become of it). */
    fun hasPostedFiles(attachments: List<AttachmentOut>): Boolean =
        attachments.any { it.drive != null && it.drive.state != "deleted" }

    /** The item ids a message's files point at (what a `message.updated` makes the drive's cache read again). */
    fun itemIds(attachments: List<AttachmentOut>): List<String> = attachments.mapNotNull { it.drive?.itemId }

    /**
     * §7.3: the delete's confirmation. `trash` files go to the drive's trash with `drive_files=auto` (the checkbox
     * 「ドライブの n 件のファイルもゴミ箱に移す」, ticked by default); `changed` ones stay (a line says so). With no file to
     * trash there is no checkbox and nothing is sent (the server's `auto` keeps them all anyway).
     */
    data class DeletePlan(val trash: Int, val changed: Int, val stay: Int) {
        val asks: Boolean get() = trash > 0

        /** The `drive_files` to send: `auto` ticked, `keep` unticked; null when nothing would be trashed. */
        fun query(ticked: Boolean): String? = if (!asks) null else if (ticked) "auto" else "keep"

        companion object {
            fun of(files: List<DriveMessageFileOut>): DeletePlan = DeletePlan(
                trash = files.count { it.trash },
                changed = files.count { !it.trash && it.reason == "changed" },
                stay = files.count { !it.trash && it.reason != "changed" },
            )
        }
    }

    /**
     * §12.3: whether files sent here go to the channel's drive: a public or private channel (a DM has no drive), not
     * archived, with the channel's choice, else the workspace's (§19.3: `files_to_drive ?? channel_files_to_drive`).
     */
    fun filesGoToDrive(channel: ChannelOut?, settings: WorkspaceSettingsOut): Boolean {
        channel ?: return false
        if (channel.type != "public" && channel.type != "private") return false
        if (channel.archived) return false
        return channel.filesToDrive ?: channel.filesToDriveEffective ?: settings.channelFilesToDrive
    }

    /** §12.7: the owner's three choices; [Choice.of] reads the channel's `files_to_drive`. */
    enum class Choice(val value: Boolean?) {
        WORKSPACE(null), ON(true), OFF(false);

        companion object {
            fun of(value: Boolean?): Choice = when (value) { null -> WORKSPACE; true -> ON; false -> OFF }
        }
    }

    /** The choice in words: 「ワークスペースに従う（今はする）」 / 「する」 / 「しない」. */
    fun choiceLabel(choice: Choice, workspace: Boolean): String = when (choice) {
        Choice.WORKSPACE -> L10n.str(R.string.channel_files_choice_workspace, L10n.str(if (workspace) R.string.channel_files_choice_on else R.string.channel_files_choice_off))
        Choice.ON -> L10n.str(R.string.channel_files_choice_on)
        Choice.OFF -> L10n.str(R.string.channel_files_choice_off)
    }

    /** §12.6: the drive search's `origin` for 「投稿のファイルを含む」 ticked or not. */
    fun origin(includePosted: Boolean): String = if (includePosted) "all" else "uploads"

    /** §12.2: a post of a file in the details: 「三井 · 10/28 15:02 · #m2-seminar（スレッド）」. */
    fun postLine(post: DrivePostOut, sender: String?, channel: String?, time: String): String {
        val where = channel?.let { "#$it" + if (post.parentId != null) L10n.str(R.string.channel_files_post_in_thread) else "" }
        return listOfNotNull(sender, time.takeIf { it.isNotEmpty() }, where).joinToString(" · ")
    }
}
