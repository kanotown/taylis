package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
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

@Composable
fun MessageBody(text: String, users: Map<String, UserPublic>, modifier: Modifier = Modifier) {
    val lines = splitIntoLines(tokenizeBody(text))
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    Column(modifier = modifier) {
        for (line in lines) {
            val block = line.singleOrNull() as? BodyToken.CodeBlock
            if (block != null) {
                Text(
                    block.text,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp).background(codeBackground, RoundedCornerShape(4.dp)).padding(6.dp),
                )
                continue
            }
            val annotated = buildAnnotatedString {
                for (token in line) {
                    when (token) {
                        is BodyToken.Text -> append(token.text)
                        is BodyToken.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(token.text) }
                        is BodyToken.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(token.text) }
                        is BodyToken.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(token.text) }
                        is BodyToken.CodeBlock -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(token.text) }
                        is BodyToken.Link -> withLink(
                            LinkAnnotation.Url(token.url, TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))),
                        ) { append(token.url) }
                        is BodyToken.Mention -> withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) {
                            append("@" + (users[token.userId]?.displayName ?: "unknown"))
                        }
                        is BodyToken.MentionAll -> withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) { append("@" + token.target) }
                        BodyToken.Newline -> append("\n")
                    }
                }
            }
            Text(annotated, style = MaterialTheme.typography.bodyLarge)
        }
    }
}
