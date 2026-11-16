package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.DataObject
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.outlined.FormatBold
import androidx.compose.material.icons.outlined.FormatItalic
import androidx.compose.material.icons.outlined.FormatListNumbered
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material.icons.outlined.FormatStrikethrough
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Title
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.app.AppController

/**
 * M187: the `@` and `:` completions under a text being written, one set of rules for the composer and 「メッセージを編集」:
 * the people (then groups, @channel / @here) while an `@name` is typed, else the emoji for a `:name` (the custom ones
 * first, by name, label or keyword, then the standard ones; [EMOJI_LIMIT] in all).
 */
object Completions {
    const val EMOJI_LIMIT = 8

    /** What the rows offer; at most one of the two is non-empty (the emoji only while no person matches). */
    data class Hits(val mentions: List<Mentions.Candidate> = emptyList(), val emoji: List<EmojiEntry> = emptyList()) {
        val isEmpty: Boolean get() = mentions.isEmpty() && emoji.isEmpty()
    }

    /**
     * The emoji for `:query`: the custom ones as `:name:` entries (category `custom`; M100: by label and keywords too,
     * 「:ありがとう」 finds :hpd-bow:), then the standard ones.
     */
    fun emoji(query: String, custom: Collection<CustomEmojiOut>): List<EmojiEntry> =
        (CustomEmoji.candidates(query, custom).map { EmojiEntry(shortcode = it.name, glyph = ":${it.name}:", category = CUSTOM, keywords = it.label ?: "") } +
            Emoji.candidates(query)).take(EMOJI_LIMIT)

    /** What [typed] (the text up to the cursor) offers; [people] ranks the candidates for an `@` query, asked only then. */
    fun find(typed: String, custom: Collection<CustomEmojiOut>, people: (query: String) -> List<Mentions.Candidate>): Hits {
        val mentions = Mentions.query(typed)?.let(people).orEmpty()
        if (mentions.isNotEmpty()) return Hits(mentions = mentions)
        return Hits(emoji = Emoji.query(typed)?.let { emoji(it, custom) }.orEmpty())
    }

    /**
     * The text the completions read in a field whose selection is [start]..[end]: what is before the cursor (a word can
     * be completed in the middle of the text), nothing while a range is selected.
     */
    fun typed(text: String, start: Int, end: Int): String =
        if (start != end) "" else text.substring(0, start.coerceIn(0, text.length))

    /** `@name` typed before [cursor] completed to [username] (and a space), the cursor after it. */
    fun mention(text: String, cursor: Int, username: String): ComposerFormat.Result = complete(text, cursor) { Mentions.complete(it, username) }

    /** `:name` typed before [cursor] replaced with [glyph] (and a space), the cursor after it. */
    fun emoji(text: String, cursor: Int, glyph: String): ComposerFormat.Result = complete(text, cursor) { Emoji.complete(it, glyph) }

    /**
     * [completed] on the text before [cursor]; the text after it stays. A space right after the cursor is the one the
     * completion ends with (the desktop's `takenAfter`): one space there, and the cursor after it, past the completed word
     * (before it, the word would be read again and offered).
     */
    private fun complete(text: String, cursor: Int, completed: (String) -> String): ComposerFormat.Result {
        val at = cursor.coerceIn(0, text.length)
        val head = completed(text.substring(0, at))
        val rest = text.substring(at).let { if (head.endsWith(" ") && it.startsWith(" ")) it.substring(1) else it }
        return ComposerFormat.Result(head + rest, head.length, head.length)
    }

    private const val CUSTOM = "custom"
}

/**
 * M187: [Completions] for [typed] in the conversation [channelId] (in the thread [parentId]); while an `@name` is typed,
 * the channel's members are read for the ranking (MOBILE_UI.md §23: once; again when they change), and the people of the
 * conversation come first (the thread's, then the channel's), me last.
 */
@Composable
fun completionHits(controller: AppController, channelId: String, parentId: String?, typed: String): Completions.Hits {
    val store = controller.store
    val mentionOpen = Mentions.query(typed) != null
    val memberEpoch = store.memberEpoch(channelId)
    LaunchedEffect(mentionOpen, channelId, memberEpoch) { if (mentionOpen) controller.readMentionMembers(channelId) }
    return Completions.find(typed, store.customEmoji.values) { query ->
        Mentions.candidates(query, store.users.values, store.groups.values, aiBotIds = controller.aiBotIdsRead, context = Mentions.context(store, channelId, parentId))
    }
}

/** The completion rows' place: under the composer's input, or under the edit dialog's field (no side padding there). */
val COMPLETION_ROW_PADDING = PaddingValues(horizontal = 8.dp, vertical = 4.dp)

/**
 * `:tada` completes to an emoji (M11f): the chips for [Completions.Hits.emoji], a custom one as its image (or text pill)
 * and label, not `:name:` twice. A tap notes the emoji as used ([QuickReactions.remember]) and hands it to [onPick].
 * [version]: the Store's, so an image that lands while the row shows is drawn.
 */
