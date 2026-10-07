package jp.chikuwachat.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.DbOption
import jp.chikuwachat.android.api.DbProperty
import jp.chikuwachat.android.api.DbRow
import jp.chikuwachat.android.api.DbRowRef
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.DatabaseSession
import jp.chikuwachat.android.sync.DbCellContext
import jp.chikuwachat.android.sync.RelationChip
import jp.chikuwachat.android.sync.RelationChips
import jp.chikuwachat.android.sync.RowSession
import jp.chikuwachat.android.sync.WikiDb
import jp.chikuwachat.android.sync.WikiHub
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/*
 * M124 (docs/WIKI.md §5.5, §5.7, §5.8, §9.2): a database page and a row page on the phone. The database's description
 * is its body; under it the view chips, then a table view's rows as cards (the title and the view's first visible
 * properties) or a calendar view's month as an agenda (each day with the rows on it), pull to refresh and 「＋ 新規」.
 * A row's page has its properties above the body, one editor per type; a view-only reader gets the same form read
 * only. Schemas and views are edited on a computer (§5.5).
 */

object DbUi {
    fun context(controller: AppController, refs: Map<String, DbRowRef>): DbCellContext = DbCellContext(
        names = { id -> controller.store.users[id]?.displayName ?: L10n.str(R.string.common_member) },
        refs = refs,
        hidden = L10n.str(R.string.docs_db_hidden_rows),
        untitled = L10n.str(R.string.docs_untitled),
        zone = ZoneId.systemDefault(),
        locale = L10n.locale,
        datePattern = L10n.str(R.string.docs_db_date_pattern),
    )

    fun propName(prop: DbProperty): String = WikiDb.propName(prop, L10n.str(R.string.docs_db_title_prop))

    /** An option's colour as a chip's background (the server's names, Desktop's palette). */
    fun optionColor(color: String): Color = when (color) {
        "brown" -> Color(0x339A6B3F)
        "orange" -> Color(0x40F59E0B)
        "yellow" -> Color(0x47FACC15)
        "green" -> Color(0x3810B981)
        "blue" -> Color(0x380EA5E9)
        "purple" -> Color(0x388B5CF6)
        "pink" -> Color(0x38EC4899)
        "red" -> Color(0x38F43F5E)
        else -> Color(0x2671717A)
    }
}

/** The open database: read at once, again (folded 300 ms) on wiki.rows.changed and after reconnecting. */
@Composable
fun rememberDatabaseSession(controller: AppController, hub: WikiHub, databaseId: String): DatabaseSession? {
    val api = hub.dbApi ?: return null
    val scope = rememberCoroutineScope()
    val session = remember(databaseId, api) { DatabaseSession(databaseId, api, controller.store, scope) }
    DisposableEffect(session) { onDispose { session.stop() } }
    val signals by hub.rowsSignal.collectAsState()
    val reconnects by hub.reconnects.collectAsState()
    val mine = signals[databaseId] ?: 0L
    LaunchedEffect(session) { session.refresh() }
    var seen by remember(session) { mutableStateOf(mine to reconnects) }
    LaunchedEffect(session, mine, reconnects) {
        if (seen == (mine to reconnects)) return@LaunchedEffect
        seen = mine to reconnects
        delay(300)
        session.refresh()
    }
    return session
}

/** The open row's cells: read at once, again on wiki.page.updated (change "props") and after reconnecting. */
@Composable
fun rememberRowSession(controller: AppController, hub: WikiHub, rowId: String): RowSession? {
    val api = hub.dbApi ?: return null
    val scope = rememberCoroutineScope()
    val session = remember(rowId, api) { RowSession(rowId, api, scope, onError = { controller.report(it) }) }
    val signals by hub.propsSignal.collectAsState()
    val reconnects by hub.reconnects.collectAsState()
    val mine = signals[rowId] ?: 0L
    LaunchedEffect(session) { session.refresh() }
    var seen by remember(session) { mutableStateOf(mine to reconnects) }
    LaunchedEffect(session, mine, reconnects) {
        if (seen == (mine to reconnects)) return@LaunchedEffect
        seen = mine to reconnects
        delay(300)
        session.refresh()
    }
    return session
}

