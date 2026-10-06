package jp.chikuwachat.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import java.util.UUID
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * M119 「問題を報告・ご意見」 (MODERATION.md §3.1): a report that needs no message, from Settings (anyone, guests too)
 * or a person's profile (`user_id`). The rules the form follows, kept apart from the view so tests can run them.
 */
object Reports {
    /** The server's limit on `note` (after trimming). */
    const val MAX_NOTE = 4000

    /** The child safety contact of docs/store/CHILD_SAFETY.md (the developer), shown as text in the form. */
    const val CHILD_SAFETY_CONTACT = "kanotown@gmail.com"

    /** The categories in the order every client shows them (子どもの安全 first); the server's `category`. */
    val categoryCodes: List<String> = listOf("child_safety", "harassment", "inappropriate", "spam", "feedback", "other")

    val categories: List<Pair<String, String>> get() = categoryCodes.map { it to label(it) }

    fun label(category: String): String = when (category) {
        "child_safety" -> L10n.str(R.string.moderation_child_safety)
        "harassment" -> L10n.str(R.string.moderation_harassment)
        "inappropriate" -> L10n.str(R.string.moderation_inappropriate_content)
        "spam" -> L10n.str(R.string.moderation_spam)
        "feedback" -> L10n.str(R.string.report_problem_feedback)
        else -> L10n.str(R.string.common_other)
    }

    enum class Problem { NO_CATEGORY, EMPTY_NOTE, NOTE_TOO_LONG }

    /** What stops 「送信」, or null when the server would take it. */
    fun problem(category: String?, note: String): Problem? = when {
        category == null || category !in categoryCodes -> Problem.NO_CATEGORY
        note.isBlank() -> Problem.EMPTY_NOTE
        note.trim().length > MAX_NOTE -> Problem.NOTE_TOO_LONG
        else -> null
    }

    /** `POST /api/v1/reports`'s body: the note trimmed, `user_id` only for a person, always the retry key. */
    fun body(category: String, note: String, userId: String?, clientReportId: String): JsonObject = buildJsonObject {
        put("category", category)
        put("note", note.trim())
        if (userId != null) put("user_id", userId)
        put("client_report_id", clientReportId)
    }

    /**
     * The retry key (`client_report_id`): made on the first 「送信」 and kept through every failure, so a resend after a
     * lost response gets the first report back (`200`) instead of a second one; cleared once the server took it.
     */
    fun key(current: String?, make: () -> String = { UUID.randomUUID().toString() }): String = current ?: make()
}

/**
 * The form (MODERATION.md §3.1): category, the required text with its counter, where the report goes and the child
 * safety contact, 「送信」. Never leaves the app. `userId`: a report about that person (「〇〇 さんを報告」).
 */
@Composable
fun ReportProblemDialog(controller: AppController, userId: String?, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val name = userId?.let { controller.store.users[it]?.displayName ?: L10n.str(R.string.moderation_unknown_user) }
    var category by rememberSaveable { mutableStateOf<String?>(null) }
    var note by rememberSaveable { mutableStateOf("") }
    var clientReportId by rememberSaveable { mutableStateOf<String?>(null) }
    var sent by rememberSaveable { mutableStateOf(false) }
    var tried by rememberSaveable { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val problem = Reports.problem(category, note)

    fun submit() {
        tried = true
        failure = null
        val chosen = category
        if (problem != null || chosen == null || busy) return
        val key = Reports.key(clientReportId)
        clientReportId = key
        busy = true
        scope.launch {
            val error = controller.submitReport(Reports.body(chosen, note, userId, key))
            busy = false
            if (error == null) {
                clientReportId = null
                sent = true
            } else {
                failure = error
            }
        }
    }

    Dialog(onDismissRequest = { if (!busy) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = LocalView.current
        val lightBars = !isSystemInDarkTheme()
        SideEffect {
            (view.parent as? DialogWindowProvider)?.window?.let { window ->
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = lightBars
                    isAppearanceLightNavigationBars = lightBars
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(enabled = !busy, onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_close)) }
                    Text(
                        if (name != null) stringResource(R.string.report_problem_report_user, name) else stringResource(R.string.report_problem_title),
                        style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).semantics { heading() },
                    )
                    if (!sent) {
                        TextButton(enabled = !busy, onClick = ::submit) { Text(if (busy) stringResource(R.string.report_problem_sending) else stringResource(R.string.common_send)) }
                    }
                }
                HorizontalDivider()
                Column(
                    Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp).widthIn(max = 640.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (sent) {
                        Text(stringResource(R.string.report_problem_sent), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(stringResource(R.string.report_problem_where_it_goes), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = onDismiss) { Text(stringResource(R.string.common_close)) }
                        return@Column
                    }
                    Text(stringResource(R.string.report_problem_where_it_goes), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(stringResource(R.string.report_problem_category), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(Modifier.selectableGroup()) {
                        Reports.categories.forEach { (value, label) ->
                            Row(
                                Modifier.fillMaxWidth().selectable(selected = category == value, enabled = !busy, role = Role.RadioButton) { category = value }.padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = category == value, onClick = null)
                                Spacer(Modifier.width(8.dp))
                                Text(label)
                            }
                        }
                    }
                    if (tried && problem == Reports.Problem.NO_CATEGORY) {
                        Text(stringResource(R.string.report_problem_choose_a_category), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    OutlinedTextField(
                        value = note, onValueChange = { note = it.take(Reports.MAX_NOTE) }, enabled = !busy,
                        label = { Text(stringResource(R.string.report_problem_details)) },
                        placeholder = { Text(stringResource(R.string.report_problem_details_placeholder)) },
                        minLines = 5,
                        isError = tried && note.isBlank(),
                        supportingText = {
                            Row(Modifier.fillMaxWidth()) {
                                if (tried && note.isBlank()) {
                                    Text(stringResource(R.string.report_problem_write_the_details), modifier = Modifier.weight(1f))
                                } else {
                                    Spacer(Modifier.weight(1f))
                                }
                                Text("${note.length} / ${Reports.MAX_NOTE}")
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    failure?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    Button(enabled = !busy, onClick = ::submit, modifier = Modifier.fillMaxWidth()) {
                        Text(if (busy) stringResource(R.string.report_problem_sending) else stringResource(R.string.common_send))
                    }
                    SelectionContainer {
                        Text(
                            stringResource(R.string.report_problem_child_safety_contact, Reports.CHILD_SAFETY_CONTACT),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
