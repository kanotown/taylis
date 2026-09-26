package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.SearchHit
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/** Full-text search: the server filters by membership; we highlight the keywords it matched. */
@Composable
fun SearchPane(controller: AppController, onOpen: (jp.chikuwachat.android.api.MessageOut) -> Unit) {
    val store = controller.store
    var query by rememberSaveable { mutableStateOf("") }
    var hits by remember { mutableStateOf(listOf<SearchHit>()) }
    var keywords by remember { mutableStateOf(listOf<String>()) }
    var hasMore by remember { mutableStateOf(false) }
    var searched by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun run(offset: Int = 0) {
        val q = query.trim()
        if (q.isEmpty()) return
        scope.launch {
            controller.searchMessages(q, offset).onSuccess { result ->
                hits = if (offset == 0) result.hits else hits + result.hits
                keywords = result.keywords
                hasMore = result.hasMore
                searched = true
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            query, { query = it },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            placeholder = { Text("メッセージを検索") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { run() }),
        )
        if (searched && hits.isEmpty()) Text("見つかりませんでした", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        LazyColumn(Modifier.fillMaxSize()) {
            items(hits, key = { it.message.id }) { hit ->
                val message = hit.message
                val channel = store.channel(message.channelId)
                Column(
                    Modifier.fillMaxWidth().clickable { onOpen(message) }.padding(horizontal = 16.dp, vertical = 10.dp),
                ) {
                    Row {
                        Text(channel?.let { channelTitle(it, store) } ?: "?", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(8.dp))
                        Text(store.users[message.senderId]?.displayName ?: "?", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (message.parentId != null) { Spacer(Modifier.width(8.dp)); Text("スレッド", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    Text(highlighted(message.body.ifEmpty { message.attachments.joinToString(", ") { it.filename } }, keywords), style = MaterialTheme.typography.bodyMedium, maxLines = 4)
                }
                HorizontalDivider()
            }
            if (hasMore) item { TextButton(onClick = { run(hits.size) }, modifier = Modifier.padding(8.dp)) { Text("さらに読み込む") } }
        }
    }
}

/** Case-insensitive keyword highlighting done on the client (the server only returns the keywords). */
fun highlighted(text: String, keywords: List<String>) = buildAnnotatedString {
    val ranges = keywordRanges(text, keywords)
    var cursor = 0
    for ((start, end) in ranges) {
        if (start > cursor) append(text.substring(cursor, start))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold, background = androidx.compose.ui.graphics.Color(0x55FFD54F))) { append(text.substring(start, end)) }
        cursor = end
    }
    if (cursor < text.length) append(text.substring(cursor))
}

/** Sorted, non-overlapping [start, end) ranges of every keyword occurrence. */
fun keywordRanges(text: String, keywords: List<String>): List<Pair<Int, Int>> {
    val lower = text.lowercase()
    val found = ArrayList<Pair<Int, Int>>()
    for (keyword in keywords.map { it.lowercase() }.filter { it.isNotEmpty() }.sortedByDescending { it.length }) {
        var index = lower.indexOf(keyword)
        while (index >= 0) {
            found.add(index to index + keyword.length)
            index = lower.indexOf(keyword, index + keyword.length)
        }
    }
    found.sortBy { it.first }
    val merged = ArrayList<Pair<Int, Int>>()
    for (range in found) {
        val last = merged.lastOrNull()
        if (last != null && range.first <= last.second) { if (range.second > last.second) merged[merged.size - 1] = last.first to range.second } else merged.add(range)
    }
    return merged
}