// --- the database's rows ------------------------------------------------------------------------------------------

/**
 * The database under its description, as items of the page's list: the views, the count and 「＋ 新規」, then cards or
 * the agenda. `dbVersion` is the session's version (the items are rebuilt when it moves).
 */
@Suppress("UNUSED_PARAMETER")
fun LazyListScope.databaseItems(
    controller: AppController, session: DatabaseSession, dbVersion: Int, version: Int, selectedRow: String?,
    onOpenRow: (String) -> Unit, onAdd: () -> Unit,
) {
    val database = session.database
    item(key = "db-head") {
        Column(Modifier.canvasColumn().padding(top = 8.dp)) {
            HorizontalDivider()
            if (session.offlineSince != null && session.loadError != null) {
                Box(Modifier.padding(top = 6.dp)) { OfflineCopyNotice(session.offlineSince!!) { session.reload() } }
            }
            if (database == null) {
                if (session.loadError != null) {
                    Column(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(R.string.docs_db_load_failed), style = MaterialTheme.typography.bodyMedium)
                        Text(controller.describe(session.loadError!!), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = { session.reload() }, modifier = Modifier.padding(top = 8.dp)) { Icon(Icons.Outlined.Refresh, null); Text(stringResource(R.string.common_reload)) }
                    }
                } else {
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
                }
                return@Column
            }
            val view = session.view
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.weight(1f).horizontalScroll(rememberScrollState()).semantics { contentDescription = L10n.str(R.string.docs_db_views) },
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    database.views.forEach { v ->
                        FilterChip(
                            selected = v.id == view?.id, onClick = { session.selectView(v.id) },
                            label = { Text(WikiDb.viewName(v, L10n.str(R.string.docs_db_table), L10n.str(R.string.docs_db_calendar)), maxLines = 1) },
                        )
                    }
                }
                if (WikiDb.canEditRows(database.myLevel)) {
                    TextButton(onClick = onAdd) { Icon(Icons.Outlined.Add, null, Modifier.size(18.dp)); Text(stringResource(R.string.docs_db_new_row)) }
                }
            }
            if (view?.type != "calendar") {
                Text(
                    pluralStringResource(R.plurals.docs_db_count, session.total, session.total), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp),
                )
            }
        }
    }
    if (database == null) return
    val view = session.view
    val ctx = DbUi.context(controller, session.refs)
    if (view?.type == "calendar") {
        val prop = WikiDb.datePropOf(database, view)
        item(key = "db-month") {
            Row(Modifier.canvasColumn(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { session.moveMonth(-1) }) { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, stringResource(R.string.docs_db_prev_month)) }
                Text(
                    session.month.format(DateTimeFormatter.ofPattern(L10n.str(R.string.docs_db_month_pattern), L10n.locale)),
                    style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() },
                )
                IconButton(onClick = { session.moveMonth(1) }) { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, stringResource(R.string.docs_db_next_month)) }
                if (session.loading) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            }
        }
        if (prop == null) {
            item(key = "db-nodate") { MutedLine(stringResource(R.string.docs_db_need_date_prop)) }
            return
        }
        val zone = ZoneId.systemDefault()
        val days = WikiDb.agenda(session.rows, prop, session.month.atDay(1), session.month.atEndOfMonth(), zone)
        if (days.isEmpty() && !session.loading) item(key = "db-agenda-empty") { MutedLine(stringResource(R.string.docs_db_agenda_empty)) }
        val byId = session.rows.associateBy { it.id }
        val today = LocalDate.now()
        val dayFormat = DateTimeFormatter.ofPattern(L10n.str(R.string.docs_db_day_pattern), L10n.locale)
        days.forEach { day ->
            item(key = "day-${day.day}") {
                Text(
                    day.day.format(dayFormat), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                    color = if (day.day == today) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.canvasColumn().padding(top = 12.dp, bottom = 4.dp).semantics { heading() },
                )
            }
            day.entries.forEach { entry ->
                val row = byId[entry.rowId] ?: return@forEach
                item(key = "day-${day.day}-${entry.rowId}") {
                    val value = WikiDb.asDate(WikiDb.cellValue(prop, row))
                    val label = if (entry.multiDay || value?.time == true) WikiDb.cellText(prop, row, ctx) else null
                    AgendaRow(controller, version, row, label, selected = row.id == selectedRow) { onOpenRow(row.id) }
                }
            }
        }
        return
    }
    val props = WikiDb.cardProps(database, view)
    if (session.rows.isEmpty() && !session.loading) item(key = "db-empty") { MutedLine(stringResource(R.string.docs_db_empty)) }
    session.rows.forEach { row ->
        item(key = "row-${row.id}") {
            val card = WikiDb.card(row, props, ctx, L10n.str(R.string.docs_db_title_prop))
            RowCard(controller, version, card.icon, card.title, card.lines, selected = row.id == selectedRow) { onOpenRow(row.id) }
        }
    }
    if (session.nextCursor != null) {
        item(key = "db-more") {
            val scope = rememberCoroutineScope()
            Box(Modifier.canvasColumn(), contentAlignment = Alignment.Center) {
                TextButton(onClick = { scope.launch { session.loadMore() } }) { Text(stringResource(R.string.docs_db_load_more)) }
            }
        }
    }
}

