package jp.chikuwachat.android.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.DriveLinkState
import jp.chikuwachat.android.sync.DriveLinks
import jp.chikuwachat.android.sync.DriveNames
import kotlinx.coroutines.launch

/**
 * M166 (docs/DRIVE.md §13.1, §25.1, §26; the desktop's DriveLinkCard.tsx): this server's `/d/<id>` links in a message.
 * Inline the link reads 「📁 名前」 / 「📎 名前」 once its item is known ([DriveLinks.label]; never the markdown `[name]`),
 * and under the body each distinct item (at most three) is a card: its thumbnail or icon, its current name and
 * 「研究室ドライブ › 論文 · 4.6 MB」. Whoever cannot read it (404: another location, the trash, deleted) sees
 * 「表示できないファイル」 and nothing of it. A tap opens a photo, a video or a document with a preview in the viewer, and
 * a folder or any other file in 「ドライブ」 at its folder (the file's details over it).
 */

/** The inline labels and the tap of `/d/` links in the bodies on the main screen (null elsewhere: plain text). */
class DriveLinkLabels(val state: (String) -> DriveLinkState?, val open: (String) -> Unit, val version: Int)

val LocalDriveLinks = compositionLocalOf<DriveLinkLabels?> { null }

/** The cards of a message's drive links (none when it has none, or on another server's /d/). */
@Composable
fun DriveLinkCards(controller: AppController, body: String) {
    val base = controller.serverBase ?: return
    val ids = remember(body, base) { DriveLinks.idsIn(base, body) }
    if (ids.isEmpty()) return
    val hub = controller.drive ?: return
    // Every link's item, so the inline labels beyond the three cards read too (one minute's cache in the hub).
    LaunchedEffect(ids) { ids.forEach { hub.link(it) } }
    Column(Modifier.padding(top = 2.dp)) { ids.take(DriveLinks.MAX_CARDS).forEach { DriveLinkCard(controller, it) } }
}

@Composable
fun DriveLinkCard(controller: AppController, itemId: String) {
    val hub = controller.drive ?: return
    hub.version.collectAsState().value
    val state = hub.peekLink(itemId)
    var viewing by remember(itemId) { mutableStateOf<DriveItemOut?>(null) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val shape = RoundedCornerShape(12.dp)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // One height whatever it shows (loading, the item, why not), so the row does not move when the card fills in.
    val frame = Modifier.padding(vertical = 4.dp).widthIn(max = 420.dp).fillMaxWidth().heightIn(min = 60.dp).clip(shape)
        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
    @Composable
    fun Plain(icon: ImageVector, title: String, note: String?, modifier: Modifier = Modifier) {
        Row(frame.then(modifier).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) { Icon(icon, contentDescription = null, tint = muted, modifier = Modifier.size(22.dp)) }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                if (note != null) Text(note, style = MaterialTheme.typography.labelSmall, color = muted)
            }
        }
    }
    when (state) {
        null -> Row(frame.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            LaunchedEffect(itemId) { hub.link(itemId) }
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
            Text(stringResource(R.string.drive_card_loading), style = MaterialTheme.typography.bodyMedium, color = muted)
        }
        DriveLinkState.Unreadable -> Plain(Icons.Outlined.Lock, stringResource(R.string.drive_card_unavailable), stringResource(R.string.drive_card_unavailable_note))
        DriveLinkState.Failed -> Plain(
            Icons.Outlined.WarningAmber, stringResource(R.string.drive_card_failed), stringResource(R.string.drive_card_retry),
            Modifier.clickable(onClickLabel = stringResource(R.string.common_retry)) { scope.launch { hub.link(itemId, force = true) } },
        )
        is DriveLinkState.Ok -> state.detail.item.album?.let { album ->
            // AL4 (docs/ALBUMS.md §10.4): an album's card — its pictures, title, count and days; a tap opens it.
            AlbumLinkCard(controller, state.detail, album) { scope.launch { controller.openDriveLink(itemId, force = false) } }
        } ?: run {
            val item = state.detail.item
            val open = {
                if (DriveNames.viewer(item) != null) viewing = item
                else scope.launch { controller.openDriveLink(itemId, force = false) }
            }
            Row(
                frame.clickable(onClickLabel = stringResource(R.string.drive_open)) { open() }.padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 4.dp)
                    .semantics { contentDescription = L10n.str(R.string.drive_card_named, item.name) },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                DriveThumb(controller, item)
                Column(Modifier.weight(1f)) {
                    FileNameText(item.name)
                    Text(DriveNames.cardDetails(state.detail), style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (!item.isFolder) {
                    IconButton(onClick = { scope.launch { controller.openDriveLink(itemId, force = false) } }) {
                        Icon(Icons.AutoMirrored.Outlined.DriveFileMove, stringResource(R.string.drive_card_show_in_drive), tint = muted)
                    }
                }
            }
        }
    }
    viewing?.let { item -> DriveViewer(controller, item, onDismiss = { viewing = null }) }
}
