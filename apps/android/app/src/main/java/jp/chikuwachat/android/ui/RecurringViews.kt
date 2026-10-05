package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.AssignmentTurnedIn
import androidx.compose.material.icons.outlined.EventRepeat
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MemberOut
import jp.chikuwachat.android.api.RecurringPostOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch
import java.time.ZoneId
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** The chip's 「未提出」 before the due time (amber, as on the desktop); red once it has passed. */
private val AMBER = Color(0xFFF59E0B)
private val DONE_GREEN = Color(0xFF34C759)

/**
 * L6 (M60, RECURRING.md §5): under a collecting post, 「提出 7/10 · 締切 10/9 (金) 18:00」 with 「未提出」 (amber; red after
 * the due time) when I am a target who has not replied, or 「提出済み」. A tap opens 「提出状況」. message.updated (change
 * "collection") replaces the row, so the chip follows replies on any device. `version` keeps me and the names current.
 */
@Composable
fun CollectionChip(message: MessageState, store: Store, version: Int) {
    val collection = message.collection ?: return
    if (message.deleted) return
    var open by rememberSaveable(message.id) { mutableStateOf(false) }
    val meId = remember(version) { store.me?.id }
    val chip = Recurring.chip(collection, meId)
    val pending = chip.mine == Recurring.Mine.PENDING
    val shape = RoundedCornerShape(6.dp)
    val said = chip.label + when (chip.mine) {
        Recurring.Mine.PENDING -> stringResource(R.string.recurring_views_not_submitted)
        Recurring.Mine.SUBMITTED -> stringResource(R.string.recurring_views_submitted)
        null -> ""
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(top = 6.dp)
            .touchTarget { source -> Modifier.clickable(interactionSource = source, indication = null, onClickLabel = L10n.str(R.string.recurring_views_submissions)) { open = true } }
            .border(1.dp, if (pending) AMBER.copy(alpha = 0.6f) else MaterialTheme.colorScheme.outlineVariant, shape)
            .background(if (pending) AMBER.copy(alpha = 0.10f) else Color.Transparent, shape)
            .padding(horizontal = 8.dp, vertical = 4.dp)
            .semantics(mergeDescendants = true) { contentDescription = said },
    ) {
        Icon(
            Icons.Outlined.AssignmentTurnedIn, contentDescription = null, modifier = Modifier.size(14.dp),
            tint = if (chip.complete) DONE_GREEN else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            chip.label, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 5.dp).weight(1f, fill = false),
        )
        when (chip.mine) {
            Recurring.Mine.PENDING -> MineBadge(stringResource(R.string.recurring_views_not_submitted_2), if (chip.overdue) MaterialTheme.colorScheme.error else AMBER, if (chip.overdue) MaterialTheme.colorScheme.onError else Color.White)
            Recurring.Mine.SUBMITTED -> MineBadge(stringResource(R.string.recurring_views_submitted_2), MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), MaterialTheme.colorScheme.primary)
            null -> {}
        }
    }
    if (open) CollectionSheet(message, store, version, onDismiss = { open = false })
}