@Composable
private fun MutedLine(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.canvasColumn().padding(vertical = 16.dp))
}

/** A table row as a card: icon and title, then 「プロパティ：値」 for the chosen properties that have one. */
@Composable
private fun RowCard(controller: AppController, version: Int, icon: String?, title: String, lines: List<Pair<String, String>>, selected: Boolean, onOpen: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
        modifier = Modifier.canvasColumn().padding(vertical = 4.dp).clickable(onClickLabel = stringResource(R.string.docs_db_open_row), onClick = onOpen),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            PageTitleText(controller, version, icon, title, MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, kind = "row")
            lines.forEach { (name, text) ->
                Row(Modifier.padding(top = 3.dp)) {
                    Text(name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(96.dp))
                    Text(text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

/** A row on a day of the agenda; a range or a time says so under the title. */
@Composable
private fun AgendaRow(controller: AppController, version: Int, row: DbRow, label: String?, selected: Boolean, onOpen: () -> Unit) {
    Row(
        Modifier.canvasColumn()
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent, RoundedCornerShape(8.dp))
            .clickable(onClickLabel = stringResource(R.string.docs_db_open_row), onClick = onOpen)
            .heightIn(min = 44.dp).padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(width = 3.dp, height = 28.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            PageTitleText(controller, version, row.icon, row.title, MaterialTheme.typography.bodyLarge, kind = "row")
            if (label != null) Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

/** 「＋ 新規」: the new row's title (empty: 「無題」); it opens once made. */
@Composable
fun NewRowDialog(controller: AppController, session: DatabaseSession, onDismiss: () -> Unit, onCreated: (DbRow) -> Unit) {
    var title by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.docs_db_new_row_title)) },
        text = {
            OutlinedTextField(
                title, { title = it.take(200) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.docs_title_label)) },
            )
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                busy = true
                scope.launch {
                    try {
                        onCreated(session.createRow(title.trim()))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        controller.report(e)
                    } finally {
                        busy = false
                    }
                }
            }) { if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.common_create)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

// --- a row's properties ---------------------------------------------------------------------------------------------

/**
 * The row's properties above its body: one line per property (name, value), a tap opens the type's editor (edit and
 * full); relations as chips that open the rows, links to rows I cannot read as one 「アクセスできないページ」; then the
 * rows that link here one-way (「（データベース）の（プロパティ）」).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RowPropertiesSection(controller: AppController, session: RowSession, version: Int, onOpenPage: (String) -> Unit) {
    val rowVersion by session.version.collectAsState()
    val detail = remember(rowVersion) { session.detail }
    var editing by remember(session.rowId) { mutableStateOf<DbProperty?>(null) }
    Column(Modifier.canvasColumn().padding(bottom = 8.dp).semantics { contentDescription = L10n.str(R.string.docs_db_properties) }) {
        if (detail == null) {
            if (session.loadError != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(controller.describe(session.loadError!!), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                    TextButton(onClick = { session.reload() }) { Text(stringResource(R.string.common_reload)) }
                }
            } else CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            return@Column
        }
        val editable = session.editable
        val refs = detail.refs.associateBy { it.id }
        val ctx = DbUi.context(controller, refs)
        if (!editable) {
            Text(stringResource(R.string.docs_db_view_only), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
        }
        val props = detail.database.properties.filter { it.type != "title" }
        if (props.isEmpty()) MutedSmall(stringResource(R.string.docs_db_no_properties))
        props.forEach { prop ->
            val canEdit = editable && WikiDb.canEditCell(detail.database.myLevel, prop)
            PropertyLine(
                controller, version, prop, detail.row, ctx, refs, canEdit, saving = prop.id in session.saving,
                onEdit = { editing = prop }, onSet = { value -> session.set(prop.id, value) }, onOpenPage = onOpenPage,
            )
        }
        detail.referencedBy.filter { it.rows.isNotEmpty() }.forEach { back ->
            Column(Modifier.fillMaxWidth().padding(top = 6.dp)) {
                Text(
                    stringResource(R.string.docs_db_referenced_by, back.databaseTitle.ifBlank { L10n.str(R.string.docs_untitled) }, back.propName.ifBlank { back.propId }),
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 2.dp)) {
                    back.rows.forEach { ref -> RowChip(controller, version, ref.icon, ref.title.ifBlank { L10n.str(R.string.docs_untitled) }) { onOpenPage(ref.id) } }
                }
            }
        }
        HorizontalDivider(Modifier.padding(top = 10.dp))
    }
    editing?.let { prop ->
        val close = { editing = null }
        val row = detail?.row ?: return@let close()
        val set = { value: JsonElement -> session.set(prop.id, value); close() }
        when (prop.type) {
            "text", "number", "url" -> TextValueDialog(prop, row, onDismiss = close, onSave = set)
            "select" -> SelectDialog(prop, WikiDb.string(WikiDb.cellValue(prop, row)), onDismiss = close, onSave = set)
            "multi_select" -> MultiSelectDialog(prop, WikiDb.strings(WikiDb.cellValue(prop, row)), onDismiss = close, onSave = set)
            "person" -> PersonDialog(controller, prop, WikiDb.strings(WikiDb.cellValue(prop, row)), onDismiss = close, onSave = set)
            "date" -> DateDialog(prop, WikiDb.asDate(WikiDb.cellValue(prop, row)), onDismiss = close, onSave = set)
            "relation" -> RelationDialog(controller, session, prop, row, detail.refs, onDismiss = close, onSave = set)
            else -> close()
        }
    }
}

@Composable
private fun MutedSmall(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PropertyLine(
    controller: AppController, version: Int, prop: DbProperty, row: DbRow, ctx: DbCellContext, refs: Map<String, DbRowRef>,
    canEdit: Boolean, saving: Boolean, onEdit: () -> Unit, onSet: (JsonElement) -> Unit, onOpenPage: (String) -> Unit,
) {
    val name = DbUi.propName(prop)
    val value = WikiDb.cellValue(prop, row)
    val tappable = canEdit && prop.type != "checkbox"
    Row(
        Modifier.fillMaxWidth()
            .then(if (tappable) Modifier.clickable(onClickLabel = L10n.str(R.string.docs_db_edit_cell, name), onClick = onEdit) else Modifier)
            .heightIn(min = 40.dp).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(112.dp).padding(end = 8.dp))
        Box(Modifier.weight(1f)) {
            when (prop.type) {
                "checkbox" -> Checkbox(
                    checked = WikiDb.checked(value), enabled = canEdit,
                    onCheckedChange = { on -> onSet(WikiDb.encodeCheckbox(on)) },
                    modifier = Modifier.semantics { contentDescription = name },
                )
                "select", "multi_select" -> {
                    val ids = if (prop.type == "select") listOfNotNull(WikiDb.string(value)) else WikiDb.strings(value)
                    val options = ids.mapNotNull { id -> prop.options.firstOrNull { it.id == id } }
                    if (options.isEmpty()) EmptyValue(canEdit)
                    else FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { options.forEach { OptionChip(it) } }
                }
                "relation" -> {
                    val chips = RelationChips.of(prop, row, refs, ctx.untitled)
                    if (chips.isEmpty()) EmptyValue(canEdit)
                    else FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        chips.forEach { chip ->
                            when (chip) {
                                is RelationChip.Row -> RowChip(controller, version, chip.icon, chip.title) { onOpenPage(chip.id) }
                                RelationChip.Hidden -> HiddenChip()
                            }
                        }
                    }
                }
                "url" -> {
                    val url = WikiDb.string(value)
                    if (url == null) EmptyValue(canEdit)
                    else Row(verticalAlignment = Alignment.CenterVertically) {
                        val uri = LocalUriHandler.current
                        Text(url, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        IconButton(onClick = { runCatching { uri.openUri(url) } }) { Icon(Icons.AutoMirrored.Outlined.OpenInNew, stringResource(R.string.docs_db_open_link), Modifier.size(18.dp)) }
                    }
                }
                else -> {
                    val text = WikiDb.cellText(prop, row, ctx)
                    if (text.isEmpty()) EmptyValue(canEdit)
                    else Text(
                        text, style = MaterialTheme.typography.bodyMedium,
                        color = if (prop.type in WikiDb.COMPUTED) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
        if (saving) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
    }
}

@Composable
private fun EmptyValue(canEdit: Boolean) {
    Text(
        if (canEdit) stringResource(R.string.docs_db_empty_value_edit) else stringResource(R.string.docs_db_empty_value),
        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.outline,
    )
}

@Composable
private fun OptionChip(option: DbOption) {
    Text(
        option.name, style = MaterialTheme.typography.labelMedium, maxLines = 1,
        modifier = Modifier.background(DbUi.optionColor(option.color), RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/** A linked row: its title; a tap opens it. */
@Composable
private fun RowChip(controller: AppController, version: Int, icon: String?, title: String, onOpen: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(6.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.clickable(onClickLabel = stringResource(R.string.docs_open_page), onClick = onOpen),
    ) {
        Box(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
            PageTitleText(controller, version, icon, title, MaterialTheme.typography.labelMedium, kind = "row")
        }
    }
}

/** Links to rows I cannot read: one chip, no title, no id, no count (WIKI.md §5.7). */
@Composable
private fun HiddenChip() {
    Row(
        Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 4.dp)
            .semantics(mergeDescendants = true) { contentDescription = L10n.str(R.string.docs_db_hidden_rows_hint) },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Lock, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(4.dp))
        Text(stringResource(R.string.docs_db_hidden_rows), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// --- editors --------------------------------------------------------------------------------------------------------

private fun editorButtons(onDismiss: () -> Unit, onClear: (() -> Unit)?, confirm: @Composable () -> Unit): Pair<@Composable () -> Unit, @Composable () -> Unit> =
    confirm to {
        Row {
            if (onClear != null) TextButton(onClick = onClear) { Text(stringResource(R.string.docs_db_clear)) }
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) }
        }
    }

