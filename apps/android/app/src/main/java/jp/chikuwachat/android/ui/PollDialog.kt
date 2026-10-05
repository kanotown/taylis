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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** The server's limits (messages/schemas.py PollCreate): 2-10 options of 1-80 characters, a question of 1-200. */
object PollForm {
    const val MAX_OPTIONS = 10

    /** What is wrong before sending, in the words the form shows (the desktop's pollProblem); null when it can go. */
    fun problem(question: String, options: List<String>): String? {
        val filled = options.map { it.trim() }.filter { it.isNotEmpty() }
        return when {
            question.isBlank() -> L10n.str(R.string.poll_dialog_enter_a_question)
            filled.size < 2 -> L10n.str(R.string.poll_dialog_enter_at_least_2_options)
            filled.map { it.lowercase() }.toSet().size != filled.size -> L10n.str(R.string.poll_dialog_some_options_are_the_same)
            else -> null
        }
    }
}

/** The option fields as a saveable list of strings (M28c). */
private val OptionsSaver = listSaver<SnapshotStateList<String>, String>(save = { it.toList() }, restore = { it.toMutableStateList() })

/**
 * 「アンケートを作成」 (testers asked for a form like Polly, and for polls with several answers): a question, 2-10
 * options, and whether one person may pick several. M27: 「匿名にする」 (off unless chosen) hides who voted from everyone,
 * the author too; it cannot be changed afterwards. `/poll 質問 | A | B` still makes a named single-answer poll at once.
 */
@Composable
fun PollDialog(
    onDismiss: () -> Unit,
    onCreate: suspend (question: String, options: List<String>, multiple: Boolean, anonymous: Boolean) -> Boolean,
    launch: (suspend () -> Unit) -> Unit,
    initialQuestion: String = "",
    initialOptions: List<String> = listOf("", ""),
    initialMultiple: Boolean = false,
) {
    // Saveable (M28c): a rotation while filling the form emptied it. `busy` is not: the request runs in the controller's
    // scope and reports to the state that started it.
    // M30: /日程 alone opens the form filled in (日程調整, the next weekdays, several answers).
    var question by rememberSaveable { mutableStateOf(initialQuestion) }
    val options = rememberSaveable(saver = OptionsSaver) { initialOptions.take(PollForm.MAX_OPTIONS).toMutableStateList() }
    var multiple by rememberSaveable { mutableStateOf(initialMultiple) }
    var anonymous by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var tried by rememberSaveable { mutableStateOf(false) }
    val problem = PollForm.problem(question, options)
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.poll_dialog_create_poll)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    question, { if (it.length <= 200) question = it }, label = { Text(stringResource(R.string.poll_dialog_question)) }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                options.forEachIndexed { index, option ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            option, { if (it.length <= 80) options[index] = it }, label = { Text(stringResource(R.string.poll_dialog_option, index + 1)) }, singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        if (options.size > 2) {
                            IconButton(onClick = { options.removeAt(index) }) { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.poll_dialog_delete_option, index + 1)) }
                        }
                    }
                }
                if (options.size < PollForm.MAX_OPTIONS) {
                    TextButton(onClick = { options.add("") }) {
                        Icon(Icons.Default.Add, contentDescription = null)
                        Text(stringResource(R.string.poll_dialog_add_option), modifier = Modifier.padding(start = 4.dp))
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = multiple, onCheckedChange = { multiple = it })
                    Text(stringResource(R.string.poll_dialog_allow_multiple_choices))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = anonymous, onCheckedChange = { anonymous = it })
                    Text(stringResource(R.string.poll_dialog_anonymous_dont_show_who_voted), modifier = Modifier.padding(start = 8.dp))
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
                    val made = onCreate(question.trim(), options.map { it.trim() }.filter { it.isNotEmpty() }, multiple, anonymous)
                    busy = false
                    if (made) onDismiss()
                }
            }) { Text(if (busy) stringResource(R.string.common_creating) else stringResource(R.string.common_create)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}
