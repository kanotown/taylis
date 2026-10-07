package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit

/**
 * A long attachment / file name is shortened in its middle so the extension stays visible
 * (「研究報告書_最終版_修正…2026年度.pdf」, 2026-10-07). The split rule and its cases are shared with the desktop and
 * iOS (apps/shared/file-name-ellipsis.json): `ext` from the last dot (not a leading one, at most 8 characters, no
 * whitespace), `tail` the stem's last 6 code points when the stem is longer than 12 (never starting inside a
 * character). A single line uses Compose's middle ellipsis on the whole name; a small tile with two lines puts the
 * stem on the first and the extension on the second ([FileNameText]).
 */
object FileNameEllipsis {
    data class Parts(val head: String, val tail: String, val ext: String) {
        val stem: String get() = head + tail
    }

    private const val MAX_EXT = 8
    private const val TAIL = 6
    private const val TAIL_FROM = 12
    private const val ZWJ = 0x200d

    private fun extendsPrevious(cp: Int): Boolean {
        if (cp == ZWJ || cp in 0xfe00..0xfe0f || cp in 0xe0100..0xe01ef || cp in 0x1f3fb..0x1f3ff || cp in 0xe0020..0xe007f || cp in 0x1160..0x11ff) return true
        val type = Character.getType(cp)
        return type == Character.NON_SPACING_MARK.toInt() || type == Character.COMBINING_SPACING_MARK.toInt() || type == Character.ENCLOSING_MARK.toInt()
    }

    private fun regionalIndicator(cp: Int) = cp in 0x1f1e6..0x1f1ff

    private fun string(cps: List<Int>): String = buildString { cps.forEach { appendCodePoint(it) } }

    fun split(name: String): Parts {
        val cps = name.codePoints().toArray().toList()
        val dot = cps.lastIndexOf('.'.code)
        val extLength = cps.size - 1 - dot
        if (dot <= 0 || extLength < 1 || extLength > MAX_EXT || cps.subList(dot + 1, cps.size).any { Character.isWhitespace(it) || Character.isSpaceChar(it) }) {
            return Parts(name, "", "")
        }
        val stem = cps.subList(0, dot)
        val ext = string(cps.subList(dot, cps.size))
        if (stem.size <= TAIL_FROM) return Parts(string(stem), "", ext)
        var start = stem.size - TAIL
        while (start > 0) {
            if (extendsPrevious(stem[start]) || stem[start - 1] == ZWJ) { start -= 1; continue }
            if (regionalIndicator(stem[start])) {
                var before = 0
                while (start - 1 - before >= 0 && regionalIndicator(stem[start - 1 - before])) before += 1
                if (before % 2 == 1) { start -= 1; continue }
            }
            break
        }
        return Parts(string(stem.subList(0, start)), string(stem.subList(start, stem.size)), ext)
    }

    /** How a single line of [name] overflows: in the middle when it has an extension, else at the end. */
    fun overflow(name: String): TextOverflow = if (split(name).ext.isEmpty()) TextOverflow.Ellipsis else TextOverflow.MiddleEllipsis
}

/**
 * A file name on one line that keeps its extension: the middle of the name gives way ([FileNameEllipsis]). `text`
 * draws the name with styling (search highlights); it must be the same characters as [name]. TalkBack reads the
 * whole name (the semantics text is never truncated).
 */
@Composable
fun FileNameText(
    name: String,
    modifier: Modifier = Modifier,
    text: AnnotatedString? = null,
    style: TextStyle = LocalTextStyle.current,
    color: Color = Color.Unspecified,
    fontWeight: FontWeight? = null,
) {
    val overflow = FileNameEllipsis.overflow(name)
    if (text != null) Text(text, modifier, color = color, style = style, fontWeight = fontWeight, maxLines = 1, overflow = overflow)
    else Text(name, modifier, color = color, style = style, fontWeight = fontWeight, maxLines = 1, overflow = overflow)
}

/**
 * A small tile's two lines (the composer's pending files): the stem on the first, cut in its middle, the extension on
 * the second; a name without an extension keeps two lines with an ellipsis at the end. Read as one name by TalkBack.
 */
@Composable
fun FileNameTwoLines(name: String, fontSize: TextUnit, lineHeight: TextUnit, color: Color, modifier: Modifier = Modifier) {
    val parts = FileNameEllipsis.split(name)
    if (parts.ext.isEmpty()) {
        Text(name, modifier, fontSize = fontSize, lineHeight = lineHeight, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, color = color)
        return
    }
    Column(modifier.clearAndSetSemantics { contentDescription = name }, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(parts.stem, Modifier.fillMaxWidth(), fontSize = fontSize, lineHeight = lineHeight, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, textAlign = TextAlign.Center, color = color)
        Text(parts.ext, Modifier.fillMaxWidth(), fontSize = fontSize, lineHeight = lineHeight, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, color = color)
    }
}
