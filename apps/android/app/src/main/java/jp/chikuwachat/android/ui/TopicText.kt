package jp.chikuwachat.android.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.em
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/** A piece of a channel's topic ([TopicText.tokens]). */
sealed class TopicToken {
    data class Text(val text: String) : TopicToken()
    data class Bold(val text: String) : TopicToken()
    data class Italic(val text: String) : TopicToken()
    data class Strike(val text: String) : TopicToken()
    data class Code(val text: String) : TopicToken()
    data class Link(val url: String, val label: String? = null) : TopicToken() {
        /** What the link reads as: its label, else its address. */
        val shown: String get() = label?.takeIf { it.isNotEmpty() } ?: url
    }
}

/** A link of a topic that opens in the app (this server's permalinks), as message links do. */
sealed class TopicInternalLink {
    data class Message(val id: String) : TopicInternalLink()
    data class Canvas(val id: String) : TopicInternalLink()
    data class Page(val id: String) : TopicInternalLink()
    data class Event(val id: String) : TopicInternalLink()
    data class Drive(val id: String) : TopicInternalLink()
    data class Equipment(val id: String) : TopicInternalLink()
}

/**
 * 2026-10-28 (as Mattermost's channel header, the desktop's TopicText.tsx): a channel's topic with its links.
 * `[text](https://…)`, bare http(s) URLs and `[text](mailto:…)` are links; **bold**, _italic_, ~~strike~~ and `code` keep
 * their look; everything on one line. It is the message dialect's inline tokens ([tokenizeInline]) narrowed to these:
 * only http, https and mailto are ever links (`[x](javascript:…)`, `data:`, `intent:` stay text). Mentions read as names
 * and math stays its text. The topic is still edited as plain text.
 */
object TopicText {
    private val ALLOWED = setOf("http", "https", "mailto")
    private val MAILTO = Regex("""\[([^\]\n]+)\]\((mailto:[^\s()<>"]+@[^\s()<>"]+)\)""")
    private val LINE_BREAK = Regex("""\s*\n\s*""")

    /** Whether `url` may become a link: http, https or mailto (any case), nothing else. */
    fun allowed(url: String): Boolean {
        val colon = url.indexOf(':')
        if (colon <= 0) return false
        val scheme = url.substring(0, colon).lowercase()
        if (scheme !in ALLOWED) return false
        return if (scheme == "mailto") url.length > colon + 1 else url.regionMatches(colon, "://", 0, 3) && url.length > colon + 3
    }

    /** The topic's tokens; `nameOf` names a mentioned user (null: 「unknown」). */
    fun tokens(topic: String, nameOf: (String) -> String? = { null }): List<TopicToken> {
        val out = ArrayList<TopicToken>()
        fun text(value: String) {
            if (value.isEmpty()) return
            val last = out.lastOrNull()
            if (last is TopicToken.Text) out[out.size - 1] = TopicToken.Text(last.text + value) else out.add(TopicToken.Text(value))
        }
        fun withMailto(value: String) {
            var last = 0
            for (match in MAILTO.findAll(value)) {
                text(value.substring(last, match.range.first))
                out.add(TopicToken.Link(match.groupValues[2], match.groupValues[1]))
                last = match.range.last + 1
            }
            text(value.substring(last))
        }
        for (token in tokenizeInline(topic.replace(LINE_BREAK, " "))) {
            when (token) {
                is BodyToken.Text -> withMailto(token.text)
                is BodyToken.Bold -> out.add(TopicToken.Bold(token.text))
                is BodyToken.Italic -> out.add(TopicToken.Italic(token.text))
                is BodyToken.Strike -> out.add(TopicToken.Strike(token.text))
                is BodyToken.Code -> out.add(TopicToken.Code(token.text))
                is BodyToken.CodeBlock -> text(token.text)
                is BodyToken.Link -> if (allowed(token.url)) out.add(TopicToken.Link(token.url, token.label)) else text(token.label ?: token.url)
                is BodyToken.Mention -> text("@" + (nameOf(token.userId) ?: "unknown"))
                is BodyToken.MentionGroup -> text("@group")
                is BodyToken.MentionAll -> text("@" + token.target)
                is BodyToken.Math -> text(if (token.display) "\$\$" + token.tex + "\$\$" else "\$" + token.tex + "\$")
                BodyToken.Newline -> text(" ")
            }
        }
        return out
    }

