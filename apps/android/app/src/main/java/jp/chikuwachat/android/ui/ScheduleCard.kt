package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.EventAvailable
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private val YES_TONE = Color(0xFF16A34A)
private val MAYBE_TONE = Color(0xFFD97706)
private val STAR = Color(0xFFF59E0B)

@Composable
private fun tone(answer: String?): Color = when (answer) {
    SchedulePolls.YES -> YES_TONE
    SchedulePolls.MAYBE -> MAYBE_TONE
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

/**
 * My answers as the card shows them: what I pressed last while its request is on its way, else the poll's. The requests
 * go one after another (a second press builds on the first, not on a poll that has not heard of it yet).
 */
private class MyAnswers {
    var local by mutableStateOf<List<String?>?>(null)
    val lock = Mutex()
}

/**
 * A scheduling poll under its message (M54, SCHEDULING.md §5; the desktop's ScheduleCard): per candidate the ○ △ × counts
 * and my three buttons (pressing mine again takes it back), the candidate with the most ○ starred, my comment, 「表で見る」
 * (people × candidates), and for its author, the channel's owners and administrators 「決める」 after asking. Once decided
 * the card shows the decided candidate large, with 「予定を開く」 (the M52 event form) and 「決定を取り消す」. Anonymous: no
 * names anywhere. `readOnly`: a channel only previewed, where nobody answers or decides.
 */
@Composable
fun ScheduleCard(poll: PollOut, message: MessageState, controller: AppController, version: Int, readOnly: Boolean = false) {
    val store = controller.store
    val me = remember(version) { store.me?.id }
    val channel = remember(version, message.channelId) { store.channel(message.channelId)?.channel }
    val mineState = remember(message.id) { MyAnswers() }
    val mine = mineState.local ?: SchedulePolls.myAnswers(poll, me)
    val counts = SchedulePolls.counts(poll)
    val best = SchedulePolls.bestSlots(poll).toSet()
    val decided = poll.decided
    val closed = poll.closedAt != null || decided != null
    val disabled = readOnly || closed || message.pending
    val decider = !readOnly && !message.pending && SchedulePolls.canDecide(me, message.senderId, controller.isAdmin, channel?.membership?.role)
    val isDm = channel?.type == "dm" || channel?.type == "group_dm"
    var table by rememberSaveable { mutableStateOf(false) }
    var confirm by rememberSaveable { mutableStateOf<Int?>(null) }
    var withoutEvent by rememberSaveable { mutableStateOf<Int?>(null) }

    fun send(answers: List<String?>, comment: String? = null) {
        mineState.local = answers
        controller.scope.launch {
            mineState.lock.withLock { controller.answerSchedule(message, answers, comment) }
            if (mineState.local === answers) mineState.local = null
        }
    }

    fun decide(index: Int, createEvent: Boolean) {
        controller.scope.launch {
            if (controller.decideSchedule(message, index, createEvent) == AppController.DecideOutcome.NEEDS_NO_EVENT) withoutEvent = index
        }
    }

    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier.fillMaxWidth().padding(top = 4.dp).border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .background(MaterialTheme.colorScheme.surface, shape).padding(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("📅 " + poll.question, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.width(6.dp))
            Tag("日程調整")
            if (poll.anonymous) { Spacer(Modifier.width(6.dp)); Tag("匿名") }
        }

        if (decided != null) {
            Column(
                Modifier.fillMaxWidth().padding(top = 8.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 8.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.EventAvailable, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                    Text(" 決定", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                }
                Text(
                    poll.options.getOrNull(decided.index) ?: "", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.padding(top = 2.dp),
                )
                counts.getOrNull(decided.index)?.let { CountLine(it, Modifier.padding(top = 2.dp)) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    decided.eventId?.let { eventId ->
                        TextButton(onClick = { controller.scope.launch { controller.openDecidedEvent(eventId) } }) {
                            Icon(Icons.Outlined.CalendarMonth, contentDescription = null, modifier = Modifier.size(16.dp))
                            Text(" 予定を開く")
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    if (decider) TextButton(onClick = { controller.scope.launch { controller.undecideSchedule(message) } }) { Text("決定を取り消す") }
                }
            }
        }

        poll.options.forEachIndexed { index, label ->
            val chosen = decided?.index == index
            val rowShape = RoundedCornerShape(8.dp)
            Column(
                Modifier.fillMaxWidth().padding(top = 6.dp)
                    .then(if (chosen) Modifier.border(1.5.dp, MaterialTheme.colorScheme.primary, rowShape) else Modifier)
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (decided != null && !chosen) 0.5f else 1f), rowShape)
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (index in best) {
                        Icon(Icons.Filled.Star, contentDescription = "○ がいちばん多い", tint = STAR, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(3.dp))
                    }
                    Text(label, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    CountLine(counts.getOrElse(index) { SlotCounts(0, 0, 0) })
                }
                Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    SchedulePolls.ANSWERS.forEach { answer ->
                        AnswerButton(label, answer, on = mine.getOrNull(index) == answer, enabled = !disabled) {
                            send(SchedulePolls.pressAnswer(mine, index, answer))
                        }
                        Spacer(Modifier.width(4.dp))
                    }
                    Spacer(Modifier.weight(1f))
                    if (decider && decided == null) {
                        TextButton(onClick = { confirm = index }, modifier = Modifier.semantics { contentDescription = "$label に決める" }) { Text("決める") }
                    }
                }
            }
        }

        val myText = SchedulePolls.myComment(poll, me)
        if (!readOnly && (!disabled || myText.isNotEmpty())) {
            CommentField(myText, enabled = !disabled, modifier = Modifier.padding(top = 8.dp)) { text -> send(mine, text) }
        }

        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
            Text(SchedulePolls.footer(poll), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            TextButton(onClick = { table = true }) {
                Icon(Icons.Outlined.TableChart, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(" 表で見る")
            }
        }
    }

    if (table) ScheduleTable(poll, message, controller, me, mine, readOnly, onAnswer = { send(it) }, onComment = { send(mine, it) }, onDismiss = { table = false })
    confirm?.let { index ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("この日に決めますか？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(poll.options.getOrNull(index) ?: "", fontWeight = FontWeight.SemiBold)
                    Text(
                        (if (isDm) "スレッドで回答した人に知らせます。" else "チャンネルのカレンダーに予定を作り、スレッドで回答した人に知らせます。") +
                            "回答は締め切られます (取り消すと再開します)。",
                    )
                }
            },
            confirmButton = { TextButton(onClick = { confirm = null; decide(index, createEvent = true) }) { Text("決定") } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("キャンセル") } },
        )
    }
    // SCHEDULING.md §7 3.: I may not add to this channel's calendar (posting is restricted to its owners): the decision can
    // still be made, without the event.
    withoutEvent?.let { index ->
        AlertDialog(
            onDismissRequest = { withoutEvent = null },
            title = { Text("予定を作れません") },
            text = {
                Text("このチャンネルのカレンダーには予定を追加できません (投稿はオーナーだけに制限されています)。予定を作らずに「${poll.options.getOrNull(index) ?: ""}」に決めますか？")
            },
            confirmButton = { TextButton(onClick = { withoutEvent = null; decide(index, createEvent = false) }) { Text("予定を作らずに決める") } },
            dismissButton = { TextButton(onClick = { withoutEvent = null }) { Text("キャンセル") } },
        )
    }
}

