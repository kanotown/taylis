package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.delay
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

/** "Alice が入力中…" above the composer; volatile (SYNC_PROTOCOL.md §5.2), re-checked every second so entries expire. */
@Composable
fun TypingLine(controller: AppController, channelId: String, parentId: String? = null, version: Int = 0) {
    val store = controller.store
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val users = remember(version, now, channelId, parentId) { store.typingUsers(channelId, parentId, now) }
    LaunchedEffect(users.isNotEmpty()) {
        while (users.isNotEmpty()) {
            delay(1000)
            now = System.currentTimeMillis()
        }
    }
    // The line keeps its height while nobody types (as on the desktop and iOS): coming and going, it changed the
    // conversation's height and every row jumped when a message arrived (the typing ends with it; tester, 2026-09-30).
    Row(Modifier.fillMaxWidth().height(20.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        if (users.isEmpty()) return@Row
        val names = users.map { store.users[it]?.displayName ?: "…" }
        val label = if (names.size <= 2) names.joinToString(stringResource(R.string.common_list_separator)) + stringResource(R.string.typing_line_typing) else stringResource(R.string.typing_line_and_others_are_typing, names.first(), names.size - 1)
        CircularProgressIndicator(Modifier.size(10.dp), strokeWidth = 1.5.dp)
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}
