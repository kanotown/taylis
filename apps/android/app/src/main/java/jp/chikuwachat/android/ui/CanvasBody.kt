package jp.chikuwachat.android.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * M46: one block of a canvas (CANVAS.md §4.2): the message renderer's blocks ([BodyBlockView]) plus tasks with boxes that
 * tick (§4.4 「チェックの切り替え」: `onToggle` null = the boxes only show), images of the canvas (the authenticated
 * loader; [CanvasImage]) and rules. A heading offers 「このセクションを編集」 when `onEditSection` is given.
 */
@Composable
fun CanvasBlockView(
    block: BodyBlock,
    inline: BodyInline,
    controller: AppController,
    onToggle: ((line: Int, done: Boolean) -> Unit)?,
    onEditSection: ((line: Int) -> Unit)?,
) {
    when (block) {
        is BodyBlock.Tasks -> androidx.compose.foundation.layout.Column(Modifier.padding(vertical = 2.dp)) {
            block.items.forEach { item ->
                val label = visibleText(item.tokens)
                Row(Modifier.padding(start = (item.level * 24).dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = item.done,
                        onCheckedChange = onToggle?.let { toggle -> { done: Boolean -> toggle(item.line, done) } },
                        enabled = onToggle != null,
                        modifier = Modifier.semantics { contentDescription = (if (item.done) "完了を取り消す: " else "完了にする: ") + label },
                    )
                    Text(
                        inline.build(item.tokens),
                        inlineContent = inline.inlineContent,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (item.done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        textDecoration = if (item.done) TextDecoration.LineThrough else null,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        is BodyBlock.Image -> CanvasImage(block.attachmentId, block.alt, controller)
        is BodyBlock.Heading -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = if (block.level == 1) 10.dp else 6.dp)) {
            Text(
                inline.build(block.tokens),
                inlineContent = inline.inlineContent,
                style = when (block.level) { 1 -> MaterialTheme.typography.headlineSmall; 2 -> MaterialTheme.typography.titleLarge; else -> MaterialTheme.typography.titleMedium },
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            val line = block.line
            if (onEditSection != null && line != null) {
                IconButton(onClick = { onEditSection(line) }) {
                    Icon(Icons.Outlined.Edit, contentDescription = "このセクションを編集: " + visibleText(block.tokens), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                }
            }
        }
        else -> BodyBlockView(block, inline)
    }
}

/**
 * An image of the canvas (`![alt](attachment:<id>)`): its thumbnail, fetched with the session (the image is only
 * readable by the conversation's members, §4.10), the full image on a tap. One that cannot be read (someone else's
 * pending upload, another canvas's) shows as 「表示できない画像」.
 */
@Composable
fun CanvasImage(attachmentId: String, alt: String, controller: AppController) {
    var attachment by remember(attachmentId) { mutableStateOf<AttachmentOut?>(null) }
    var bitmap by remember(attachmentId) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(attachmentId) { mutableStateOf(false) }
    var viewing by remember(attachmentId) { mutableStateOf(false) }
    LaunchedEffect(attachmentId) {
        val meta = controller.canvasAttachment(attachmentId)
        if (meta == null || !meta.contentType.startsWith("image/")) { failed = true; return@LaunchedEffect }
        attachment = meta
        val path = if (meta.hasThumbnail) "/api/v1/attachments/$attachmentId/thumbnail" else "/api/v1/attachments/$attachmentId/content?inline=1"
        bitmap = runCatching {
            val bytes = controller.fetchBytes(path)
            withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
        }.getOrNull()
        if (bitmap == null) failed = true
    }
    val shape = RoundedCornerShape(8.dp)
    val image = bitmap
    val shown = attachment
    Box(Modifier.padding(vertical = 4.dp)) {
        when {
            image != null && shown != null -> {
                // As wide as the column allows (up to 480 dp) in the image's own proportions; a thumbnail is scaled up.
                val w = shown.width ?: image.width
                val h = shown.height ?: image.height
                Image(
                    image, contentDescription = alt.ifEmpty { shown.filename }, contentScale = ContentScale.Fit,
                    modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth().aspectRatio(if (w > 0 && h > 0) w.toFloat() / h else 1.5f)
                        .clip(shape).clickable { viewing = true },
                )
            }
            else -> Row(
                Modifier.background(MaterialTheme.colorScheme.surfaceVariant, shape).padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(if (failed) Icons.Outlined.BrokenImage else Icons.Outlined.Image, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    if (failed) "表示できない画像" + (alt.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: "") else "画像を読み込んでいます…",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
    if (viewing && shown != null) ImageViewer(shown, controller, onDismiss = { viewing = false })
}

/** The width a canvas's text keeps on a wide screen (a line of Japanese stays readable). */
val CANVAS_TEXT_WIDTH = 760.dp

/** Full width up to [CANVAS_TEXT_WIDTH], centred. */
fun Modifier.canvasColumn(): Modifier = this.fillMaxWidth().widthIn(max = CANVAS_TEXT_WIDTH)
