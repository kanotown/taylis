package jp.chikuwachat.android.ui

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
fun MessageBody(text: String, users: Map<String, UserPublic>, modifier: Modifier = Modifier) {
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    fun inline(tokens: List<BodyToken>): AnnotatedString = buildAnnotatedString {
        for (token in tokens) {
            when (token) {
                is BodyToken.Text -> append(token.text)
                is BodyToken.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(token.text) }
                is BodyToken.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(token.text) }
                is BodyToken.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(token.text) }
                is BodyToken.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(token.text) }
                is BodyToken.CodeBlock -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(token.text) }
                is BodyToken.Link -> withLink(
                    LinkAnnotation.Url(token.url, TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))),
                ) { append(token.label ?: token.url) }
                is BodyToken.Mention -> withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) {
                    append("@" + (users[token.userId]?.displayName ?: "unknown"))
                }
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
                is BodyBlock.Paragraph -> Text(joined(block.lines), style = MaterialTheme.typography.bodyLarge)
                is BodyBlock.Quote -> Row(Modifier.padding(vertical = 2.dp).height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(muted.copy(alpha = 0.4f), RoundedCornerShape(2.dp)))
                    Spacer(Modifier.width(8.dp))
                    Text(joined(block.lines), style = MaterialTheme.typography.bodyLarge, color = muted)
                }
                is BodyBlock.ListBlock -> Column(Modifier.padding(vertical = 1.dp)) {
                    block.items.forEachIndexed { index, item ->
                        Row(Modifier.padding(start = (item.level * 16).dp), verticalAlignment = Alignment.Top) {
                            val marker = if (block.ordered) "${block.start + index}." else if (item.level > 0) "◦" else "•"
                            Text(marker, style = MaterialTheme.typography.bodyLarge, color = muted, modifier = Modifier.width(22.dp))
                            Text(inline(item.tokens), style = MaterialTheme.typography.bodyLarge)
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