@Composable
private fun MineBadge(text: String, background: Color, color: Color) {
    Text(
        text, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = color, maxLines = 1,
        modifier = Modifier.padding(start = 6.dp).background(background, RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

/** 「提出状況」: 提出済み / 未提出 with avatars, in the targets' order (any member may look: the thread shows who replied). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CollectionSheet(message: MessageState, store: Store, version: Int, onDismiss: () -> Unit) {
    val collection = message.collection ?: return
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val meId = remember(version) { store.me?.id }
    val chip = Recurring.chip(collection, meId)
    val (submitted, missing) = Recurring.lists(collection)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 16.dp).navigationBarsPadding()) {
            Text(stringResource(R.string.recurring_views_submissions), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            Text(
                chip.label + if (chip.overdue) stringResource(R.string.recurring_views_past_due) else "", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp),
            )
            SheetSection(stringResource(R.string.recurring_views_submitted_3, submitted.size), submitted, stringResource(R.string.recurring_views_no_one_yet), store, meId, version)
            HorizontalDivider(Modifier.padding(top = 12.dp))
            SheetSection(stringResource(R.string.recurring_views_not_submitted_3, missing.size), missing, stringResource(R.string.recurring_views_everyone_has_submitted), store, meId, version)
            Text(
                stringResource(R.string.recurring_views_replying_in_the_thread_counts_as) +
                    if (collection.remindedAt != null) stringResource(R.string.recurring_views_after_the_deadline_those_who_hadnt) else stringResource(R.string.recurring_views_after_the_deadline_only_those_who),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 14.dp),
            )
        }
    }
}

@Composable
private fun SheetSection(title: String, ids: List<String>, empty: String, store: Store, meId: String?, version: Int) {
    val people = remember(version, ids) { PeopleText.people(store, ids) }
    Text(
        title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 14.dp, bottom = 6.dp).semantics { heading() },
    )
    if (people.isEmpty()) Text(empty, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    people.forEach { person ->
        Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(person.id, person.name, size = 28.dp)
            Text(person.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp).weight(1f))
            if (person.id == meId) Text(stringResource(R.string.recurring_views_you), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// --- the channel details' 「定期投稿」 ----------------------------------------------------------------------------------

/**
 * Channel details (RECURRING.md §5): the list every member reads (name, schedule, next time, collecting or not, 停止中),
 * and for the channel's owners and administrators (members, §7) 今すぐ投稿, 止める / 再開, 編集 and 削除 (confirmed) behind
 * each row's menu, and 「定期投稿を追加」. The list is read when the page opens and after each action (its changes send
 * no events). The outcome of an action is said under the list.
 */
@Composable
fun RecurringPostsSection(controller: AppController, channel: ChannelState, version: Int) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    val manage = Recurring.canManage(channel, controller.isAdmin) && !channel.channel.archived
    var rows by remember(channel.id) { mutableStateOf<List<RecurringPostOut>?>(null) }
    var failed by remember(channel.id) { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
    var confirmDelete by remember { mutableStateOf<RecurringPostOut?>(null) }
    // "new", or the id of the post being edited (the form's own draft survives a rotation).
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    val localTz = remember { ZoneId.systemDefault().id }
    LaunchedEffect(channel.id, reload) {
        controller.recurringPosts(channel.id)
            .onSuccess { rows = it; failed = false }
            .onFailure { if (rows == null) failed = true }
    }

    fun act(post: RecurringPostOut, done: String, action: suspend () -> Result<*>) {
        busy = post.id
        result = null
        scope.launch {
            action()
                .onSuccess { result = true to done; reload += 1 }
                .onFailure { result = false to controller.describe(it) }
            busy = null
        }
    }

    Text(stringResource(R.string.recurring_views_recurring_posts), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp).semantics { heading() })
    val list = rows
    when {
        list == null && failed -> Text(stringResource(R.string.common_couldnt_load), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        list == null -> Text(stringResource(R.string.common_loading), color = MaterialTheme.colorScheme.onSurfaceVariant)
        list.isEmpty() -> Text(
            stringResource(R.string.recurring_views_no_recurring_posts) + if (manage) stringResource(R.string.recurring_views_a_bot_can_start_a_weekly) else "",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        else -> Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))) {
            list.forEachIndexed { index, post ->
                if (index > 0) HorizontalDivider()
                RecurringPostRow(
                    post, store, version, localTz, manage = manage, busy = busy == post.id,
                    onRun = { act(post, L10n.str(R.string.recurring_views_posted)) { controller.runRecurringPost(post.id) } },
                    onToggle = { act(post, if (post.enabled) L10n.str(R.string.recurring_views_paused) else L10n.str(R.string.recurring_views_resumed)) { controller.setRecurringEnabled(post.id, !post.enabled) } },
                    onEdit = { editing = post.id },
                    onDelete = { confirmDelete = post },
                )
            }
        }
    }
    result?.let { (ok, text) ->
        Text(text, style = MaterialTheme.typography.bodySmall, color = if (ok) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 4.dp))
    }
    if (manage) {
        TextButton(
            onClick = { editing = "new" }, enabled = !failed && (list?.size ?: 0) < Recurring.MAX_PER_CHANNEL,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
        ) { Text(stringResource(R.string.recurring_views_add_recurring_post)) }
    }
    confirmDelete?.let { post ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(stringResource(R.string.recurring_views_delete, post.name)) },
            text = { Text(stringResource(R.string.recurring_views_past_posts_and_submissions_are_kept)) },
            confirmButton = { TextButton(onClick = { confirmDelete = null; act(post, L10n.str(R.string.recurring_views_deleted)) { controller.deleteRecurringPost(post.id) } }) { Text(stringResource(R.string.recurring_views_delete_2), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
    editing?.let { which ->
        val post = if (which == "new") null else list?.firstOrNull { it.id == which }
        if (which == "new" || post != null) {
            RecurringPostForm(
                controller, channel, post, version,
                onDismiss = { editing = null },
                onSaved = { editing = null; result = true to L10n.str(R.string.common_saved_2); reload += 1 },
            )
        }
    }
}

@Composable
private fun RecurringPostRow(
    post: RecurringPostOut, store: Store, version: Int, localTz: String, manage: Boolean, busy: Boolean,
    onRun: () -> Unit, onToggle: () -> Unit, onEdit: () -> Unit, onDelete: () -> Unit,
) {
    val collectLine = remember(version, post) {
        post.collect?.let { spec ->
            L10n.str(R.string.recurring_views_collects_from) + Recurring.targetsSummary(spec, { store.groups[it]?.name }, { store.users[it]?.displayName }) + " · " + Recurring.dueSummary(spec.due)
        } ?: L10n.str(R.string.recurring_views_no_collection)
    }
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.EventRepeat, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                Text(post.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp).weight(1f, fill = false))
                if (!post.enabled) {
                    Text(
                        stringResource(R.string.common_paused), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 6.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            }
            val next = Recurring.shortDateTime(post.nextRunAt)
            Text(
                Recurring.scheduleSummary(post.schedule, post.tz, localTz) + if (post.enabled && next.isNotEmpty()) stringResource(R.string.recurring_views_next, next) else "",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp),
            )
            Text(collectLine, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (manage) {
            var menu by remember { mutableStateOf(false) }
            Box {
                IconButton(enabled = !busy, onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.recurring_views_actions_for, post.name)) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.recurring_views_post_now)) }, onClick = { menu = false; onRun() })
                    DropdownMenuItem(text = { Text(if (post.enabled) stringResource(R.string.recurring_views_pause) else stringResource(R.string.common_resume)) }, onClick = { menu = false; onToggle() })
                    if (Recurring.editable(post)) DropdownMenuItem(text = { Text(stringResource(R.string.common_edit)) }, onClick = { menu = false; onEdit() })
                    DropdownMenuItem(text = { Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error) }, onClick = { menu = false; onDelete() })
                }
            }
        }
    }
}

