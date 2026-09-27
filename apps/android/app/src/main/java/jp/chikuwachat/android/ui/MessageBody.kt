package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.Image
import androidx.compose.ui.unit.sp
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
    /** M12f: custom emoji by name and their cached images; `onNeedEmojiImage` fetches a missing one. */
    customEmoji: Map<String, CustomEmojiOut> = emptyMap(),
    emojiImages: Map<String, ImageBitmap> = emptyMap(),
    onNeedEmojiImage: ((CustomEmojiOut) -> Unit)? = null,
    /** M12k: user groups by id, for `<@group:id>`. */
    groups: Map<String, GroupOut> = emptyMap(),
) {
    val inlineContent = HashMap<String, InlineTextContent>()
    fun AnnotatedString.Builder.appendWithEmoji(text: String) {
        val replaced = Emoji.replaceShortcodes(text)
        if (customEmoji.isEmpty()) { append(replaced); return }
        for (piece in CustomEmoji.split(replaced) { customEmoji.containsKey(it) }) {
            when (piece) {
                is CustomEmoji.Piece.Text -> append(piece.text)
                is CustomEmoji.Piece.Emoji -> {
                    val emoji = customEmoji[piece.name]!!
                    val image = emojiImages[emoji.id]
                    if (image == null) { onNeedEmojiImage?.invoke(emoji); append(":${piece.name}:") }
                    else {
                        val key = "emoji:" + emoji.id
                        inlineContent[key] = InlineTextContent(Placeholder(20.sp, 20.sp, PlaceholderVerticalAlign.TextCenter)) {
                            Image(image, contentDescription = ":${piece.name}:", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                        }
                        appendInlineContent(key, ":${piece.name}:")
                    }
                }
            }
        }
    }
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
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
                    if (internal != null && onOpenMessage != null) {
                        withLink(LinkAnnotation.Clickable("message:$internal", TextLinkStyles(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium))) { onOpenMessage(internal) }) {
                            append("💬 " + (token.label?.takeIf { it != token.url } ?: "メッセージを表示"))
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
    fun joined(lines: List<List<BodyToken>>): AnnotatedString = buildAnnotatedString {
        lines.forEachIndexed { index, tokens ->
            if (index > 0) append("\n")
            append(inline(tokens))
        }
    }

    Column(modifier = modifier) {
        for (block in parseBlocks(text)) {
            when (block) {
                is BodyBlock.Heading -> Text(
                    inline(block.tokens),
                    style = when (block.level) { 1 -> MaterialTheme.typography.titleLarge; 2 -> MaterialTheme.typography.titleMedium; else -> MaterialTheme.typography.titleSmall },
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(top = 2.dp),
                )
                is BodyBlock.Paragraph -> Text(joined(block.lines), inlineContent = inlineContent, style = MaterialTheme.typography.bodyLarge)
                is BodyBlock.Quote -> Row(Modifier.padding(vertical = 2.dp).height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(muted.copy(alpha = 0.4f), RoundedCornerShape(2.dp)))
                    Spacer(Modifier.width(8.dp))
                    Text(joined(block.lines), inlineContent = inlineContent, style = MaterialTheme.typography.bodyLarge, color = muted)
                }
                is BodyBlock.ListBlock -> Column(Modifier.padding(vertical = 1.dp)) {
                    block.items.forEachIndexed { index, item ->
                        Row(Modifier.padding(start = (item.level * 16).dp), verticalAlignment = Alignment.Top) {
                            val marker = if (block.ordered) "${block.start + index}." else if (item.level > 0) "◦" else "•"
                            Text(marker, style = MaterialTheme.typography.bodyLarge, color = muted, modifier = Modifier.width(22.dp))
                            Text(inline(item.tokens), inlineContent = inlineContent, style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
                is BodyBlock.CodeBlock -> Column(
                    Modifier.fillMaxWidth().padding(vertical = 2.dp).background(codeBackground, RoundedCornerShape(6.dp)).padding(8.dp),
                    horizontalAlignment = Alignment.End,
                ) {
                    block.lang?.let { Text(it.uppercase(), style = MaterialTheme.typography.labelSmall, color = muted) }
                    Text(block.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}

