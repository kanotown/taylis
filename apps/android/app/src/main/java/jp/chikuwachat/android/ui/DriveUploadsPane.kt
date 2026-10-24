package jp.chikuwachat.android.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.platform.DriveUploadCenter
import jp.chikuwachat.android.platform.driveUploadError
import jp.chikuwachat.android.sync.ConflictChoice
import jp.chikuwachat.android.sync.DriveNames
import jp.chikuwachat.android.sync.DriveUploadJob
import jp.chikuwachat.android.sync.DriveUploadRules
import jp.chikuwachat.android.sync.UploadState
import jp.chikuwachat.android.sync.describeDriveError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.util.UUID

/*
 * 2026-10-24 (docs/DRIVE.md §6, MOBILE_UI.md §25): uploads into the drive from the phone — the ＋ of a folder one can
 * write to (写真・動画 / カメラで撮る / ファイル / 新しいフォルダ), the uploads bar under the folder and its sheet (each
 * file's name, progress, state, 取りやめる / やり直す / 選ぶ, 完了したものを消す), and the question of a name conflict.
 * Plain rows and a thin divider; no coloured side bars.
 */

/** The jobs of the account on screen (its server and user), newest last. */
@Composable
internal fun myDriveUploads(controller: AppController): List<DriveUploadJob> {
    val all by DriveUploadCenter.jobs.collectAsState()
    val server = controller.activeKey ?: return emptyList()
    val me = controller.store.me?.id
    return all.filter { it.serverUrl == server && (me == null || it.userId == me) }
}

/** The ＋ of a writable folder: files from the photo picker, the camera or the system's picker, or a new folder. */
@Composable
internal fun DriveUploadButton(controller: AppController, locationId: String, folderId: String, label: String, onFolderMade: (DriveItemOut) -> Unit) {
    val context = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    var naming by rememberSaveable { mutableStateOf(false) }
    fun target(): DriveUploadCenter.Target? {
        val server = controller.activeKey ?: return null
        val (userId, session) = controller.shareAccount(server) ?: return null
        return DriveUploadCenter.Target(server, userId, session, locationId, folderId, label)
    }
    fun add(uris: List<Uri>, cleanup: (() -> Unit)? = null) {
        val target = target()
        if (uris.isEmpty() || target == null) { cleanup?.invoke(); return }
        DriveUploadCenter.addUris(context, controller.scope, uris, target, cleanup)
    }
    val media = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(50)) { add(it) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { add(it) }
    val camera = rememberCameraCapture(controller) { uri, cleanup -> add(listOf(uri), cleanup) }
    Box {
        IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.Add, stringResource(R.string.drive_upload)) }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.drive_upload_photos)) }, leadingIcon = { Icon(Icons.Outlined.PhotoLibrary, null) },
                onClick = { menu = false; media.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) })
            if (camera != null) DropdownMenuItem(text = { Text(stringResource(R.string.drive_upload_camera)) }, leadingIcon = { Icon(Icons.Outlined.PhotoCamera, null) },
                onClick = { menu = false; camera() })
            DropdownMenuItem(text = { Text(stringResource(R.string.drive_upload_files)) }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null) },
                onClick = { menu = false; files.launch(arrayOf("*/*")) })
            HorizontalDivider()
            DropdownMenuItem(text = { Text(stringResource(R.string.drive_new_folder)) }, leadingIcon = { Icon(Icons.Outlined.CreateNewFolder, null) },
                onClick = { menu = false; naming = true })
        }
    }
    if (naming) NewFolderDialog(controller, folderId, onDismiss = { naming = false }, onMade = { naming = false; onFolderMade(it) })
}

