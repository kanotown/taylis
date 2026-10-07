package jp.chikuwachat.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
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
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp)) {
        ActionButtons(controller, actions, version)
    }
}

/** The grouped buttons (the 「操作」 page, the top of 在室状況), with the confirmation they share. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ActionButtons(controller: AppController, actions: List<ActionOut>, version: Int, modifier: Modifier = Modifier, compact: Boolean = false) {
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
