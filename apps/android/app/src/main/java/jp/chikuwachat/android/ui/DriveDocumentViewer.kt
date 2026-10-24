package jp.chikuwachat.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import jp.chikuwachat.android.api.AttachmentPreviewOut
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.DriveNames
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** How often a preview being made is looked at again (drive.changed for its folder usually says it first). */
internal const val DRIVE_PREVIEW_POLL_MS = 4_000L

/** The pages' hold for a document (DRIVE.md §27.3; the desktop's DriveDocument): null once there are pages to read. */
internal fun driveDocumentHold(source: DriveNames.DocumentSource, answeredNone: Boolean): DocumentHold? = when (source) {
    DriveNames.DocumentSource.PREVIEW, DriveNames.DocumentSource.ORIGINAL -> null
    DriveNames.DocumentSource.MAKING -> DocumentHold.MAKING
    DriveNames.DocumentSource.FAILED -> DocumentHold.FAILED
    DriveNames.DocumentSource.ASK -> if (answeredNone) DocumentHold.UNAVAILABLE else DocumentHold.MAKING
}

private fun withPreview(item: DriveItemOut, preview: AttachmentPreviewOut?): DriveItemOut =
    item.file?.let { item.copy(file = it.copy(preview = preview)) } ?: item

/**
 * 2026-10-24 (DRIVE.md §27.3, as the desktop): a PDF or an Office file of the drive never turns into a download. A PDF
 * reads its preview when that is made, else its own bytes (`/drive/items/{id}/content`, streamed to the cache), and
 * stays on them. A file without a preview (imported from Nextcloud, §24) asks the server for one
 * (`POST /drive/items/{id}/preview`); while it is made the viewer says 「プレビューを作成中…」 and looks again every 4 s and
 * whenever drive.changed names its folder, then shows the pages. None for it (null) or a failed one says so, with
 * 「ダウンロード」.
 */
@Composable
internal fun DriveDocumentViewer(controller: AppController, item: DriveItemOut, onDismiss: () -> Unit, onOpenElsewhere: () -> Unit) {
    var live by remember(item.id) { mutableStateOf(item) }
    var answeredNone by remember(item.id) { mutableStateOf(false) }
    // A PDF opened from its own bytes stays on them (a preview made meanwhile would reload the pages).
    val original = remember(item.id) { DriveNames.documentSource(item) == DriveNames.DocumentSource.ORIGINAL }
    val source = if (original) DriveNames.DocumentSource.ORIGINAL else DriveNames.documentSource(live)
    val api = controller.driveWriteApi
    LaunchedEffect(item.id) {
        if (item.file == null || item.file.preview != null || api == null) return@LaunchedEffect
        try {
            val out = api.requestDrivePreview(item.id)
            live = withPreview(live, out.preview)
            if (out.preview == null) answeredNone = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            answeredNone = true
            controller.report(e)
        }
    }
    val hold = driveDocumentHold(source, answeredNone)
    val hub = controller.drive
    hub?.version?.collectAsState()?.value
    val epoch = item.parentId?.let { hub?.folderEpoch(it) } ?: 0
    if (hold == DocumentHold.MAKING && !original) {
        LaunchedEffect(item.id, epoch) {
            while (true) {
                if (live.file?.preview != null) {
                    runCatching { controller.driveApi?.driveItem(item.id)?.item }.getOrNull()?.let { live = it }
                }
                delay(DRIVE_PREVIEW_POLL_MS)
            }
        }
    }
    val attachment = remember(live) { DriveNames.asAttachment(live) } ?: return
    PdfPreviewViewer(
        attachment, controller, onDismiss, onOpenElsewhere = onOpenElsewhere,
        load = if (source == DriveNames.DocumentSource.ORIGINAL) ({ file -> controller.driveOriginalTo(item, file) }) else null,
        hold = hold,
        // The viewer closes so that the download's own dialog (progress, 「キャンセル」) is not hidden behind it.
        onDownload = { onDismiss(); controller.downloadDrive(item, AppController.DriveAction.SAVE) },
    )
}