// --- the form ----------------------------------------------------------------------------------------------------

/** Which time picker is up. */
private enum class TimeField { POST, DUE }

/**
 * 「定期投稿を追加」 / 「定期投稿を編集」 (RECURRING.md §5, full screen; the desktop's dialog): the name (the bot's), the body
 * with the {date} {weekday} {week} hint, 毎週 (weekdays) or 毎月 (a day) and the time, and 返信で提出を集める with whom
 * (チャンネルの全員, or groups and people) and the due time (投稿した日 / N 日後, a time). A new post takes this device's zone;
 * an edited one keeps its own (named when it differs).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RecurringPostForm(controller: AppController, channel: ChannelState, post: RecurringPostOut?, version: Int, onDismiss: () -> Unit, onSaved: (RecurringPostOut) -> Unit) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    var saved by rememberSaveable(post?.id) {
        mutableStateOf(Codec.plain.encodeToString(RecurringDraft.serializer(), if (post != null) Recurring.draftFromPost(post) else Recurring.emptyDraft()))
    }
    val draft = remember(saved) { Codec.plain.decodeFromString(RecurringDraft.serializer(), saved) }
    var error by remember { mutableStateOf<String?>(null) }
    var tried by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf<TimeField?>(null) }
    val localTz = remember { ZoneId.systemDefault().id }
    val zone = post?.tz?.takeIf { it.isNotEmpty() } ?: localTz
    val problem = Recurring.problem(draft)
    fun set(change: (RecurringDraft) -> RecurringDraft) {
        saved = Codec.plain.encodeToString(RecurringDraft.serializer(), change(draft))
        error = null
    }
    fun submit() {
        tried = true
        if (busy) return
        if (problem != null) { error = problem; return }
        busy = true
        scope.launch {
            controller.saveRecurringPost(channel.id, post?.id, draft)
                .onSuccess { onSaved(it) }
                .onFailure { error = controller.describe(it) }
            busy = false
        }
    }
    val title = if (post == null) stringResource(R.string.recurring_views_add_recurring_post) else stringResource(R.string.recurring_views_edit_recurring_post)

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
                    Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                    TextButton(enabled = !busy, onClick = ::submit) { Text(if (busy) stringResource(R.string.common_saving) else if (post == null) stringResource(R.string.common_add) else stringResource(R.string.common_save)) }
                }
                HorizontalDivider()
                Column(
                    Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    OutlinedTextField(
                        value = draft.name, onValueChange = { value -> set { it.copy(name = value.take(80)) } },
                        label = { Text(stringResource(R.string.recurring_views_name_the_bots_display_name)) }, placeholder = { Text(stringResource(R.string.recurring_views_weekly_report)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = draft.body, onValueChange = { value -> set { it.copy(body = value.take(Recurring.MAX_BODY)) } },
                        label = { Text(stringResource(R.string.recurring_views_text)) }, placeholder = { Text(stringResource(R.string.recurring_views_weekly_report_date_nreply_to_this)) },
                        minLines = 4, modifier = Modifier.fillMaxWidth(),
                        supportingText = { Text(remember { Recurring.placeholderHint() }) },
                    )

                    Text(stringResource(R.string.common_repeat), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        listOf("weekly" to stringResource(R.string.common_weekly), "monthly" to stringResource(R.string.common_monthly)).forEachIndexed { index, (kind, label) ->
                            SegmentedButton(
                                selected = draft.kind == kind, onClick = { set { it.copy(kind = kind) } },
                                shape = SegmentedButtonDefaults.itemShape(index, 2), label = { Text(label) },
                            )
                        }
                    }
                    if (draft.kind == "weekly") {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Recurring.WEEKDAY_LABELS.forEachIndexed { day, label ->
                                val on = day in draft.weekdays
                                Box(
                                    Modifier.size(40.dp).clip(CircleShape)
                                        .background(if (on) MaterialTheme.colorScheme.primary else Color.Transparent, CircleShape)
                                        .border(1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, CircleShape)
                                        .toggleable(value = on, role = Role.Checkbox, onValueChange = { now ->
                                            set { it.copy(weekdays = if (now) (it.weekdays + day).distinct().sorted() else it.weekdays - day) }
                                        })
                                        .semantics { contentDescription = L10n.str(R.string.common_weekday_name, label); selected = on },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(label, fontWeight = FontWeight.Medium, color = if (on) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface)
                                }
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (draft.kind == "monthly") {
                            Choice(Recurring.dayLabel(draft.day), stringResource(R.string.recurring_views_day), (1..31).map { it to Recurring.dayLabel(it) }) { day -> set { it.copy(day = day) } }
                        }
                        OutlinedButton(onClick = { picking = TimeField.POST }, modifier = Modifier.semantics { contentDescription = L10n.str(R.string.recurring_views_time, Recurring.clockLabel(draft.time)) }) {
                            Text(Recurring.clockLabel(draft.time))
                        }
                    }
                    Text(
                        if (zone != localTz) stringResource(R.string.recurring_views_times_are_in, zone) else stringResource(R.string.common_time_zone, zone),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                    Row(
                        Modifier.fillMaxWidth().padding(top = 4.dp).toggleable(value = draft.collect, role = Role.Switch, onValueChange = { on -> set { it.copy(collect = on) } }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.recurring_views_collect_submissions_from_replies), style = MaterialTheme.typography.bodyLarge)
                            Text(
                                stringResource(R.string.recurring_views_people_who_reply_in_the_thread),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Spacer(Modifier.width(8.dp))
                        Switch(checked = draft.collect, onCheckedChange = null)
                    }
                    if (draft.collect) {
                        Column(
                            Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp)).padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            TargetPicker(controller, channel, draft, version) { change -> set(change) }
                            Text(stringResource(R.string.common_deadlines), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Choice(
                                    afterLabel(draft.afterDays), stringResource(R.string.recurring_views_due_day),
                                    (0..Recurring.MAX_AFTER_DAYS).map { it to afterLabel(it) },
                                ) { days -> set { it.copy(afterDays = days) } }
                                OutlinedButton(onClick = { picking = TimeField.DUE }, modifier = Modifier.semantics { contentDescription = L10n.str(R.string.recurring_views_deadline_time, Recurring.clockLabel(draft.dueTime)) }) {
                                    Text(Recurring.clockLabel(draft.dueTime))
                                }
                            }
                        }
                    }
                    val shown = error ?: problem?.takeIf { tried }
                    if (shown != null) Text(shown, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        picking?.let { field ->
            val current = if (field == TimeField.POST) draft.time else draft.dueTime
            val (hour, minute) = current.split(":").let { (it.getOrNull(0)?.toIntOrNull() ?: 9) to (it.getOrNull(1)?.toIntOrNull() ?: 0) }
            TimePickDialog(hour, minute, title = if (field == TimeField.POST) stringResource(R.string.recurring_views_posting_time) else stringResource(R.string.recurring_views_deadline_time_2), onDismiss = { picking = null }) { h, m ->
                val text = "%02d:%02d".format(h, m)
                set { if (field == TimeField.POST) it.copy(time = text) else it.copy(dueTime = text) }
                picking = null
            }
        }
    }
}

private fun afterLabel(days: Int): String = if (days == 0) L10n.str(R.string.recurring_views_posting_day) else L10n.str(R.string.recurring_views_days_later, days)

/** A value out of a list, as a button with its menu. */
@Composable
private fun <T> Choice(current: String, label: String, choices: List<Pair<T, String>>, onPick: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = "$label $current" }) {
            Text(current)
            Icon(Icons.Default.ArrowDropDown, contentDescription = null)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.heightIn(max = 360.dp)) {
            choices.forEach { (value, text) -> DropdownMenuItem(text = { Text(text) }, onClick = { open = false; onPick(value) }) }
        }
    }
}