@Composable
fun EmojiCompletionRow(hits: List<EmojiEntry>, controller: AppController, version: Int, onPick: (EmojiEntry) -> Unit, padding: PaddingValues = COMPLETION_ROW_PADDING) {
    if (hits.isEmpty()) return
    val store = controller.store
    LazyRow(Modifier.fillMaxWidth().padding(padding), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(hits, key = { it.shortcode }) { entry ->
            Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { QuickReactions.remember(controller.prefs, entry.glyph); onPick(entry) }) {
                val custom = if (entry.category == "custom") store.customEmoji[entry.shortcode] else null
                if (custom != null) {
                    val image = version.let { store.emojiImages[custom.id] }
                    if (image == null) controller.loadEmojiImage(custom)
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                        if (image != null) EmojiImage(image, store.emojiAnimations[custom.id], contentDescription = null, modifier = Modifier.height(20.dp).width((20 * CustomEmoji.aspect(custom)).dp))
                        Text("  " + (custom.label ?: ":${custom.name}:"), style = MaterialTheme.typography.labelLarge)
                    }
                } else {
                    Text(entry.glyph + "  :" + entry.shortcode + ":", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }
        }
    }
}

/** `@name`: the chips for [Completions.Hits.mentions] (an AI bot with 「AI」, M66); a tap hands the candidate to [onPick]. */
@Composable
fun MentionCompletionRow(hits: List<Mentions.Candidate>, onPick: (Mentions.Candidate) -> Unit, padding: PaddingValues = COMPLETION_ROW_PADDING) {
    if (hits.isEmpty()) return
    LazyRow(Modifier.fillMaxWidth().padding(padding), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(hits, key = { it.username }) { candidate ->
            Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { onPick(candidate) }) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                    Text("@" + candidate.username + "  " + candidate.label, style = MaterialTheme.typography.labelLarge)
                    if (candidate.ai) AiBadge(Modifier.padding(start = 6.dp)) // M66
                }
            }
        }
    }
}

/**
 * M187: the writing tools the composer's tool row and the edit dialog share, put into the caller's row: @ (an `@` at the
 * cursor, [ComposerText.mention]), the emoji picker ([onEmoji]: the caller opens it) and 「Aa」 ([FormatMenu]). Drawn in
 * [tint]; greyed while not [enabled] (the edit being saved).
 */
@Composable
fun WritingTools(tint: Color, onMention: () -> Unit, onEmoji: () -> Unit, onFormat: (ComposerFormat) -> Unit, enabled: Boolean = true) {
    val color = if (enabled) tint else tint.copy(alpha = 0.38f)
    IconButton(enabled = enabled, onClick = onMention) {
        Icon(Icons.Outlined.AlternateEmail, contentDescription = stringResource(R.string.common_mention), tint = color)
    }
    IconButton(enabled = enabled, onClick = onEmoji) { Icon(Icons.Outlined.EmojiEmotions, contentDescription = stringResource(R.string.common_emoji), tint = color) }
    Box {
        var formatOpen by remember { mutableStateOf(false) }
        IconButton(enabled = enabled, onClick = { formatOpen = true }, modifier = Modifier.semantics { contentDescription = L10n.str(R.string.composer_formatting) }) {
            Text("Aa", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = color)
        }
        FormatMenu(formatOpen, onDismiss = { formatOpen = false }) { format ->
            formatOpen = false
            onFormat(format)
        }
    }
}

/** 仕上げ B: 「Aa」, the marks put around the selection or at the cursor ([ComposerFormat]). */
@Composable
private fun FormatMenu(expanded: Boolean, onDismiss: () -> Unit, onPick: (ComposerFormat) -> Unit) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        ComposerFormat.entries.forEach { format ->
            DropdownMenuItem(
                text = { Text(format.label) }, onClick = { onPick(format) },
                leadingIcon = { Icon(format.icon(), contentDescription = null) },
            )
        }
    }
}

private fun ComposerFormat.icon(): ImageVector = when (this) {
    ComposerFormat.BOLD -> Icons.Outlined.FormatBold
    ComposerFormat.ITALIC -> Icons.Outlined.FormatItalic
    ComposerFormat.STRIKE -> Icons.Outlined.FormatStrikethrough
    ComposerFormat.CODE -> Icons.Outlined.Code
    ComposerFormat.CODE_BLOCK -> Icons.Outlined.DataObject
    ComposerFormat.HEADING -> Icons.Outlined.Title
    ComposerFormat.QUOTE -> Icons.Outlined.FormatQuote
    ComposerFormat.BULLET -> Icons.AutoMirrored.Outlined.FormatListBulleted
    ComposerFormat.NUMBERED -> Icons.Outlined.FormatListNumbered
    ComposerFormat.LINK -> Icons.Outlined.Link
}
