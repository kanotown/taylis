package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.drawBehind
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.em
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.Placeholder
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.ui.graphics.ImageBitmap
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.GroupOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.LocalContentColor
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
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.TextStyle
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

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
    /** M101 (docs/EMOJI.md §7): an emoji-only body is shown large (the timeline and threads only, not previews). */
    jumbo: Boolean = false,
    /** A tap on a mention of someone known (2026-10-06): their profile. Null: mentions are plain text. */
    onOpenUser: ((String) -> Unit)? = null,
) {
    if (jumbo) {
        val only = remember(text, version, customEmoji) { EmojiOnly.parse(text, customEmoji) }
        if (only != null) {
            JumboEmoji(text, only, customEmoji, emojiImages, emojiAnimations, onNeedEmojiImage, version, modifier)
            return
        }
    }
    val inline = bodyInline(users, internalBase, onOpenMessage, onOpenCanvas, customEmoji, emojiImages, emojiAnimations, onNeedEmojiImage, groups, version, citations, onOpenUser)
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
 * M101 (docs/EMOJI.md §7): an emoji-only body, large: standard emoji at [EmojiOnly.Jumbo.FONT] sp, image emoji
 * [EmojiOnly.Jumbo.IMAGE] high (a wide one wider, at most 3:1), text emoji as [EmojiOnly.Jumbo.PILL] pills, pack emoji
 * [EmojiOnly.Jumbo.PACK] high; a single pack emoji as a stamp, [EmojiOnly.Jumbo.STAMP] dp. Every box has its size before
 * the image comes (blank until then), so nothing moves when it does; a line grows to hold its tallest emoji.
 */
@Composable
private fun JumboEmoji(
    text: String,
    only: EmojiOnly.Result,
    customEmoji: Map<String, CustomEmojiOut>,
    emojiImages: Map<String, ImageBitmap>,
    emojiAnimations: Map<String, EmojiAnimation>,
    onNeedEmojiImage: ((CustomEmojiOut) -> Unit)?,
    version: Int,
    modifier: Modifier,
) {
    val images = remember(version, emojiImages) { emojiImages }
    val pieces = remember(text, version) { CustomEmoji.split(Emoji.replaceShortcodes(text.trim())) { customEmoji.containsKey(it) } }
    if (only.stamp) {
        val emoji = pieces.firstNotNullOfOrNull { (it as? CustomEmoji.Piece.Emoji)?.let { piece -> customEmoji[piece.name] } } ?: return
        val image = images[emoji.id]
        if (image == null) onNeedEmojiImage?.invoke(emoji)
        Box(modifier.padding(vertical = 2.dp).width((EmojiOnly.Jumbo.STAMP * CustomEmoji.aspect(emoji)).dp).height(EmojiOnly.Jumbo.STAMP.dp)) {
            if (image != null) EmojiImage(image, emojiAnimations[emoji.id], contentDescription = emoji.label ?: ":${emoji.name}:", modifier = Modifier.fillMaxSize())
        }
        return
    }
    val inlineContent = HashMap<String, InlineTextContent>()
    val line = buildAnnotatedString {
        for (piece in pieces) when (piece) {
            is CustomEmoji.Piece.Text -> append(piece.text)
            is CustomEmoji.Piece.Emoji -> {
                val emoji = customEmoji.getValue(piece.name)
                val image = images[emoji.id]
                if (image == null) onNeedEmojiImage?.invoke(emoji)
                val height = if (emoji.isText) EmojiOnly.Jumbo.PILL else if (emoji.packId != null) EmojiOnly.Jumbo.PACK else EmojiOnly.Jumbo.IMAGE
                val key = "jumbo:" + emoji.id + if (image == null) ":loading" else ""
                inlineContent[key] = InlineTextContent(Placeholder((height * CustomEmoji.aspect(emoji)).sp, height.sp, PlaceholderVerticalAlign.TextCenter)) {
                    if (image != null) EmojiImage(image, emojiAnimations[emoji.id], contentDescription = ":${piece.name}:", modifier = Modifier.fillMaxSize())
                }
                appendInlineContent(key, ":${piece.name}:")
            }
        }
    }
    // A style of its own, not merged with the theme's: bodyLarge's fixed 24 sp line height would cut the larger
    // emoji; unset, each line is as tall as its font and placeholders need.
    Text(line, inlineContent = inlineContent, style = TextStyle(fontSize = EmojiOnly.Jumbo.FONT.sp), modifier = modifier.padding(vertical = 2.dp))
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
    /** A tap on a known user's mention; a group, @channel and an unknown user stay plain. */
    onOpenUser: ((String) -> Unit)? = null,
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
                    // M100: a wide one (at most 3:1) or a text emoji's pill is wider, as high; known before the image comes.
                    inlineContent[key] = InlineTextContent(Placeholder((1.25f * CustomEmoji.aspect(emoji)).em, 1.25.em, PlaceholderVerticalAlign.TextCenter)) {
                        if (image != null) EmojiImage(image, emojiAnimations[emoji.id], contentDescription = ":${piece.name}:", modifier = Modifier.fillMaxSize())
                    }
                    appendInlineContent(key, ":${piece.name}:")
                }
            }
        }
    }
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    // M122: links to pages of 「ドキュメント」 and to files (DocLinks.kt); null outside the main screen.
    val docLinks = LocalPageLinks.current
    // TeX math (MathRender.kt): drawn at the body text's size, tinted with the text's colour.
    val context = LocalContext.current
    val mathFontPx = with(LocalDensity.current) { MaterialTheme.typography.bodyLarge.fontSize.toPx() }
    val mathDescentPx = remember(mathFontPx) { MathRender.fontDescent(mathFontPx) }
    val mathColor = MaterialTheme.colorScheme.onSurface
    val mutedColor = MaterialTheme.colorScheme.onSurfaceVariant
    fun inline(tokens: List<BodyToken>): AnnotatedString = buildAnnotatedString {
        for (token in tokens) {
            when (token) {
                is BodyToken.Text -> appendWithEmoji(token.text)
                is BodyToken.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { appendWithEmoji(token.text) }
                is BodyToken.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendWithEmoji(token.text) }
                is BodyToken.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendWithEmoji(token.text) }
                // Thin spaces either side so the background does not touch the letters (as on iOS).
                is BodyToken.Code -> withStyle(SpanStyle(fontFamily = CodeFont, fontSize = 0.9.em, background = codeBackground)) { append(" " + token.text + " ") }
                is BodyToken.CodeBlock -> withStyle(SpanStyle(fontFamily = CodeFont)) { append(token.text) }
                is BodyToken.Link -> {
                    val internal = internalBase?.let { Permalink.messageId(it, token.url) }
                    val canvas = internalBase?.let { Permalink.canvasId(it, token.url) }
                    // M122: `page:<id>` (the canvas dialect) or this server's `/p/<id>`; `attachment:<id>` a file.
                    val page = jp.chikuwachat.android.sync.WikiLinks.idOf(token.url) ?: internalBase?.let { Permalink.pageId(it, token.url) }
                    val file = jp.chikuwachat.android.sync.WikiLinks.attachmentOf(token.url)
                    val written = token.label?.takeIf { it != token.url }
                    if (page != null) {
                        val label = docLinks?.label?.invoke(page)
                        val text = DocLinkText.page(label, written)
                        val style = SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)
                        if (docLinks != null && label !is jp.chikuwachat.android.sync.PageLabel.Hidden) {
                            withLink(LinkAnnotation.Clickable("page:$page", TextLinkStyles(style)) { docLinks.open(page) }) { appendWithEmoji(text) }
                        } else withStyle(if (docLinks == null) style else SpanStyle(color = mutedColor)) { appendWithEmoji(text) }
                    } else if (file != null) {
                        val text = DocLinkText.file(written)
                        if (docLinks != null) {
                            withLink(LinkAnnotation.Clickable("file:$file", TextLinkStyles(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium))) { docLinks.openFile(file) }) { append(text) }
                        } else append(text)
                    } else if (internal != null && onOpenMessage != null) {
                        withLink(LinkAnnotation.Clickable("message:$internal", TextLinkStyles(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium))) { onOpenMessage(internal) }) {
                            val label = token.label?.takeIf { it != token.url }
                            if (citations && label != null) append("[$label]")
                            else append("💬 " + (label ?: L10n.str(R.string.message_body_view_message)))
                        }
                    } else if (canvas != null && onOpenCanvas != null) {
                        withLink(LinkAnnotation.Clickable("canvas:$canvas", TextLinkStyles(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium))) { onOpenCanvas(canvas) }) {
                            append("📄 " + (token.label?.takeIf { it != token.url } ?: L10n.str(R.string.common_open_canvas)))
                        }
                    } else withLink(
                    LinkAnnotation.Url(token.url, TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))),
                ) { append(token.label ?: token.url) }
                }
                is BodyToken.Mention -> {
                    val user = users[token.userId]
                    val style = SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)
                    // Only the mention's own span takes the tap: the rest of the row keeps its tap and long press.
                    if (user != null && onOpenUser != null) {
                        withLink(LinkAnnotation.Clickable("user:" + user.id, TextLinkStyles(style)) { onOpenUser(user.id) }) { append("@" + user.displayName) }
                    } else withStyle(style) { append("@" + (user?.displayName ?: "unknown")) }
                }
                is BodyToken.MentionGroup -> withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) { append("@" + (groups[token.groupId]?.name ?: L10n.str(R.string.common_group))) }
                is BodyToken.MentionAll -> withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) { append("@" + token.target) }
                is BodyToken.Math -> {
                    val source = if (token.display) "\$\$" + token.tex + "\$\$" else "\$" + token.tex + "\$"
                    val rendered = MathRender.render(context, token.tex, mathFontPx, display = false, fontDescentPx = mathDescentPx)
                    if (rendered == null) {
                        // A formula AndroidMath cannot read: its source, code-like and muted.
                        withStyle(SpanStyle(fontFamily = CodeFont, fontSize = 0.9.em, background = codeBackground, color = mutedColor)) { append(" " + source + " ") }
                    } else {
                        // Its box ends at the text's bottom (the font's descent below the baseline, which the bitmap
                        // reaches too), so the formula's baseline is the text's; in em, so it follows the text size.
                        val key = "math:" + rendered.width + "x" + rendered.height + ":" + token.tex
                        inlineContent[key] = InlineTextContent(Placeholder((rendered.width / mathFontPx).em, (rendered.height / mathFontPx).em, PlaceholderVerticalAlign.TextBottom)) {
                            Image(rendered.bitmap, contentDescription = null, colorFilter = ColorFilter.tint(mathColor), modifier = Modifier.fillMaxSize())
                        }
                        appendInlineContent(key, source)
                    }
                }
                BodyToken.Newline -> append("\n")
            }
        }
    }
    return BodyInline(::inline, inlineContent)
}

