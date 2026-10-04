package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.drawBehind
import androidx.compose.runtime.remember
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.Image
import androidx.compose.ui.unit.em
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.Placeholder
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.ui.graphics.ImageBitmap
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.GroupOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.UserPublic

/** Renders the light markdown subset (DATA_MODEL.md "本文の形式"); mentions resolve to display names. */
@Composable
fun MessageBody(
    text: String,
    users: Map<String, UserPublic>,
    modifier: Modifier = Modifier,
    /** M12b: links on this server (`<base>/m/<id>`) open the message in place instead of a browser. */
    internalBase: String? = null,
    onOpenMessage: ((String) -> Unit)? = null,
    /** M46: canvas links on this server (`<base>/c/<id>`) open the canvas in place. */
    onOpenCanvas: ((String) -> Unit)? = null,
    /** M12f: custom emoji by name and their cached images; `onNeedEmojiImage` fetches a missing one. */
    customEmoji: Map<String, CustomEmojiOut> = emptyMap(),
    emojiImages: Map<String, ImageBitmap> = emptyMap(),
    /** The animated ones' frames (GIF), shown moving. */
    emojiAnimations: Map<String, EmojiAnimation> = emptyMap(),
    onNeedEmojiImage: ((CustomEmojiOut) -> Unit)? = null,
    /** M12k: user groups by id, for `<@group:id>`. */
    groups: Map<String, GroupOut> = emptyMap(),
    /**
     * The Store's version when the maps above are the Store's own (changed in place): a new value makes the
     * body render again, so names and custom emoji images appear once they arrive (strong skipping).
     */
    version: Int = 0,
    /** M58: a canvas link on a line of its own (`<base>/c/<id>`) drawn as this card (CANVAS.md §4.13); null: a link. */
    canvasCard: (@Composable (canvasId: String) -> Unit)? = null,
    /** M70: message links read as citations — 「[3]」 instead of 「💬 3」 (an AI answer's sources, AiTexts.linkCitations). */
    citations: Boolean = false,
) {
    val inline = bodyInline(users, internalBase, onOpenMessage, onOpenCanvas, customEmoji, emojiImages, emojiAnimations, onNeedEmojiImage, groups, version, citations)
    // The parse depends on the text alone (M28c: keyed on the version too, every keystroke in the composer parsed every
    // row on screen again).
    val blocks = remember(text) { parseBlocks(text) }
    Column(modifier = modifier) {
        for (block in blocks) {
            if (canvasCard != null && block is BodyBlock.Paragraph) {
                for (piece in CanvasCards.split(block.lines, internalBase)) when (piece) {
                    is CanvasCards.Piece.Card -> canvasCard(piece.canvasId)
                    is CanvasCards.Piece.Lines -> BodyBlockView(BodyBlock.Paragraph(piece.lines), inline)
                }
            } else BodyBlockView(block, inline)
        }
    }
}

/**
 * Inline tokens as styled text (mentions, links, custom emoji), and the images that text refers to. [build] fills
 * [inlineContent] as it goes, so a Text passes both, built first (M46: shared by the message body and the canvas).
 */
class BodyInline(val build: (List<BodyToken>) -> AnnotatedString, val inlineContent: Map<String, InlineTextContent>) {
    fun joined(lines: List<List<BodyToken>>): AnnotatedString = buildAnnotatedString {
        lines.forEachIndexed { index, tokens ->
            if (index > 0) append("\n")
            append(build(tokens))
        }
    }
}

