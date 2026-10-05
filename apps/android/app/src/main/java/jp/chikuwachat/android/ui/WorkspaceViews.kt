package jp.chikuwachat.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.app.Workspace
import jp.chikuwachat.android.app.Workspaces
import jp.chikuwachat.android.platform.WorkspaceIconCache
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

// M16c: the workspace switcher (WORKSPACES.md §5): the active workspace over the channel list, a bottom sheet with
// every registered workspace (unread marks, sign-out) and 「ワークスペースを追加」.

/**
 * A workspace's tile: the icon an admin set (M93, WORKSPACES.md §3.4.1), else its initials on a colour of its own (the
 * desktop's rule), greyed when signed out.
 */
@Composable
fun WorkspaceTile(entry: Workspace?, name: String, size: Dp, modifier: Modifier = Modifier, dimmed: Boolean = false) {
    val shape = RoundedCornerShape(size / 4)
    val icon = entry?.let { WorkspaceIconCache.image(it.serverUrl, it.iconVersion) }
    if (icon != null) {
        Image(icon, contentDescription = null, contentScale = ContentScale.Crop, modifier = modifier.size(size).alpha(if (dimmed) 0.45f else 1f).clip(shape))
        return
    }
    val color = Color(Workspaces.color(entry?.let(Workspaces::colorKey) ?: name))
    Box(
        modifier.size(size).alpha(if (dimmed) 0.45f else 1f).background(color, shape),
        contentAlignment = Alignment.Center,
    ) {
        Text(Workspaces.initials(name), color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.42f).sp, maxLines = 1)
    }
}

/**
 * The channel list's title: the workspace on screen; a dot when another one has something unread. Opens the switcher;
 * M37: on the phone's home only with two workspaces or more (`switchable`; with one, ⋮ offers 「ワークスペースを追加」).
 */
@Composable
fun WorkspaceTitle(controller: AppController, switchable: Boolean = true) {
    val entry = controller.activeWorkspace
    val name = controller.workspaceName
    val othersUnread = controller.workspaces.any { it.serverUrl != controller.activeKey && !it.signedOut && (it.hasUnread || it.badge > 0) }
    val tap = if (switchable) Modifier.clickable(onClickLabel = stringResource(R.string.workspace_views_switch_workspace)) { controller.openSwitcher() } else Modifier
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).then(tap).padding(horizontal = 4.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            WorkspaceTile(entry, name, 30.dp)
            if (othersUnread) {
                Box(
                    Modifier.align(Alignment.TopEnd).padding(start = 0.dp).size(11.dp)
                        .background(MaterialTheme.colorScheme.surface, CircleShape).padding(2.dp)
                        .background(MaterialTheme.colorScheme.error, CircleShape),
                )
            }
        }
        Spacer(Modifier.width(10.dp))
        Text(name, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (switchable) Icon(Icons.Default.ExpandMore, contentDescription = stringResource(R.string.workspace_views_switch_workspace), modifier = Modifier.padding(start = 2.dp))
    }
}

/**
 * Every registered workspace: tile, name, account, unread number or dot (GET /sync/summary, read again when the
 * sheet opens), a check on the one on screen and, per row, サインアウト (confirmed); 「ワークスペースを追加」 last.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceSheet(controller: AppController, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var leaving by remember { mutableStateOf<Workspace?>(null) }
    LaunchedEffect(Unit) { controller.refreshSummaries() }
    fun close(then: () -> Unit) {
        scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss(); then() }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Text(stringResource(R.string.common_workspaces), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp))
        LazyColumn(Modifier.fillMaxWidth().navigationBarsPadding()) {
            itemsIndexed(controller.workspaces, key = { _, it -> it.serverUrl }) { index, entry ->
                WorkspaceRow(
                    controller, entry, index, controller.workspaces.size,
                    onOpen = { close { controller.switchWorkspace(entry.serverUrl) } },
                    onLeave = { leaving = entry },
                )
            }
            item(key = "add") { AddWorkspaceItem(onClick = { close { controller.beginAddWorkspace() } }) }
        }
    }
    leaving?.let { entry -> SignOutWorkspaceDialog(controller, entry, onDismiss = { leaving = null }) }
}

/**
 * M40: 自分 → 「ワークスペース」, the switcher's list as a screen: every workspace with its marks, a tap on another one
 * switches to it, サインアウト per row (confirmed), 「ワークスペースを追加」 last.
 */
