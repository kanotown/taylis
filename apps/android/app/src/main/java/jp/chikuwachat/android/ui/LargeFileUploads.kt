package jp.chikuwachat.android.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.platform.DriveUploadCenter
import jp.chikuwachat.android.platform.driveUploadError
import jp.chikuwachat.android.sync.LargeFiles
import jp.chikuwachat.android.sync.UploadState

/**
 * CF5 (docs/CHANNEL_FILES.md §12.4, 「CF5 の Android」): the composer's files over the attachments' limit, on their way to the drive
 * (the background upload of DriveUploadCenter: it goes on with the app closed). One row each under the chips — name,
 * state and progress, where it goes, × (取りやめる) and, once failed, やり直す — and one line saying the link comes into
 * the message when it is done. Sending stays possible meanwhile. A thin outline; no coloured side bar.
 */
@Composable
fun LargeFileUploads(controller: AppController, channelId: String, parentId: String?) {
    val all by DriveUploadCenter.jobs.collectAsState()
    val live by DriveUploadCenter.live.collectAsState()
    val jobs = LargeFiles.composerJobs(all, controller.activeKey, controller.store.me?.id, channelId, parentId)
    if (jobs.isEmpty()) return
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (job in jobs) {
            val failed = job.state == UploadState.FAILED
            val sent = maxOf(job.sentBytes, live[job.id] ?: 0L).coerceAtMost(job.size)
            val status = LargeFiles.status(job, live[job.id], ::driveUploadError)
            Row(
                Modifier.fillMaxWidth()
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
                    .padding(start = 10.dp)
                    .semantics { contentDescription = L10n.str(R.string.large_file_row, job.name) + "、" + status },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    if (failed) Icons.Outlined.ErrorOutline else Icons.Outlined.CloudUpload, contentDescription = null,
                    tint = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp),
                )
                Column(Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 6.dp)) {
                    FileNameText(job.name, style = MaterialTheme.typography.bodySmall)
                    val where = job.label.takeIf { it.isNotEmpty() && job.parentId.isNotEmpty() }
                    Text(
                        listOfNotNull(status, where).joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                    if (!failed && job.state != UploadState.DONE) {
                        val fraction = if (job.size > 0) sent.toFloat() / job.size else 0f
                        if (job.state == UploadState.PREPARING || job.state == UploadState.COMPLETING) {
                            LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp).height(2.dp))
                        } else {
                            LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp).height(2.dp))
                        }
                    }
                }
                if (failed && job.error != "read_failed") {
                    IconButton(onClick = { DriveUploadCenter.retry(context, job.id) }) {
                        Icon(Icons.Outlined.Refresh, stringResource(R.string.drive_upload_retry), modifier = Modifier.size(20.dp))
                    }
                }
                if (job.state != UploadState.DONE) {
                    IconButton(onClick = { DriveUploadCenter.cancel(context, controller.scope, job.id) }) {
                        Icon(Icons.Outlined.Close, stringResource(R.string.drive_upload_cancel), modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
        val mine = jobs.any { (it.post?.resolved ?: it.post?.place) == LargeFiles.PLACE_MINE }
        val limit = controller.store.limits?.maxAttachmentBytes
        Text(
            if (mine) stringResource(R.string.large_file_note_mine)
            else stringResource(R.string.large_file_note, limit?.let { formatSize(it) } ?: "100 MB"),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 4.dp),
        )
    }
}
