package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.NotificationLevels
import kotlinx.coroutines.launch
import java.time.Instant
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** D1 (MOBILE_POLISH.md, MOBILE_UI.md §6.8): the round buttons under the name on the details page. */
enum class DetailsButton { FAVORITE, NOTIFICATIONS, SEARCH, ADD_MEMBER }

object ChannelDetailsHeader {
    /** Favourite and notifications for a member, search always, 「追加」 in a channel (not a DM) that is not archived. */
    fun buttons(isChannel: Boolean, isMember: Boolean, archived: Boolean): List<DetailsButton> = buildList {
        if (isMember) {
            add(DetailsButton.FAVORITE)
            add(DetailsButton.NOTIFICATIONS)
        }
        add(DetailsButton.SEARCH)
        if (isChannel && isMember && !archived) add(DetailsButton.ADD_MEMBER)
    }

    /** The one 「通知」 row's value on the right (the choices open from it): mute first, then the timed mute, then the level. */
    fun notificationSummary(level: String, mutedOn: Boolean, timedMute: String?): String = when {
        mutedOn -> L10n.str(R.string.channel_details_header_muted)
        timedMute != null -> timedMute
        else -> NotificationLabels.shortLabel(level)
    }

    /** 「メンバー 12 人」; empty while the count is unknown. */
    fun memberLine(count: Int?): String = count?.let { L10n.plural(R.plurals.common_member_members, it, it) } ?: ""
}

/**
 * M35's choices for one conversation (the same menu as the app bar's 🔔 in a conversation): 「既定 (…)」 and the three
 * levels, the 「ミュート」 switch, and 「8 時間ミュート」 / 「ミュート解除 (…)」.
 */
@Composable
fun ChannelNotificationMenu(controller: AppController, channel: ChannelState, expanded: Boolean, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val store = controller.store
    val ownLevel = NotificationLevels.own(channel)
    val overall = (store.me ?: controller.me)?.notificationDefault ?: NotificationLevels.MENTIONS
    val mutedOn = NotificationLevels.mutedUntilUnmuted(channel)
    val mute = Timeline.muteLabel(channel.channel.notification?.mutedUntil)
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        (listOf<Pair<String?, String>>(null to NotificationLabels.defaultChoice(overall)) + NotificationLevels.levels.map { it to NotificationLabels.label(it) })
            .forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text((if (ownLevel == value) "✓ " else "    ") + label) },
                    onClick = { onDismiss(); scope.launch { controller.setChannelLevel(channel.id, value) } },
                )
            }
        HorizontalDivider()
        DropdownMenuItem(
            text = { Text(stringResource(R.string.channel_details_header_mute)) },
            trailingIcon = { Switch(checked = mutedOn, onCheckedChange = null) },
            onClick = { onDismiss(); scope.launch { controller.setChannelMuted(channel.id, !mutedOn) } },
        )
        if (mute != null) {
            DropdownMenuItem(text = { Text(stringResource(R.string.channel_details_header_unmute, mute)) }, onClick = { onDismiss(); scope.launch { controller.setChannelTimedMute(channel.id, null) } })
        } else {
            DropdownMenuItem(text = { Text(stringResource(R.string.channel_details_header_mute_for_8_hours)) }, onClick = {
                onDismiss()
                scope.launch { controller.setChannelTimedMute(channel.id, Instant.now().plusSeconds(8 * 3600).toString()) }
            })
        }
    }
}

/**
 * D1: the top of the details page, as on Slack: a large glyph (# / 🔒, the other person's avatar in a DM), the name, the
 * member count and the topic, then a row of round buttons. `memberCount` is the loaded list's size when there is one.
 */