@Composable
fun WorkspacesPane(controller: AppController) {
    var leaving by remember { mutableStateOf<Workspace?>(null) }
    LaunchedEffect(Unit) { controller.refreshSummaries() }
    LazyColumn(Modifier.fillMaxSize()) {
        itemsIndexed(controller.workspaces, key = { _, it -> it.serverUrl }) { index, entry ->
            WorkspaceRow(
                controller, entry, index, controller.workspaces.size,
                onOpen = { if (entry.serverUrl != controller.activeKey) controller.switchWorkspace(entry.serverUrl) },
                onLeave = { leaving = entry },
            )
        }
        item(key = "add") { AddWorkspaceItem(onClick = { controller.beginAddWorkspace() }) }
    }
    leaving?.let { entry -> SignOutWorkspaceDialog(controller, entry, onDismiss = { leaving = null }) }
}

@Composable
private fun AddWorkspaceItem(onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(stringResource(R.string.common_add_workspace)) },
        leadingContent = {
            Box(
                Modifier.size(40.dp).border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Default.Add, contentDescription = null) }
        },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    )
}

/** サインアウト of one workspace, confirmed: its local data goes, the server keeps everything. */
@Composable
private fun SignOutWorkspaceDialog(controller: AppController, entry: Workspace, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.workspace_views_sign_out_of, entry.name)) },
        text = {
            Text(
                stringResource(R.string.workspace_views_n_nthis_workspaces_messages_and_drafts, entry.signInName, Workspaces.hostLabel(entry.serverUrl)),
            )
        },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                // In the controller's scope: the dialog (and the screen under it) goes away before the work is done.
                controller.scope.launch { controller.signOutWorkspace(entry.serverUrl) }
            }) { Text(stringResource(R.string.workspace_views_sign_out), color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

@Composable
private fun WorkspaceRow(controller: AppController, entry: Workspace, index: Int, count: Int, onOpen: () -> Unit, onLeave: () -> Unit) {
    val active = entry.serverUrl == controller.activeKey
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    // The one on screen shows its marks in the channel list; the others show what their server last said.
    val badge = if (active || entry.signedOut) 0 else entry.badge
    val unread = !active && !entry.signedOut && entry.hasUnread
    ListItem(
        headlineContent = { Text(entry.name, fontWeight = if (unread || badge > 0) FontWeight.Bold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Text(
                if (entry.signedOut) stringResource(R.string.workspace_views_sign_in_required) else "${entry.signInName} @ ${Workspaces.hostLabel(entry.serverUrl)}",
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (entry.signedOut) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        leadingContent = { WorkspaceTile(entry, entry.name, 40.dp, dimmed = entry.signedOut && !active) },
        trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                when {
                    badge > 0 -> Badge { Text(if (badge > 99) "99+" else badge.toString()) }
                    unread -> Box(Modifier.size(10.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
                }
                if (active) Icon(Icons.Default.Check, contentDescription = stringResource(R.string.workspace_views_showing), tint = MaterialTheme.colorScheme.primary)
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.common_menu_for, entry.name)) }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        // M114 (WORKSPACES.md §5.4): the order of this list, kept on this device.
                        if (count > 1) {
                            DropdownMenuItem(text = { Text(stringResource(R.string.workspace_views_move_up)) }, enabled = index > 0, onClick = { menu = false; controller.moveWorkspace(entry.serverUrl, -1) })
                            DropdownMenuItem(text = { Text(stringResource(R.string.workspace_views_move_down)) }, enabled = index < count - 1, onClick = { menu = false; controller.moveWorkspace(entry.serverUrl, 1) })
                            HorizontalDivider()
                        }
                        if (entry.signedOut && !active) {
                            DropdownMenuItem(text = { Text(stringResource(R.string.workspace_views_remove_from_list)) }, onClick = { menu = false; scope.launch { controller.signOutWorkspace(entry.serverUrl) } })
                        } else {
                            DropdownMenuItem(text = { Text(stringResource(R.string.workspace_views_sign_out_2), color = MaterialTheme.colorScheme.error) }, onClick = { menu = false; onLeave() })
                        }
                    }
                }
            }
        },
        colors = ListItemDefaults.colors(containerColor = if (active) MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f) else Color.Transparent),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen),
    )
}