/** 「新しいフォルダ」: POST /drive/folders; a retry of the same dialog sends the same client_op_id (one folder). */
@Composable
internal fun NewFolderDialog(controller: AppController, parentId: String, onDismiss: () -> Unit, onMade: (DriveItemOut) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val opId = rememberSaveable(parentId) { UUID.randomUUID().toString() }
    var sentName by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.drive_new_folder)) },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it; error = null }, singleLine = true, label = { Text(stringResource(R.string.drive_new_folder_name)) })
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp)) }
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank() && !busy, onClick = {
                val api = controller.driveWriteApi ?: return@TextButton
                busy = true
                scope.launch {
                    try {
                        // Another name is another folder: a new key; the same name again (a lost answer) keeps it.
                        val key = if (sentName == null || sentName == name.trim()) opId else UUID.randomUUID().toString()
                        sentName = name.trim()
                        onMade(api.createDriveFolder(parentId, name.trim(), key))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = describeDriveError(e)
                    } finally {
                        busy = false
                    }
                }
            }) { Text(stringResource(R.string.drive_new_folder_create)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/** Under a drive screen while the account has uploads: how far they are; a tap opens the sheet. */
@Composable
internal fun DriveUploadsBar(controller: AppController) {
    val jobs = myDriveUploads(controller)
    if (jobs.isEmpty()) return
    val live by DriveUploadCenter.live.collectAsState()
    val totals = DriveUploadRules.totals(jobs, live)
    Surface(tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = stringResource(R.string.drive_uploads_show)) { controller.driveUploadsShown = true }
            .padding(horizontal = 16.dp, vertical = 8.dp)) {
            HorizontalDivider(Modifier.padding(bottom = 6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(L10n.str(R.string.drive_uploads_title, totals.done, totals.files), style = MaterialTheme.typography.labelLarge)
                    Text(
                        L10n.str(R.string.drive_progress, DriveNames.bytes(totals.sent), DriveNames.bytes(totals.bytes)) +
                            if (totals.failed > 0) " · " + L10n.str(R.string.drive_upload_state_failed, totals.failed.toString()) else "",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Icon(Icons.Outlined.ExpandLess, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (totals.pending > 0 && totals.bytes > 0) {
                LinearProgressIndicator(progress = { (totals.sent.toFloat() / totals.bytes).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
            }
        }
    }
}

/** The uploads sheet (opened from the bar or a notification) and a name conflict's question, wherever the app is. */
@Composable
fun DriveUploadDialogs(controller: AppController) {
    val jobs = myDriveUploads(controller)
    if (controller.driveUploadsShown) DriveUploadsSheet(controller, jobs) { controller.driveUploadsShown = false }
    // One question at a time (the oldest first), while the app is in front.
    val asking = jobs.firstOrNull { it.state == UploadState.ASKING }
    if (asking != null && controller.appForeground) ConflictQuestion(controller, asking, DriveUploadRules.remainingInBatch(jobs, asking))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DriveUploadsSheet(controller: AppController, jobs: List<DriveUploadJob>, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val live by DriveUploadCenter.live.collectAsState()
    val totals = DriveUploadRules.totals(jobs, live)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(L10n.str(R.string.drive_uploads_title, totals.done, totals.files), style = MaterialTheme.typography.titleMedium)
                    Text(L10n.str(R.string.drive_progress, DriveNames.bytes(totals.sent), DriveNames.bytes(totals.bytes)),
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (jobs.any { it.isFinished }) TextButton(onClick = { controller.activeKey?.let { DriveUploadCenter.clearFinished(context, it) } }) {
                    Text(stringResource(R.string.drive_uploads_clear))
                }
            }
            HorizontalDivider(Modifier.padding(top = 8.dp))
            if (jobs.isEmpty()) {
                Text(stringResource(R.string.drive_uploads_empty), Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 520.dp)) {
                items(jobs.asReversed(), key = { it.id }) { job -> UploadRow(controller, job, live[job.id]) }
            }
            Spacer(Modifier.size(12.dp))
        }
    }
}

/** A job's state in words (the desktop's drive.upload.* wording). */
internal fun uploadStateText(job: DriveUploadJob): String = when (job.state) {
    UploadState.PREPARING -> L10n.str(R.string.drive_upload_state_preparing)
    UploadState.QUEUED -> L10n.str(R.string.drive_upload_state_queued)
    UploadState.UPLOADING -> L10n.str(R.string.drive_upload_state_uploading)
    UploadState.COMPLETING -> L10n.str(R.string.drive_upload_state_completing)
    UploadState.WAITING -> L10n.str(R.string.drive_upload_state_waiting)
    UploadState.ASKING -> L10n.str(R.string.drive_upload_state_asking)
    UploadState.DONE -> L10n.str(R.string.drive_upload_state_done)
    UploadState.SKIPPED -> L10n.str(R.string.drive_upload_state_skipped)
    UploadState.CANCELLED -> L10n.str(R.string.drive_upload_state_cancelled)
    else -> L10n.str(R.string.drive_upload_state_failed, driveUploadError(job.error) ?: jp.chikuwachat.android.api.ErrorTexts.unknown)
}

@Composable
private fun UploadRow(controller: AppController, job: DriveUploadJob, live: Long?) {
    val context = LocalContext.current
    val sent = if (job.state == UploadState.DONE) job.size else maxOf(job.sentBytes, live ?: 0L).coerceAtMost(job.size)
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                FileNameText(job.name)
                Text(L10n.str(R.string.drive_upload_to, job.label), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            when {
                job.state == UploadState.ASKING -> TextButton(onClick = { controller.driveUploadsShown = false }) { Text(stringResource(R.string.drive_upload_answer)) }
                job.state == UploadState.FAILED && job.error != "read_failed" -> TextButton(onClick = { DriveUploadCenter.retry(context, job.id) }) { Text(stringResource(R.string.drive_upload_retry)) }
            }
            if (!job.isFinished && job.state != UploadState.PREPARING) {
                TextButton(onClick = { DriveUploadCenter.cancel(context, controller.scope, job.id) }) { Text(stringResource(R.string.drive_upload_cancel)) }
            }
        }
        if (!job.isFinished && job.state != UploadState.FAILED && job.size > 0) {
            LinearProgressIndicator(progress = { (sent.toFloat() / job.size).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp))
        }
        val state = uploadStateText(job)
        Text(
            if (job.isFinished || job.state == UploadState.FAILED) state else "$state · " + L10n.str(R.string.drive_progress, DriveNames.bytes(sent), DriveNames.bytes(job.size)),
            style = MaterialTheme.typography.labelSmall,
            color = if (job.state == UploadState.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    HorizontalDivider(Modifier.padding(horizontal = 20.dp))
}

/**
 * The question of a name conflict (the desktop's): 上書きして新しいバージョンにする / 名前を変えて両方残す / スキップ, and
 * 「残りすべてに同じ操作」 while more of the batch remain. A folder of that name cannot take a version: only rename / skip.
 */
@Composable
private fun ConflictQuestion(controller: AppController, job: DriveUploadJob, remaining: Int) {
    val context = LocalContext.current
    var all by remember(job.id) { mutableStateOf(false) }
    fun choose(choice: String) = DriveUploadCenter.answer(context, controller.scope, job.id, choice, all)
    val folder = job.existingKind == "folder"
    AlertDialog(
        onDismissRequest = {},
        title = { Text(stringResource(R.string.drive_conflict_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(L10n.str(if (folder) R.string.drive_conflict_folder_text else R.string.drive_conflict_text, job.name, job.label))
                Spacer(Modifier.size(4.dp))
                if (!folder) TextButton(onClick = { choose(ConflictChoice.VERSION) }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.drive_conflict_version), Modifier.fillMaxWidth())
                }
                TextButton(onClick = { choose(ConflictChoice.RENAME) }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.drive_conflict_rename), Modifier.fillMaxWidth()) }
                TextButton(onClick = { choose(ConflictChoice.SKIP) }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.drive_conflict_skip), Modifier.fillMaxWidth()) }
                if (remaining > 0) {
                    Row(Modifier.fillMaxWidth().clickable(role = Role.Checkbox) { all = !all }, verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = all, onCheckedChange = { all = it })
                        Text(L10n.plural(R.plurals.drive_conflict_all, remaining, remaining), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        },
        confirmButton = {},
    )
}
