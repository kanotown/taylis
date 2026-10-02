package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.AiAgentPublic
import jp.chikuwachat.android.api.AiRunOut
import jp.chikuwachat.android.api.AiSummaryTargetOut
import jp.chikuwachat.android.api.ErrorMessages
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.AiSummaryPhase
import jp.chikuwachat.android.sync.AiSummaryRequest
import jp.chikuwachat.android.sync.AiSummaryState
import kotlinx.coroutines.launch

/** M66 (docs/AI.md §4, §6): the words of the AI screens, kept apart from the views for the unit tests. */
object AiTexts {
    /** The three choices of a conversation's 「要約」, in order. */
    fun choices(channelId: String): List<Pair<String, AiSummaryRequest>> = listOf(
        "未読を要約" to AiSummaryRequest(channelId, "unread"),
        "直近 1 日を要約" to AiSummaryRequest(channelId, "recent", days = 1),
        "直近 7 日を要約" to AiSummaryRequest(channelId, "recent", days = 7),
    )

    fun threadRequest(channelId: String, parentId: String) = AiSummaryRequest(channelId, "thread", threadId = parentId)

    fun title(request: AiSummaryRequest): String = when (request.scope) {
        "unread" -> "未読の要約"
        "thread" -> "スレッドの要約"
        "recent" -> "直近 ${request.days ?: 1} 日の要約"
        else -> "要約"
    }

    /** While the sheet waits: asked, queued at the server, or being written. */
    fun progress(state: AiSummaryState): String? = when (state.phase) {
        AiSummaryPhase.REQUESTING -> "依頼しています…"
        AiSummaryPhase.RUNNING -> if (state.run?.status == "running") "要約を作成しています…" else "順番を待っています…"
        else -> null
    }

    /** §2.3: the oldest messages beyond what fits were left out. */
    fun omittedNote(count: Int): String? = if (count > 0) "古い $count 件は省きました" else null

    /** §4: shown on a channel's details while an AI bot is a member; null otherwise. */
    fun memberNotice(agents: List<AiAgentPublic>, memberIds: Collection<String>): String? {
        val present = agents.filter { it.botUserId in memberIds }
        val names = present.map { it.name }.distinct()
        if (names.isEmpty()) return null
        // §12: each bot's model decides where its part goes (Anthropic, OpenAI or both), as on the web.
        val where = listOfNotNull(
            "Anthropic".takeIf { present.any { !it.model.startsWith("gpt-") } },
            "OpenAI".takeIf { present.any { it.model.startsWith("gpt-") } },
        ).joinToString(" と ")
        return "AI (${names.joinToString("、")}) が参加しています。メンションしたときと要約のときに、会話の一部が $where の API に送られます"
    }

    const val PRIVATE_NOTE = "要約はあなたにだけ表示されます"

    private fun providerLabel(provider: String): String = when (provider) {
        "openai" -> "OpenAI"
        "anthropic" -> "Anthropic"
        else -> provider
    }

    /**
     * Review v0.1.18 #2: the line under the 「要約」 choices — 「要約は <bot> (<provider>) に送られます」, or the reason a
     * summary cannot be asked for now (the shared error texts). Null: nothing to say (no target, an older server).
     */
    fun targetLine(target: AiSummaryTargetOut?): String? {
        target ?: return null
        if (!target.available) return target.reason?.let { ErrorMessages.byCode[it] } ?: "今は要約できません"
        val provider = target.provider?.takeIf { it.isNotBlank() } ?: return null
        val name = target.agentName?.takeIf { it.isNotBlank() }
        return if (name != null) "要約は $name (${providerLabel(provider)}) に送られます" else "要約は ${providerLabel(provider)} に送られます"
    }

    /** The choices are disabled while the server says no; an unknown target (an older server) leaves them as before. */
    fun choicesDisabled(target: AiSummaryTargetOut?): Boolean = target?.available == false

    /** The summary sheet's caption: the provider and model the run actually used, e.g. 「OpenAI · gpt-6.1-sol」. */
    fun runCaption(run: AiRunOut?): String? {
        run ?: return null
        val model = run.model?.takeIf { it.isNotBlank() }
        val provider = run.provider?.takeIf { it.isNotBlank() } ?: model?.let { if (it.startsWith("gpt-")) "openai" else "anthropic" } ?: return null
        return if (model != null) "${providerLabel(provider)} · $model" else providerLabel(provider)
    }
}