    /** True when the topic has a link. */
    fun hasLink(topic: String): Boolean = tokens(topic).any { it is TopicToken.Link }

    /** A link on this server (`base`) that opens in the app, or null (another site, a mail address: the system opens it). */
    fun internal(base: String?, url: String): TopicInternalLink? {
        if (base == null || url.startsWith("mailto:", ignoreCase = true)) return null
        Permalink.messageId(base, url)?.let { return TopicInternalLink.Message(it) }
        Permalink.canvasId(base, url)?.let { return TopicInternalLink.Canvas(it) }
        Permalink.pageId(base, url)?.let { return TopicInternalLink.Page(it) }
        Permalink.eventId(base, url)?.let { return TopicInternalLink.Event(it) }
        Permalink.driveId(base, url)?.let { return TopicInternalLink.Drive(it) }
        Permalink.equipmentId(base, url)?.let { return TopicInternalLink.Equipment(it) }
        return null
    }
}

/**
 * A channel's topic as styled text ([TopicText.tokens]). `links`: the links take a tap (this server's open in the app,
 * the others in the browser or mail app); false draws them as their text only, for a place that is one tap target
 * itself (the conversation's app bar opens the details).
 */
@Composable
fun TopicLine(
    controller: AppController, topic: String, modifier: Modifier = Modifier, links: Boolean = true,
    style: TextStyle = MaterialTheme.typography.bodyMedium, color: Color = Color.Unspecified,
    maxLines: Int = Int.MAX_VALUE, textAlign: TextAlign? = null,
) {
    val store = controller.store
    val tokens = remember(topic) { TopicText.tokens(topic) { id -> store.users[id]?.displayName } }
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    val pageLinks = LocalPageLinks.current
    val base = controller.serverBase
    fun open(link: TopicInternalLink) {
        when (link) {
            is TopicInternalLink.Message -> controller.scope.launch { controller.openPermalink(link.id) }
            is TopicInternalLink.Canvas -> controller.scope.launch { controller.openCanvasLink(link.id) }
            is TopicInternalLink.Page -> pageLinks?.open?.invoke(link.id)
            is TopicInternalLink.Event -> controller.scope.launch { controller.openEventLink(link.id) }
            is TopicInternalLink.Drive -> controller.scope.launch { controller.openDriveLink(link.id) }
            is TopicInternalLink.Equipment -> controller.openEquipmentLink(link.id)
        }
    }
    val text: AnnotatedString = buildAnnotatedString {
        for (token in tokens) {
            when (token) {
                is TopicToken.Text -> append(token.text)
                is TopicToken.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(token.text) }
                is TopicToken.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(token.text) }
                is TopicToken.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(token.text) }
                is TopicToken.Code -> withStyle(SpanStyle(fontFamily = CodeFont, fontSize = 0.9.em, background = codeBackground)) { append(" " + token.text + " ") }
                is TopicToken.Link -> if (!links) append(token.shown) else {
                    val styles = TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))
                    val internal = TopicText.internal(base, token.url)
                        // A page link needs the main screen's page links; equipment links need lending (else the browser).
                        ?.takeIf { (it !is TopicInternalLink.Page || pageLinks != null) && (it !is TopicInternalLink.Equipment || store.lending != null) }
                    if (internal != null) withLink(LinkAnnotation.Clickable(token.url, styles) { open(internal) }) { append(token.shown) }
                    else withLink(LinkAnnotation.Url(token.url, styles)) { append(token.shown) }
                }
            }
        }
    }
    Text(text, modifier = modifier, style = style, color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis, textAlign = textAlign)
}
