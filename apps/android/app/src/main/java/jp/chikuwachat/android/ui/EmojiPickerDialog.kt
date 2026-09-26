package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Emoji picker (M11f): search by shortcode / keyword (en + ja) or browse by category. */
@Composable
fun EmojiPickerDialog(onDismiss: () -> Unit, onPick: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    var category by remember { mutableStateOf(EmojiData.categories.first().first) }
    val searching = query.isNotBlank()
    val shown = remember(query, category) { Emoji.search(query).let { hits -> if (searching) hits else hits.filter { it.category == category } } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("絵文字") },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, singleLine = true, placeholder = { Text("検索 (例: tada、乾杯)") }, modifier = Modifier.fillMaxWidth())
                if (!searching) {
                    FlowRow(Modifier.padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        EmojiData.categories.forEach { (key, label) -> FilterChip(selected = category == key, onClick = { category = key }, label = { Text(label) }) }
                    }
                }
                LazyVerticalGrid(columns = GridCells.Fixed(8), modifier = Modifier.fillMaxWidth().height(240.dp)) {
                    items(shown, key = { it.shortcode }) { entry ->
                        Text(
                            entry.glyph,
                            fontSize = 24.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.clickable { onPick(entry.glyph) }.padding(6.dp),
                        )
                    }
                }
                if (shown.isEmpty()) Text("見つかりません", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth().padding(16.dp), textAlign = TextAlign.Center)
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}