/** 提出する人: everyone in the channel, or groups and people (the channel's members, not bots). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TargetPicker(controller: AppController, channel: ChannelState, draft: RecurringDraft, version: Int, onChange: ((RecurringDraft) -> RecurringDraft) -> Unit) {
    val store = controller.store
    var members by remember(channel.id) { mutableStateOf<List<MemberOut>?>(null) }
    var failed by remember(channel.id) { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(channel.id) {
        controller.memberList(channel.id).onSuccess { members = it }.onFailure { failed = true }
    }
    val groups = remember(version) { store.groups.values.sortedBy { it.name } }
    val people = remember(version, members) {
        (members ?: emptyList())
            .filter { store.users[it.userId]?.role != "bot" }
            .map { Triple(it.userId, store.users[it.userId]?.displayName ?: "?", store.users[it.userId]?.username ?: "") }
            .sortedBy { it.second }
    }
    Text(stringResource(R.string.recurring_views_who_submits), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).toggleable(value = draft.allMembers, role = Role.Checkbox, onValueChange = { on -> onChange { it.copy(allMembers = on) } }),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = draft.allMembers, onCheckedChange = null)
        Text(stringResource(R.string.common_everyone_in_the_channel), modifier = Modifier.padding(start = 8.dp))
        Text(stringResource(R.string.recurring_views_members_at_posting_time), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (draft.allMembers) return
    if (groups.isNotEmpty()) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            groups.forEach { group ->
                val on = group.id in draft.groupIds
                FilterChip(
                    selected = on, label = { Text("@" + group.name) },
                    onClick = { onChange { it.copy(groupIds = if (on) it.groupIds - group.id else it.groupIds + group.id) } },
                )
            }
        }
    }
    when {
        members == null && failed -> Text(stringResource(R.string.common_couldnt_load_members), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        members == null -> Text(stringResource(R.string.common_loading), color = MaterialTheme.colorScheme.onSurfaceVariant)
        else -> {
            if (people.size > 8) {
                OutlinedTextField(query, { query = it }, singleLine = true, placeholder = { Text(stringResource(R.string.common_filter_by_name)) }, modifier = Modifier.fillMaxWidth())
            }
            val q = query.trim().lowercase()
            val shown = if (q.isEmpty()) people else people.filter { it.second.lowercase().contains(q) || it.third.lowercase().contains(q) }
            Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp))) {
                shown.forEachIndexed { index, (id, name, _) ->
                    if (index > 0) HorizontalDivider()
                    val on = id in draft.userIds
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN)
                            .toggleable(value = on, role = Role.Checkbox, onValueChange = { now -> onChange { it.copy(userIds = if (now) it.userIds + id else it.userIds - id) } })
                            .padding(horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = on, onCheckedChange = null)
                        Avatar(id, name, size = 24.dp, modifier = Modifier.padding(start = 8.dp))
                        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp).weight(1f))
                    }
                }
                if (shown.isEmpty()) Text(stringResource(R.string.recurring_views_no_matching_people), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth().padding(12.dp))
            }
        }
    }
    Text(stringResource(R.string.recurring_views_applies_to_the_channels_members_at), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
