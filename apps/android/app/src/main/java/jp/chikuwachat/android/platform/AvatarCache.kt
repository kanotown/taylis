package jp.chikuwachat.android.platform

import android.graphics.BitmapFactory
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import jp.chikuwachat.android.api.UserPublic
import java.net.URLEncoder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Profile pictures (M14a): fetched once per (user, version) through the API and kept in memory.
 * `versions` follows the store's users; a composable asks `image(id)` and shows the initials until it arrives.
 */
object AvatarCache {
    val versions = mutableStateMapOf<String, String>()
    val images = mutableStateMapOf<String, ImageBitmap>()
    private val loading = HashSet<String>()
    var fetcher: (suspend (String) -> ByteArray)? = null
    var scope: CoroutineScope? = null

    fun note(user: UserPublic) {
        val version = user.avatarUpdatedAt
        if (version == null) versions.remove(user.id) else versions[user.id] = version
    }

    fun reset() {
        versions.clear()
        images.clear()
        loading.clear()
        fetcher = null
    }

    /** The cached picture; starts a fetch and returns null until it arrives (or always, without a picture). */
    fun image(id: String): ImageBitmap? {
        val version = versions[id] ?: return null
        val key = "$id|$version"
        images[key]?.let { return it }
        val fetch = fetcher ?: return null
        val scope = scope ?: return null
        if (!loading.add(key)) return null
        scope.launch {
            try {
                val bytes = fetch("/api/v1/users/$id/avatar?v=" + URLEncoder.encode(version, "UTF-8"))
                val bitmap = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
                if (bitmap != null) images[key] = bitmap
            } catch (_: Exception) {
                // the initials stay; a later render retries
            } finally { loading.remove(key) }
        }
        return null
    }
}
