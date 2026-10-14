package jp.chikuwachat.android.share

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.AppLanguage
import jp.chikuwachat.android.ChikuwaApp
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.AppRoot
import jp.chikuwachat.android.ui.Avatar
import jp.chikuwachat.android.ui.ChikuwaTheme
import jp.chikuwachat.android.ui.RecentConversations
import jp.chikuwachat.android.ui.WorkspaceTile
import jp.chikuwachat.android.ui.channelTitle
import jp.chikuwachat.android.ui.formatSize

/**
 * MOBILE_UI.md §20: the target of other apps' share sheets (ACTION_SEND / ACTION_SEND_MULTIPLE: files, pictures,
 * videos, text and links). Shows what is shared, the conversation to send it to and an optional message; 送信 hands it
 * to [ShareWorker] and closes. Not signed in: the app's sign-in comes first, then the share screen again.
 */
class ShareActivity : ComponentActivity() {
    private val controller get() = (application as ChikuwaApp).controller
    private val model: ShareModel by viewModels()

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLanguage.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        model.start(read(intent), ownProviders())
        setContent {
            ChikuwaTheme(controller.appearance) {
                ShareRoot(controller, model, onClose = { finish() }, onSent = {
                    Toast.makeText(this, R.string.share_in_started, Toast.LENGTH_SHORT).show()
                    finish()
                })
            }
        }
    }

    /**
     * Every authority of this app's own providers, and the system's answer for any other spelling (REVIEW-v0.1.62 #2):
     * an authority that resolves to a provider of this package (or of this app's uid) is ours. A share of one of them
     * is refused (SharePayload.parse).
     */
    private fun ownProviders(): OwnProviders {
        val info = runCatching {
            if (Build.VERSION.SDK_INT >= 33) packageManager.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_PROVIDERS.toLong()))
            else @Suppress("DEPRECATION") packageManager.getPackageInfo(packageName, PackageManager.GET_PROVIDERS)
        }.getOrNull()
        val listed = info?.providers.orEmpty().flatMap { it.authority?.split(';').orEmpty() }
        val pm = packageManager
        val ownPackage = packageName
        val ownUid = applicationInfo.uid
        return OwnProviders((listed + "$packageName.files").toSet()) { authority ->
            val provider = if (Build.VERSION.SDK_INT >= 33) pm.resolveContentProvider(authority, PackageManager.ComponentInfoFlags.of(0))
            else @Suppress("DEPRECATION") pm.resolveContentProvider(authority, 0)
            provider != null && (provider.packageName == ownPackage || provider.applicationInfo?.uid == ownUid)
        }
    }

    companion object {
        /** The share intent's extras as plain data ([SharePayload.parse] decides what they mean). */
        fun read(intent: Intent?): ShareIntentData {
            if (intent == null) return ShareIntentData(null)
            val streams: List<Uri> = when (intent.action) {
                Intent.ACTION_SEND_MULTIPLE -> parcelableList(intent)
                else -> listOfNotNull(parcelable(intent))
            }
            val texts = when (intent.action) {
                Intent.ACTION_SEND_MULTIPLE -> intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)?.map { it.toString() }
                    ?: listOfNotNull(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
                else -> listOfNotNull(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
            }
            // Not ClipData's URIs: a browser sharing a link puts the share sheet's preview picture there (seen with Chrome),
            // which is not what is shared. EXTRA_STREAM alone names the files.
            return ShareIntentData(
                action = intent.action,
                // REVIEW-v0.1.62 #2: Android's own parse (the decoded authority ContentResolver resolves), not the text.
                streams = streams.map { ShareStream(it.toString(), it.scheme, it.authority) },
                texts = texts,
                subject = intent.getStringExtra(Intent.EXTRA_SUBJECT),
                // Intent.EXTRA_SHORTCUT_ID (API 29; an older system never sends it).
                shortcutId = intent.getStringExtra("android.intent.extra.shortcut.ID"),
            )
        }

        private fun parcelable(intent: Intent): Uri? =
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)

        private fun parcelableList(intent: Intent): List<Uri> =
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
    }
}

