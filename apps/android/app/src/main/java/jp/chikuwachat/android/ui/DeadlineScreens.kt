package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.AlarmAdd
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskStatus
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.TaskListState
import java.text.Collator
import java.util.Locale

/** M86: the note over 「締切」 — a server before M85, or a read that failed (null: nothing to say). */
fun deadlinesNote(state: TaskListState?, available: Boolean): String? = when {
    !available || state == TaskListState.UNSUPPORTED -> "このサーバは締切に対応していません"
    state == TaskListState.FAILED -> "締切を読み込めませんでした。再接続すると読み直します"
    else -> null
}

/** The chip's colours (background, text) for its tone, in the light or dark theme. */
@Composable
private fun toneColors(tone: DeadlineTone): Pair<Color, Color> {
    val scheme = MaterialTheme.colorScheme
    val dark = scheme.surface.luminance() < 0.5f
    return when (tone) {
        DeadlineTone.SOON -> scheme.errorContainer to scheme.onErrorContainer
        DeadlineTone.WEEK -> if (dark) Color(0xFF4A3410) to Color(0xFFFCD34D) else Color(0xFFFEF3C7) to Color(0xFF92400E)
        DeadlineTone.LATER -> scheme.surfaceContainerHigh to scheme.onSurfaceVariant
    }
}

/**
 * M86 (DEADLINES.md §8 2.): one line above a channel's tabs with its next open deadline that has not passed —
 * 「⏰ 全国大会 原稿 あと 3 日」 (今日 / 明日), red the day before and on the day, amber within a week, grey later. A line of
 * its own, so a long channel name in the bar above keeps its room. A tap opens the deadline. Nothing without one, in a
 * DM, or from a server before M85.
 */
@Composable
fun DeadlineChipRow(controller: AppController, channel: ChannelState) {
    if (!TaskRules.hasBoard(channel.channel)) return
    val hub = controller.tasks ?: return
    val changes = taskVersion(hub)
    val today = rememberToday().toString()
    LaunchedEffect(hub) { hub.openDeadlines() }
    val next = remember(changes, today, channel.id) { hub.deadlineList()?.tasks?.let { DeadlineRules.next(it, channel.id, today) } } ?: return
    val tone = DeadlineRules.tone(next, today)
    val (background, text) = toneColors(tone)
    val label = DeadlineRules.chipText(next, today)
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
        Surface(
            shape = RoundedCornerShape(50), color = background,
            modifier = Modifier.heightIn(min = 32.dp)
                .clickable(role = Role.Button, onClickLabel = "締切を開く") { controller.taskForm = TaskForm(next, null) }
                .semantics(mergeDescendants = true) { contentDescription = "次の締切、$label" },
        ) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Alarm, contentDescription = null, tint = text, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    label, color = text, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    fontWeight = if (tone == DeadlineTone.LATER) FontWeight.Normal else FontWeight.SemiBold,
                )
            }
        }
    }
}

/**
 * M86 (DEADLINES.md §8 3.): the home's 「締切」 tile — my channels' deadlines in 今週 / 今月 / それ以降 / 過ぎたもの (empty
 * sections left out). A row: its date (「10/9 (金)」, 「今日 17:00」), the title (struck through once done), #channel and
 * the assignees; a tap opens the deadline's form. ＋ adds one on a board I may post to.
 */
@Composable
fun DeadlinesPane(controller: AppController, version: Int) {
    val hub = controller.tasks
    val changes = taskVersion(hub)
    val today = rememberToday().toString()
    LaunchedEffect(hub) { hub?.openDeadlines() }
    val list = remember(changes, hub) { hub?.deadlineList() }
    val groups = remember(list, today) { DeadlineRules.groups(list?.tasks ?: emptyList(), today) }
    val store = controller.store
    // Where ＋ may add one: the boards I may post to (never as a guest), by name.
    val boards = remember(version) {
        val collator = Collator.getInstance(Locale.JAPANESE)
        store.channels.values.filter { DeadlineRules.canAdd(it, controller.isAdmin, controller.isGuest) }
            .sortedWith { a, b -> collator.compare(a.channel.name ?: "", b.channel.name ?: "") }.map { it.id }
    }
    val available = hub?.available == true
    val loading = available && (list == null || list.state == TaskListState.LOADING)
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            deadlinesNote(list?.state, available)?.let { NoteStrip(it) }
            LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(bottom = 88.dp)) {
                if (groups.isEmpty() && list?.state != TaskListState.UNSUPPORTED && available) {
                    item(key = "empty") {
                        Text(
                            if (loading) "読み込み中…" else "締切はありません", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp),
                        )
                    }
                }
                groups.forEach { group ->
                    item(key = "h:" + group.key.name) {
                        Text(
                            group.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() },
                        )
                    }
                    items(group.tasks, key = { group.key.name + ":" + it.id }) { task ->
                        DeadlineRow(controller, task, today, version, past = group.key == DeadlineGroupKey.PAST)
                        HorizontalDivider(Modifier.padding(start = 16.dp))
                    }
                }
            }
        }
        if (available && list?.state != TaskListState.UNSUPPORTED && boards.isNotEmpty()) {
            FloatingActionButton(
                onClick = { controller.taskForm = TaskForm(null, DeadlineRules.createInit(boards.first(), boards)) },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            ) { Icon(Icons.Outlined.AlarmAdd, contentDescription = "締切を追加") }
        }
    }
}

@Composable
private fun DeadlineRow(controller: AppController, task: TaskOut, today: String, version: Int, past: Boolean) {
    val store = controller.store
    val done = task.status == TaskStatus.DONE
    val whenText = DeadlineRules.whenText(task, today)
    val names = remember(version, task.assigneeIds) { task.assigneeIds.map { store.users[it]?.displayName ?: "?" } }
    val place = TaskRules.placeLabel(task)
    val detail = buildList {
        add(place)
        if (names.isNotEmpty()) add("担当: " + names.joinToString("、"))
        if (done) add("完了")
    }.joinToString(" · ")
    val soon = !done && !past && DeadlineRules.tone(task, today) == DeadlineTone.SOON
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN)
            .clickable(onClickLabel = "開く") { controller.taskForm = TaskForm(task, null) }
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .semantics(mergeDescendants = true) { contentDescription = "$whenText、${task.title}、$detail" },
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            whenText, style = MaterialTheme.typography.labelLarge, modifier = Modifier.widthIn(min = 96.dp).padding(top = 2.dp, end = 8.dp),
            color = if (soon) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = if (soon) FontWeight.SemiBold else FontWeight.Normal,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                task.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                textDecoration = if (done) TextDecoration.LineThrough else null,
                color = if (done || past) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            )
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