/**
 * Code (2026-10-06): JetBrains Mono, bundled (res/font, the Latin subset of the desktop's font as static Regular and
 * Bold, its programming ligatures left out; THIRD_PARTY_NOTICES.md). Letters it lacks (Japanese) come from the system's
 * fonts. Inline code at 0.9 of the text around it, code blocks at 13.5 sp on 20 sp lines.
 */
val CodeFont = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_bold, FontWeight.Bold),
)

private val CodeBlockStyle = TextStyle(fontFamily = CodeFont, fontSize = 13.5.sp, lineHeight = 20.sp)

/**
 * 2026-10-05: blank lines are this gap (about 0.4 of a bodyLarge line), not empty lines — between the runs of a
 * paragraph and at its ends toward the block before / after; several blank lines are one gap
 * (apps/shared/body-paragraphs.json).
 */
private val PARAGRAPH_GAP = 10.dp

@Composable
private fun ParagraphView(layout: ParagraphLayout, inline: BodyInline) {
    if (layout.groups.isEmpty()) {
        Spacer(Modifier.height(PARAGRAPH_GAP)) // only blank lines between two blocks: one gap
        return
    }
    Column(
        Modifier.padding(top = if (layout.gapBefore) PARAGRAPH_GAP else 0.dp, bottom = if (layout.gapAfter) PARAGRAPH_GAP else 0.dp),
        verticalArrangement = Arrangement.spacedBy(PARAGRAPH_GAP),
    ) {
        for (group in layout.groups) {
            Text(inline.joined(group), inlineContent = inline.inlineContent, style = MaterialTheme.typography.bodyLarge)
        }
    }
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
        is BodyBlock.Paragraph -> ParagraphView(paragraphLayout(block.lines), inline)
        // 2026-10-08: its lines are paragraphs and lists (apps/shared/lists.json `quoted`), drawn as outside a quote
        // in the muted colour (the drawn bullets take it too).
        is BodyBlock.Quote -> Row(Modifier.padding(vertical = 2.dp).height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(muted.copy(alpha = 0.4f), RoundedCornerShape(2.dp)))
            Spacer(Modifier.width(8.dp))
            CompositionLocalProvider(LocalContentColor provides muted) {
                Column { block.blocks.forEach { BodyBlockView(it, inline) } }
            }
        }
        // apps/shared/lists.json: each item's marker (1. a. i. / • ◦ ▪) comes from the parser; a wide one ("viii.")
        // pushes its text over rather than wrapping.
        is BodyBlock.ListBlock -> Column(Modifier.padding(vertical = 1.dp)) {
            val bulletLift = with(LocalDensity.current) { BULLET_LIFT.roundToPx() }
            block.items.forEach { item ->
                Row(Modifier.padding(start = (item.level * 20).dp), verticalAlignment = Alignment.Top) {
                    if (item.ordered) {
                        Text(
                            item.marker,
                            style = MaterialTheme.typography.bodyLarge,
                            color = muted,
                            maxLines = 1,
                            softWrap = false,
                            textAlign = TextAlign.End,
                            modifier = Modifier.alignByBaseline().widthIn(min = 20.dp).padding(end = 6.dp),
                        )
                    } else {
                        Box(Modifier.alignBy { it.measuredHeight / 2 + bulletLift }.widthIn(min = 20.dp).padding(end = 8.dp), contentAlignment = Alignment.CenterEnd) {
                            ListBulletMark(item.level)
                        }
                    }
                    Text(inline.build(item.tokens), inlineContent = inlineContent, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.alignByBaseline())
                }
            }
        }
        is BodyBlock.Table -> MarkdownTable(block, inline.build, inlineContent)
        is BodyBlock.CodeBlock -> Column(
            Modifier.fillMaxWidth().padding(vertical = 2.dp)
                .background(codeBackground, RoundedCornerShape(8.dp))
                .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp))
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.End,
        ) {
            block.lang?.let { Text(it.uppercase(), style = MaterialTheme.typography.labelSmall, color = muted) }
            Text(block.text, style = CodeBlockStyle, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.fillMaxWidth())
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
        is BodyBlock.Image -> Text("🖼 " + block.alt.ifEmpty { stringResource(R.string.common_image) }, style = MaterialTheme.typography.bodyMedium, color = muted)
        BodyBlock.Rule -> HorizontalDivider(Modifier.padding(vertical = 8.dp))
        is BodyBlock.Math -> MathBlockView(block.tex)
        // M149: the canvas dialect only (messages keep `:::` as text); CanvasBody draws them with ticking boxes and rows.
        is BodyBlock.Callout -> CalloutBox(block, inline) { BodyBlockView(it, inline) }
        is BodyBlock.Toggle -> ToggleBox(block, inline) { BodyBlockView(it, inline) }
        is BodyBlock.Embed -> EmbedLine(block)
    }
}


/** How far above the text's baseline a bullet's centre sits: half the x-height and a little (0.31 of bodyLarge). */
private val BULLET_LIFT = 5.sp
/** A level-1 dot's size, about 0.4 of bodyLarge (16 sp). */
private val BULLET_SIZE = 6.4.sp

/**
 * 2026-10-08: a bullet drawn rather than a glyph ("•" in the muted colour was small and faint), as the web draws it
 * (styles.css `.md-ul`): a solid dot for the first level, a ring for the second, a small square for the third, in the
 * text's colour. Its row aligns its centre BULLET_LIFT above the text's first baseline.
 */
@Composable
private fun ListBulletMark(level: Int) {
    val color = LocalContentColor.current
    val size = with(LocalDensity.current) { BULLET_SIZE.toDp() }
    when (level.coerceAtMost(2)) {
        0 -> Box(Modifier.size(size).background(color, CircleShape))
        1 -> Box(Modifier.size(size * 1.05f).border(maxOf(1.3.dp, size * 0.2f), color, CircleShape))
        else -> Box(Modifier.size(size * 0.9f).background(color, RoundedCornerShape(1.dp)))
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
