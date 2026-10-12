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
 * system's picker can), so the background upload reads the copies. A file over the size limit is not copied.
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
    /** The copy failed for these files (unreadable), by URI. */
    private val unreadable = mutableStateMapOf<String, Boolean>()
    /** The copied size by URI (a provider that did not tell the size). */
    private val copiedSizes = mutableStateMapOf<String, Long>()
    private val jobId = UUID.randomUUID().toString()
    private var copying: Job? = null
    private var started = false
    private var handedOver = false

    /** The files as they will be checked: the copy's size when the provider did not say, unreadable when the copy failed. */
    val checkedFiles: List<SharedFile>
        get() = files.map { file ->
            file.copy(size = file.size ?: copiedSizes[file.uri], readable = file.readable && unreadable[file.uri] != true)
        }

    fun problems(limits: Limits?): List<String> = SharePayload.problems(checkedFiles, text, limits)

    /** Called once with the intent's contents (a rotation keeps the model and calls it again: ignored). */
    fun start(data: ShareIntentData, ownAuthorities: Set<String>) {
        if (started) return
        started = true
        val parsed = SharePayload.parse(data, ownAuthorities) ?: ShareRequest(emptyList(), "", null)
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

    private fun describe(uri: String): SharedFile {
        val parsed = uri.toUri()
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

    /** Each file to `filesDir/share/<job>/<index>`, stopping at the size limit (the screen then says it is too large). */
    private suspend fun copyAll(described: List<SharedFile>) = withContext(Dispatchers.IO) {
        val dir = jobs.dir(jobId).apply { mkdirs() }
        described.forEachIndexed { index, file ->
            if (!file.readable) return@forEachIndexed
            val limit = controller.store.limits?.maxAttachmentBytes
            if (limit != null && file.size != null && file.size > limit) return@forEachIndexed
            val target = File(dir, index.toString())
            try {
                val input = resolver.openInputStream(file.uri.toUri()) ?: throw IOException("no stream")
                var total = 0L
                input.use { source ->
                    target.outputStream().use { out ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = source.read(buffer)
                            if (read < 0) break
                            out.write(buffer, 0, read)
                            total += read
                            // Past the limit the copy stops: the size shown says why it cannot be sent.
                            if (limit != null && total > limit) break
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
            val bitmap = runCatching { thumbnail(file.uri.toUri(), mime) }.getOrNull() ?: continue
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
            val checked = checkedFiles
            val job = ShareJob(
                id = jobId,
                serverUrl = target.first,
                channelId = target.second,
                channelTitle = channelTitle,
                body = text.trim(),
                clientMsgId = UUID.randomUUID().toString(),
                files = checked.mapIndexed { index, file ->
                    ShareJobFile(path = index.toString(), name = file.name, mime = file.mime, size = file.size ?: 0L)
                },
            )
            withContext(Dispatchers.IO) { jobs.save(job) }
            ShareWorker.enqueue(getApplication(), jobId)
            handedOver = true
            controller.accountKey?.let { RecentConversations.push(controller.prefs, recentKey(it), target.second) }
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