/** Signed in with a workspace on screen: the share screen; otherwise the app's own boot / sign-in screens. */
@Composable
private fun ShareRoot(controller: AppController, model: ShareModel, onClose: () -> Unit, onSent: () -> Unit) {
    LaunchedEffect(Unit) { controller.boot() }
    val signedIn = controller.screen == AppController.Screen.MAIN && !controller.addingWorkspace
    if (signedIn) {
        ShareScreen(controller, model, onClose, onSent)
    } else {
        Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            if (controller.screen != AppController.Screen.BOOT) {
                Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(top = 32.dp, start = 16.dp, end = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.share_in_sign_in_to_continue), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        IconButton(onClick = onClose) { Icon(Icons.Default.Close, stringResource(R.string.common_cancel)) }
                    }
                }
            }
            Box(Modifier.weight(1f)) { AppRoot(controller) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ShareScreen(controller: AppController, model: ShareModel, onClose: () -> Unit, onSent: () -> Unit) {
    val store = controller.store
    val active = controller.activeKey
    val request = model.request
    // Direct Share: the chosen conversation's workspace comes on screen and the conversation is picked (once).
    var shortcutTaken by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(request, controller.workspaces) {
        if (shortcutTaken || request == null) return@LaunchedEffect
        val target = ShareDestinations.shortcutTarget(request.shortcutId, controller.workspaces.map { it.serverUrl })
        shortcutTaken = true
        if (target != null) {
            model.destination = target
            if (target.first != active) controller.switchWorkspace(target.first)
        }
    }
    // A conversation of another workspace is not offered once the switcher moved away from it.
    val chosen = model.destination?.takeIf { it.first == active }?.second?.let { store.channel(it) }
    val limits = store.limits
    val problems = model.problems(limits)
    val ready = chosen != null && problems.isEmpty() && !model.sending
    val title: (ChannelState) -> String = { channelTitle(it, store) }
    val account = controller.accountKey
    val recentIds = remember(account, store.channels.size) {
        if (account == null) emptyList() else
            RecentConversations.read(controller.prefs, ShareModel.recentKey(account)) + RecentConversations.read(controller.prefs, RecentConversations.key(account))
    }
    val lists = ShareDestinations.list(
        model.query, store.channels.values, recentIds, store.me?.id, controller.isAdmin, title,
        userNames = { id -> store.users[id]?.let { listOf(it.displayName, it.username) } ?: emptyList() },
    )
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.share_in_title)) },
                navigationIcon = {
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, stringResource(R.string.common_cancel)) }
                },
                actions = {
                    if (model.sending) {
                        CircularProgressIndicator(Modifier.size(24.dp).padding(end = 4.dp), strokeWidth = 2.dp)
                    }
                    TextButton(enabled = ready, onClick = {
                        val channel = chosen ?: return@TextButton
                        model.send(title(channel)) { handed -> if (handed) onSent() }
                    }) { Text(stringResource(R.string.common_send)) }
                },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding(), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (controller.workspaces.size > 1) {
                item("workspace") { WorkspacePicker(controller) }
            }
            if (model.files.isNotEmpty()) {
                item("files") { SharedFiles(model) }
            }
            if (request != null && request.refused > 0) {
                item("refused") { Note(stringResource(R.string.share_in_refused_items, request.refused), error = false) }
            }
            if (request != null) {
                items(problems, key = { "p:$it" }) { Note(it, error = true) }
            }
            item("text") {
                OutlinedTextField(
                    value = model.text,
                    onValueChange = { model.text = it },
                    label = { Text(stringResource(R.string.share_in_message_hint)) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    minLines = 2,
                    maxLines = 6,
                )
            }
            item("to") {
                Text(
                    if (chosen == null) stringResource(R.string.share_in_choose_destination) else stringResource(R.string.share_in_destination, title(chosen)),
                    style = MaterialTheme.typography.titleSmall,
                    color = if (chosen == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            item("search") {
                OutlinedTextField(
                    value = model.query,
                    onValueChange = { model.query = it },
                    placeholder = { Text(stringResource(R.string.share_in_search)) },
                    leadingIcon = { Icon(Icons.Default.Search, null) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                )
            }
            if (lists.recent.isNotEmpty()) {
                item("recent-h") { Header(stringResource(R.string.share_in_recent)) }
                items(lists.recent, key = { "r:" + it.id }) { channel ->
                    DestinationRow(channel, title(channel), store.me?.id, selected = chosen?.id == channel.id) {
                        model.destination = (active ?: return@DestinationRow) to channel.id
                    }
                }
            }
            if (lists.others.isNotEmpty()) {
                if (model.query.isBlank()) item("all-h") { Header(stringResource(R.string.share_in_all)) }
                items(lists.others, key = { "o:" + it.id }) { channel ->
                    DestinationRow(channel, title(channel), store.me?.id, selected = chosen?.id == channel.id) {
                        model.destination = (active ?: return@DestinationRow) to channel.id
                    }
                }
            }
            if (lists.recent.isEmpty() && lists.others.isEmpty()) {
                item("none") {
                    Text(
                        stringResource(if (model.query.isBlank()) R.string.share_in_no_destinations else R.string.share_in_no_results),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun WorkspacePicker(controller: AppController) {
    var open by remember { mutableStateOf(false) }
    val entry = controller.activeWorkspace
    Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(role = Role.DropdownList) { open = true }.padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WorkspaceTile(entry, controller.workspaceName, 28.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.share_in_workspace), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(controller.workspaceName, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Default.UnfoldMore, null)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            controller.workspaces.forEach { workspace ->
                DropdownMenuItem(
                    text = { Text(workspace.name) },
                    leadingIcon = { WorkspaceTile(workspace, workspace.name, 24.dp, dimmed = workspace.signedOut) },
                    onClick = {
                        open = false
                        if (workspace.serverUrl != controller.activeKey) controller.switchWorkspace(workspace.serverUrl)
                    },
                )
            }
        }
    }
}

@Composable
private fun SharedFiles(model: ShareModel) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(model.checkedFiles, key = { it.uri }) { file ->
            Column(Modifier.width(112.dp)) {
                Box(
                    Modifier.size(112.dp, 84.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
                    contentAlignment = Alignment.Center,
                ) {
                    val thumb = model.thumbnails[file.uri]
                    if (thumb != null) {
                        Image(thumb.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    } else {
                        val icon = when {
                            file.mime == "application/pdf" -> Icons.Default.PictureAsPdf
                            file.mime?.startsWith("video/") == true -> Icons.Default.Movie
                            else -> Icons.AutoMirrored.Filled.InsertDriveFile
                        }
                        Icon(icon, null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Text(file.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                file.size?.let {
                    Text(formatSize(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun Note(text: String, error: Boolean) {
    Text(
        text,
        color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
    )
}

@Composable
private fun Header(text: String) {
    Column {
        Spacer(Modifier.padding(top = 8.dp))
        HorizontalDivider()
        Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
    }
}

@Composable
private fun DestinationRow(channel: ChannelState, title: String, meId: String?, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.RadioButton, onClick = onClick).padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
            if (channel.channel.isDm) {
                val other = channel.channel.dmUserIds.orEmpty().firstOrNull { it != meId } ?: meId ?: channel.id
                Avatar(other, title, size = 28.dp)
            } else {
                Icon(if (channel.channel.type == "private") Icons.Default.Lock else Icons.Default.Tag, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.width(12.dp))
        Text(title.removePrefix("#"), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
        RadioButton(selected = selected, onClick = onClick)
    }
}
