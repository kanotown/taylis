package jp.chikuwachat.android.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.foundation.Image
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController

/** The first http(s) link in a body, outside code (M11g); null when there is none. */
object Links {
    private val FENCE = Regex("```[\\s\\S]*?```")
    private val CODE = Regex("`[^`\\n]*`")
    private val URL = Regex("https?://[^\\s<>)\\]]+")
    private const val TRAILING = ".,!?;:。、」』）"

    fun first(body: String): String? {
        val text = body.replace(FENCE, " ").replace(CODE, " ")
        val found = URL.find(text)?.value ?: return null
        return found.trimEnd { it in TRAILING }
    }

    /** The preview card's first line: the site name as given (not uppercased), else the link's host; null when neither. */
    fun siteLabel(siteName: String?, url: String): String? =
        siteName?.trim()?.takeIf { it.isNotEmpty() } ?: runCatching { java.net.URI(url).host }.getOrNull()?.takeIf { it.isNotEmpty() }
}

/**
 * Open Graph card under a message for its first link (M11g); nothing while loading or when the page had no data.
 * A 1 dp outline, no fill and no accent bar (the same look on desktop and iOS): the site name (else the link's host),
 * the title and the description on the left, the thumbnail on the right.
 */
@Composable
fun LinkPreviewCard(controller: AppController, url: String) {
    LaunchedEffect(url) { controller.loadLinkPreview(url) }
    val preview = controller.linkPreviews[url] ?: return
    val uriHandler = LocalUriHandler.current
    val shape = RoundedCornerShape(8.dp)
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier
            .padding(top = 6.dp)
            .widthIn(max = 420.dp)
            .clip(shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable { runCatching { uriHandler.openUri(preview.url) } }
            .padding(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Links.siteLabel(preview.siteName, preview.url)?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            preview.title?.let {
                Text(
                    it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp),
                )
            }
            preview.description?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = secondary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
        }
        preview.imageUrl?.let { image ->
            RemoteImage(image, Modifier.padding(start = 10.dp).size(64.dp).clip(RoundedCornerShape(6.dp)))
        }
    }
}

/** A small third-party image (the preview thumbnail) loaded once per composition; nothing on failure. */
@Composable
private fun RemoteImage(url: String, modifier: Modifier) {
    var bitmap by remember(url) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(url) {
        bitmap = withContext(Dispatchers.IO) {
            runCatching {
                val connection = java.net.URL(url).openConnection().apply { connectTimeout = 5000; readTimeout = 5000 }
                connection.getInputStream().use { input -> BitmapFactory.decodeStream(input)?.asImageBitmap() }
            }.getOrNull()
        }
    }
    bitmap?.let { Image(it, contentDescription = null, modifier = modifier, contentScale = ContentScale.Crop) }
}
