package jp.chikuwachat.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.IconButton
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ActionOut
import jp.chikuwachat.android.app.AppController

/**
 * M143 (docs/ACTIONS.md §9): 「操作」 — the 操作ボタン I may press, in their groups (a heading per group, its buttons side
 * by side; the ungrouped ones last). A press asks first when the button wants it (the administrator's sentence), shows a
 * spinner on the button (pressing it again meanwhile does nothing), and ends with a snackbar: the relay's message or the
 * reason. Administration stays on the desktop / Web.
 */
@Composable
fun ActionsPane(controller: AppController, version: Int) {
    val store = controller.store
    // Opening the page reads the buttons again (the bootstrap's may be old after a long background).
    LaunchedEffect(Unit) { controller.engine?.loadActions() }
    val actions = remember(version) { ActionRules.pressable(store.actions, store.me?.role) }
    if (actions.isEmpty()) {
        Text(stringResource(R.string.actions_page_none), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    val feed = rememberActionStatusFeed(controller, active = true)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp)) {
        ActionButtons(controller, actions, version, feed = feed)
    }
}

/** The grouped buttons (the 「操作」 page, the top of 在室状況), with the confirmation they share. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ActionButtons(
    controller: AppController, actions: List<ActionOut>, version: Int, modifier: Modifier = Modifier, compact: Boolean = false,
    feed: ActionStatusFeed? = null,
) {
    val groups = remember(actions) { ActionRules.groups(actions) }
    if (groups.isEmpty()) return
    val press = rememberActionPress(controller)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 16.dp)) {
        groups.forEach { group ->
            Column {
                group.label?.let {
                    Text(
                        it, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 6.dp).semantics { heading() },
                    )
                }
                if (feed != null) {
                    ActionRules.statusLines(group, controller.store.actionStatuses, feed.loading, feed.error).forEach { line ->
                        StatusLineRow(line, feed)
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    group.actions.forEach { action ->
                        ActionButton(controller, action, version, sending = action.id in controller.actionsBusy) { press(action) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ActionButton(controller: AppController, action: ActionOut, version: Int, sending: Boolean, onClick: () -> Unit) {
    val sendingText = stringResource(R.string.actions_sending)
    OutlinedButton(
        onClick = { if (!sending) onClick() },
        modifier = Modifier.heightIn(min = TouchTarget.MIN).widthIn(min = 112.dp)
            .semantics { contentDescription = ActionRules.title(action); if (sending) stateDescription = sendingText },
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(Modifier.clearAndSetSemantics {}, verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
                if (sending) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else ActionGlyph(controller, action, version, size = 20.dp)
            }
            Text(
                action.name, modifier = Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** A button's picture: its icon (the 在室状況 set), else its emoji, else a bolt. Decorative. */
@Composable
fun ActionGlyph(controller: AppController, action: ActionOut, version: Int, size: Dp) {
    if (AttendanceIcons.glyph(action.icon, action.emoji) == AttendanceIcons.Glyph.None) {
        Icon(Icons.Filled.Bolt, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(size))
    } else {
        StateGlyph(controller, action.icon, action.emoji, version, size = size, tint = MaterialTheme.colorScheme.primary)
    }
}

/**
 * Pressing, shared by every place a button shows: asks first when the button wants it (an AlertDialog with the
 * configured sentence and 「実行」), then [AppController.pressAction] (once; the app's scope keeps the answer).
 */
