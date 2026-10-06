package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

/** Messages pinned in a channel (M11c), most recently pinned first; a row reveals the message. */
@Composable
fun PinsPane(controller: AppController, channelId: String, version: Int, onOpen: (MessageOut) -> Unit) {
    val store = controller.store
    var pins by remember(channelId) { mutableStateOf<List<MessageOut>?>(null) }
    // A read again: a row pinned meanwhile (its place is the server's), a change during a read, events lost.
    var reads by remember(channelId) { mutableIntStateOf(0) }
    var reading by remember(channelId) { mutableStateOf(false) }
    var changedWhileReading by remember(channelId) { mutableStateOf(false) }
    LaunchedEffect(channelId, controller.engineStatus, reads) {
        reading = true
        changedWhileReading = false
        controller.listPins(channelId).onSuccess { pins = it }.onFailure { controller.error = controller.describe(it) }
        reading = false
        if (changedWhileReading) reads += 1
    }
    // 2026-10-06: pin changes arrive as message.updated / message.deleted (pinned_at null), live or as rows the store takes
    // (my own delete or unpin): a deleted or unpinned row leaves at once, also one older than the rows held here (the
    // store's pinned rows alone missed those).
    val engine = controller.engine
    LaunchedEffect(engine, channelId) {
        engine?.rowEvents?.collect { event ->
            val message = event.message?.takeIf { it.channelId == channelId } ?: return@collect
            if (reading) { changedWhileReading = true; return@collect }
            val shown = pins ?: return@collect
            val next = PinsList.applied(shown, message)
            if (next == null) reads += 1 else pins = next
        }
    }
    LaunchedEffect(engine, channelId) {
        val stale = engine?.rowsStale ?: return@LaunchedEffect
        var seen = stale.value
        stale.collect { count -> if (count != seen) { seen = count; reads += 1 } }
    }
    val list = pins
    LazyColumn(Modifier.fillMaxSize()) {
        when {
            list == null -> item { Text(stringResource(R.string.common_loading), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            list.isEmpty() -> item {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.pins_pane_no_pinned_messages), style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.pins_pane_long_press_a_message_and_choose), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                }
            }
            else -> items(list, key = { it.id }) { message ->
                MessageCard(message, store, version, { controller.loadEmojiImage(it) }, onClick = { onOpen(message) })
                HorizontalDivider()
            }
        }
    }
}

/** The pins pane's list (most recently pinned first) after a change to one row of its channel. */
object PinsList {
    /**
     * A deleted or unpinned row leaves, a pinned one the list holds takes the newer version (by updated_seq,
     * SYNC_PROTOCOL.md §8); null for a pinned row the list does not hold: its place is the server's (read the list again).
     */
    fun applied(list: List<MessageOut>, message: MessageOut): List<MessageOut>? {
        val index = list.indexOfFirst { it.id == message.id }
        val pinned = message.pinnedAt != null && !message.deleted
        if (index < 0) return if (pinned) null else list
        if (message.updatedSeq < list[index].updatedSeq) return list
        return if (pinned) list.toMutableList().also { it[index] = message } else list.filterIndexed { i, _ -> i != index }
    }
}
