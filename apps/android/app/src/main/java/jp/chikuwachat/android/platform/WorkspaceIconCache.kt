package jp.chikuwachat.android.platform

import android.graphics.BitmapFactory
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * M93 (WORKSPACES.md §3.4.1): the workspace icons an admin set, fetched once per (server, version) without signing in
 * (GET /server/icon is public) and kept in memory, like [AvatarCache]. A tile asks [image] and shows the letter until the
 * picture arrives; a failed version is not asked again until the next start (or a new version).
 */
object WorkspaceIconCache {
    val images = mutableStateMapOf<String, ImageBitmap>()
    private val loading = HashSet<String>()
    private val failed = HashSet<String>()
    var fetcher: (suspend (serverUrl: String, version: String) -> ByteArray)? = null
    var scope: CoroutineScope? = null
    /** Turns the PNG into a picture (tests swap it: no Android graphics on the JVM). */
    var decode: (ByteArray) -> ImageBitmap? = { bytes -> BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }

    fun key(serverUrl: String, version: String): String = "$serverUrl|$version"

    fun reset() {
        images.clear()
        loading.clear()
        failed.clear()
    }

    /** The cached picture of `serverUrl`'s icon `version`; starts a fetch and returns null until it arrives (or without one). */
    fun image(serverUrl: String, version: String?): ImageBitmap? {
        if (version.isNullOrEmpty()) return null
        val key = key(serverUrl, version)
        images[key]?.let { return it }
        val fetch = fetcher ?: return null
        val scope = scope ?: return null
        if (key in failed || !loading.add(key)) return null
        scope.launch {
            try {
                val bytes = fetch(serverUrl, version)
                val bitmap = withContext(Dispatchers.Default) { decode(bytes) }
                if (bitmap != null) {
                    // An older version of this server's icon is not shown again: let it go.
                    images.keys.filter { it.startsWith("$serverUrl|") }.forEach { images.remove(it) }
                    images[key] = bitmap
                } else failed.add(key)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                failed.add(key) // the letter stays
            } finally { loading.remove(key) }
        }
        return null
    }
}
