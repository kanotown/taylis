package jp.chikuwachat.android.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.AiStatusOut
import jp.chikuwachat.android.api.LinkPreviewOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

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
 * Review v0.1.18 #5 (docs/AI.md §4): whether a message's link preview loads by itself, decided by its sender when it is
 * shown (so stored and re-synced messages behave the same). An AI bot's reply never does: a prompt injection could put
 * the conversation into a link, and the server's fetch would send it out without anyone tapping. The AI bots are the
 * status's agents; until the status is read, any bot (role "bot") is held back too, to be safe.
 * M98: a channel's feed bot (`botKind` "feed", not an AI agent) is the exception: its links are the entries of feeds the
 * channel's members registered (SECURITY.md §14).
 */
object LinkPreviewPolicy {
    // Review v0.1.18 #5, the same rule on the three clients: no bot's link is fetched by itself (an AI reply could
    // carry a prompt-injected URL; a disabled AI bot drops out of the status). A webhook's card is one tap away.
    fun autoLoads(senderId: String, senderRole: String?, ai: AiStatusOut?, senderBotKind: String? = null): Boolean =
        (senderRole != "bot" || senderBotKind == "feed") && (ai?.agents?.none { it.botUserId == senderId } ?: true)
}

/**
 * Open Graph card under a message for its first link (M11g); nothing while loading or when the page had no data.
 * With `auto` false (an AI bot's message, [LinkPreviewPolicy]) it shows the link and 「プレビューを表示」 instead, and
 * loads the card only after that tap.
 * A 1 dp outline, no fill and no accent bar (the same look on desktop and iOS): the site name (else the link's host),
 * the title and the description on the left, the thumbnail on the right.
 */
@Composable
fun LinkPreviewCard(controller: AppController, url: String, messageId: String, auto: Boolean = true) {
    val asked = auto || controller.previewsAsked[messageId] == true
    if (!asked) {
        PlainLinkRow(url) { controller.previewsAsked[messageId] = true }
        return
    }
    LaunchedEffect(url) { controller.loadLinkPreview(url) }
    val preview = controller.linkPreviews[url]
    if (preview == null) {
        // Asked for by a tap: the row keeps its place (and height) while loading, and says so when there is nothing.
        if (!auto) PlainLinkRow(url, status = if (controller.linkPreviews.containsKey(url)) stringResource(R.string.link_preview_card_no_preview) else stringResource(R.string.common_loading))
        return
    }
    PreviewCard(preview)
}

/**
 * Review v0.1.18 #5: a link under a message whose preview is not loaded by itself — the link (opens on tap) and
 * 「プレビューを表示」, else `status`. One fixed height whatever it shows, so the row does not jump.
 */
@Composable
private fun PlainLinkRow(url: String, status: String? = null, onShow: (() -> Unit)? = null) {
    val uriHandler = LocalUriHandler.current
    Row(Modifier.padding(top = 6.dp).height(48.dp).widthIn(max = 420.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            url, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis,
            textDecoration = TextDecoration.Underline,
            modifier = Modifier.weight(1f, fill = false).clickable(onClickLabel = stringResource(R.string.link_preview_card_open_link)) { runCatching { uriHandler.openUri(url) } },
        )
        if (onShow != null) {
            TextButton(onClick = onShow, modifier = Modifier.padding(start = 4.dp)) { Text(stringResource(R.string.link_preview_card_show_preview), style = MaterialTheme.typography.labelMedium) }
        } else if (status != null) {
            Text(status, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, modifier = Modifier.padding(start = 12.dp))
        }
    }
}

@Composable
private fun PreviewCard(preview: LinkPreviewOut) {
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
