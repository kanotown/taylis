package jp.chikuwachat.android.platform

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import jp.chikuwachat.android.ui.DownloadCache

/**
 * M166 (docs/DRIVE.md §7.3, §26): a drive file (or a folder's ZIP) on the phone — streamed to disk a block at a time
 * (never whole in memory: a 300 MB file is fine), then handed to another app through the FileProvider (「共有」
 * ACTION_SEND, 「ほかのアプリで開く」 ACTION_VIEW) or written into the public Downloads (MediaStore on Android 10+,
 * no permission; older systems pick the place with the system's file dialog).
 */
object DriveFiles {
    private const val BLOCK = 64 * 1024

    /** The drive's corner of the download cache (the FileProvider's `downloads/`): one file at a time is kept. */
    fun cacheDir(context: Context): File = File(File(context.cacheDir, "downloads"), "drive")

    /** Where a version's file sits: its id is a folder, so two files of the same name stay apart (DownloadCache). */
    fun cacheFile(context: Context, key: String, name: String): File = File(cacheDir(context), DownloadCache.path(key, name))

    /** Every drive file in the cache but `keep` (the next one replaces the last: the cache does not grow with each download). */
    fun prune(context: Context, keep: File?) {
        val root = cacheDir(context)
        val kept = keep?.parentFile
        root.listFiles()?.forEach { dir -> if (dir != kept) dir.deleteRecursively() }
    }

    /**
     * Copies `input` to `output` in blocks, telling [progress] the bytes so far (at most every 256 KiB); `cancelled` is
     * asked between blocks. Returns the bytes copied.
     */
    fun copy(input: InputStream, output: OutputStream, cancelled: () -> Boolean, progress: (Long) -> Unit): Long {
        val buffer = ByteArray(BLOCK)
        var total = 0L
        var told = 0L
        while (true) {
            if (cancelled()) throw IOException("cancelled")
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            total += read
            if (total - told >= 256 * 1024) { progress(total); told = total }
        }
        output.flush()
        progress(total)
        return total
    }

    /** Streams into `target` through a sibling `.part` file, moved into place only once complete (a cut-off copy never counts). */
    fun streamToFile(input: InputStream, target: File, expected: Long?, cancelled: () -> Boolean, progress: (Long) -> Unit) {
        target.parentFile?.mkdirs()
        val part = File(target.parentFile, target.name + ".part")
        try {
            val copied = part.outputStream().use { copy(input, it, cancelled, progress) }
            if (expected != null && expected >= 0 && copied != expected) throw IOException("short download: $copied of $expected")
            if (!part.renameTo(target)) { target.delete(); if (!part.renameTo(target)) throw IOException("could not save the download") }
        } catch (e: Exception) {
            part.delete()
            throw e
        }
    }

    /** Android 10+: a new row in the public Downloads, pending until complete (removed when the copy fails). */
    @androidx.annotation.RequiresApi(29)
    fun streamToDownloads(context: Context, name: String, mime: String, input: InputStream, expected: Long?, cancelled: () -> Boolean, progress: (Long) -> Unit): Uri {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IOException("Downloads refused the file")
        try {
            val copied = (resolver.openOutputStream(uri) ?: throw IOException("cannot write $uri")).use { copy(input, it, cancelled, progress) }
            if (expected != null && expected >= 0 && copied != expected) throw IOException("short download: $copied of $expected")
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            return uri
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw e
        }
    }

    /** Copies a cached file to a place picked with the system's dialog (Android 8–9's 「ダウンロードに保存」). */
    fun copyTo(context: Context, file: File, uri: Uri) {
        val output = context.contentResolver.openOutputStream(uri) ?: throw IOException("cannot write $uri")
        output.use { out -> file.inputStream().use { copy(it, out, { false }, {}) } }
    }

    private fun uriOf(context: Context, file: File): Uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)

    /** 「共有」: the system's share sheet with the file (ACTION_SEND, read permission on the FileProvider URI). */
    fun share(context: Context, file: File, mime: String, title: String) {
        val intent = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uriOf(context, file))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(intent, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }

    /** 「ほかのアプリで開く」 (ACTION_VIEW; SECURITY.md §4: never shown inline here). */
    fun open(context: Context, file: File, mime: String, title: String) {
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uriOf(context, file), mime)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(Intent.createChooser(intent, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