@Composable
fun bodyInline(
    users: Map<String, UserPublic>,
    internalBase: String? = null,
    onOpenMessage: ((String) -> Unit)? = null,
    onOpenCanvas: ((String) -> Unit)? = null,
    customEmoji: Map<String, CustomEmojiOut> = emptyMap(),
    emojiImages: Map<String, ImageBitmap> = emptyMap(),
    emojiAnimations: Map<String, EmojiAnimation> = emptyMap(),
    onNeedEmojiImage: ((CustomEmojiOut) -> Unit)? = null,
    groups: Map<String, GroupOut> = emptyMap(),
    version: Int = 0,
    citations: Boolean = false,
): BodyInline {
    // The Store's maps change in place, so `version` is read here on purpose: the Compose compiler leaves a parameter the
    // body never reads out of the skip check, and the body was never drawn again when only the maps had changed (custom
    // emoji images that arrived after the first draw stayed `:name:`, 2026-09-29). The images are what it keys.
    val images = remember(version, emojiImages) { emojiImages }
    val inlineContent = HashMap<String, InlineTextContent>()
    fun AnnotatedString.Builder.appendWithEmoji(text: String) {
        val replaced = Emoji.replaceShortcodes(text)
        if (customEmoji.isEmpty()) { append(replaced); return }
        for (piece in CustomEmoji.split(replaced) { customEmoji.containsKey(it) }) {
            when (piece) {
                is CustomEmoji.Piece.Text -> append(piece.text)
                is CustomEmoji.Piece.Emoji -> {
                    val emoji = customEmoji[piece.name]!!
                    val image = images[emoji.id]
                    if (image == null) onNeedEmojiImage?.invoke(emoji)
                    // Its square from the start, blank until the image comes (2026-10-04, 「ガタつく」): `:name:` there was
                    // wider, so the line re-wrapped and the row changed height when the image arrived, as on iOS.
                    val key = "emoji:" + emoji.id + if (image == null) ":loading" else ""
                    // In em: as large as the text around it, so a heading's emoji is a heading's size (testers, 2026-09-29).
                    inlineContent[key] = InlineTextContent(Placeholder(1.25.em, 1.25.em, PlaceholderVerticalAlign.TextCenter)) {
                        if (image != null) EmojiImage(image, emojiAnimations[emoji.id], contentDescription = ":${piece.name}:", modifier = Modifier.fillMaxSize())
                    }
                    appendInlineContent(key, ":${piece.name}:")
                }
            }
        }
    }
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    fun inline(tokens: List<BodyToken>): AnnotatedString = buildAnnotatedString {
        for (token in tokens) {
            when (token) {
                is BodyToken.Text -> appendWithEmoji(token.text)
                is BodyToken.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { appendWithEmoji(token.text) }
                is BodyToken.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendWithEmoji(token.text) }
                is BodyToken.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendWithEmoji(token.text) }
                is BodyToken.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(token.text) }
                is BodyToken.CodeBlock -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(token.text) }
                is BodyToken.Link -> {
                    val internal = internalBase?.let { Permalink.messageId(it, token.url) }
                    val canvas = internalBase?.let { Permalink.canvasId(it, token.url) }
                    if (internal != null && onOpenMessage != null) {
                        withLink(LinkAnnotation.Clickable("message:$internal", TextLinkStyles(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium))) { onOpenMessage(internal) }) {
                            val label = token.label?.takeIf { it != token.url }
                            if (citations && label != null) append("[$label]")
                            else append("💬 " + (label ?: "メッセージを表示"))
                        }
                    } else if (canvas != null && onOpenCanvas != null) {
                        withLink(LinkAnnotation.Clickable("canvas:$canvas", TextLinkStyles(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium))) { onOpenCanvas(canvas) }) {
                            append("📄 " + (token.label?.takeIf { it != token.url } ?: "キャンバスを開く"))
                        }
                    } else withLink(
                    LinkAnnotation.Url(token.url, TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))),
                ) { append(token.label ?: token.url) }
                }
                is BodyToken.Mention -> withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) {
                    append("@" + (users[token.userId]?.displayName ?: "unknown"))
                }
                is BodyToken.MentionGroup -> withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) { append("@" + (groups[token.groupId]?.name ?: "グループ")) }
                is BodyToken.MentionAll -> withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) { append("@" + token.target) }
                BodyToken.Newline -> append("\n")
            }
        }
    }
    return BodyInline(::inline, inlineContent)
}

