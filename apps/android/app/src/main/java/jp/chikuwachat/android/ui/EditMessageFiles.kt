package jp.chikuwachat.android.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelFiles
import jp.chikuwachat.android.sync.DriveLinkState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * M186 (docs/CHANNEL_FILES.md §7.6; the same on Desktop / Web and iOS): an edit takes files off a message and adds new
 * ones. These decide; [EditFilesSection] draws the edit dialog's part.
 */
object EditFiles {
    /**
     * The save's `attachment_ids`: the files left (in their place) and the new uploads after them. Null when they are the
     * message's files as they were: a body-only edit, as before M186 (and what a server before M186 understands).
     */
    fun attachmentIds(original: List<String>, files: List<String>): List<String>? = files.takeIf { it != original }

    /**
     * Save: not while a file is on its way or failed (taken out or tried again first), and something must be left —
     * the body, or a file (a message of files only may have no text).
     */
    fun canSave(body: String, files: Int, uploads: Int, saving: Boolean): Boolean =
        !saving && uploads == 0 && (body.isNotBlank() || files > 0)

    /** Whether `adding` more fit next to the `held` files and uploads (the composer's 「添付は10件までです」). */
    fun fits(held: Int, adding: Int, max: Int): Boolean = held + adding <= max

    /**
     * A server before M186 ignores `attachment_ids` and answers with the files as they were: the body is saved, the files
     * are not (「このサーバではファイルを変更できません」). Compared as sets: the server puts the new ones in the order they
     * were uploaded, which need not be the order they finished here.
     */
    fun ignoredByServer(sent: List<String>?, answer: List<String>): Boolean = sent != null && sent.toSet() != answer.toSet()
}

/**
 * One edit's files while its dialog is open: the message's files (one taken off is gone from [files]) with the new uploads
 * after them, and the picked files on their way or failed ([uploads]). The controller holds it per message
 * ([AppController.messageEdits]): a rotation keeps it, and an upload finishes into it. Closing the dialog ([end]) leaves
 * the new uploads to the server's GC (24 hours), as the composer's.
 */
class EditFilesSession(original: List<AttachmentOut>, private val max: Int, private val describe: (Throwable) -> String) {
    /** A picked file going up; [failed] is why once it did not (× takes it out, 「もう一度」 tries again). */
    class Upload(val name: String, internal val send: suspend () -> Result<AttachmentOut>, private val cleanup: () -> Unit = {}) {
        var failed by mutableStateOf<String?>(null)
            internal set
        private var released = false

        /** The camera's photo is removed once it is up, taken out, or the dialog closed. */
        internal fun release() {
            if (released) return
            released = true
            cleanup()
        }
    }

    val originalIds: List<String> = original.map { it.id }
    val files = mutableStateListOf<AttachmentOut>().apply { addAll(original) }
    val uploads = mutableStateListOf<Upload>()

    /** More were picked than the limit leaves room for: none of them went up (the composer's rule). */
    var overLimit by mutableStateOf(false)
        private set
    private var ended = false

    val full: Boolean get() = files.size + uploads.size >= max
    val limit: Int get() = max

    /** The save's `attachment_ids` ([EditFiles.attachmentIds]). */
    fun attachmentIds(): List<String>? = EditFiles.attachmentIds(originalIds, files.map { it.id })

    fun canSave(body: String, saving: Boolean): Boolean = EditFiles.canSave(body, files.size, uploads.size, saving)

    fun remove(file: AttachmentOut) {
        files.remove(file)
        overLimit = false
    }

    /** Starts the uploads; none when they would not fit (false, and [overLimit] says so). */
    fun add(picked: List<Upload>, scope: CoroutineScope): Boolean {
        if (picked.isEmpty()) return true
        if (ended || !EditFiles.fits(files.size + uploads.size, picked.size, max)) {
            overLimit = !ended
            picked.forEach { it.release() }
            return false
        }
        overLimit = false
        uploads.addAll(picked)
        picked.forEach { start(it, scope) }
        return true
    }

    fun retry(upload: Upload, scope: CoroutineScope) {
        if (upload in uploads && upload.failed != null) start(upload, scope)
    }

    fun discard(upload: Upload) {
        if (uploads.remove(upload)) upload.release()
        overLimit = false
    }

    /** The dialog closed (saved or not): a failed one is let go now, one still on its way when it is over. */
    fun end() {
        ended = true
        uploads.filter { it.failed != null }.forEach { it.release() }
        uploads.clear()
    }

    private fun start(upload: Upload, scope: CoroutineScope) {
        upload.failed = null
        scope.launch {
            val result = upload.send()
            if (ended || upload !in uploads) {
                upload.release()
                return@launch
            }
            result
                .onSuccess {
                    uploads.remove(upload)
                    files.add(it)
                    upload.release()
                }
                .onFailure { upload.failed = describe(it) }
        }
    }
}

/**
 * M186 (§7.6): the edit dialog's files under the text. Photos and videos as the composer's tiles, other files, a
 * 「削除されたファイル」 and one moved where I cannot read it as one-line rows; each with a × 「名前 を外す」. Then the uploads
 * (a spinner tile; a failed one as a row with 「もう一度」) and 「ファイルを追加」 with the composer's choices.
 */
