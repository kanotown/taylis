package jp.chikuwachat.android.share

import android.app.Application
import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.net.toUri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import jp.chikuwachat.android.ChikuwaApp
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.ui.RecentConversations
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * MOBILE_UI.md §20.2: the share screen's state, kept across a rotation. The shared files are described at once and
 * copied into the app's own storage while the screen is open: the read permission another app grants with a share
 * lasts only as long as this screen, and a content URI cannot be kept for later (only documents picked through the
 * system's picker can), so the background upload reads the copies. Every file is copied whole (the drive takes large ones).
 */
class ShareModel(app: Application) : AndroidViewModel(app) {
    private val controller get() = (getApplication<Application>() as ChikuwaApp).controller
    private val jobs = ShareJobs(app)
    private val resolver: ContentResolver = app.contentResolver

    var request by mutableStateOf<ShareRequest?>(null)
        private set
    var files by mutableStateOf<List<SharedFile>>(emptyList())
        private set
    val thumbnails = mutableStateMapOf<String, Bitmap>()
    var text by mutableStateOf("")
    var query by mutableStateOf("")
    /** The chosen conversation: (workspace server URL, channel id). */
    var destination by mutableStateOf<Pair<String, String>?>(null)
    var sending by mutableStateOf(false)
        private set
    /** 2026-10-24 (DRIVE.md §6): 「ドライブに保存」 — the folder chosen (instead of a conversation), and whether the picker is open. */
    var driveTarget by mutableStateOf<ShareDriveTarget?>(null)
    var pickingDrive by mutableStateOf(false)
    /** The copy failed for these files (unreadable), by URI. */
    private val unreadable = mutableStateMapOf<String, Boolean>()
    /** The copied size by URI (a provider that did not tell the size). */
    private val copiedSizes = mutableStateMapOf<String, Long>()
    private val jobId = UUID.randomUUID().toString()
    private var copying: Job? = null
    private var started = false
    private var handedOver = false
    private var own: OwnProviders = OwnProviders(emptySet()) { true }

    /** The files as they will be checked: the copy's size when the provider did not say, unreadable when the copy failed. */
    val checkedFiles: List<SharedFile>
        get() = files.map { file ->
            file.copy(size = file.size ?: copiedSizes[file.uri], readable = file.readable && unreadable[file.uri] != true)
        }

    fun problems(limits: Limits?): List<String> =
        if (driveTarget != null) SharePayload.driveProblems(checkedFiles) else SharePayload.problems(checkedFiles, text, limits)

    /** Called once with the intent's contents (a rotation keeps the model and calls it again: ignored). */
    fun start(data: ShareIntentData, own: OwnProviders) {
        if (started) return
        started = true
        this.own = own
        val parsed = SharePayload.parse(data, own) ?: ShareRequest(emptyList(), "", null)
        request = parsed
        text = parsed.text
        viewModelScope.launch {
            withContext(Dispatchers.IO) { jobs.purgeAbandoned() }
            val described = withContext(Dispatchers.IO) { parsed.uris.map { describe(it) } }
            files = described
            copying = launch { copyAll(described) }
            launch { loadThumbnails(described) }
        }
    }

    /**
     * REVIEW-v0.1.62 #2: the one Uri every read of a shared file uses (describe, copy, thumbnail), checked again on that
     * same object: its decoded authority is not one of this app's providers. Null: refused, nothing is read.
     */
    private fun foreign(uri: String): Uri? {
        val parsed = uri.toUri()
        return parsed.takeIf { SharePayload.isReadable(it.scheme, it.authority, own) }
    }

    private fun describe(uri: String): SharedFile {
        val parsed = foreign(uri) ?: return SharedFile(uri, SharePayload.fileName(null, uri), null, null, readable = false)
        var name: String? = null
        var size: Long? = null
        val readable = runCatching {
            resolver.query(parsed, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    if (!cursor.isNull(0)) name = cursor.getString(0)
                    if (!cursor.isNull(1)) size = cursor.getLong(1).takeIf { it >= 0 }
                }
            }
            true
        }.getOrDefault(false)
        val mime = runCatching { resolver.getType(parsed) }.getOrNull()
        return SharedFile(uri, SharePayload.fileName(name, uri), size, mime, readable)
    }

    /** Each file to `filesDir/share/<job>/<index>` (a file over the attachments' limit too: the drive takes it). */
    private suspend fun copyAll(described: List<SharedFile>) = withContext(Dispatchers.IO) {
        val dir = jobs.dir(jobId).apply { mkdirs() }
        described.forEachIndexed { index, file ->
            if (!file.readable) return@forEachIndexed
            // Every file is copied whole (2026-10-24): 「ドライブに保存」 takes files past the attachments' limit; a
            // conversation still refuses those (problems()).
            val target = File(dir, index.toString())
            try {
                val source = foreign(file.uri) ?: throw IOException("refused")
                val input = resolver.openInputStream(source) ?: throw IOException("no stream")
                var total = 0L
                input.use { source ->
                    target.outputStream().use { out ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = source.read(buffer)
                            if (read < 0) break
                            out.write(buffer, 0, read)
                            total += read
                        }
                    }
                }
                withContext(Dispatchers.Main) { copiedSizes[file.uri] = total }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                target.delete()
                withContext(Dispatchers.Main) { unreadable[file.uri] = true }
            }
        }
    }

    private suspend fun loadThumbnails(described: List<SharedFile>) = withContext(Dispatchers.IO) {
        for (file in described) {
            val mime = file.mime ?: continue
            if (!file.readable || !(mime.startsWith("image/") || mime.startsWith("video/"))) continue
            val uri = foreign(file.uri) ?: continue
            val bitmap = runCatching { thumbnail(uri, mime) }.getOrNull() ?: continue
            withContext(Dispatchers.Main) { thumbnails[file.uri] = bitmap }
        }
    }

    private fun thumbnail(uri: Uri, mime: String): Bitmap? {
        if (Build.VERSION.SDK_INT >= 29) return resolver.loadThumbnail(uri, Size(THUMB_PX, THUMB_PX), null)
        if (!mime.startsWith("image/")) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= THUMB_PX && bounds.outHeight / (sample * 2) >= THUMB_PX) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    }

    /**
     * 送信: waits for the copies, saves the job and hands it to [ShareWorker]; true once handed over (the screen closes).
     * The conversation goes to the front of this device's recent conversations.
     */
    fun send(channelTitle: String, onDone: (Boolean) -> Unit) {
        val target = destination ?: return
        if (sending) return
        sending = true
        viewModelScope.launch {
            copying?.join()
            val limits = controller.store.limits
            if (problems(limits).isNotEmpty() || destination != target) {
                sending = false
                onDone(false)
                return@launch
            }
            // REVIEW-v0.1.62 #1: the job belongs to the account signed in there now, and runs only as that account.
            val account = controller.shareAccount(target.first)
            if (account == null) {
                sending = false
                onDone(false)
                return@launch
            }
            val checked = checkedFiles
            val job = ShareJob(
                id = jobId,
                serverUrl = target.first,
                userId = account.first,
                session = account.second,
                channelId = target.second,
                channelTitle = channelTitle,
                body = text.trim(),
                clientMsgId = UUID.randomUUID().toString(),
                files = checked.mapIndexed { index, file ->
                    ShareJobFile(path = index.toString(), name = file.name, mime = file.mime, size = file.size ?: 0L)
                },
            )
            withContext(Dispatchers.IO) { jobs.save(job) }
            ShareWorker.enqueue(getApplication(), jobId, target.first)
            handedOver = true
            controller.accountKey?.let { RecentConversations.push(controller.prefs, recentKey(it), target.second) }
            onDone(true)
        }
    }

    /**
     * 「ドライブに保存」's 保存: waits for the copies, moves them into drive upload jobs of the account signed in here
     * (DriveUploadCenter, the same jobs and work as the drive screen's uploads) and closes; true once handed over.
     */
    fun saveToDrive(onDone: (Boolean) -> Unit) {
        val target = driveTarget ?: return
        if (sending) return
        sending = true
        viewModelScope.launch {
            copying?.join()
            val account = controller.shareAccount(target.serverUrl)
            if (SharePayload.driveProblems(checkedFiles).isNotEmpty() || account == null || driveTarget != target) {
                sending = false
                onDone(false)
                return@launch
            }
            val dir = jobs.dir(jobId)
            val files = checkedFiles.mapIndexedNotNull { index, file -> File(dir, index.toString()).takeIf { file.readable && it.isFile }?.let { it to file.name } }
            val app = getApplication<Application>()
            withContext(Dispatchers.IO) {
                jp.chikuwachat.android.platform.DriveUploadCenter.addFiles(app, files, jp.chikuwachat.android.platform.DriveUploadCenter.Target(
                    target.serverUrl, account.first, account.second, target.locationId, target.folderId, target.label,
                ))
                dir.deleteRecursively()
            }
            handedOver = true
            onDone(true)
        }
    }

    override fun onCleared() {
        copying?.cancel()
        if (!handedOver) {
            val dir = jobs.dir(jobId)
            Thread { dir.deleteRecursively() }.start()
        }
        super.onCleared()
    }

    companion object {
        private const val THUMB_PX = 192

        /** Where the share screen keeps the conversations shared to (per account, like the jump screen's list). */
        fun recentKey(account: String): String = "chikuwa.share.recent:$account"
    }
}

/** A drive folder chosen in the share screen: its workspace, location and folder, and 「研究室ドライブ › 論文」. */
data class ShareDriveTarget(val serverUrl: String, val locationId: String, val folderId: String, val label: String)