/** One block of a body (the canvas draws its tasks, images and headings itself, ui/CanvasBody.kt). */
@Composable
fun BodyBlockView(block: BodyBlock, inline: BodyInline) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    val inlineContent = inline.inlineContent
    when (block) {
        // Larger than they were (testers, 2026-09-29), with their custom emoji drawn (they showed as :name:).
        is BodyBlock.Heading -> Text(
            inline.build(block.tokens),
            inlineContent = inlineContent,
            style = when (block.level) { 1 -> MaterialTheme.typography.headlineMedium; 2 -> MaterialTheme.typography.headlineSmall; else -> MaterialTheme.typography.titleLarge },
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 2.dp),
        )
        is BodyBlock.Paragraph -> Text(inline.joined(block.lines), inlineContent = inlineContent, style = MaterialTheme.typography.bodyLarge)
        is BodyBlock.Quote -> Row(Modifier.padding(vertical = 2.dp).height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(muted.copy(alpha = 0.4f), RoundedCornerShape(2.dp)))
            Spacer(Modifier.width(8.dp))
            Text(inline.joined(block.lines), inlineContent = inlineContent, style = MaterialTheme.typography.bodyLarge, color = muted)
        }
        is BodyBlock.ListBlock -> Column(Modifier.padding(vertical = 1.dp)) {
            block.items.forEachIndexed { index, item ->
                Row(Modifier.padding(start = (item.level * 16).dp), verticalAlignment = Alignment.Top) {
                    val marker = if (block.ordered) "${block.start + index}." else if (item.level > 0) "◦" else "•"
                    Text(marker, style = MaterialTheme.typography.bodyLarge, color = muted, modifier = Modifier.width(22.dp))
                    Text(inline.build(item.tokens), inlineContent = inlineContent, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
        is BodyBlock.Table -> MarkdownTable(block, inline.build, inlineContent)
        is BodyBlock.CodeBlock -> Column(
            Modifier.fillMaxWidth().padding(vertical = 2.dp).background(codeBackground, RoundedCornerShape(6.dp)).padding(8.dp),
            horizontalAlignment = Alignment.End,
        ) {
            block.lang?.let { Text(it.uppercase(), style = MaterialTheme.typography.labelSmall, color = muted) }
            Text(block.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth())
        }
        // The canvas dialect only (parseBlocks(canvas = true)); CanvasBody draws these with boxes that tick and images.
        is BodyBlock.Tasks -> Column(Modifier.padding(vertical = 1.dp)) {
            block.items.forEach { item ->
                Row(Modifier.padding(start = (item.level * 16).dp)) {
                    Text(if (item.done) "☑" else "☐", style = MaterialTheme.typography.bodyLarge, color = muted, modifier = Modifier.width(22.dp))
                    Text(inline.build(item.tokens), inlineContent = inlineContent, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
        is BodyBlock.Image -> Text("🖼 " + block.alt.ifEmpty { "画像" }, style = MaterialTheme.typography.bodyMedium, color = muted)
        BodyBlock.Rule -> HorizontalDivider(Modifier.padding(vertical = 8.dp))
    }
}


/** Column widths and row heights of the last layout pass, for drawing the grid lines. */
private class TableGeometry {
    var widths = IntArray(0)
    var heights = IntArray(0)
}

/**
 * M15g: a GFM table. Columns are as wide as their widest cell (capped), rows as tall as their
 * tallest cell; the grid and the header shading are drawn behind. Wide tables scroll sideways.
 */
@Composable
private fun MarkdownTable(block: BodyBlock.Table, inline: (List<BodyToken>) -> AnnotatedString, inlineContent: Map<String, InlineTextContent>) {
    val lineColor = MaterialTheme.colorScheme.outlineVariant
    val headerColor = MaterialTheme.colorScheme.surfaceVariant
    val geometry = remember { TableGeometry() }
    val columns = block.header.size
    Box(Modifier.padding(vertical = 2.dp).horizontalScroll(rememberScrollState())) {
        Layout(
            content = {
                (listOf(block.header) + block.rows).forEachIndexed { row, cells ->
                    cells.forEachIndexed { column, tokens ->
                        Text(
                            inline(tokens),
                            inlineContent = inlineContent,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (row == 0) FontWeight.Bold else null,
                            textAlign = when (block.align.getOrNull(column)) {
                                TableAlign.CENTER -> TextAlign.Center
                                TableAlign.RIGHT -> TextAlign.End
                                else -> TextAlign.Start
                            },
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                }
            },
            modifier = Modifier.drawBehind {
                val heights = geometry.heights
                if (heights.isEmpty()) return@drawBehind
                drawRect(headerColor, size = Size(size.width, heights[0].toFloat()))
                var y = 0f
                drawLine(lineColor, Offset(0f, 0.5f), Offset(size.width, 0.5f))
                heights.forEach { h -> y += h; drawLine(lineColor, Offset(0f, y - 0.5f), Offset(size.width, y - 0.5f)) }
                var x = 0f
                drawLine(lineColor, Offset(0.5f, 0f), Offset(0.5f, size.height))
                geometry.widths.forEach { w -> x += w; drawLine(lineColor, Offset(x - 0.5f, 0f), Offset(x - 0.5f, size.height)) }
            },
        ) { measurables, _ ->
            val rows = if (columns == 0) 0 else measurables.size / columns
            val cap = 280.dp.roundToPx()
            val widths = IntArray(columns) { column ->
                (0 until rows).maxOf { row -> measurables[row * columns + column].maxIntrinsicWidth(Constraints.Infinity).coerceAtMost(cap) }
            }
            val placeables = measurables.mapIndexed { index, measurable -> measurable.measure(Constraints.fixedWidth(widths[index % columns])) }
            val heights = IntArray(rows) { row -> (0 until columns).maxOf { column -> placeables[row * columns + column].height } }
            geometry.widths = widths
            geometry.heights = heights
            layout(widths.sum(), heights.sum()) {
                var y = 0
                for (row in 0 until rows) {
                    var x = 0
                    for (column in 0 until columns) {
                        placeables[row * columns + column].place(x, y)
                        x += widths[column]
                    }
                    y += heights[row]
                }
            }
        }
    }
}
