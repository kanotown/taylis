package jp.chikuwachat.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import jp.chikuwachat.android.app.AppController
import kotlinx.serialization.Serializable

/*
 * M57 (CANVAS.md §17): the canvas's table editor on Android — full screen over the Markdown editor. 「行ごと」 (the
 * default): the header and its columns first (name, alignment, add / delete), then one card per body row with its cells
 * stacked, each labelled by its column's header; 「表の形」: the table as the canvas will show it, scrolling sideways.
 * 「完了」 hands the edited table back (CanvasEditorField writes it into the text), 「キャンセル」 changes nothing.
 */

/** An open table editor: where the table came from and the table as edited so far (kept across a rotation). */
@Serializable
data class TableEditState(val session: CanvasTable.Session, val edited: CanvasTable.Table)

private enum class TableView { ROWS, GRID }

private fun alignLabel(align: CanvasTable.Align?): String = when (align) {
    null -> "なし"
    CanvasTable.Align.LEFT -> "左"
    CanvasTable.Align.CENTER -> "中央"
    CanvasTable.Align.RIGHT -> "右"
}

/** A column's name in the row cards: its header, or 「列N」 while the header is blank. */
private fun columnName(table: CanvasTable.Table, column: Int): String = table.header[column].trim().ifEmpty { "列${column + 1}" }

@Composable
fun CanvasTableEditor(
    controller: AppController,
    state: TableEditState,
    onChange: (CanvasTable.Table) -> Unit,
    onDone: () -> Unit,
    onCancel: () -> Unit,
) {
    val table = state.edited
    var view by rememberSaveable { mutableStateOf(TableView.ROWS) }
    var confirmDiscard by remember { mutableStateOf(false) }
    val changed = table != state.session.table
    // Back: キャンセル — after a question when something was changed (a mistaken back must not lose the edits).
    val back = { if (changed) confirmDiscard = true else onCancel() }

    Dialog(onDismissRequest = back, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = LocalView.current
        val lightBars = !isSystemInDarkTheme()
        SideEffect {
            (window.parent as? DialogWindowProvider)?.window?.let { w ->
                WindowCompat.getInsetsController(w, window).apply {
                    isAppearanceLightStatusBars = lightBars
                    isAppearanceLightNavigationBars = lightBars
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onCancel) { Text("キャンセル") }
                    Text(
                        if (state.session.isNew) "新しい表" else "表を編集",
                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f).semantics { heading() }, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    TextButton(onClick = onDone) { Text("完了", fontWeight = FontWeight.SemiBold) }
                }
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 8.dp)) {
                    listOf(TableView.ROWS to "行ごと", TableView.GRID to "表の形").forEachIndexed { index, (value, label) ->
                        SegmentedButton(selected = view == value, onClick = { view = value }, shape = SegmentedButtonDefaults.itemShape(index, 2)) { Text(label) }
                    }
                }
                HorizontalDivider()
                when (view) {
                    TableView.ROWS -> RowCards(table, onChange)
                    TableView.GRID -> GridPreview(controller, table)
                }
            }
        }
        if (confirmDiscard) {
            AlertDialog(
                onDismissRequest = { confirmDiscard = false },
                title = { Text("表の変更を破棄しますか？") },
                text = { Text("この画面で直した内容は本文に入りません。") },
                confirmButton = { TextButton(onClick = { confirmDiscard = false; onCancel() }) { Text("破棄", color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text("編集を続ける") } },
            )
        }
    }
}