/** Text, number and URL: one field; a number or a URL that does not read says so. */
@Composable
private fun TextValueDialog(prop: DbProperty, row: DbRow, onDismiss: () -> Unit, onSave: (JsonElement) -> Unit) {
    val current = WikiDb.cellValue(prop, row)
    val initial = when (prop.type) {
        "number" -> WikiDb.number(current)?.let { if (it % 1.0 == 0.0 && kotlin.math.abs(it) < 1e15) it.toLong().toString() else it.toString() }.orEmpty()
        else -> WikiDb.string(current).orEmpty()
    }
    var text by rememberSaveable(prop.id) { mutableStateOf(initial) }
    var error by remember { mutableStateOf<String?>(null) }
    val save = {
        when (prop.type) {
            "number" -> if (text.isBlank()) onSave(JsonNull) else WikiDb.parseNumber(text)?.let { onSave(WikiDb.encodeNumber(it)) } ?: run { error = L10n.str(R.string.docs_db_invalid_number) }
            "url" -> WikiDb.encodeUrl(text)?.let(onSave) ?: run { error = L10n.str(R.string.docs_db_invalid_url) }
            else -> onSave(WikiDb.encodeText(text.take(2000)))
        }
    }
    val (confirm, dismiss) = editorButtons(onDismiss, null) { TextButton(onClick = save) { Text(stringResource(R.string.common_save)) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(DbUi.propName(prop)) },
        text = {
            OutlinedTextField(
                text, { text = it; error = null }, modifier = Modifier.fillMaxWidth(), singleLine = prop.type != "text", maxLines = 6,
                isError = error != null, supportingText = error?.let { e -> { Text(e) } },
                keyboardOptions = KeyboardOptions(keyboardType = when (prop.type) {
                    "number" -> KeyboardType.Decimal
                    "url" -> KeyboardType.Uri
                    else -> KeyboardType.Text
                }),
            )
        },
        confirmButton = confirm, dismissButton = dismiss,
    )
}