/** 「AI」 beside an AI bot's name (instead of 「BOT」) and on its mention candidate. */
@Composable
fun AiBadge(modifier: Modifier = Modifier) {
    Surface(shape = MaterialTheme.shapes.extraSmall, color = MaterialTheme.colorScheme.tertiaryContainer, modifier = modifier) {
        Text("AI", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp))
    }
}

/** §4: the notice on a channel's details while an AI bot is a member. */
@Composable
fun AiMemberNotice(text: String, modifier: Modifier = Modifier) {
    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceVariant, modifier = modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
            Icon(Icons.Default.AutoAwesome, contentDescription = null, modifier = Modifier.size(18.dp).padding(top = 2.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

/**
 * The AI sheets of the main screen: the 「要約」 choices for [AppController.aiSummaryChooser], and the summary itself
 * ([AppController.aiSummary]: progress, then the Markdown through the message body's renderer, or the failure).
 */
@Composable
fun AiSheets(controller: AppController) {
    controller.aiSummaryChooser?.let { channelId -> AiSummaryChooser(controller, channelId) }
    controller.aiSummary?.let { AiSummarySheet(controller, it) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AiSummaryChooser(controller: AppController, channelId: String) {
    val sheet = rememberModalBottomSheetState()
    // Review v0.1.18 #2: where the summary would go, read as the choices open.
    LaunchedEffect(channelId) { controller.loadSummaryTarget(channelId) }
    val target = controller.aiSummaryTargets[channelId]
    val disabled = AiTexts.choicesDisabled(target)
    ModalBottomSheet(onDismissRequest = { controller.aiSummaryChooser = null }, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp)) {
            Text("要約", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            AiTexts.choices(channelId).forEach { (label, request) ->
                Text(
                    label,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (disabled) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f) else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(enabled = !disabled) { controller.requestSummary(request) }.padding(horizontal = 24.dp, vertical = 14.dp),
                )
            }
            AiSummaryTargetLine(target, Modifier.padding(horizontal = 24.dp, vertical = 4.dp))
            Text(AiTexts.PRIVATE_NOTE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        }
    }
}

/** Review v0.1.18 #2: the line under the 「要約」 choices (AiTexts.targetLine); nothing without a target. */
@Composable
fun AiSummaryTargetLine(target: AiSummaryTargetOut?, modifier: Modifier = Modifier) {
    val line = AiTexts.targetLine(target) ?: return
    Text(
        line, style = MaterialTheme.typography.bodySmall, modifier = modifier,
        color = if (target?.available == false) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AiSummarySheet(controller: AppController, state: AiSummaryState) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = controller.scope
    val store = controller.store
    val version by store.version.collectAsState()
    val channelName = store.channel(state.request.channelId)?.let { channelTitle(it, store) }
    fun close() {
        scope.launch { sheet.hide() }.invokeOnCompletion { controller.closeSummary() }
    }
    ModalBottomSheet(onDismissRequest = { controller.closeSummary() }, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp).padding(bottom = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.AutoAwesome, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                Column(Modifier.weight(1f).padding(start = 8.dp)) {
                    Text(AiTexts.title(state.request), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    if (channelName != null) Text(channelName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
                val progress = AiTexts.progress(state)
                val failure = state.failureText
                val output = state.run?.output
                when {
                    progress != null -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(vertical = 16.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                        Text(progress, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    failure != null -> Text(failure, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp))
                    else -> {
                        AiTexts.omittedNote(state.run?.omittedCount ?: 0)?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
                        }
                        SelectionContainer {
                            MessageBody(
                                output?.takeIf { it.isNotBlank() } ?: "(要約する内容がありませんでした)", store.users, groups = store.groups,
                                internalBase = controller.serverBase,
                                onOpenMessage = { id -> close(); scope.launch { controller.openPermalink(id) } },
                                customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations,
                                onNeedEmojiImage = { controller.loadEmojiImage(it) }, version = version,
                            )
                        }
                    }
                }
            }
            Text(AiTexts.PRIVATE_NOTE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            AiTexts.runCaption(state.run)?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.End) {
                if (state.phase == AiSummaryPhase.FAILED) TextButton(onClick = { controller.retrySummary() }) { Text("もう一度") }
                TextButton(onClick = ::close) { Text("閉じる") }
            }
        }
    }
}