@Composable
private fun RowCards(table: CanvasTable.Table, onChange: (CanvasTable.Table) -> Unit) {
    val focus = LocalFocusManager.current
    val next = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) })
    val nextOptions = KeyboardOptions(imeAction = ImeAction.Next)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        val cardModifier = Modifier.fillMaxWidth().widthIn(max = 720.dp)
        // The header card: each column's name, alignment and its menu (add left / right, delete).
        Card(cardModifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("見出しと列", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                table.header.forEachIndexed { column, name ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = name,
                            onValueChange = { onChange(CanvasTable.setHeader(table, column, it)) },
                            label = { Text("列${column + 1}の見出し") },
                            singleLine = true, keyboardOptions = nextOptions, keyboardActions = next,
                            modifier = Modifier.weight(1f),
                        )
                        AlignChoice(table.align[column], columnName(table, column)) { onChange(CanvasTable.setAlign(table, column, it)) }
                        ColumnMenu(table, column, onChange)
                    }
                }
            }
        }
        table.rows.forEachIndexed { row, cells ->
            Card(cardModifier) {
                Column(Modifier.padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("行 ${row + 1}", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        RowMenu(table, row, onChange)
                    }
                    Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        cells.forEachIndexed { column, cell ->
                            OutlinedTextField(
                                value = cell,
                                onValueChange = { onChange(CanvasTable.setCell(table, row, column, it)) },
                                label = { Text(columnName(table, column), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                singleLine = true, keyboardOptions = nextOptions, keyboardActions = next,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
            }
        }
        if (table.rows.isEmpty()) {
            Text("見出しだけの表です。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        OutlinedButton(onClick = { onChange(CanvasTable.addRow(table, table.rows.size)) }) {
            Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Text(" 行を追加")
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** なし・左・中央・右 for one column. */
@Composable
private fun AlignChoice(align: CanvasTable.Align?, column: String, onPick: (CanvasTable.Align?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = "${column}の位置揃え: ${alignLabel(align)}" }) {
            Text(alignLabel(align))
            Icon(Icons.Outlined.ArrowDropDown, contentDescription = null)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            listOf(null, CanvasTable.Align.LEFT, CanvasTable.Align.CENTER, CanvasTable.Align.RIGHT).forEach { value ->
                DropdownMenuItem(
                    text = { Text(if (value == null) "位置揃えなし" else alignLabel(value) + "揃え", fontWeight = if (value == align) FontWeight.SemiBold else null) },
                    onClick = { open = false; onPick(value) },
                )
            }
        }
    }
}

@Composable
private fun ColumnMenu(table: CanvasTable.Table, column: Int, onChange: (CanvasTable.Table) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "${columnName(table, column)}の列のメニュー") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("左に列を追加") }, onClick = { open = false; onChange(CanvasTable.addColumn(table, column)) })
            DropdownMenuItem(text = { Text("右に列を追加") }, onClick = { open = false; onChange(CanvasTable.addColumn(table, column + 1)) })
            DropdownMenuItem(
                text = { Text("列を削除", color = if (table.columns > 1) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)) },
                enabled = table.columns > 1,
                onClick = { open = false; onChange(CanvasTable.deleteColumn(table, column)) },
            )
        }
    }
}

@Composable
private fun RowMenu(table: CanvasTable.Table, row: Int, onChange: (CanvasTable.Table) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "行 ${row + 1} のメニュー") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("上に行を追加") }, onClick = { open = false; onChange(CanvasTable.addRow(table, row)) })
            DropdownMenuItem(text = { Text("下に行を追加") }, onClick = { open = false; onChange(CanvasTable.addRow(table, row + 1)) })
            DropdownMenuItem(text = { Text("上へ") }, enabled = row > 0, onClick = { open = false; onChange(CanvasTable.moveRow(table, row, row - 1)) })
            DropdownMenuItem(text = { Text("下へ") }, enabled = row < table.rows.size - 1, onClick = { open = false; onChange(CanvasTable.moveRow(table, row, row + 1)) })
            DropdownMenuItem(
                text = { Text("行を削除", color = MaterialTheme.colorScheme.error) },
                onClick = { open = false; onChange(CanvasTable.deleteRow(table, row)) },
            )
        }
    }
}

/** 「表の形」: the table as the canvas shows it (the message renderer's table, scrolling sideways). */
@Composable
private fun GridPreview(controller: AppController, table: CanvasTable.Table) {
    val store = controller.store
    val version by store.version.collectAsState()
    // The cells show mentions as @username (like the editor); stored, they are <@uuid>, which the renderer names.
    val body = remember(table, version) {
        CanvasText.encodeMentions(CanvasTable.serialize(table).joinToString("\n"), store.users.values, store.groups.values)
    }
    val blocks = remember(body) { parseBlocks(body, canvas = true) }
    val inline = bodyInline(
        store.users, internalBase = controller.serverBase,
        onOpenMessage = null, onOpenCanvas = null,
        customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations,
        onNeedEmojiImage = { controller.loadEmojiImage(it) }, groups = store.groups, version = version,
    )
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("キャンバスでの見え方です。マスを直すには「行ごと」に切り替えます。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.semantics { contentDescription = "表のプレビュー" }) {
            blocks.forEach { BodyBlockView(it, inline) }
        }
    }
}