/** A select: one option (a tap saves), or 「消す」. Options are made on a computer (full access). */
@Composable
private fun SelectDialog(prop: DbProperty, current: String?, onDismiss: () -> Unit, onSave: (JsonElement) -> Unit) {
    val (confirm, dismiss) = editorButtons(onDismiss, if (current != null) ({ onSave(JsonNull) }) else null) {}
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(DbUi.propName(prop)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (prop.options.isEmpty()) MutedSmall(stringResource(R.string.docs_db_no_options))
                prop.options.forEach { option ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onSave(WikiDb.encodeSelect(option.id)) }.heightIn(min = 44.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = option.id == current, onClick = { onSave(WikiDb.encodeSelect(option.id)) })
                        OptionChip(option)
                    }
                }
            }
        },
        confirmButton = confirm, dismissButton = dismiss,
    )
}

@Composable
private fun MultiSelectDialog(prop: DbProperty, current: List<String>, onDismiss: () -> Unit, onSave: (JsonElement) -> Unit) {
    var chosen by remember(prop.id) { mutableStateOf(current.filter { id -> prop.options.any { it.id == id } }) }
    val (confirm, dismiss) = editorButtons(onDismiss, null) { TextButton(onClick = { onSave(WikiDb.encodeIds(chosen)) }) { Text(stringResource(R.string.docs_db_done)) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(DbUi.propName(prop)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (prop.options.isEmpty()) MutedSmall(stringResource(R.string.docs_db_no_options))
                prop.options.forEach { option ->
                    val on = option.id in chosen
                    val toggle = { chosen = if (on) chosen - option.id else chosen + option.id }
                    Row(Modifier.fillMaxWidth().clickable(onClick = toggle).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = on, onCheckedChange = { toggle() })
                        OptionChip(option)
                    }
                }
            }
        },
        confirmButton = confirm, dismissButton = dismiss,
    )
}

