package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store

/** Someone in a list of who voted, reacted or acknowledged (M27). */
data class Person(val id: String, val name: String)

/**
 * M27: who did something, in the short form a message row has room for (the same on all clients): up to three names,
 * then 「ほか N 人」. The full list is a tap away ([PeopleDialog]).
 */
object PeopleText {
    const val SHOWN = 3

    /** 「山田、佐藤」, 「山田、佐藤、鈴木 ほか 2 人」; empty for nobody. */
    fun compact(names: List<String>, shown: Int = SHOWN): String {
        if (names.size <= shown) return names.joinToString("、")
        return names.take(shown).joinToString("、") + " ほか ${names.size - shown} 人"
    }

    /** M15e acknowledgements: 「山田、佐藤 が確認」, 「山田、佐藤、鈴木 ほか 2 人が確認」. */
    fun acknowledged(names: List<String>): String =
        if (names.size <= SHOWN) compact(names) + " が確認" else compact(names) + "が確認"

    /** A user's name for these lists; someone no longer known reads as 「?」 like elsewhere. */
    fun name(store: Store, userId: String): String =
        store.users[userId]?.displayName ?: store.me?.takeIf { it.id == userId }?.displayName ?: "?"

    fun people(store: Store, userIds: List<String>): List<Person> = userIds.map { Person(it, name(store, it)) }
}

/** The whole list behind a compact line (voters of an option, who acknowledged): avatar and name, in the given order. */
@Composable
fun PeopleDialog(title: String, people: List<Person>, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                people.forEach { PersonRow(it) }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

@Composable
private fun PersonRow(person: Person) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Avatar(person.id, person.name, size = 28.dp)
        Spacer(Modifier.width(10.dp))
        Text(person.name, style = MaterialTheme.typography.bodyLarge)
    }
}

/**
 * 「リアクションした人」 (M27): for each reaction its emoji (a custom one drawn as its image, like the chips) and who added
 * it. `version` is read: names and emoji images live in the Store, not in `message`.
 */
@Composable
fun ReactorsDialog(message: MessageState, store: Store, version: Int, onNeedEmojiImage: (CustomEmojiOut) -> Unit, onDismiss: () -> Unit) {
    val groups = remember(version, message.reactions) { message.reactions.map { it to PeopleText.people(store, it.userIds) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("リアクションした人") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                groups.forEachIndexed { index, (reaction, people) ->
                    if (index > 0) HorizontalDivider(Modifier.padding(vertical = 10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val custom = CustomEmoji.name(reaction.emoji)?.let { store.customEmoji[it] }
                        val image = custom?.let { store.emojiImages[it.id] }
                        if (custom != null && image == null) onNeedEmojiImage(custom)
                        if (image != null) {
                            EmojiImage(image, store.emojiAnimations[custom.id], contentDescription = reaction.emoji, modifier = Modifier.size(24.dp))
                        } else {
                            Text(reaction.emoji, style = MaterialTheme.typography.titleLarge)
                        }
                        Spacer(Modifier.width(8.dp))
                        Text("${reaction.count} 人", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(Modifier.fillMaxWidth().padding(start = 4.dp, top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        people.forEach { PersonRow(it) }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}
