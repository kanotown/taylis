package jp.chikuwachat.android.share

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderShared
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.DriveCrumb
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DriveLocationOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.DriveNames
import jp.chikuwachat.android.sync.describeDriveError
import jp.chikuwachat.android.ui.NewFolderDialog
import kotlinx.coroutines.CancellationException

/**
 * 2026-10-24 (MOBILE_UI.md §20, DRIVE.md §6): 「ドライブに保存」's folder — the drives I can write to, then their folders
 * (into subfolders, ← one level up, 「新しいフォルダ」), 「ここに保存」 picks the folder shown.
 */
@Composable
internal fun ShareDrivePicker(controller: AppController, onPick: (ShareDriveTarget) -> Unit, onClose: () -> Unit) {
    val hub = controller.drive
    hub?.version?.collectAsState()?.value
    LaunchedEffect(hub) { hub?.loadLocations(withMine = true) }
    var location by remember { mutableStateOf<DriveLocationOut?>(null) }
    /** The folders opened, the location's root first. */
    var stack by remember { mutableStateOf<List<String>>(emptyList()) }
    BackHandler {
        when {
            stack.size > 1 -> stack = stack.dropLast(1)
            location != null -> { location = null; stack = emptyList() }
            else -> onClose()
        }
    }
    val held = location
    if (held == null) {
        val writable = hub?.locations?.filter { it.canWrite }
        LazyColumn(Modifier.fillMaxSize()) {
            item { Header(stringResource(R.string.share_in_drive_choose), onBack = onClose) }
            when {
                writable == null && hub?.locationsError != null -> item { Text(hub.locationsError!!, Modifier.padding(16.dp)) }
                writable == null -> item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                writable.isEmpty() -> item { Text(stringResource(R.string.share_in_drive_no_locations), Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                else -> items(writable, key = { it.id }) { place ->
                    val icon = when (place.kind) { "workspace" -> Icons.Outlined.FolderShared; "user" -> Icons.Outlined.Person; else -> Icons.Outlined.Tag }
                    PickRow(icon, DriveNames.locationName(place)) { location = place; stack = listOf(place.rootId) }
                }
            }
        }
        return
    }
    val folderId = stack.lastOrNull() ?: held.rootId
    var page by remember(folderId) { mutableStateOf<Pair<List<DriveCrumb>, List<DriveItemOut>>?>(null) }
    var error by remember(folderId) { mutableStateOf<String?>(null) }
    var attempt by remember(folderId) { mutableIntStateOf(0) }
    var naming by remember { mutableStateOf(false) }
    LaunchedEffect(folderId, attempt) {
        error = null
        try {
            val api = controller.driveApi ?: return@LaunchedEffect
            val out = api.driveChildren(folderId, "name", "asc", null, 200)
            page = out.path to out.items.filter { it.isFolder }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = describeDriveError(e)
        }
    }
    val label = page?.first?.let { DriveNames.pathLine(it, held.kind) } ?: DriveNames.locationName(held)
    Column(Modifier.fillMaxSize()) {
        Header(label, onBack = { if (stack.size > 1) stack = stack.dropLast(1) else { location = null; stack = emptyList() } }) {
            IconButton(onClick = { naming = true }) { Icon(Icons.Outlined.CreateNewFolder, stringResource(R.string.drive_new_folder)) }
        }
        HorizontalDivider()
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            val folders = page?.second
            when {
                error != null -> item {
                    Column(Modifier.padding(16.dp)) {
                        Text(error!!)
                        TextButton(onClick = { attempt += 1 }) { Text(stringResource(R.string.common_retry)) }
                    }
                }
                folders == null -> item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                else -> items(folders, key = { it.id }) { folder -> PickRow(Icons.Outlined.Folder, folder.name) { stack = stack + folder.id } }
            }
        }
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.End) {
            Button(enabled = page != null, onClick = {
                val server = controller.activeKey ?: return@Button
                onPick(ShareDriveTarget(server, held.id, folderId, label))
            }) { Text(stringResource(R.string.share_in_drive_save_here)) }
        }
    }
    if (naming) NewFolderDialog(controller, folderId, onDismiss = { naming = false }, onMade = { naming = false; stack = stack + it.id })
}

@Composable
private fun Header(title: String, onBack: () -> Unit, actions: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.share_in_drive_back)) }
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        actions()
    }
}

@Composable
private fun PickRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
