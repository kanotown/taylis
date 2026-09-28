package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** The server's limits (messages/schemas.py PollCreate): 2-10 options of 1-80 characters, a question of 1-200. */
object PollForm {
    const val MAX_OPTIONS = 10

    /** What is wrong before sending, in the words the form shows (the desktop's pollProblem); null when it can go. */
    fun problem(question: String, options: List<String>): String? {
        val filled = options.map { it.trim() }.filter { it.isNotEmpty() }
        return when {
            question.isBlank() -> "質問を入れてください"
            filled.size < 2 -> "選択肢を 2 つ以上入れてください"
            filled.map { it.lowercase() }.toSet().size != filled.size -> "同じ選択肢が重なっています"
            else -> null
        }
    }
}

/**
 * 「アンケートを作成」 (testers asked for a form like Polly, and for polls with several answers): a question, 2-10
 * options, and whether one person may pick several. `/poll 質問 | A | B` still makes a single-answer poll at once.
 */
@Composable
fun PollDialog(onDismiss: () -> Unit, onCreate: suspend (question: String, options: List<String>, multiple: Boolean) -> Boolean, launch: (suspend () -> Unit) -> Unit) {
    var question by remember { mutableStateOf("") }
    val options = remember { mutableStateListOf("", "") }
    var multiple by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var tried by remember { mutableStateOf(false) }
    val problem = PollForm.problem(question, options)
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("アンケートを作成") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    question, { if (it.length <= 200) question = it }, label = { Text("質問") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                options.forEachIndexed { index, option ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            option, { if (it.length <= 80) options[index] = it }, label = { Text("選択肢 ${index + 1}") }, singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        if (options.size > 2) {
                            IconButton(onClick = { options.removeAt(index) }) { Icon(Icons.Default.Close, contentDescription = "選択肢 ${index + 1} を削除") }
                        }
                    }
                }
                if (options.size < PollForm.MAX_OPTIONS) {
                    TextButton(onClick = { options.add("") }) {
                        Icon(Icons.Default.Add, contentDescription = null)
                        Text("選択肢を追加", modifier = Modifier.padding(start = 4.dp))
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = multiple, onCheckedChange = { multiple = it })
                    Text("複数選択を許可する")
                }
                if (tried && problem != null) Text(problem, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                tried = true
                if (problem != null) return@TextButton
                busy = true
                launch {
                    val made = onCreate(question.trim(), options.map { it.trim() }.filter { it.isNotEmpty() }, multiple)
                    busy = false
                    if (made) onDismiss()
                }
            }) { Text(if (busy) "作成中…" else "作成") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("キャンセル") } },
    )
}
