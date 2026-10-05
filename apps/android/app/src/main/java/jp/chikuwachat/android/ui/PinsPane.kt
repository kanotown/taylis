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
    var pins by remember { mutableStateOf<List<MessageOut>?>(null) }
    // Pin changes arrive as message.updated; re-read when the pinned rows move (also ones older than the loaded timeline).
    val signature = remember(version, channelId) { store.pinnedIds(channelId).joinToString(",") }
    LaunchedEffect(channelId, signature, controller.engineStatus) {
        controller.listPins(channelId).onSuccess { pins = it }.onFailure { controller.error = controller.describe(it) }
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