@Composable
private fun Tag(text: String) {
    Text(
        text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp)).padding(horizontal = 4.dp, vertical = 1.dp),
    )
}

/** 「○ 2 · △ 0 · × 1」, read as 「○ 2 人、△ 0 人、× 1 人」. */
@Composable
private fun CountLine(counts: SlotCounts, modifier: Modifier = Modifier) {
    Row(modifier.clearAndSetSemantics { contentDescription = "○ ${counts.yes} 人、△ ${counts.maybe} 人、× ${counts.no} 人" }) {
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        val style = MaterialTheme.typography.labelMedium
        Text("○", style = style, color = YES_TONE)
        Text(" ${counts.yes} · ", style = style, color = muted)
        Text("△", style = style, color = MAYBE_TONE)
        Text(" ${counts.maybe} · × ${counts.no}", style = style, color = muted)
    }
}

/** One of a candidate's three answers (44 × 36 dp); filled when it is mine. */
@Composable
private fun AnswerButton(label: String, answer: String, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(8.dp)
    val color = tone(answer)
    Box(
        Modifier.size(width = 44.dp, height = 36.dp)
            .background(if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface, shape)
            .border(1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { contentDescription = "$label: ${SchedulePolls.answerName(answer)}"; selected = on; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            SchedulePolls.mark(answer), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium,
            color = when {
                on -> MaterialTheme.colorScheme.onPrimary
                enabled -> color
                else -> color.copy(alpha = 0.5f)
            },
        )
    }
}

/** My comment (up to 100 characters): kept in the field until 「保存」. */
@Composable
private fun CommentField(value: String, enabled: Boolean, modifier: Modifier = Modifier, onSave: (String) -> Unit) {
    var text by rememberSaveable(value) { mutableStateOf(value) }
    val changed = text.trim() != value
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = text, onValueChange = { text = it.replace('\n', ' ').take(SchedulePolls.MAX_COMMENT) }, enabled = enabled, singleLine = true,
            label = { Text("ひとこと") }, placeholder = { Text("例: 午後なら参加できます") }, modifier = Modifier.weight(1f),
        )
        if (changed && enabled) TextButton(onClick = { onSave(text.trim()) }) { Text("保存") }
    }
}