/** People: search by name; the members who can sign in (and anyone already chosen). */
@Composable
private fun PersonDialog(controller: AppController, prop: DbProperty, current: List<String>, onDismiss: () -> Unit, onSave: (JsonElement) -> Unit) {
    var chosen by remember(prop.id) { mutableStateOf(current) }
    var query by rememberSaveable { mutableStateOf("") }
    val users = controller.store.users.values
        .filter { (it.deactivatedAt == null && it.botKind == null) || it.id in current }
        .filter { query.isBlank() || it.displayName.contains(query.trim(), ignoreCase = true) || it.username.contains(query.trim(), ignoreCase = true) }
        .sortedWith(compareByDescending<jp.chikuwachat.android.api.UserPublic> { it.id in current }.thenBy { it.displayName })
        .take(80)
    val (confirm, dismiss) = editorButtons(onDismiss, null) { TextButton(onClick = { onSave(WikiDb.encodeIds(chosen)) }) { Text(stringResource(R.string.docs_db_done)) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(DbUi.propName(prop)) },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text(stringResource(R.string.docs_db_find_person)) })
                Column(Modifier.verticalScroll(rememberScrollState()).padding(top = 6.dp)) {
                    users.forEach { user ->
                        val on = user.id in chosen
                        val toggle = { chosen = if (on) chosen - user.id else chosen + user.id }
                        Row(Modifier.fillMaxWidth().clickable(onClick = toggle).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = on, onCheckedChange = { toggle() })
                            Avatar(user.id, user.displayName, size = 24.dp)
                            Spacer(Modifier.width(8.dp))
                            Text(user.displayName, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = confirm, dismissButton = dismiss,
    )
}

private fun millisOf(day: LocalDate): Long = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()

private fun dayOfMillis(millis: Long): LocalDate = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()

/** A date: the start, an optional end, an optional time (this device's zone); 「消す」 clears it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateDialog(prop: DbProperty, current: jp.chikuwachat.android.sync.DbDateValue?, onDismiss: () -> Unit, onSave: (JsonElement) -> Unit) {
    val zone = ZoneId.systemDefault()
    val parts = remember(prop.id) { WikiDb.dateParts(current, zone, LocalDate.now()) }
    var start by remember { mutableStateOf(parts.start) }
    var end by remember { mutableStateOf(parts.end) }
    var startTime by remember { mutableStateOf(parts.startTime) }
    var endTime by remember { mutableStateOf(parts.endTime) }
    var picking by remember { mutableStateOf<String?>(null) } // "start" | "end" | "startTime" | "endTime"
    val dayFormat = DateTimeFormatter.ofPattern(L10n.str(R.string.docs_db_date_pattern), L10n.locale)
    val timeFormat = DateTimeFormatter.ofPattern("H:mm")
    val (confirm, dismiss) = editorButtons(onDismiss, if (current != null) ({ onSave(JsonNull) }) else null) {
        TextButton(onClick = { onSave(WikiDb.encodeDate(start, end, startTime, endTime, zone)) }) { Text(stringResource(R.string.common_save)) }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(DbUi.propName(prop)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                DateLine(stringResource(R.string.docs_db_start_date), start.format(dayFormat), startTime?.format(timeFormat), { picking = "start" }, { picking = "startTime" })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.docs_db_end_date), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Switch(checked = end != null, onCheckedChange = { on -> end = if (on) start else null; if (!on) endTime = null })
                }
                end?.let { last -> DateLine(stringResource(R.string.docs_db_end_date), last.format(dayFormat), if (startTime != null) (endTime ?: startTime)?.format(timeFormat) else null, { picking = "end" }, { picking = "endTime" }) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.docs_db_include_time), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Switch(checked = startTime != null, onCheckedChange = { on -> startTime = if (on) LocalTime.of(9, 0) else null; if (!on) endTime = null })
                }
            }
        },
        confirmButton = confirm, dismissButton = dismiss,
    )
    when (picking) {
        "start", "end" -> {
            val state = rememberDatePickerState(initialSelectedDateMillis = millisOf(if (picking == "end") end ?: start else start))
            DatePickerDialog(
                onDismissRequest = { picking = null },
                confirmButton = {
                    TextButton(onClick = {
                        state.selectedDateMillis?.let(::dayOfMillis)?.let { day ->
                            if (picking == "start") {
                                start = day
                                end?.let { if (it < day) end = day }
                            } else end = if (day < start) start else day
                        }
                        picking = null
                    }) { Text(stringResource(R.string.docs_db_done)) }
                },
                dismissButton = { TextButton(onClick = { picking = null }) { Text(stringResource(R.string.common_cancel)) } },
            ) { DatePicker(state) }
        }
        "startTime", "endTime" -> {
            val initial = (if (picking == "endTime") endTime ?: startTime else startTime) ?: LocalTime.of(9, 0)
            val state = rememberTimePickerState(initial.hour, initial.minute, is24Hour = true)
            AlertDialog(
                onDismissRequest = { picking = null },
                text = { TimePicker(state) },
                confirmButton = {
                    TextButton(onClick = {
                        val time = LocalTime.of(state.hour, state.minute)
                        if (picking == "startTime") startTime = time else endTime = time
                        picking = null
                    }) { Text(stringResource(R.string.docs_db_done)) }
                },
                dismissButton = { TextButton(onClick = { picking = null }) { Text(stringResource(R.string.common_cancel)) } },
            )
        }
    }
}

@Composable
private fun DateLine(label: String, day: String, time: String?, onDay: () -> Unit, onTime: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(64.dp))
        OutlinedButton(onClick = onDay) { Text(day) }
        if (time != null) OutlinedButton(onClick = onTime) { Text(time) }
    }
}

/**
 * A relation: the linked rows (× takes one off), then rows to add, searched among the rows of the related database I
 * can read. Links to rows I cannot read are not listed; they stay whatever is saved (the server keeps them).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RelationDialog(
    controller: AppController, session: RowSession, prop: DbProperty, row: DbRow, known: List<DbRowRef>,
    onDismiss: () -> Unit, onSave: (JsonElement) -> Unit,
) {
    var chosen by remember(prop.id) { mutableStateOf(row.relations[prop.id].orEmpty()) }
    var titles by remember(prop.id) { mutableStateOf(known.associateBy { it.id }) }
    var query by rememberSaveable { mutableStateOf("") }
    var found by remember { mutableStateOf<List<DbRowRef>?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(query) {
        delay(250)
        try {
            val got = session.candidates(prop.id, query.trim())
            found = got
            titles = titles + got.associateBy { it.id }
            failed = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failed = controller.describe(e)
        }
    }
    val (confirm, dismiss) = editorButtons(onDismiss, null) { TextButton(onClick = { onSave(WikiDb.encodeRelation(chosen)) }) { Text(stringResource(R.string.docs_db_done)) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(DbUi.propName(prop)) },
        text = {
            Column {
                if (chosen.isNotEmpty() || prop.id in row.hiddenRelations) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(bottom = 6.dp)) {
                        chosen.forEach { id ->
                            val ref = titles[id]
                            Row(
                                Modifier.background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(6.dp)).padding(start = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    (ref?.icon?.let { "$it " } ?: "") + (ref?.title?.ifBlank { null } ?: L10n.str(R.string.docs_untitled)),
                                    style = MaterialTheme.typography.labelMedium, maxLines = 1,
                                )
                                IconButton(onClick = { chosen = chosen - id }, modifier = Modifier.size(32.dp)) {
                                    Icon(Icons.Outlined.Close, stringResource(R.string.docs_db_remove), Modifier.size(14.dp))
                                }
                            }
                        }
                        if (prop.id in row.hiddenRelations) HiddenChip()
                    }
                }
                OutlinedTextField(query, { query = it }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text(stringResource(R.string.docs_db_find_row)) })
                Column(Modifier.verticalScroll(rememberScrollState()).padding(top = 6.dp)) {
                    failed?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                    val list = found
                    when {
                        list == null && failed == null -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        list != null && list.isEmpty() -> MutedSmall(stringResource(R.string.docs_db_no_rows_found))
                    }
                    list.orEmpty().filter { it.id !in chosen }.forEach { ref ->
                        Row(
                            Modifier.fillMaxWidth().clickable { chosen = chosen + ref.id }.heightIn(min = 44.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.Add, stringResource(R.string.docs_db_add), Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text((ref.icon?.let { "$it " } ?: "") + ref.title.ifBlank { L10n.str(R.string.docs_untitled) }, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = confirm, dismissButton = dismiss,
    )
}
