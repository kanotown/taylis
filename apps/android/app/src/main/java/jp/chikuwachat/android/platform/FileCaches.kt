package jp.chikuwachat.android.platform

import java.io.File
import java.security.MessageDigest

/**
 * 2026-11-16 (a hostile-server review): the files downloaded into the cache (attachments handed to other apps, videos for
 * the player, drive files, preview PDFs) sat at `downloads/<attachment id>/<name>` and `previews/<id>/…`, were reused when
 * only their size matched, and stayed after a sign-out: a server could plant a file under another workspace's attachment
 * id. Each workspace now has its own folder (a hash of its server URL, no address in clear on disk), a file is reused
 * only when this process downloaded it in full, and a sign-out or a removed workspace takes its folders with it.
 */
object FileCaches {
    const val DOWNLOADS = "downloads"
    const val PREVIEWS = "previews"

    /** A workspace's folder name: 16 hex characters of SHA-256 of its server URL. */
    fun serverFolder(serverUrl: String): String =
        MessageDigest.getInstance("SHA-256").digest(serverUrl.toByteArray()).joinToString("") { "%02x".format(it) }.take(16)

    /** `cache/downloads/<server>`: files handed to other apps (the FileProvider's `downloads/`). */
    fun downloads(cacheDir: File, serverUrl: String): File = File(File(cacheDir, DOWNLOADS), serverFolder(serverUrl))

    /** `cache/previews/<server>`: the PDFs the in-app viewer draws. */
    fun previews(cacheDir: File, serverUrl: String): File = File(File(cacheDir, PREVIEWS), serverFolder(serverUrl))

    /** The files this process downloaded in full (absolute path → length). */
    private val complete = HashMap<String, Long>()

    /** [file] was downloaded in full just now: it may be used again while it stays as it is. */
    fun markComplete(file: File) {
        val length = file.length()
        synchronized(complete) { complete[file.absolutePath] = length }
    }

    /** Whether [file] may be used instead of downloading again: this process downloaded it in full, [expected] bytes. */
    fun reusable(file: File, expected: Long?): Boolean {
        if (expected == null || expected < 0) return false
        val recorded = synchronized(complete) { complete[file.absolutePath] } ?: return false
        return recorded == expected && file.isFile && file.length() == expected
    }

    /** A workspace's files go (its sign-out, its removal, another account on its server). */
    fun forget(cacheDir: File, serverUrl: String) {
        for (dir in listOf(downloads(cacheDir, serverUrl), previews(cacheDir, serverUrl))) {
            val prefix = dir.absolutePath + File.separator
            synchronized(complete) { complete.keys.removeAll { it.startsWith(prefix) } }
            dir.deleteRecursively()
        }
    }

    /**
     * At the start: everything in `downloads/` and `previews/` that is not the folder of a registered workspace goes (the
     * layout before 2026-11-16, and the folders of workspaces removed while the app could not delete them).
     */
    fun prune(cacheDir: File, serverUrls: Collection<String>) {
        val keep = serverUrls.map(::serverFolder).toSet()
        for (root in listOf(File(cacheDir, DOWNLOADS), File(cacheDir, PREVIEWS))) {
            root.listFiles()?.forEach { child -> if (child.name !in keep) child.deleteRecursively() }
        }
        synchronized(complete) { complete.keys.removeAll { !File(it).isFile } }
    }
}