@Composable
fun ChannelDetailsHeader(
    controller: AppController,
    channel: ChannelState,
    version: Int,
    memberCount: Int?,
    onSearch: () -> Unit,
    onAddMember: () -> Unit,
) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    val isChannel = !channel.channel.isDm
    val meId = store.me?.id
    val others = (channel.channel.dmUserIds ?: emptyList()).filter { it != meId }
    Column(Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        when {
            isChannel -> Box(
                Modifier.size(64.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (channel.channel.type == "private") Icons.Filled.Lock else Icons.Filled.Tag, contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(34.dp),
                )
            }
            others.size == 1 -> Avatar(others[0], store.users[others[0]]?.displayName ?: "?", size = 64.dp, presence = store.presenceOf(others[0]))
            others.isEmpty() && meId != null -> Avatar(meId, myDisplayName(store), size = 64.dp)
            else -> Box(
                Modifier.size(64.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp)),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.Group, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(34.dp)) }
        }
        val title = remember(version, channel) { channelTitle(channel, store).let { if (isChannel) it.removePrefix("#") else it } }
        Text(
            title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
            maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp, start = 8.dp, end = 8.dp),
        )
        val count = memberCount ?: channel.channel.memberCount
        val sub = if (isChannel) ChannelDetailsHeader.memberLine(count) else if (others.size == 1) dmPresenceSubtitle(channel, store) ?: "" else ChannelDetailsHeader.memberLine(count)
        if (sub.isNotEmpty()) {
            EmojiLineText(sub, controller, version, MaterialTheme.typography.bodyMedium, MaterialTheme.colorScheme.onSurfaceVariant, Modifier.padding(top = 2.dp))
        }
        channel.channel.topic?.takeIf { isChannel && it.isNotBlank() }?.let { topic ->
            Text(
                topic, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 6.dp, start = 16.dp, end = 16.dp),
            )
        }
        val buttons = ChannelDetailsHeader.buttons(isChannel, channel.isMember, channel.channel.archived)
        Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            buttons.forEach { button ->
                when (button) {
                    DetailsButton.FAVORITE -> {
                        val starred = store.isFavorite(channel.id)
                        RoundButton(
                            if (starred) Icons.Filled.Star else Icons.Outlined.StarBorder, if (starred) stringResource(R.string.channel_details_header_starred) else stringResource(R.string.common_star), selected = starred,
                        ) { scope.launch { controller.toggleFavorite(channel.id) } }
                    }
                    DetailsButton.NOTIFICATIONS -> {
                        var open by remember { mutableStateOf(false) }
                        val level = NotificationLevels.resolved(channel, store.me?.notificationDefault ?: NotificationLevels.MENTIONS, meId)
                        val quiet = level == NotificationLevels.NONE || NotificationLevels.mutedUntilUnmuted(channel) || Timeline.muteLabel(channel.channel.notification?.mutedUntil) != null
                        Box {
                            RoundButton(if (quiet) Icons.Filled.NotificationsOff else Icons.Filled.Notifications, stringResource(R.string.common_notifications)) { open = true }
                            ChannelNotificationMenu(controller, channel, open, onDismiss = { open = false })
                        }
                    }
                    DetailsButton.SEARCH -> RoundButton(Icons.Filled.Search, stringResource(R.string.common_search), onClick = onSearch)
                    DetailsButton.ADD_MEMBER -> RoundButton(Icons.Filled.PersonAdd, stringResource(R.string.common_add), onClick = onAddMember)
                }
            }
        }
    }
}

@Composable
private fun RoundButton(icon: ImageVector, label: String, selected: Boolean = false, onClick: () -> Unit) {
    Column(
        Modifier.widthIn(min = 72.dp).clickable(role = Role.Button, onClick = onClick).padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(52.dp).background(if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = if (selected) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 6.dp), maxLines = 1)
    }
}

/** D1: the notification settings folded into one row (the current setting on the right); a tap opens the choices. */
@Composable
fun ChannelNotificationRow(controller: AppController, channel: ChannelState) {
    val store = controller.store
    var open by remember { mutableStateOf(false) }
    val level = NotificationLevels.resolved(channel, (store.me ?: controller.me)?.notificationDefault ?: NotificationLevels.MENTIONS, store.me?.id)
    val mutedOn = NotificationLevels.mutedUntilUnmuted(channel)
    val mute = Timeline.muteLabel(channel.channel.notification?.mutedUntil)
    Box {
        Row(
            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(role = Role.Button, onClickLabel = stringResource(R.string.channel_details_header_open_notification_settings)) { open = true }.padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (level == NotificationLevels.NONE || mutedOn || mute != null) Icons.Filled.NotificationsOff else Icons.Filled.Notifications,
                contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(16.dp))
            Text(stringResource(R.string.common_notifications), modifier = Modifier.weight(1f))
            Text(ChannelDetailsHeader.notificationSummary(level, mutedOn, mute), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        ChannelNotificationMenu(controller, channel, open, onDismiss = { open = false })
    }
}
