package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.AiRunOut
import jp.chikuwachat.android.api.AiSourceOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.AiAskState
import jp.chikuwachat.android.sync.AiSummaryPhase
import kotlinx.coroutines.launch

/**
 * M71 (docs/AI.md §13): 「AI に聞く」 at the top of the search's message results. The words and the filter chips (as
 * modifiers) are the question; the narrowed conversation goes as `channel_id`. Shown only while summaries are available
 * and the server told where the question would go (GET /ai/ask/target: a server before M70 answers 404 and the bar stays
 * hidden); when it cannot be asked, the reason in red and the button disabled. The answer opens in [AskSheets].
 */
@Composable
fun AskBar(controller: AppController, version: Int, params: SearchParams, onHistory: () -> Unit) {
    val store = controller.store
    val question = remember(params, version) { Search.askQuery(params, { store.users[it]?.username }) }
    val channelId = params.channelId
    val usable = controller.aiSummaryAvailable && question.isNotEmpty() && !AiTexts.askTooLong(question)
    LaunchedEffect(usable, question, channelId) { if (usable) controller.loadAskTarget(question, channelId) }
    val target = controller.aiAskTarget?.takeIf { it.question == question && it.channelId == channelId }?.target
    val session = controller.aiAsk
    if ((!usable || target == null) && session == null) return
    val line = if (usable) AiTexts.askTargetLine(target) else null
    val canAsk = usable && target?.available == true && session?.phase != AiSummaryPhase.REQUESTING
    Surface(
        shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.AutoAwesome, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Button(onClick = { controller.startAsk(question, channelId) }, enabled = canAsk) { Text("AI に聞く") }
                Spacer(Modifier.weight(1f))
                if (session != null && !controller.aiAskShown) TextButton(onClick = { controller.aiAskShown = true }) { Text("答え") }
                TextButton(onClick = onHistory) {
                    Icon(Icons.Default.History, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("履歴")
                }
            }
            if (line != null) {
                Text(
                    line, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp),
                    color = if (target?.available == false) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * The answer sheet ([AppController.aiAsk] while [AppController.aiAskShown]) and the history sheet (`historyOpen`).
 * A cited message ([n] in the answer or a source row) opens like a search result: the sheet steps aside, the question
 * is kept (「答え」 on the bar shows it again).
 */
@Composable
fun AskSheets(
    controller: AppController,
    version: Int,
    historyOpen: Boolean,
    onCloseHistory: () -> Unit,
    onOpenSource: (messageId: String, channelId: String, parentId: String?) -> Unit,
) {
    val session = controller.aiAsk
    if (session != null && controller.aiAskShown) {
        AskAnswerSheet(controller, version, session, onOpenSource)
    }
    if (historyOpen) AskHistorySheet(controller, onDismiss = onCloseHistory, onPick = { run -> onCloseHistory(); controller.showAskRun(run) })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AskAnswerSheet(
    controller: AppController,
    version: Int,
    state: AiAskState,
    onOpenSource: (messageId: String, channelId: String, parentId: String?) -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = controller.scope
    val store = controller.store
    val run = state.run
    val sources = run?.takeIf { it.status == "done" }?.citedSources.orEmpty()
    fun close() {
        scope.launch { sheet.hide() }.invokeOnCompletion { controller.closeAsk() }
    }
    /** The sheet steps aside (the question stays) and the message opens in its conversation. */
    fun open(source: AiSourceOut) {
        scope.launch { sheet.hide() }.invokeOnCompletion {
            controller.aiAskShown = false
            onOpenSource(source.messageId, source.channelId, source.parentId)
        }
    }
    fun openId(messageId: String) {
        val source = sources.firstOrNull { it.messageId.equals(messageId, ignoreCase = true) }
        if (source != null) open(source)
        else scope.launch { sheet.hide() }.invokeOnCompletion { controller.aiAskShown = false; scope.launch { controller.openPermalink(messageId) } }
    }
    ModalBottomSheet(onDismissRequest = { controller.closeAsk() }, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp).padding(bottom = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.AutoAwesome, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                Column(Modifier.weight(1f).padding(start = 8.dp)) {
                    Text("AI に聞く", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    if (state.question.isNotBlank()) Text("「${state.question}」", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
                val progress = AiTexts.askProgress(state)
                val failure = state.failureText
                when {
                    progress != null -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(vertical = 16.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                        Text(progress, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    failure != null -> Text(failure, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp))
                    else -> {
                        val base = controller.serverBase
                        val output = run?.output?.takeIf { it.isNotBlank() } ?: "(答えがありませんでした)"
                        val body = remember(output, sources, base) { if (base != null) AiTexts.linkCitations(output, sources, base) else output }
                        SelectionContainer {
                            MessageBody(
                                body, store.users, groups = store.groups,
                                internalBase = base, onOpenMessage = ::openId, citations = true,
                                customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations,
                                onNeedEmojiImage = { controller.loadEmojiImage(it) }, version = version,
                            )
                        }
                        AiTexts.askOmittedNote(run?.omittedCount ?: 0)?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                        }
                        if (sources.isNotEmpty()) AskSources(controller, sources, ::open)
                    }
                }
            }
            Text(AiTexts.ASK_NOTE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            AiTexts.runCaption(run)?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.End) {
                if (state.phase == AiSummaryPhase.FAILED) TextButton(onClick = { controller.retryAsk() }) { Text("もう一度") }
                TextButton(onClick = ::close) { Text("閉じる") }
            }
        }
    }
}

/** The cited messages: [n], who, where, when and the excerpt; a tap opens the message (its thread for a reply). */
@Composable
private fun AskSources(controller: AppController, sources: List<AiSourceOut>, onOpen: (AiSourceOut) -> Unit) {
    val store = controller.store
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text("出典", style = MaterialTheme.typography.labelLarge, color = muted, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
    sources.forEach { source ->
        val sender = store.users[source.senderId]?.displayName ?: "?"
        val conversation = store.channel(source.channelId)?.let { channelTitle(it, store) } ?: "会話"
        Row(
            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN)
                .clickable(onClickLabel = if (source.parentId != null) "スレッドで表示" else "会話で表示") { onOpen(source) }
                .padding(vertical = 6.dp),
        ) {
            Text("[${source.n}]", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary, modifier = Modifier.width(36.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    AiTexts.sourceLine(sender, conversation, source.parentId != null, Timeline.fullLabel(source.createdAt)),
                    style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (source.excerpt.isNotBlank()) Text(source.excerpt, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** 「履歴」: my recent questions (GET /ai/runs?kind=ask), the question and when; a tap shows that answer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AskHistorySheet(controller: AppController, onDismiss: () -> Unit, onPick: (AiRunOut) -> Unit) {
    var runs by remember { mutableStateOf<List<AiRunOut>?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val read = controller.askHistory()
        if (read == null) failed = true else runs = read
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp)) {
            Text("過去の質問", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            val list = runs
            val muted = MaterialTheme.colorScheme.onSurfaceVariant
            when {
                failed -> Text("読み込めませんでした", color = muted, modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp))
                list == null -> Row(Modifier.padding(horizontal = 24.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("読み込んでいます…", color = muted)
                }
                list.isEmpty() -> Text("まだ質問していません", color = muted, modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp))
                else -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp)) {
                    items(list, key = { it.id }) { run ->
                        Column(Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable { onPick(run) }.padding(horizontal = 24.dp, vertical = 10.dp)) {
                            Text(run.question?.takeIf { it.isNotBlank() } ?: "(質問)", style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOfNotNull(Timeline.fullLabel(run.createdAt).takeIf { it.isNotBlank() }, AiTexts.historyStatus(run)).joinToString(" · "),
                                style = MaterialTheme.typography.labelSmall, color = muted,
                            )
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}
