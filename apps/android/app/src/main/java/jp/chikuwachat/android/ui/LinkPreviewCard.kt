package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
}

/** Open Graph card under a message for its first link (M11g); nothing while loading or when the page had no data. */
@Composable
fun LinkPreviewCard(controller: AppController, url: String) {
    LaunchedEffect(url) { controller.loadLinkPreview(url) }
    val preview = controller.linkPreviews[url] ?: return
    val uriHandler = LocalUriHandler.current
    Row(
        Modifier
            .padding(top = 6.dp)
            .widthIn(max = 420.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable { runCatching { uriHandler.openUri(preview.url) } },
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary.copy(alpha = 0.6f)))
        Column(Modifier.weight(1f).padding(10.dp)) {
            preview.siteName?.let { Text(it.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            preview.title?.let { Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            preview.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp)) }
        }
        preview.imageUrl?.let { image ->
            RemoteImage(image, Modifier.padding(8.dp).size(64.dp).clip(RoundedCornerShape(8.dp)))
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