@Composable
fun rememberActionPress(controller: AppController): (ActionOut) -> Unit {
    var asking by remember { mutableStateOf<ActionOut?>(null) }
    asking?.let { action ->
        AlertDialog(
            onDismissRequest = { asking = null },
            title = { Text(ActionRules.title(action)) },
            text = { Text(ActionRules.confirmText(action)) },
            confirmButton = {
                TextButton(onClick = { asking = null; controller.pressAction(action) }) { Text(stringResource(R.string.actions_run)) }
            },
            dismissButton = { TextButton(onClick = { asking = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
    return { action ->
        if (action.id !in controller.actionsBusy) {
            if (action.confirm) asking = action else controller.pressAction(action)
        }
    }
}

/**
 * The 「操作」 part of the 在室状況 quick-switch sheet (`show_on_attendance`): a heading and one row per button
 * (「組：名前」), at least 52 dp high; a spinner while it is sent.
 */
@Composable
fun ActionSheetRows(controller: AppController, actions: List<ActionOut>, version: Int) {
    if (actions.isEmpty()) return
    val press = rememberActionPress(controller)
    val ordered = remember(actions) { ActionRules.groups(actions).flatMap { it.actions } }
    Text(
        stringResource(R.string.actions_nav), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 12.dp, bottom = 4.dp).semantics { heading() },
    )
    val sendingText = stringResource(R.string.actions_sending)
    ordered.forEach { action ->
        val sending = action.id in controller.actionsBusy
        Row(
            Modifier.fillMaxWidth().heightIn(min = 52.dp)
                .clickable(enabled = !sending, role = Role.Button) { press(action) }
                .semantics { contentDescription = ActionRules.title(action); if (sending) stateDescription = sendingText }
                .padding(horizontal = 24.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(30.dp).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
                if (sending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else ActionGlyph(controller, action, version, size = 22.dp)
            }
            Text(
                ActionRules.title(action), modifier = Modifier.weight(1f).padding(start = 14.dp).clearAndSetSemantics {},
                style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * §12.4: the state of the groups on a page: read when it opens, every minute while the app is in front (and on coming
 * back, when the last read is that old), replaced by actions.status_updated (the store). [ActionStatusFeed.refresh] asks
 * the relays now (`refresh=true`; a 429 says 「少し待って…」).
 */
class ActionStatusFeed {
    /** The first read is under way (「状態を確認中…」). */
    var loading by mutableStateOf(true)
    var refreshing by mutableStateOf(false)
    /** Why the last read failed as a whole (no answer from our server, 429 …), or null. */
    var error by mutableStateOf<String?>(null)
    /** Moves every half minute, for 「◯分前に確認」. */
    var now by mutableStateOf(java.time.Instant.now())
    var refresh: () -> Unit = {}
}

@Composable
fun rememberActionStatusFeed(controller: AppController, active: Boolean): ActionStatusFeed {
    val feed = remember { ActionStatusFeed() }
    val scope = rememberCoroutineScope()
    var lastRead by remember { mutableStateOf(0L) }
    suspend fun read(refresh: Boolean) {
        lastRead = System.currentTimeMillis()
        if (refresh) feed.refreshing = true
        try {
            controller.engine?.loadActionStatuses(refresh)
            feed.error = null
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Throwable) {
            feed.error = ActionRules.refusalText(e)
        } finally {
            feed.loading = false
            if (refresh) feed.refreshing = false
            feed.now = java.time.Instant.now()
        }
    }
    feed.refresh = { if (!feed.refreshing) scope.launch { read(true) } }
    val foreground = controller.appForeground
    LaunchedEffect(active, foreground) {
        if (!active || !foreground) return@LaunchedEffect
        while (true) {
            if (System.currentTimeMillis() - lastRead >= ActionRules.STATUS_POLL_MS) read(false)
            feed.now = java.time.Instant.now()
            kotlinx.coroutines.delay(30_000)
        }
    }
    return feed
}

private fun toneColor(tone: String): Color = when (tone) {
    "ok" -> Color(0xFF10B981)
    "warn" -> Color(0xFFF59E0B)
    "alert" -> Color(0xFFF43F5E)
    else -> Color(0xFFA1A1AA)
}

/** One state line: a tone dot, 「名前：」 for an ungrouped button, the text, the details, 「◯分前に確認」 and 更新. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatusLineRow(line: ActionRules.StatusLine, feed: ActionStatusFeed) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val small = MaterialTheme.typography.bodySmall
    FlowRow(
        Modifier.fillMaxWidth().padding(bottom = 6.dp).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        val dot = if (line is ActionRules.StatusLine.Known) toneColor(line.tone) else MaterialTheme.colorScheme.outlineVariant
        Box(Modifier.size(10.dp).background(dot, CircleShape))
        line.label?.let { Text(stringResource(R.string.actions_status_label, it), style = small, color = muted) }
        when (line) {
            is ActionRules.StatusLine.Known -> {
                Text(line.status.status!!.text, style = small, fontWeight = FontWeight.Medium)
                if (line.details.isNotEmpty()) Text(line.details, style = small, color = muted)
            }
            is ActionRules.StatusLine.Failed -> Text(line.text, style = small, color = MaterialTheme.colorScheme.error)
            is ActionRules.StatusLine.Loading -> Text(stringResource(R.string.actions_status_loading), style = small, color = muted)
        }
        val status = (line as? ActionRules.StatusLine.Known)?.status ?: (line as? ActionRules.StatusLine.Failed)?.status
        status?.let { Text(ActionRules.checkedLabel(it.fetchedAt, feed.now), style = MaterialTheme.typography.labelSmall, color = muted) }
        IconButton(onClick = feed.refresh, enabled = !feed.refreshing, modifier = Modifier.size(TouchTarget.MIN)) {
            if (feed.refreshing) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            else Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.actions_status_refresh), tint = muted, modifier = Modifier.size(18.dp))
        }
    }
}
