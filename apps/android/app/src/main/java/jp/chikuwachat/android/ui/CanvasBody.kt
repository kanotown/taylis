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
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.material.icons.outlined.AddTask
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
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
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource
import jp.chikuwachat.android.L10n

/**
 * M46: one block of a canvas (CANVAS.md §4.2): the message renderer's blocks ([BodyBlockView]) plus tasks with boxes that
 * tick (§4.4 「チェックの切り替え」: `onToggle` null = the boxes only show), images of the canvas (the authenticated
 * loader; [CanvasImage]) and rules. A heading offers 「このセクションを編集」 when `onEditSection` is given.
 * M73 (CANVAS.md §18.3 / §18.5): an open checklist item's long press (and its accessibility action) offers
 * 「タスクにする」 when `onMakeTask` is given.
 */
@Composable
fun CanvasBlockView(
    block: BodyBlock,
    inline: BodyInline,
    controller: AppController,
    onToggle: ((line: Int, done: Boolean) -> Unit)?,
    onEditSection: ((line: Int) -> Unit)?,
    onMakeTask: ((line: Int) -> Unit)? = null,
) {
    when (block) {
        is BodyBlock.Tasks -> androidx.compose.foundation.layout.Column(Modifier.padding(vertical = 2.dp)) {
            block.items.forEach { item ->
                val label = visibleText(item.tokens)
                var menu by remember { mutableStateOf(false) }
                val makeTask = onMakeTask?.takeIf { !item.done }
                Box {
                    Row(
                        Modifier
                            .padding(start = (item.level * 24).dp)
                            .then(
                                if (makeTask == null) Modifier else Modifier
                                    // Under the box and the links (they take their own taps first): only a long press here.
                                    .pointerInput(item.line) { detectTapGestures(onLongPress = { menu = true }) }
                                    .semantics { customActions = listOf(CustomAccessibilityAction(L10n.str(R.string.common_make_a_task)) { makeTask(item.line); true }) },
                            ),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(
                            checked = item.done,
                            onCheckedChange = onToggle?.let { toggle -> { done: Boolean -> toggle(item.line, done) } },
                            enabled = onToggle != null,
                            modifier = Modifier.semantics { contentDescription = (if (item.done) L10n.str(R.string.canvas_body_mark_not_done) else L10n.str(R.string.canvas_body_mark_done)) + label },
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
                    if (makeTask != null) {
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.common_make_a_task)) },
                                leadingIcon = { Icon(Icons.Outlined.AddTask, contentDescription = null) },
                                onClick = { menu = false; makeTask(item.line) },
                            )
                        }
                    }
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
                    Icon(Icons.Outlined.Edit, contentDescription = stringResource(R.string.canvas_body_edit_this_section) + visibleText(block.tokens), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                }
            }
        }
        // M149 (WIKI.md §22.5): what a container holds is drawn here too (boxes tick with their lines in the body, images
        // load); a heading inside one offers no section editing (its section would run past the container's close).
        is BodyBlock.Callout -> CalloutBox(block, inline) { CanvasBlockView(it, inline, controller, onToggle, null, onMakeTask) }
        is BodyBlock.Toggle -> ToggleBox(block, inline) { CanvasBlockView(it, inline, controller, onToggle, null, onMakeTask) }
        is BodyBlock.Embed -> EmbeddedDatabase(block, controller)
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
                    if (failed) stringResource(R.string.canvas_body_image_cant_be_shown) + (alt.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: "") else stringResource(R.string.canvas_body_loading_image),
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