private val NAME_WIDTH: Dp = 104.dp
private val CELL_WIDTH: Dp = 100.dp
private val COMMENT_WIDTH: Dp = 200.dp
private val ROW_HEIGHT: Dp = 44.dp
private val HEAD_HEIGHT: Dp = 56.dp

/**
 * 「表で見る」 (full screen): people × candidates like 調整さん, the counts first, then my row (a cell goes ○ → △ → × →
 * unanswered), then everyone else by their first answer, with their comments. The names stay while the candidates scroll
 * sideways. An anonymous poll has the counts, my row and the comments unnamed.
 */
@Composable
private fun ScheduleTable(
    poll: PollOut, message: MessageState, controller: AppController, me: String?, mine: List<String?>, readOnly: Boolean,
    onAnswer: (List<String?>) -> Unit, onComment: (String) -> Unit, onDismiss: () -> Unit,
) {
    val store = controller.store
    val counts = SchedulePolls.counts(poll)
    val best = SchedulePolls.bestSlots(poll).toSet()
    val editable = !readOnly && poll.closedAt == null && poll.decided == null && !message.pending
    val people = if (poll.anonymous) emptyList() else poll.respondents.filter { it != me }
    fun name(id: String) = store.users[id]?.displayName ?: "?"
    fun commentOf(id: String) = poll.comments.firstOrNull { it.userId == id }?.text ?: ""
    val myComment = SchedulePolls.myComment(poll, me)

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
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "閉じる") }
                    Column(Modifier.weight(1f)) {
                        Text(poll.question, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
                        Text("回答の一覧", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                HorizontalDivider()
                Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
                    Row(Modifier.fillMaxWidth()) {
                        // The names (fixed).
                        Column(Modifier.width(NAME_WIDTH)) {
                            NameCell("名前", HEAD_HEIGHT, muted = true)
                            NameCell("集計", ROW_HEIGHT, muted = true)
                            if (me != null) NameCell("自分", ROW_HEIGHT, bold = true)
                            people.forEach { NameCell(name(it), ROW_HEIGHT) }
                        }
                        // The candidates and the comments (scrolled sideways).
                        Column(Modifier.weight(1f).horizontalScroll(rememberScrollState())) {
                            Row {
                                poll.options.forEachIndexed { index, label ->
                                    val decidedHere = poll.decided?.index == index
                                    Row(
                                        Modifier.width(CELL_WIDTH).height(HEAD_HEIGHT)
                                            .background(if (decidedHere) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                                            .padding(horizontal = 4.dp),
                                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
                                    ) {
                                        if (index in best) Icon(Icons.Filled.Star, contentDescription = "○ がいちばん多い", tint = STAR, modifier = Modifier.size(12.dp))
                                        Text(label, style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                                TableText("コメント", COMMENT_WIDTH, HEAD_HEIGHT, muted = true)
                            }
                            HorizontalDivider(Modifier.width(CELL_WIDTH * poll.options.size + COMMENT_WIDTH))
                            Row {
                                counts.forEach { count ->
                                    Box(Modifier.width(CELL_WIDTH).height(ROW_HEIGHT), contentAlignment = Alignment.Center) { CountLine(count) }
                                }
                                Spacer(Modifier.width(COMMENT_WIDTH))
                            }
                            if (me != null) {
                                Row(Modifier.background(MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.35f))) {
                                    poll.options.forEachIndexed { index, label ->
                                        val answer = mine.getOrNull(index)
                                        Box(Modifier.width(CELL_WIDTH).height(ROW_HEIGHT), contentAlignment = Alignment.Center) {
                                            if (editable) {
                                                Box(
                                                    Modifier.size(width = 44.dp, height = 36.dp)
                                                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp))
                                                        .clickable { onAnswer(mine.mapIndexed { i, v -> if (i == index) SchedulePolls.nextAnswer(v) else v }) }
                                                        .semantics { contentDescription = "自分の $label: ${SchedulePolls.answerName(answer)} (押すと変わります)"; role = Role.Button },
                                                    contentAlignment = Alignment.Center,
                                                ) { Mark(answer) }
                                            } else {
                                                Mark(answer)
                                            }
                                        }
                                    }
                                    TableText(myComment, COMMENT_WIDTH, ROW_HEIGHT)
                                }
                            }
                            people.forEach { id ->
                                Row {
                                    poll.options.indices.forEach { index ->
                                        Box(Modifier.width(CELL_WIDTH).height(ROW_HEIGHT), contentAlignment = Alignment.Center) { Mark(SchedulePolls.answerOf(poll, id, index)) }
                                    }
                                    TableText(commentOf(id), COMMENT_WIDTH, ROW_HEIGHT)
                                }
                            }
                        }
                    }
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (editable && me != null) {
                            Text("押すと ○ → △ → × → 未回答 と変わります", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            CommentField(myComment, enabled = true, onSave = onComment)
                        }
                        if (poll.anonymous && poll.comments.isNotEmpty()) {
                            Text("コメント (匿名)", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            poll.comments.forEach { Text("・" + it.text, style = MaterialTheme.typography.bodyMedium) }
                        }
                        if (!poll.anonymous && people.isEmpty()) {
                            Text("まだ誰も答えていません", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Mark(answer: String?) {
    Text(
        SchedulePolls.mark(answer), fontWeight = if (answer != null) FontWeight.Bold else FontWeight.Normal, style = MaterialTheme.typography.titleMedium,
        color = if (answer == null) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f) else tone(answer),
        modifier = Modifier.semantics { contentDescription = SchedulePolls.answerName(answer) },
    )
}

@Composable
private fun NameCell(text: String, height: Dp, muted: Boolean = false, bold: Boolean = false) {
    Box(Modifier.width(NAME_WIDTH).height(height).padding(start = 16.dp, end = 4.dp), contentAlignment = Alignment.CenterStart) {
        Text(
            text, maxLines = 2, overflow = TextOverflow.Ellipsis,
            style = if (muted) MaterialTheme.typography.labelMedium else MaterialTheme.typography.bodyMedium,
            color = if (muted) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

@Composable
private fun TableText(text: String, width: Dp, height: Dp, muted: Boolean = false) {
    Box(Modifier.width(width).height(height).padding(horizontal = 8.dp), contentAlignment = Alignment.CenterStart) {
        Text(
            text, maxLines = 2, overflow = TextOverflow.Ellipsis,
            style = if (muted) MaterialTheme.typography.labelMedium else MaterialTheme.typography.bodySmall,
            color = if (muted) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
        )
    }
}