@Composable
fun EditFilesSection(session: EditFilesSession, controller: AppController, enabled: Boolean) {
    val hub = controller.drive
    hub?.version?.collectAsState()?.value
    fun look(attachment: AttachmentOut): ChannelFiles.Look = when (val look = ChannelFiles.look(attachment)) {
        ChannelFiles.Look.MOVED ->
            if (attachment.drive?.itemId?.let { hub?.peekLink(it) } is DriveLinkState.Ok) ChannelFiles.Look.PLAIN else look
        else -> look
    }
    val media = session.files.filter { look(it) == ChannelFiles.Look.PLAIN && (it.isImage || it.isVideo) }
    val rows = session.files.filter { it !in media }
    val going = session.uploads.filter { it.failed == null }
    val failed = session.uploads.filter { it.failed != null }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (media.isNotEmpty() || going.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                media.forEach { file ->
                    key(file.id) {
                        PendingTile(file, controller, removeLabel = L10n.str(R.string.message_edit_remove_file, file.filename), enabled = enabled) { session.remove(file) }
                    }
                }
                going.forEach { UploadingTile() }
            }
        }
        rows.forEach { file ->
            key(file.id) {
                when (look(file)) {
                    // Never the name of a file in the trash, deleted or moved out of my sight (§12.1): what the message shows.
                    ChannelFiles.Look.DELETED -> {
                        val label = stringResource(R.string.channel_files_deleted)
                        EditFileRow(Icons.Outlined.Delete, label, L10n.str(R.string.message_edit_remove_file, label), enabled) { session.remove(file) }
                    }
                    ChannelFiles.Look.MOVED -> {
                        val label = stringResource(R.string.drive_card_unavailable)
                        EditFileRow(Icons.Outlined.Lock, label, L10n.str(R.string.message_edit_remove_file, label), enabled) { session.remove(file) }
                    }
                    ChannelFiles.Look.PLAIN -> EditFileRow(
                        Icons.Outlined.Description, file.filename, L10n.str(R.string.message_edit_remove_file, file.filename), enabled,
                        isName = true, detail = formatSize(file.sizeBytes),
                    ) { session.remove(file) }
                }
            }
        }
        failed.forEach { upload ->
            EditFileRow(
                Icons.Outlined.WarningAmber, upload.name, L10n.str(R.string.message_edit_remove_file, upload.name), enabled,
                isName = true, detail = upload.failed, detailIsError = true,
                onRetry = { session.retry(upload, controller.scope) },
            ) { session.discard(upload) }
        }
        if (session.overLimit || session.full) {
            Text(
                stringResource(R.string.composer_you_can_attach_up_to_files, session.limit),
                style = MaterialTheme.typography.bodySmall, color = if (session.overLimit) MaterialTheme.colorScheme.error else muted,
            )
        }
        AddFilesButton(session, controller, enabled = enabled && !session.full)
    }
}

/** 「ファイルを追加」: the composer's photo library, camera and files; what is picked goes up into the session. */
@Composable
private fun AddFilesButton(session: EditFilesSession, controller: AppController, enabled: Boolean) {
    fun pick(uris: List<android.net.Uri>, cleanup: () -> Unit = {}) {
        if (uris.isEmpty()) return
        controller.scope.launch {
            val names = controller.fileFacts(uris).map { it.first }
            session.add(
                uris.mapIndexed { index, uri ->
                    EditFilesSession.Upload(
                        names.getOrNull(index)?.ifEmpty { null } ?: "file",
                        send = { controller.uploadAttachment(uri, report = false) },
                        // Only the camera hands over a file to remove (one photo).
                        cleanup = if (uris.size == 1) cleanup else ({}),
                    )
                },
                controller.scope,
            )
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { pick(it) }
    val mediaPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { pick(it) }
    val camera = rememberCameraCapture(controller) { uri, cleanup -> pick(listOf(uri), cleanup) }
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(enabled = enabled, onClick = { open = true }) {
            Icon(Icons.Outlined.AttachFile, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.message_edit_add_files))
        }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.composer_photos_videos)) },
                leadingIcon = { Icon(Icons.Outlined.PhotoLibrary, contentDescription = null) },
                onClick = { open = false; mediaPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
            )
            if (camera != null) DropdownMenuItem(
                text = { Text(stringResource(R.string.composer_camera)) },
                leadingIcon = { Icon(Icons.Outlined.PhotoCamera, contentDescription = null) },
                onClick = { open = false; camera() },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.common_files)) },
                leadingIcon = { Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, contentDescription = null) },
                onClick = { open = false; picker.launch("*/*") },
            )
        }
    }
}

/** One file as a row (a file name, or a quiet label for one whose name is not shown) with a ×; a failed upload's 「もう一度」. */
@Composable
private fun EditFileRow(
    icon: ImageVector,
    label: String,
    removeLabel: String,
    enabled: Boolean,
    isName: Boolean = false,
    detail: String? = null,
    detailIsError: Boolean = false,
    onRetry: (() -> Unit)? = null,
    onRemove: () -> Unit,
) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp)).padding(start = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(icon, contentDescription = null, tint = muted, modifier = Modifier.size(18.dp))
        Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
            if (isName) FileNameText(label, style = MaterialTheme.typography.bodySmall)
            else Text(label, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (detail != null) Text(
                detail, style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                color = if (detailIsError) MaterialTheme.colorScheme.error else muted,
            )
        }
        if (onRetry != null) TextButton(enabled = enabled, onClick = onRetry) { Text(stringResource(R.string.common_try_again)) }
        IconButton(enabled = enabled, onClick = onRemove, modifier = Modifier.semantics { contentDescription = removeLabel }) {
            Icon(Icons.Outlined.Close, contentDescription = null, modifier = Modifier.size(18.dp))
        }
    }
}
