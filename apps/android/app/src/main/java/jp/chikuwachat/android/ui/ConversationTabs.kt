package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.ChannelLinkOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState

/** M29: what the body of an open conversation shows, picked from the tab row under the app bar. */
enum class ConversationTab(val label: String) {
    MESSAGES("メッセージ"),
    PINS("ピン留め"),
    FILES("ファイル"),
}

/**
 * M29 (IMPLEMENTATION_PLAN.md): the phone's conversation screen as pages. The channel details are a page of their own,
 * and the pins and files are tabs over the timeline, which stays composed underneath (its scroll position, read anchor
 * and draft survive a switch).
 */
object ConversationNav {
    // What back closes first (details → tab → thread → conversation → list) is MainNav.back (M33).

    /** The tab row: a joined conversation's timeline, not a thread, a preview before joining, the search or the details. */
    fun tabRowShown(channelOpen: Boolean, member: Boolean, threadOpen: Boolean, searching: Boolean, detailsOpen: Boolean): Boolean =
        channelOpen && member && !threadOpen && !searching && !detailsOpen

    /**
     * Whether the timeline's rows are on screen. While 「ピン留め」, 「ファイル」 or the details show, the conversation is not
     * being looked at: no rows count as seen and nothing marks read (SYNC_PROTOCOL.md §10.1 2.).
     */
    fun conversationOnScreen(tab: ConversationTab, detailsOpen: Boolean): Boolean = tab == ConversationTab.MESSAGES && !detailsOpen
}

/**
 * M29: one horizontally scrolling row under the app bar: the tabs, then the conversation's links (M15f's link bar) and
 * 「＋ リンク」 for those who may edit them. `version`: the links live in the Store (loaded after the conversation opens,
 * replaced by events).
 */
@Composable
fun ConversationTabRow(controller: AppController, channel: ChannelState, version: Int, tab: ConversationTab, onTab: (ConversationTab) -> Unit) {
    val links = remember(version, channel.id) { controller.store.linksOf(channel.id) }
    val editable = ChannelLinks.canEdit(channel, controller.store.me?.role)
    // The link editor (null link = add).
    var editingLink by remember(channel.id) { mutableStateOf<Pair<Boolean, ChannelLinkOut?>>(false to null) }
    if (editingLink.first) ChannelLinkDialog(controller, channel.id, editingLink.second, onDismiss = { editingLink = false to null })
    LazyRow(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN),
        contentPadding = PaddingValues(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items(ConversationTab.entries, key = { "tab:" + it.name }) { entry ->
            ConversationTabItem(entry.label, selected = entry == tab) { onTab(entry) }
        }
        if (links.isNotEmpty() || editable) {
            item(key = "divider") { VerticalDivider(Modifier.padding(horizontal = 6.dp).height(20.dp)) }
        }
        itemsIndexed(links, key = { _, link -> "link:" + link.id }) { index, link ->
            ChannelLinkChip(controller, channel.id, link, index, links.size, editable, onEdit = { editingLink = true to it }, modifier = Modifier.padding(horizontal = 3.dp))
        }
        if (editable) {
            item(key = "add") {
                TextButton(onClick = { editingLink = true to null }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(14.dp))
                    Text(" リンク", style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
    HorizontalDivider()
}

/** A tab: its label, underlined while selected; TalkBack reads it as a tab with its state. */
@Composable
private fun ConversationTabItem(label: String, selected: Boolean, onClick: () -> Unit) {
    val indicator = MaterialTheme.colorScheme.primary
    Box(
        Modifier
            .heightIn(min = TouchTarget.MIN)
            .selectable(selected = selected, role = Role.Tab, onClick = onClick)
            .drawBehind {
                if (selected) {
                    val thickness = 2.dp.toPx()
                    drawRect(indicator, topLeft = Offset(0f, size.height - thickness), size = Size(size.width, thickness))
                }
            }
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
