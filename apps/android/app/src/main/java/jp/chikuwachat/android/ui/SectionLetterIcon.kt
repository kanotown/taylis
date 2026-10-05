package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.text.Normalizer
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * M114 (docs/DATA_MODEL.md sidebar_sections): a section's letter badge, `letter:<text>:<colour>`: one or two ASCII
 * letters / digits or one Japanese character (kana, kanji, 々) in a text emoji colour. The server checks the same rule;
 * apps/shared/section-icons.json holds the cases every client passes.
 */
data class SectionLetterIcon(val text: String, val color: String) {
    val icon: String get() = "$PREFIX$text:$color"

    companion object {
        const val PREFIX = "letter:"

        /** The palette keys in the server's order (apps/shared/text-emoji.json), with the names the picker says. */
        val COLORS: List<Pair<String, String>> = listOf(
            "gray" to L10n.str(R.string.section_letter_icon_gray), "red" to L10n.str(R.string.section_letter_icon_red), "orange" to L10n.str(R.string.section_letter_icon_orange), "yellow" to L10n.str(R.string.section_letter_icon_yellow),
            "green" to L10n.str(R.string.section_letter_icon_green), "blue" to L10n.str(R.string.section_letter_icon_blue), "purple" to L10n.str(R.string.section_letter_icon_purple), "pink" to L10n.str(R.string.section_letter_icon_pink),
        )

        private val TEXT = Regex("[A-Za-z0-9]{1,2}|[\\u3005\\u3041-\\u309f\\u30a0-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff]")

        fun isLetterText(text: String): Boolean = TEXT.matches(text)

        /** The badge an icon is, or null (an emoji or a custom emoji `:name:`, drawn as before). */
        fun parse(icon: String?): SectionLetterIcon? {
            if (icon == null || !icon.startsWith(PREFIX)) return null
            val parts = icon.removePrefix(PREFIX).split(":")
            if (parts.size != 2 || !isLetterText(parts[0]) || COLORS.none { it.first == parts[1] }) return null
            return SectionLetterIcon(parts[0], parts[1])
        }

        /** What the picker's field holds, made ready: full-width letters and half-width kana become their usual form. */
        fun normalize(input: String): String = Normalizer.normalize(input, Normalizer.Form.NFKC).filterNot { it.isWhitespace() }
    }
}

/** M114: the letters on a rounded square in their text emoji colour (the light or dark pair, as the theme is). */
@Composable
fun LetterBadge(text: String, color: String, size: Dp = 18.dp, modifier: Modifier = Modifier) {
    val palette = TextEmojiPill.PALETTE[color] ?: TextEmojiPill.PALETTE.getValue("gray")
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val (bg, fg) = if (dark) palette.second else palette.first
    // Sized by the badge, not by the person's font scale: it is an icon.
    val density = LocalDensity.current
    val fontSize = with(density) { (size * (if (text.codePointCount(0, text.length) > 1) 0.5f else 0.62f)).toSp() }
    val lineHeight = with(density) { (size * 0.9f).toSp() }
    Box(
        modifier.size(size).background(Color(0xFF000000L or bg), RoundedCornerShape(size * 0.26f)).clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            color = Color(0xFF000000L or fg),
            fontSize = fontSize,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            maxLines = 1,
            softWrap = false,
            style = MaterialTheme.typography.bodySmall.copy(lineHeight = lineHeight),
        )
    }
}
