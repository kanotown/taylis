package jp.chikuwachat.android.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import jp.chikuwachat.android.api.CalendarFeedOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.CalendarFeeds
import kotlinx.coroutines.launch

/**
 * M69 (CALENDAR.md §10.6, §10.9): 「カレンダーを購読 (iCal)」 from the calendar's ⋮, as the desktop's CalendarFeedsDialog.
 * Make a private feed URL (everything I see, or my own calendar only), copy it (shown this once: the server keeps only a
 * hash), list the ones made (scope, when made, when last read) and delete them (the URL stops at once). Anyone with a URL
 * sees the events, which the screen says first.
 */
@Composable
fun CalendarFeedsScreen(controller: AppController, feeds: CalendarFeeds, onDismiss: () -> Unit) {
    val state by feeds.state.collectAsState()
    var scope by rememberSaveable { mutableStateOf(CalendarFeeds.SCOPE_ALL) }
    var copied by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<CalendarFeedOut?>(null) }
    val context = LocalContext.current
    LaunchedEffect(feeds) { feeds.load() }

    fun copy(url: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Taylis", url)
        // A secret: Android 13+ hides it from the clipboard's preview.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        clipboard.setPrimaryClip(clip)
        copied = true
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
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
            Column(Modifier.fillMaxSize().systemBarsPadding()) {
                FeedsBody(
                    state = state, scope = scope, copied = copied, available = feeds.available,
                    describe = controller::describe,
                    onClose = onDismiss,
                    onScope = { scope = it },
                    onCreate = {
                        copied = false
                        controller.scope.launch { feeds.create(scope) }
                    },
                    onCopy = ::copy,
                    onDelete = { deleting = it },
                )
            }
        }
        deleting?.let { feed ->
            AlertDialog(
                onDismissRequest = { deleting = null },
                title = { Text("購読 URL を削除しますか？") },
                text = { Text("「${CalendarFeeds.scopeLabel(feed.scope)}」の URL は、すぐに使えなくなります。この URL を登録したカレンダーには、もう予定が届きません。") },
                confirmButton = {
                    TextButton(onClick = {
                        deleting = null
                        controller.scope.launch { feeds.delete(feed.id) }
                    }) { Text("削除", color = MaterialTheme.colorScheme.error) }
                },
                dismissButton = { TextButton(onClick = { deleting = null }) { Text("キャンセル") } },
            )
        }
    }
}

@Composable
private fun FeedsBody(
    state: jp.chikuwachat.android.sync.CalendarFeedsState, scope: String, copied: Boolean, available: Boolean, describe: (Throwable) -> String,
    onClose: () -> Unit, onScope: (String) -> Unit, onCreate: () -> Unit, onCopy: (String) -> Unit, onDelete: (CalendarFeedOut) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose) { Icon(Icons.Default.Close, contentDescription = "閉じる") }
            Text("カレンダーを購読 (iCal)", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
        }
        HorizontalDivider()
        Column(
            Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Google カレンダーや Apple のカレンダーに、このアプリの予定を表示します (読み取り専用)。", style = MaterialTheme.typography.bodyMedium)
            Text(
                "購読 URL を知っている人は、ログインしなくても誰でも予定を見られます。人に教えないでください。漏れたら削除して作り直してください。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(8.dp)).padding(12.dp),
            )
            Text("範囲", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.selectableGroup()) {
                CalendarFeeds.SCOPE_CHOICES.forEach { (value, label) ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = scope == value, role = Role.RadioButton, onClick = { onScope(value) }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = scope == value, onClick = null)
                        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 12.dp))
                    }
                }
            }
            Button(onClick = onCreate, enabled = available && !state.busy) { Text("購読 URL を作る") }
            state.made?.let { url ->
                Column(
                    Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(12.dp)).padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("購読 URL", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    SelectionContainer { Text(url, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                    FilledTonalButton(onClick = { onCopy(url) }) {
                        Icon(Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                        Text(if (copied) " コピーしました" else " コピー")
                    }
                    Text(
                        "この URL はいまだけ表示します。閉じると再表示できません (必要なら作り直してください)。",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            state.error?.let { Text(describe(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Text("作った購読 URL", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val list = state.feeds
            when {
                list == null -> Text(if (available) "読み込み中…" else "接続すると表示します", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                list.isEmpty() -> Text("まだありません", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp))) {
                    list.forEachIndexed { index, feed ->
                        if (index > 0) HorizontalDivider()
                        Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
                                Text(CalendarFeeds.scopeLabel(feed.scope), style = MaterialTheme.typography.bodyMedium)
                                Text(CalendarFeeds.feedLine(feed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            IconButton(onClick = { onDelete(feed) }, enabled = !state.busy) {
                                Icon(Icons.Default.Delete, contentDescription = "この購読 URL を削除", tint = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
            Text("使い方", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            listOf(
                "Google カレンダー: パソコンのブラウザで、左の「他のカレンダー」の「＋」→「URL で追加」に URL を貼り付けて「カレンダーを追加」(スマホのアプリからは追加できません)。",
                "Apple のカレンダー: iPhone は「設定」→「カレンダー」→「アカウント」→「アカウントを追加」→「その他」→「照会するカレンダーを追加」。Mac は「ファイル」→「新規カレンダー照会…」。",
                "反映はカレンダーのアプリが読みに来たとき (数分〜数時間ごと) です。90 日前から 400 日先までの予定が入ります。",
            ).forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}
